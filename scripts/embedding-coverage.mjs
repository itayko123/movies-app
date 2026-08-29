/**
 * Measures how much of the catalogue is actually searchable by Mood Mode.
 *
 *   node scripts/embedding-coverage.mjs
 *
 * Reports the headline percentage and then breaks it down, because a single
 * number hides the failure that matters. A row with no overview still embeds
 * "successfully" — it just embeds a title and a genre list, which is far
 * thinner signal than a real synopsis. Counting it as covered would overstate
 * how well semantic search will actually work, so it is reported separately.
 *
 * Read-only. Safe to run against production at any time.
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

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const count = async (build) => {
  const { count: n, error } = await build(
    supabase.from('media_items').select('*', { count: 'exact', head: true }),
  );
  if (error) throw new Error(error.message);
  return n ?? 0;
};

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : '0.00');
const row = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);

const total = await count((q) => q);

if (total === 0) {
  console.log('media_items is empty. Run: node scripts/populate-catalogue.mjs');
  process.exit(0);
}

const embedded = await count((q) => q.not('embedding', 'is', null));
const movies = await count((q) => q.eq('media_type', 'movie'));
const moviesEmbedded = await count((q) =>
  q.eq('media_type', 'movie').not('embedding', 'is', null),
);
const tv = await count((q) => q.eq('media_type', 'tv'));
const tvEmbedded = await count((q) => q.eq('media_type', 'tv').not('embedding', 'is', null));
const noOverview = await count((q) => q.is('overview', null));
const noOverviewEmbedded = await count((q) =>
  q.is('overview', null).not('embedding', 'is', null),
);
const withRuntime = await count((q) => q.not('runtime_minutes', 'is', null));

console.log('\n══ Mood Mode catalogue coverage ═══════════════════════════');
console.log('\nHeadline');
row('rows in media_items', total);
row('with an embedding', `${embedded}  (${pct(embedded, total)}%)`);
row('awaiting an embedding', total - embedded);

console.log('\nBy media type');
row('movies embedded', `${moviesEmbedded}/${movies}  (${pct(moviesEmbedded, movies)}%)`);
row('tv embedded', `${tvEmbedded}/${tv}  (${pct(tvEmbedded, tv)}%)`);

console.log('\nQuality of what is embedded');
row('embedded WITHOUT an overview', `${noOverviewEmbedded}  (thin signal)`);
row(
  'embedded WITH an overview',
  `${embedded - noOverviewEmbedded}  (${pct(embedded - noOverviewEmbedded, total)}% of catalogue)`,
);
row('rows missing an overview', noOverview);

console.log('\nFilter readiness');
row(
  'rows with runtime_minutes',
  `${withRuntime}/${total}  (${pct(withRuntime, total)}%)`,
);
if (withRuntime < total) {
  console.log(
    '\n  note: match_media treats a null runtime as "do not exclude", so a\n' +
      '  "something short" query will still return long titles for the rows\n' +
      '  above. Fill them with: node scripts/populate-catalogue.mjs --enrich-runtime',
  );
}

console.log('\n═══════════════════════════════════════════════════════════\n');
