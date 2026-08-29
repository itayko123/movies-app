import type { z } from 'zod';
import { env, isSupabaseConfigured } from '@/lib/env';
import { invokeFunction } from '@/lib/functions';

/**
 * Minimal provider-agnostic LLM client for structured (JSON) completions.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * This exists for ONE job: turning a sentence a person typed into a structured
 * query object. It is not a chat client and deliberately has no streaming, no
 * conversation history and no tool use — every extra capability is another way
 * for a model to return something the app then has to defend against.
 *
 * ── Security: where the key lives ──────────────────────────────────────────
 * `EXPO_PUBLIC_*` variables are INLINED INTO THE CLIENT BUNDLE by Expo. A key
 * placed there is readable by anyone who downloads the app, and will be
 * extracted and billed to you. That is a property of client-side bundling, not
 * something this file can fix.
 *
 * So there are two supported deployments:
 *
 *   • `EXPO_PUBLIC_LLM_PROXY_URL` — PRODUCTION. Points at the `mood-search`
 *     Edge Function (or any endpoint you control) which holds the real key
 *     server-side. No secret ships in the app.
 *   • `EXPO_PUBLIC_OPENAI_API_KEY` (or the provider-agnostic
 *     `EXPO_PUBLIC_LLM_API_KEY`) — DEVELOPMENT ONLY. Talks to the provider
 *     directly so the feature can be exercised without deploying a backend.
 *     `assertLlmKeyIsSafe` warns loudly if either is set in a release build.
 *     Ship one of these to the App Store and the key is extractable from the
 *     bundle and billable to you within a day of anyone caring to look.
 *
 * When neither is configured `llmAvailable()` is false and the caller falls
 * back to the on-device resolver. The app never depends on this being present.
 */

export type LlmProvider = 'openai' | 'gemini' | 'anthropic';

const PROVIDERS: readonly LlmProvider[] = ['openai', 'gemini', 'anthropic'];

/** Sensible default model per provider, overridable via EXPO_PUBLIC_LLM_MODEL. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-5',
};

/**
 * Hard ceiling on how long a query may wait on the model.
 *
 * The fallback resolver is genuinely useful, so waiting 30s for a marginally
 * better answer is the wrong trade — past a couple of seconds the user has
 * already decided the app is broken.
 */
const TIMEOUT_MS = 9000;

/** The OpenAI-specific alias, which also implies the provider. */
function openaiKey(): string | null {
  const key = env.EXPO_PUBLIC_OPENAI_API_KEY.trim();
  return key.length > 0 ? key : null;
}

/**
 * Active provider.
 *
 * An explicit EXPO_PUBLIC_LLM_PROVIDER wins. Failing that, a bare
 * EXPO_PUBLIC_OPENAI_API_KEY implies 'openai' — otherwise setting the one
 * obvious variable does nothing at all, which is a silent no-op that looks
 * exactly like a broken feature.
 */
function provider(): LlmProvider | null {
  const raw = env.EXPO_PUBLIC_LLM_PROVIDER.trim().toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(raw)) return raw as LlmProvider;
  return openaiKey() ? 'openai' : null;
}

function proxyUrl(): string | null {
  const url = env.EXPO_PUBLIC_LLM_PROXY_URL.trim();
  return url.length > 0 ? url : null;
}

/**
 * Direct provider key.
 *
 * The generic variable wins so a multi-provider setup stays predictable; the
 * OpenAI alias is only consulted when the active provider IS openai, so an
 * abandoned OPENAI key cannot get sent to Anthropic as a bearer token.
 */
function apiKey(): string | null {
  const generic = env.EXPO_PUBLIC_LLM_API_KEY.trim();
  if (generic.length > 0) return generic;
  const raw = env.EXPO_PUBLIC_LLM_PROVIDER.trim().toLowerCase();
  const explicitlyOther = (PROVIDERS as readonly string[]).includes(raw) && raw !== 'openai';
  return explicitlyOther ? null : openaiKey();
}

/**
 * True when a plan request can actually be made.
 *
 * The `llm-proxy` Edge Function counts: it is the PRODUCTION route and needs no
 * extra configuration beyond Supabase itself, which is what finally makes the
 * Hebrew→English translation layer reachable in a shipped build. Nothing here
 * can verify the function is actually deployed, but that is consistent with the
 * rest of this module — `completeStructured` returns null on every failure and
 * the caller falls back to the on-device resolver.
 */
export function llmAvailable(): boolean {
  if (proxyUrl()) return true;
  if (isSupabaseConfigured) return true;
  return provider() !== null && apiKey() !== null;
}

/** Human-readable description of the active route, for diagnostics. */
export function llmRoute(): string {
  if (proxyUrl()) return `proxy(${proxyUrl()})`;
  if (isSupabaseConfigured) return 'edge(llm-proxy)';
  const name = provider();
  return name && apiKey() ? `direct(${name}:${model(name)})` : 'unconfigured';
}

function model(name: LlmProvider): string {
  const override = env.EXPO_PUBLIC_LLM_MODEL.trim();
  return override.length > 0 ? override : DEFAULT_MODELS[name];
}

/**
 * Shouts if a raw provider key is bundled into a release build.
 *
 * Called once at module load. It cannot prevent the leak — the string is
 * already in the bundle by then — but a build that ships this should not do so
 * quietly.
 */
