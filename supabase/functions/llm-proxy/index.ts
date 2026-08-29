// Server-side LLM proxy for the Mood Mode intent extractor.
//
// ── Why this exists ────────────────────────────────────────────────────────
// `src/lib/llm.ts` can reach a model two ways: a raw provider key bundled into
// the app, or a proxy URL. The bundled key is DEVELOPMENT ONLY and that file
// says so at length — `EXPO_PUBLIC_*` variables are inlined into the client
// bundle by Expo, so a key placed there is extractable from any published
// build and billable to us. This function is the production half of that
// choice: the key lives in Edge Function secrets and never ships.
//
// Until now neither route was configured (`.env` holds ANTHROPIC_API_KEY with
// no EXPO_PUBLIC_ prefix, which is correct but means `llmAvailable()` returns
// false), so the Hebrew→English translation layer in `moodPlanner.ts` has been
// dead code. This is what switches it on.
//
// ── Model ──────────────────────────────────────────────────────────────────
// Claude Haiku 4.5. Chosen deliberately for this job: intent extraction is a
// short, well-specified transform — a sentence in, a small JSON object out —
// and Haiku is the cheapest model that does it reliably ($1/$5 per MTok vs
// $5/$25 for Opus). It also sidesteps the OpenAI account entirely, which
// currently returns `insufficient_quota`.
//
// Two Haiku-specific API constraints, both easy to get wrong:
//   * `output_config.effort` is NOT supported on Haiku 4.5 and errors. Effort
//     arrived with the 4.6 generation; do not add it here.
//   * Extended thinking on a pre-4.6 model uses the legacy
//     `{type: 'enabled', budget_tokens: N}` form, not `{type: 'adaptive'}`.
//     Thinking is omitted entirely — this task does not need it, and it would
//     only add latency to a call that sits in front of a user waiting for
//     search results.

import Anthropic from 'npm:@anthropic-ai/sdk@0.110.0';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { verifyAppCheck } from '../_shared/appCheck.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { adminClient, userClient } from '../_shared/clients.ts';

const MODEL = 'claude-haiku-4-5';

// The intent extractor's prompt and reply are both small. This ceiling is
// generous for that shape and low enough that a prompt-injected "write me an
// essay" cannot run up a bill.
const MAX_OUTPUT_TOKENS = 1024;

/**
 * The contract `src/lib/llm.ts` already expects from a proxy:
 *   in  → { system, user, maxTokens? }
 *   out → { text }
 *
 * Deliberately provider-agnostic. The client does not know or care that the
 * other side is Claude, which is what lets the provider change without an app
 * release.
 */
interface ProxyRequest {
  system?: unknown;
  user?: unknown;
  maxTokens?: unknown;
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  try {
    const attestation = await verifyAppCheck(req);
    if (!attestation.ok) return jsonResponse({ error: attestation.error }, 403);

    // A signed-in user is required. This endpoint spends money on every call,
    // so it must never be reachable anonymously.
    const supabase = userClient(req);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'not_authenticated' }, 401);

    const admin = adminClient();

    // 30/hour. Mood searches are interactive and bursty — a user refining a
    // query several times in a row is normal use, not abuse — but this still
    // bounds a runaway client to a few cents an hour.
    //
    // The window is a PARAMETER of check_rate_limit, not a property of the
    // table, so moving this to a daily cap later is a one-line change here
    // with no migration.
    const limit = await checkRateLimit(admin, user.id, 'llm-proxy', 30, 3600);
    if (!limit.allowed) {
      return jsonResponse(
        { error: 'rate_limited', retry_after_seconds: limit.retry_after_seconds },
        429,
      );
    }

    let body: ProxyRequest;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400);
    }

    const system = typeof body.system === 'string' ? body.system : '';
    const userText = typeof body.user === 'string' ? body.user.trim() : '';
    if (!userText) return jsonResponse({ error: 'missing_user_text' }, 400);

    // Clamp rather than trust: `maxTokens` arrives from the client, and an
    // unbounded value here is a direct spend lever for anyone who can call the
    // function.
    const requested = typeof body.maxTokens === 'number' ? body.maxTokens : MAX_OUTPUT_TOKENS;
    const maxTokens = Math.min(Math.max(Math.floor(requested), 64), MAX_OUTPUT_TOKENS);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      // Fail loudly in the log, vaguely to the caller. A missing secret is an
      // operator error, and the client's fallback chain handles this fine.
      console.error('llm-proxy: ANTHROPIC_API_KEY is not set');
      return jsonResponse({ error: 'not_configured' }, 503);
    }

    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      // The caller's instructions and output contract. Passed through as the
      // system prompt so it sits ahead of the user's text in the prompt, which
      // is both the correct place for it and the cacheable half.
      system,
      messages: [{ role: 'user', content: userText }],
    });

    // `content` is a discriminated union — narrowing by `type` is required, and
    // a response can legitimately contain several text blocks.
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (!text) {
      // A refusal or an empty completion. Returning null text lets
      // `completeStructured` treat it as "the model had nothing useful to say"
      // and fall through to the local resolver, which is the right behaviour.
      console.warn('llm-proxy: empty completion', { stop_reason: message.stop_reason });
      return jsonResponse({ text: null });
    }

    return jsonResponse({ text });
  } catch (err) {
    console.error('llm-proxy failed:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
});
