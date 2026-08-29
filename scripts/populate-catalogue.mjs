/**
 * Fills `public.media_items` from TMDB.
 *
 *   node scripts/populate-catalogue.mjs --pages 5
 *   node scripts/populate-catalogue.mjs --pages 5 --dry-run
 *   node scripts/populate-catalogue.mjs --pages 5 --enrich-runtime
 *
 * ── Why this script has to exist ───────────────────────────────────────────
 * Nothing else populates `media_items`. The app used to push every fetched
 * page through an `upsert_media_items` RPC, but that call site was deleted in
 * the Run-4 cleanup (see the comments at `src/hooks/useSwipeDeck.ts:359` and
 * `:862`) and the deck has keyed on `(media_id, media_type)` ever since. That
 * was the right call for the deck — it removed a server round trip from the
 * swipe path — but it left `media_items` with no writer at all. Mood Mode is
 * the first feature that reads the table, so the catalogue has to be loaded
 * deliberately rather than as a side effect of browsing.
 *
 * ── Language: deliberately en-US, and this is a real trade-off ─────────────
 * The rows are fetched in ENGLISH even though the app is Hebrew-first, because
 * `mood-search` translates a Hebrew query to English before embedding it (see
 * the prompt work in the mood engine). Embedding English documents against an
 * English query keeps both sides in one semantic space; storing Hebrew
 * overviews here would mean querying a Hebrew corpus with English vectors,
 * which is exactly the cross-lingual mismatch that degrades cosine search.
 *
 * The cost is that `media_items.title` is the English title, so a Hebrew user's
 * mood RESULTS would render in English unless the client re-resolves the
 * display name. It can: `fetchTitleName(tmdb_id, media_type, 'he')` already
 * exists in `src/lib/tmdb.ts`. Wiring that into the results list belongs to the
 * UI step, and is flagged rather than silently accepted.
 *
 * ── Idempotent and resumable ───────────────────────────────────────────────
 * Every write is an upsert on the natural key `(tmdb_id, media_type)`, so
 * re-running widens the catalogue instead of duplicating it, and a crash
 * halfway through costs nothing but the requests already spent.
 *
 * `embedding` is never touched here. Populate and embed are separate passes on
 * purpose: re-running populate must not invalidate embeddings that already
 * exist, and `backfill-embeddings.mjs` finds new rows by `embedding is null`.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── env ────────────────────────────────────────────────────────────────────
// Read .env directly rather than depending on a loader: this is an ops script
// run from a shell, not part of the Metro bundle.
function loadEnv() {
  const out = {};
  let raw = '';
  try {
    raw = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    /* fall through to process.env only */
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { ...out, ...process.env };
}

const env = loadEnv();

const TMDB_TOKEN = env.EXPO_PUBLIC_TMDB_TOKEN;
const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const PAGES = Number(flag('pages', 5));
const DRY_RUN = has('dry-run');
const ENRICH_RUNTIME = has('enrich-runtime');

if (!TMDB_TOKEN) {
  console.error('missing EXPO_PUBLIC_TMDB_TOKEN');
  process.exit(1);
}
if (!DRY_RUN && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error(
    'missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'media_items has no client INSERT policy by design, so the catalogue\n' +
      'loader must authenticate as the service role. Add the key to .env:\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=...   (Dashboard → Settings → API)\n' +
      'Re-run with --dry-run to exercise the TMDB half without it.',
  );
  process.exit(1);
}

// ── TMDB ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://api.themoviedb.org/3';

