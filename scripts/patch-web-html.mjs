/**
 * Post-export patch for the web HTML shell.
 *
 *   node scripts/patch-web-html.mjs
 *
 * ── Why this exists rather than app/+html.tsx ──────────────────────────────
 * Expo Router's `+html.tsx` shell override only applies to STATIC rendering
 * (`web.output: 'static'`). This app builds as an SPA (`output: 'single'`),
 * where Expo emits a fixed built-in template and ignores `+html.tsx` entirely
 * — verified by adding the file, exporting with a cleared cache, and finding
 * the viewport tag unchanged.
 *
 * Switching to static rendering to gain the hook would mean server-rendering
 * every route, which this app is not prepared for: plenty of modules touch
 * browser/native globals at import time. Patching the one tag we need is the
 * smaller, safer change.
 *
 * ── What it fixes ─────────────────────────────────────────────────────────
 * Expo's default viewport omits `viewport-fit=cover`. Without it iOS Safari
 * reports every `env(safe-area-inset-*)` as 0, and 18 screens here read those
 * insets via react-native-safe-area-context — so the tab bar sits under the
 * home indicator, and in landscape or an added-to-home-screen launch the
 * layout runs under the notch.
 *
 * Idempotent: re-running on an already-patched file changes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'dist', 'index.html');

let html;
try {
  html = readFileSync(file, 'utf8');
} catch {
  console.error('patch-web-html: dist/index.html not found — run `expo export --platform web` first.');
  process.exit(1);
}

const VIEWPORT = /<meta\s+name="viewport"\s+content="([^"]*)"\s*\/?>/i;
const match = html.match(VIEWPORT);

if (!match) {
  // Fail loudly. Silently shipping without the tag is the bug this prevents.
  console.error('patch-web-html: no <meta name="viewport"> found — Expo changed its template.');
  process.exit(1);
}

if (match[1].includes('viewport-fit=cover')) {
  console.log('patch-web-html: already patched, nothing to do');
} else {
  const patched = html.replace(
    VIEWPORT,
    `<meta name="viewport" content="${match[1]}, viewport-fit=cover" />`,
  );
  writeFileSync(file, patched, 'utf8');
  console.log('patch-web-html: added viewport-fit=cover');
}
