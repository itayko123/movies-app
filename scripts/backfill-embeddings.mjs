/**
 * Generates pgvector embeddings for every `media_items` row that lacks one.
 *
 *   node scripts/backfill-embeddings.mjs
 *   node scripts/backfill-embeddings.mjs --limit 200
 *   node scripts/backfill-embeddings.mjs --dry-run      (no OpenAI spend)
 *
 * ── Why a script and not the embed-media Edge Function ─────────────────────
 * `supabase/functions/embed-media` is the INCREMENTAL path: an authenticated
 * user hydrates new titles, the app fires the function, twenty rows get
 * embedded. Its limits are deliberate and correct for that job — App Check,
 * a signed-in user, and `check_rate_limit(user, 'embed-media', 10, 3600)`.
 *
 * Those same limits make it the wrong tool for a bulk backfill: 20 rows per
 * invocation × 10 invocations per hour is 200 rows/hour, so a few thousand
 * titles would take a day and would burn a real user's quota to do it. This
 * script talks to Postgres as the service role and to OpenAI directly, so the
 * catalogue loads in minutes. Both paths write the identical column.
 *
 * ── The embedding input MUST match the Edge Function byte for byte ─────────
 * `embeddingInput` below is a deliberate copy of the function of the same name
 * in `supabase/functions/embed-media/index.ts`. If the two drift, rows embedded
 * by the script and rows embedded by the Edge Function end up describing the
 * same title with different text, which puts them at different points in the
 * vector space — a silent, near-undebuggable retrieval bug. Change one, change
 * the other; both carry this warning.
 *
 * ── Resumable by construction ──────────────────────────────────────────────
 * The only rows selected are `embedding is null`. Kill the process at any
 * point and re-run: it picks up exactly where it stopped, and rows already
 * embedded are never re-sent (and never re-charged).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const out = {};
  let raw = '';
  try {
    raw = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    /* process.env only */
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { ...out, ...process.env };
}

const env = loadEnv();

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY = env.OPENAI_API_KEY;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const DRY_RUN = args.includes('--dry-run');
const LIMIT = flag('limit', null) ? Number(flag('limit', null)) : Infinity;

// text-embedding-3-small: 1536 dimensions. This is asserted, not assumed —
// media_items.embedding is vector(1536) and mood-search hard-checks the width,
// so a model swap that changed it would otherwise fail deep inside a batch.
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const BATCH = 96;
const USD_PER_1M_TOKENS = 0.02;

// `--check-key` is a preflight: it needs no database and embeds one short
// string, so a bad key, a wrong model name or a changed vector width surfaces
// in two seconds instead of part-way through a catalogue-sized run.
const CHECK_KEY = args.includes('--check-key');

if (!CHECK_KEY && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error(
    'missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Add SUPABASE_SERVICE_ROLE_KEY to .env (Dashboard → Settings → API).',
  );
  process.exit(1);
}
if (!OPENAI_KEY && !DRY_RUN) {
  console.error('missing OPENAI_API_KEY (present in .env for the mood engine).');
  process.exit(1);
}

// Not created in --check-key mode: that path deliberately needs no database,
// which is what makes it runnable before the migration has even been applied.
const supabase = CHECK_KEY
  ? null
  : createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

/**
 * ⚠️ KEEP IN SYNC with supabase/functions/embed-media/index.ts → embeddingInput.
 * See the header note. This is a verbatim copy, not a reimplementation.
 */
