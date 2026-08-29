/**
 * Applies supabase_schema.sql to a real PostgreSQL and asserts its behaviour.
 *
 *   npm run check:schema
 *
 * Uses PGlite (Postgres compiled to WASM) rather than Docker or a hosted
 * project, so the suite runs anywhere with no daemon, no container and no
 * cloud credentials — and it cannot touch a real database by accident.
 *
 * What it proves, in order:
 *   1. the file applies cleanly, and is idempotent (applied twice, no error);
 *   2. RLS actually denies cross-user reads, inserts, updates and deletes —
 *      asserted by switching Postgres roles and JWT claims for real, not by
 *      reading the policy text;
 *   3. the same holds when the table owner is NOT a superuser, which is the
 *      case on a hosted Supabase project and the case a local superuser-based
 *      test silently hides. See supabase/tests/owner.sql.
 *
 * NOTE ON VERSION: PGlite tracks a recent PostgreSQL (18.x at time of writing)
 * while Supabase currently serves 17.x. Nothing in the schema uses a version
 * specific feature, but this is a near-match, not the identical engine.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const db = await PGlite.create();

let failures = 0;
let passes = 0;

async function setup(label, sql) {
  try {
    await db.exec(sql);
    console.log(`ok    | ${label}`);
  } catch (err) {
    console.log(`FAIL  | ${label}\n        ${err.message}`);
    process.exit(1);
  }
}

await setup('harness: roles, auth schema, auth.uid(), realtime publication',
  read('supabase', 'tests', 'harness.sql'));
await setup('supabase_schema.sql applies', read('supabase_schema.sql'));
await setup('supabase_schema.sql is idempotent (applied twice)', read('supabase_schema.sql'));
console.log('');

// Chunks are delimited by psql-style `\echo 'PASS ...'` lines, which double as
// the label for everything executed since the previous one.
const suite = [
  read('supabase', 'tests', 'rls.sql'),
  read('supabase', 'tests', 'owner.sql'),
].join('\n');

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

const trailing = buf.join('\n').trim();
if (trailing) await db.exec(trailing);

console.log(`\nfailures: ${failures}  (${passes} checks passed)`);
process.exit(failures === 0 ? 0 : 1);
