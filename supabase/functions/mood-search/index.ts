// AI Mood Matcher: natural-language query → Claude intent extraction →
// OpenAI embedding → pgvector match blended with the caller's taste profile.
//
// Security stack (in order): CORS → App Check attestation → user JWT →
// premium check → rate limit (5 searches/hour for free users) → AI calls.

import { z } from 'npm:zod@3.24.1';
import { corsHeaders, handleOptions, jsonResponse } from '../_shared/cors.ts';
import { verifyAppCheck } from '../_shared/appCheck.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { adminClient, userClient } from '../_shared/clients.ts';

const FREE_SEARCHES_PER_HOUR = 5;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const CLAUDE_MODEL = 'claude-sonnet-5';
const TASTE_BLEND = 0.3; // final = 0.7 * query + 0.3 * taste

const BodySchema = z.object({
  query: z.string().trim().min(2).max(500),
  locale: z.enum(['en', 'he']).default('en'),
  media_type: z.enum(['movie', 'tv']).nullish(),
});

const IntentSchema = z.object({
  search_text: z.string().min(1),
  genres: z.array(z.string()).max(6).default([]),
  media_type: z.enum(['movie', 'tv', 'any']).default('any'),
  max_runtime_minutes: z.number().int().positive().nullable().default(null),
  min_year: z.number().int().min(1900).max(2100).nullable().default(null),
  reply: z.string().min(1),
});
type Intent = z.infer<typeof IntentSchema>;

async function extractIntent(query: string, locale: 'en' | 'he'): Promise<Intent> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system:
        'You turn a viewer\'s mood description into structured search intent for a movie/TV recommendation engine. ' +
        '`search_text` must be a rich English sentence describing tone, pacing, themes, era and any named actors/directors — it is embedded and cosine-matched against plot embeddings. ' +
        '`reply` is one warm, short sentence to show the viewer, written in ' +
        (locale === 'he' ? 'Hebrew' : 'English') +
        '. Genres must come from the TMDB genre vocabulary (e.g. Comedy, Drama, Action, Science Fiction, Thriller, Romance, Animation, Crime, Documentary, Family, Fantasy, History, Horror, Music, Mystery, War, Western).',
      tool_choice: { type: 'tool', name: 'set_search_intent' },
      tools: [
        {
          name: 'set_search_intent',
          description: 'Record the structured search intent extracted from the mood query.',
          input_schema: {
            type: 'object',
            properties: {
              search_text: { type: 'string' },
              genres: { type: 'array', items: { type: 'string' } },
              media_type: { type: 'string', enum: ['movie', 'tv', 'any'] },
              max_runtime_minutes: { type: ['integer', 'null'] },
              min_year: { type: ['integer', 'null'] },
              reply: { type: 'string' },
            },
            required: ['search_text', 'genres', 'media_type', 'reply'],
          },
        },
      ],
      messages: [{ role: 'user', content: query }],
    }),
  });

  if (!res.ok) {
    throw new Error(`anthropic_error_${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const toolBlock = (data.content as Array<{ type: string; input?: unknown }>).find(
    (b) => b.type === 'tool_use',
  );
  if (!toolBlock) throw new Error('anthropic_no_tool_use');
  return IntentSchema.parse(toolBlock.input);
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`openai_error_${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const vector: number[] = data.data[0].embedding;
  if (vector.length !== EMBEDDING_DIM) throw new Error('embedding_dim_mismatch');
  return vector;
}

function parseVector(value: unknown): number[] | null {
  if (value == null) return null;
  const arr = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(arr) && arr.length === EMBEDDING_DIM ? (arr as number[]) : null;
}

function blendAndNormalize(query: number[], taste: number[] | null): number[] {
  const out = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const q = query[i];
    out[i] = taste ? (1 - TASTE_BLEND) * q + TASTE_BLEND * taste[i] : q;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] /= norm;
  return out;
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  try {
    const attestation = await verifyAppCheck(req);
    if (!attestation.ok) return jsonResponse({ error: attestation.error }, 403);

    const supabase = userClient(req);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'not_authenticated' }, 401);

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
    }
    const { query, locale, media_type } = parsed.data;

    const admin = adminClient();

    const { data: profile } = await admin
      .from('profiles')
      .select('is_premium')
      .eq('id', user.id)
      .single();

    if (!profile?.is_premium) {
      const limit = await checkRateLimit(
        admin,
        user.id,
        'mood-search',
        FREE_SEARCHES_PER_HOUR,
        3600,
      );
      if (!limit.allowed) {
        return jsonResponse(
          {
            error: 'rate_limited',
            retry_after_seconds: limit.retry_after_seconds,
            upgrade: true,
          },
          429,
        );
      }
    }

    await admin.from('mood_searches').insert({ user_id: user.id, query, locale });

    const intent = await extractIntent(query, locale);
    const queryVector = await embed(intent.search_text);

    const { data: taste } = await admin
      .from('taste_profiles')
      .select('embedding')
      .eq('user_id', user.id)
      .single();

    const finalVector = blendAndNormalize(queryVector, parseVector(taste?.embedding));

    const requestedType = media_type ?? (intent.media_type === 'any' ? null : intent.media_type);

    const { data: results, error: matchError } = await admin.rpc('match_media', {
      p_query_embedding: finalVector,
      p_match_count: 12,
      p_media_type: requestedType,
      p_genres: intent.genres.length > 0 ? intent.genres : null,
      p_max_runtime: intent.max_runtime_minutes,
      p_min_year: intent.min_year,
      p_user_id: user.id,
    });
    if (matchError) throw new Error(`match_media: ${matchError.message}`);

    return jsonResponse({
      reply: intent.reply,
      intent: {
        search_text: intent.search_text,
        genres: intent.genres,
        media_type: intent.media_type,
        max_runtime_minutes: intent.max_runtime_minutes,
        min_year: intent.min_year,
      },
      results: results ?? [],
    });
  } catch (err) {
    console.error('mood-search failed:', err);
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