function embeddingInput(item) {
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

async function embed(inputs) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
    });
    if (res.status === 429 || res.status >= 500) {
      // A 429 is two completely different failures wearing the same status
      // code: "you are going too fast" (retry, it will pass) and
      // "insufficient_quota" (a billing state — retrying is pointless and
      // just buries the real cause under five backoffs). Read the body and
      // tell them apart, or this script spends 31 seconds hiding the answer.
      const body = await res.text();
      let code = '';
      try {
        code = JSON.parse(body)?.error?.code ?? '';
      } catch {
        /* non-JSON body; fall through to the retry path */
      }
      if (code === 'insufficient_quota') {
        throw new Error(
          'OpenAI rejected the request with `insufficient_quota`.\n' +
            'The API key is valid but the account has no usable credit — this is\n' +
            'a billing state, not a rate limit, so retrying cannot fix it.\n' +
            'Add credit at platform.openai.com/settings/organization/billing.',
        );
      }
      const wait = 2 ** attempt * 1000;
      console.log(`      | ${res.status} from OpenAI (${code || 'rate limit'}), retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('openai: retries exhausted');
}

async function coverage() {
  const total = await supabase.from('media_items').select('*', { count: 'exact', head: true });
  const done = await supabase
    .from('media_items')
    .select('*', { count: 'exact', head: true })
    .not('embedding', 'is', null);
  return { total: total.count ?? 0, embedded: done.count ?? 0 };
}

async function main() {
  if (CHECK_KEY) {
    const probe = {
      title: 'Preflight',
      original_title: null,
      overview: 'A short string used only to validate the embedding endpoint.',
      media_type: 'movie',
      genres: ['Drama'],
      release_year: 2026,
    };
    const payload = await embed([embeddingInput(probe)]);
    const dims = payload.data[0].embedding.length;
    const used = payload.usage?.total_tokens ?? 0;
    console.log(`model      : ${EMBEDDING_MODEL}`);
    console.log(`dimensions : ${dims}${dims === EMBEDDING_DIM ? ' ✓' : ' ✗ MISMATCH'}`);
    console.log(`tokens     : ${used}`);
    console.log(`cost       : $${((used / 1e6) * USD_PER_1M_TOKENS).toFixed(8)}`);
    if (dims !== EMBEDDING_DIM) {
      console.error(
        `\nmedia_items.embedding is vector(${EMBEDDING_DIM}). This model returns ` +
          `${dims}. Backfilling would fail on every row.`,
      );
      process.exit(1);
    }
    console.log('\nkey valid, model correct, width matches the column. Safe to backfill.');
    return;
  }

  const before = await coverage();
  if (before.total === 0) {
    console.error(
      'media_items is empty — nothing to embed.\n' +
        'Run the catalogue loader first: node scripts/populate-catalogue.mjs',
    );
    process.exit(1);
  }
  console.log(
    `start: ${before.embedded}/${before.total} embedded ` +
      `(${((before.embedded / before.total) * 100).toFixed(1)}%)`,
  );

  let embedded = 0;
  let failed = 0;
  let tokens = 0;

  for (;;) {
    if (embedded >= LIMIT) break;
    const take = Math.min(BATCH, LIMIT - embedded);

    const { data: pending, error } = await supabase
      .from('media_items')
      .select('id, title, original_title, overview, media_type, genres, release_year')
      .is('embedding', null)
      // Most-popular-first so that if the run is interrupted, what got done is
      // the part users are most likely to search for.
      .order('popularity', { ascending: false, nullsFirst: false })
      .limit(take);
    if (error) throw new Error(error.message);
    if (!pending || pending.length === 0) break;

    if (DRY_RUN) {
      console.log(`[DRY RUN] would embed ${pending.length} rows. First input:`);
      console.log(embeddingInput(pending[0]));
      break;
    }

    const payload = await embed(pending.map(embeddingInput));
    tokens += payload.usage?.total_tokens ?? 0;

    // Update concurrently but bounded — PostgREST is happy with this and it
    // turns a serial 96-round-trip crawl into about a second.
    const queue = payload.data.map((entry) => ({ entry, item: pending[entry.index] }));
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const job = queue.pop();
        if (!job) return;
        const { entry, item } = job;
        if (!item) continue;
        if (entry.embedding.length !== EMBEDDING_DIM) {
          console.error(
            `FAIL  | ${item.title}: got ${entry.embedding.length} dims, ` +
              `column is vector(${EMBEDDING_DIM})`,
          );
          failed += 1;
          continue;
        }
        const { error: updateError } = await supabase
          .from('media_items')
          .update({ embedding: entry.embedding })
          .eq('id', item.id);
        if (updateError) {
          console.error(`FAIL  | ${item.title}: ${updateError.message}`);
          failed += 1;
        } else {
          embedded += 1;
        }
      }
    });
    await Promise.all(workers);

    console.log(
      `ok    | +${pending.length}  total embedded this run: ${embedded}` +
        (failed ? `  (${failed} failed)` : ''),
    );
  }

  const after = await coverage();
  const pct = after.total ? (after.embedded / after.total) * 100 : 0;

  console.log('\n── coverage ────────────────────────────────────────────');
  console.log(`rows in media_items : ${after.total}`);
  console.log(`with an embedding   : ${after.embedded}`);
  console.log(`without             : ${after.total - after.embedded}`);
  console.log(`coverage            : ${pct.toFixed(2)}%`);
  if (!DRY_RUN) {
    console.log(`tokens this run     : ${tokens}`);
    console.log(`cost this run       : $${((tokens / 1e6) * USD_PER_1M_TOKENS).toFixed(4)}`);
  }
  if (failed) console.log(`failed              : ${failed}`);
  console.log('────────────────────────────────────────────────────────');

  // A non-zero exit on incomplete coverage makes this usable as a CI gate
  // later without rewriting it.
  if (after.embedded < after.total) {
    console.log('incomplete — re-run to continue (safe, resumable).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