function assertLlmKeyIsSafe(): void {
  if (!__DEV__ && apiKey() && !proxyUrl()) {
    const which = env.EXPO_PUBLIC_LLM_API_KEY.trim()
      ? 'EXPO_PUBLIC_LLM_API_KEY'
      : 'EXPO_PUBLIC_OPENAI_API_KEY';
    console.warn(
      `[llm] ${which} is bundled into this release build and is publicly ` +
        'readable. Route through EXPO_PUBLIC_LLM_PROXY_URL instead.',
    );
  }
}
assertLlmKeyIsSafe();

export interface LlmRequest {
  /** Instructions and output contract. */
  system: string;
  /** The user's raw text. */
  user: string;
  maxTokens?: number;
}

/** Strips ```json fences some models add despite being told not to. */
function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * Extracts the first balanced JSON object in a string.
 *
 * Models sometimes prepend a sentence ("Here's the query:") even under a JSON
 * instruction. Scanning for a balanced object recovers those responses instead
 * of discarding an otherwise valid answer — while staying strict about what is
 * handed to the parser.
 */
function extractJson(text: string): string | null {
  const source = unfence(text);
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls the assistant's text out of each provider's response envelope. */
function readText(name: LlmProvider, payload: unknown): string | null {
  const data = payload as Record<string, any>;
  try {
    switch (name) {
      case 'openai':
        return data.choices?.[0]?.message?.content ?? null;
      case 'anthropic': {
        const blocks = data.content;
        if (!Array.isArray(blocks)) return null;
        const text = blocks
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text)
          .join('');
        return text || null;
      }
      case 'gemini': {
        const parts = data.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return null;
        const text = parts.map((p: any) => p?.text ?? '').join('');
        return text || null;
      }
    }
  } catch {
    return null;
  }
}

async function callProvider(name: LlmProvider, request: LlmRequest): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;
  const maxTokens = request.maxTokens ?? 700;
  const id = model(name);

  let payload: unknown;
  switch (name) {
    case 'openai':
      payload = await postJson(
        'https://api.openai.com/v1/chat/completions',
        { Authorization: `Bearer ${key}` },
        {
          model: id,
          max_tokens: maxTokens,
          temperature: 0.2,
          // Provider-side JSON enforcement where it exists. extractJson still
          // runs afterwards — belt and braces, since this flag is advisory on
          // some models and absent on others.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        },
      );
      break;

    case 'anthropic':
      payload = await postJson(
        'https://api.anthropic.com/v1/messages',
        {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          // Required for browser-originated calls; harmless on native.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        {
          model: id,
          max_tokens: maxTokens,
          temperature: 0.2,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        },
      );
      break;

    case 'gemini':
      payload = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          id,
        )}:generateContent?key=${encodeURIComponent(key)}`,
        {},
        {
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
          },
        },
      );
      break;
  }

  return readText(name, payload);
}

/**
 * Runs a structured completion and validates it against `schema`.
 *
 * Returns null — never throws and never returns unvalidated data — on every
 * failure mode: unconfigured, network error, timeout, non-JSON response, or a
 * response that parses but doesn't match the schema. Callers treat null as
 * "the model had nothing useful to say" and fall back.
 */
export async function completeStructured<S extends z.ZodTypeAny>(
  schema: S,
  request: LlmRequest,
): Promise<z.output<S> | null> {
  if (!llmAvailable()) return null;

  try {
    let text: string | null;

    const proxy = proxyUrl();
    if (proxy) {
      // The proxy owns provider choice and the key; it returns the same
      // envelope shape regardless of what it talks to upstream.
      const payload = (await postJson(proxy, {}, request)) as { text?: string } | null;
      text = payload?.text ?? null;
    } else if (isSupabaseConfigured) {
      /*
        The `llm-proxy` Edge Function — same {system,user,maxTokens} → {text}
        envelope as a bare proxy URL, but reached through `invokeFunction` so it
        inherits the session JWT and the App Check header. That matters: a raw
        `postJson` here would send no Authorization header at all and the
        function, which requires a signed-in user before it spends money, would
        reject every call with 401.
      */
      const payload = await invokeFunction<{ text?: string | null }>('llm-proxy', {
        system: request.system,
        user: request.user,
        maxTokens: request.maxTokens ?? 700,
      });
      text = payload?.text ?? null;
    } else {
      const name = provider();
      if (!name) return null;
      text = await callProvider(name, request);
    }

    // Raw model output, before any cleaning. This is the single most useful
    // line when the engine "just returns nothing": it distinguishes a refusal,
    // a prose answer, a fenced block and a truncated response — all of which
    // fail identically once they have been through extractJson.
    if (__DEV__) {
      console.log('[llm] raw response:', text == null ? '<null>' : text.slice(0, 1200));
    }

    if (!text) return null;

    const json = extractJson(text);
    if (!json) {
      if (__DEV__) console.warn('[llm] no JSON object found in response');
      return null;
    }

    // JSON.parse throws on malformed input — a model can emit a trailing comma
    // or an unterminated string and extractJson only checks brace balance, not
    // validity. Caught here rather than by the outer handler so the failure is
    // reported as a parse failure and the offending text is shown.
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (parseError) {
      if (__DEV__) console.warn('[llm] JSON.parse failed:', parseError, '\npayload:', json.slice(0, 600));
      return null;
    }

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      if (__DEV__) {
        console.warn('[llm] response failed schema validation:', parsed.error.message);
      }
      return null;
    }
    return parsed.data;
  } catch (error) {
    if (__DEV__) console.warn('[llm] request failed:', error);
    return null;
  }
}
