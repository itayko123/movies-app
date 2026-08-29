// Backfills pgvector embeddings for media_items rows that don't have one yet.
// Triggered fire-and-forget by the app after hydrating new TMDB rows, and
// safe to run from a schedule. Batched to 20 items per invocation.

import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { verifyAppCheck } from '../_shared/appCheck.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { adminClient, userClient } from '../_shared/clients.ts';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 20;

interface PendingItem {
  id: string;
  title: string;
  original_title: string | null;
  overview: string | null;
  media_type: 'movie' | 'tv';
  genres: string[];
  release_year: number | null;
}

/**
 * ⚠️ KEEP IN SYNC with scripts/backfill-embeddings.mjs → embeddingInput.
 *
 * Two paths write `media_items.embedding`: this function (the incremental
 * path, twenty rows at a time behind App Check and a rate limit) and the bulk
 * backfill script (the service-role path used to load the catalogue). If the
 * two build their input text differently, the same title gets embedded at a
 * different point in the vector space depending on which path happened to
 * reach it — a silent retrieval bug with no error and no log line. Change one,
 * change the other.
 */
function embeddingInput(item: PendingItem): string {
  const parts = [
    `${item.title}${item.release_year ? ` (${item.release_year})` : ''}`,
    item.media_type === 'tv' ? 'Television series.' : 'Feature film.',
    item.genres.length > 0 ? `Genres: ${item.genres.join(', ')}.` : '',
    item.overview ?? '',
  ];
  if (item.original_title && item.original_title !== item.title) {
    parts.push(`Original title: ${item.original_title}.`);
  }
  return parts.filter(Boolean).join(' ').slice(0, 6000);
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

    const admin = adminClient();

    const limit = await checkRateLimit(admin, user.id, 'embed-media', 10, 3600);
    if (!limit.allowed) {
      return jsonResponse(
        { error: 'rate_limited', retry_after_seconds: limit.retry_after_seconds },
        429,
      );
    }

    const { data: pending, error: pendingError } = await admin
      .from('media_items')
      .select('id, title, original_title, overview, media_type, genres, release_year')
      .is('embedding', null)
      .order('popularity', { ascending: false, nullsFirst: false })
      .limit(BATCH_SIZE);
    if (pendingError) throw new Error(pendingError.message);

    const items = (pending ?? []) as PendingItem[];
    if (items.length === 0) return jsonResponse({ embedded: 0 });

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: items.map(embeddingInput),
      }),
    });
    if (!res.ok) throw new Error(`openai_error_${res.status}: ${await res.text()}`);

    const data = await res.json();
    const embeddings: Array<{ index: number; embedding: number[] }> = data.data;

    let embedded = 0;
    for (const entry of embeddings) {
      const item = items[entry.index];
      if (!item) continue;
      const { error: updateError } = await admin
        .from('media_items')
        .update({ embedding: entry.embedding })
        .eq('id', item.id);
      if (!updateError) embedded += 1;
    }

    return jsonResponse({ embedded });
  } catch (err) {
    console.error('embed-media failed:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
});
