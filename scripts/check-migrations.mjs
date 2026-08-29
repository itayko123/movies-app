/**
 * Proves that `npx supabase db push` will succeed BEFORE it touches production.
 *
 *   npm run check:migrations
 *
 * `npm run check:schema` validates `supabase_schema.sql` — the repo's canonical
 * description of the database. That is not the same artefact `db push` applies.
 * Push replays the files in `supabase/migrations/` in version order, and a file
 * can be individually correct yet fail in sequence: a policy created without a
 * drop guard, a function that depends on a table an earlier migration did not
 * create, an enum referenced before it exists.
 *
 * This harness replays the real chain on PGlite and then exercises the
 * behaviour the two pending Phase 6 migrations are supposed to deliver.
 *
 * ── Scope, stated honestly ────────────────────────────────────────────────
 * `20260816140000_mood_foundation.sql` is SKIPPED. It requires pgvector and
 * PGlite does not ship it (33 contrib extensions, `vector` is not among them).
 * That migration was validated against real PostgreSQL 17 with pgvector 0.8.2
 * inside a rolled-back transaction during Phase 7 Step 1. Everything else in
 * the chain runs here for real.
 */
import { PGlite } from '@electric-sql/pglite';
// The baseline does `create extension if not exists pgcrypto` for
// gen_random_uuid(). PGlite ships pgcrypto as a loadable contrib but does not
// enable it by default, so it has to be handed to the constructor.
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

// Anything that needs an extension PGlite cannot load is listed here rather
// than silently filtered, so the gap is visible in the output.
const SKIP = new Set(['20260816140000_mood_foundation.sql']);

const db = await PGlite.create({ extensions: { pgcrypto } });
let failures = 0;
let passes = 0;

async function step(label, sql) {
  try {
    await db.exec(sql);
    console.log(`ok    | ${label}`);
    passes++;
  } catch (err) {
    console.log(`FAIL  | ${label}\n        ${err.message}`);
    failures++;
  }
}

console.log('── replaying supabase/migrations/ in version order ──────────\n');

await step('harness: roles, auth schema, auth.uid(), realtime publication',
  read('supabase', 'tests', 'harness.sql'));

const files = readdirSync(join(root, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const applied = [];
for (const file of files) {
  if (SKIP.has(file)) {
    console.log(`skip  | ${file}  (needs pgvector — validated on real PG17 instead)`);
    continue;
  }
  await step(`${file} applies`, read('supabase', 'migrations', file));
  applied.push(file);
}

// The property that matters for recovery: a push that dies half way through
// must be safe to run again. Replaying the whole chain is how we prove it.
console.log('');
for (const file of applied) {
  await step(`${file} is idempotent (applied twice)`, read('supabase', 'migrations', file));
}

if (failures > 0) {
  console.log(`\nchain did not apply cleanly — ${failures} failure(s). Stopping.`);
  process.exit(1);
}

console.log('\n── behaviour of the pending migrations ──────────────────────\n');

// psql-style `\echo 'PASS ...'` lines delimit chunks and label everything
// executed since the previous one — same convention as rls.sql.
const suite = read('supabase', 'tests', 'migrations.sql');
let buf = [];
for (const line of suite.split(/\r?\n/)) {
  const echo = line.match(/^\\echo\s+'(.*)'\s*$/);
  if (!echo) {
    buf.push(line);
    continue;
  }
  const label = echo[1].replace(/''/g, "'").replace(/^PASS\s+/, '');
  const sql = buf.join('\n').trim();
  buf = [];
  if (!sql) continue;
  try {
    await db.exec(sql);
    console.log(`ok    | ${label}`);
    passes++;
  } catch (err) {
    console.log(`FAIL  | ${label}\n        ${err.message}`);
    failures++;
  }
}

console.log(`\nfailures: ${failures}  (${passes} checks passed)`);
if (failures === 0) {
  console.log('\n`npx supabase db push` is safe to run.');
}
process.exit(failures === 0 ? 0 : 1);