async function tmdb(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${TMDB_TOKEN}`, Accept: 'application/json' },
    });
    // 429 is normal at this request volume; TMDB tells us how long to wait.
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 1) * 1000 + 250;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`TMDB ${path} -> ${res.status}`);
    return res.json();
  }
  throw new Error(`TMDB ${path} -> rate limited after 4 attempts`);
}

/**
 * Genre id → name, straight from TMDB rather than from a hardcoded copy.
 * `GENRE_CATALOG` in src/lib/tmdb.ts is a curated *selection* for onboarding,
 * not the full list — using it here would silently drop genres from rows.
 */
async function genreMaps() {
  const [movie, tv] = await Promise.all([
    tmdb('/genre/movie/list', { language: 'en-US' }),
    tmdb('/genre/tv/list', { language: 'en-US' }),
  ]);
  const toMap = (list) => new Map(list.genres.map((g) => [g.id, g.name]));
  return { movie: toMap(movie), tv: toMap(tv) };
}

const year = (s) => {
  const y = Number(String(s ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1870 ? y : null;
};

function toRow(raw, mediaType, genres) {
  const title = mediaType === 'tv' ? raw.name : raw.title;
  const original = mediaType === 'tv' ? raw.original_name : raw.original_title;
  if (!raw.id || !title) return null;
  return {
    tmdb_id: raw.id,
    media_type: mediaType,
    title,
    original_title: original ?? null,
    overview: raw.overview?.trim() ? raw.overview.trim() : null,
    poster_path: raw.poster_path ?? null,
    backdrop_path: raw.backdrop_path ?? null,
    genres: (raw.genre_ids ?? []).map((id) => genres.get(id)).filter(Boolean),
    // List endpoints never carry runtime. Left null unless --enrich-runtime.
    runtime_minutes: null,
    release_year: year(mediaType === 'tv' ? raw.first_air_date : raw.release_date),
    vote_average: typeof raw.vote_average === 'number' ? raw.vote_average : null,
    popularity: typeof raw.popularity === 'number' ? raw.popularity : null,
    origin_country: raw.origin_country ?? [],
  };
}

/**
 * What we load, and why this shape.
 *
 * The catalogue has to cover what a user can plausibly be recommended, which
 * is broader than what the deck happens to show. Trending and popular give
 * current relevance; top-rated gives depth the popularity sort would never
 * reach; the Hebrew-language discover pass is there because an Israeli-first
 * app whose semantic index contains no Israeli titles cannot return one.
 */
const SOURCES = [
  { label: 'trending movies', path: '/trending/movie/week', type: 'movie' },
  { label: 'trending tv', path: '/trending/tv/week', type: 'tv' },
  { label: 'popular movies', path: '/movie/popular', type: 'movie' },
  { label: 'popular tv', path: '/tv/popular', type: 'tv' },
  { label: 'top rated movies', path: '/movie/top_rated', type: 'movie' },
  { label: 'top rated tv', path: '/tv/top_rated', type: 'tv' },
  {
    label: 'israeli movies',
    path: '/discover/movie',
    type: 'movie',
    params: { with_original_language: 'he', sort_by: 'popularity.desc' },
  },
  {
    label: 'israeli tv',
    path: '/discover/tv',
    type: 'tv',
    params: { with_original_language: 'he', sort_by: 'popularity.desc' },
  },
];

async function main() {
  console.log(`TMDB → media_items   pages=${PAGES}${DRY_RUN ? '   [DRY RUN]' : ''}`);
  const genres = await genreMaps();

  // Deduped in memory before any write: the same title legitimately appears in
  // trending and popular, and one upsert per unique key beats eight.
  const seen = new Map();

  for (const source of SOURCES) {
    let added = 0;
    for (let page = 1; page <= PAGES; page += 1) {
      let payload;
      try {
        payload = await tmdb(source.path, {
          language: 'en-US',
          page,
          ...(source.params ?? {}),
        });
      } catch (err) {
        console.log(`warn  | ${source.label} p${page}: ${err.message}`);
        break;
      }
      const results = payload.results ?? [];
      if (results.length === 0) break;
      for (const raw of results) {
        const row = toRow(raw, source.type, genres[source.type]);
        if (!row) continue;
        const key = `${row.media_type}:${row.tmdb_id}`;
        if (!seen.has(key)) {
          seen.set(key, row);
          added += 1;
        }
      }
      if (page >= (payload.total_pages ?? 1)) break;
    }
    console.log(`ok    | ${source.label.padEnd(18)} +${added} new`);
  }

  const rows = [...seen.values()];
  console.log(`\n${rows.length} unique titles collected`);

  if (ENRICH_RUNTIME) {
    // One detail request per title. At ~1400 titles this is ~1400 requests and
    // a few minutes. Worth it: without runtime, match_media's `p_max_runtime`
    // filter passes every row (it treats null as "unknown, do not exclude"),
    // so a "something short" query silently returns three-hour films.
    console.log('enriching runtime (1 request per title)...');
    let done = 0;
    const queue = [...rows];
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const row = queue.pop();
        if (!row) return;
        try {
          const detail = await tmdb(`/${row.media_type}/${row.tmdb_id}`, { language: 'en-US' });
          const minutes =
            row.media_type === 'tv'
              ? (detail.episode_run_time ?? []).find((n) => n > 0) ?? null
              : detail.runtime ?? null;
          row.runtime_minutes = minutes && minutes > 0 ? minutes : null;
        } catch {
          /* leave null */
        }
        done += 1;
        if (done % 200 === 0) console.log(`      | runtime ${done}/${rows.length}`);
      }
    });
    await Promise.all(workers);
    const withRuntime = rows.filter((r) => r.runtime_minutes != null).length;
    console.log(`ok    | runtime resolved for ${withRuntime}/${rows.length}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] nothing written. Sample row:');
    console.log(JSON.stringify(rows[0], null, 2));
    return;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase
      .from('media_items')
      .upsert(chunk, { onConflict: 'tmdb_id,media_type', ignoreDuplicates: false });
    if (error) {
      console.error(`FAIL  | upsert at offset ${i}: ${error.message}`);
      process.exit(1);
    }
    written += chunk.length;
    console.log(`ok    | upserted ${written}/${rows.length}`);
  }

  const { count } = await supabase
    .from('media_items')
    .select('*', { count: 'exact', head: true });
  console.log(`\ndone. media_items now holds ${count} rows.`);
  console.log('next: node scripts/backfill-embeddings.mjs');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
