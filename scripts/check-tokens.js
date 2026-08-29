/**
 * Guards two invariants of the "Cinematic Midnight" design system:
 *
 *  1. The palette mirror in tailwind.config.js matches src/theme/tokens.ts.
 *  2. No solid borders creep back into the UI. The design separates surfaces
 *     with contrast/blur/shadow; a `borderWidth` or `border-*` class is a
 *     regression, so this fails the build on sight.
 *
 * Run: node scripts/check-tokens.js   (exits 1 on drift or on a stray border)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const tokens = fs.readFileSync(path.join(root, 'src', 'theme', 'tokens.ts'), 'utf8');
const tw = fs.readFileSync(path.join(root, 'tailwind.config.js'), 'utf8');

const pick = (name) => {
  const m = tokens.match(new RegExp(`\\b${name}:\\s*'([^']+)'`));
  if (!m) throw new Error(`tokens.ts missing ${name}`);
  return m[1];
};

let failed = false;

// ---- 1. palette mirror ----------------------------------------------------
const mirrored = {
  bg: pick('bg'),
  surface: pick('surface'),
  surfaceRaised: pick('surfaceRaised'),
  accent: pick('accent'),
  secondary: pick('secondary'),
  nope: pick('nope'),
  like: pick('like'),
  olive: pick('olive'),
  super: pick('super'),
  text: pick('text'),
  textSecondary: pick('textSecondary'),
};

for (const [name, value] of Object.entries(mirrored)) {
  if (!tw.includes(value)) {
    console.error(`DRIFT: tokens.ts ${name}=${value} not found in tailwind.config.js`);
    failed = true;
  }
}

// ---- 2. no solid borders --------------------------------------------------
// `borderRadius` / `borderTopLeftRadius` etc. are fine — only stroke props and
// border utility classes are banned.
const BORDER_PATTERN =
  String.raw`(borderWidth|borderTopWidth|borderBottomWidth|borderStartWidth|borderEndWidth|borderLeftWidth|borderRightWidth|borderColor)` +
  String.raw`|className="[^"]*\bborder(-[a-z0-9/\[\]-]+)?\b`;

let hits = '';
try {
  hits = execSync(
    // --untracked is load-bearing: plain `git grep` searches only files in
    // the index, and this project currently has 42 untracked .tsx against 19
    // tracked, so without it the guard was checking under a third of the UI.
    // Every component added since the design system landed was exempt.
    `git grep -nE --untracked "${BORDER_PATTERN}" -- "app/*.tsx" "app/**/*.tsx" "src/**/*.tsx" "src/**/*.ts"`,
    { cwd: root, encoding: 'utf8' },
  );
} catch {
  // git grep exits 1 when there are no matches — that is the success case.
}

// StyleSheet.hairlineWidth dividers between list items are content separators,
// not box borders, and are allowed where explicitly annotated.
const allowed = hits
  .split('\n')
  .filter(Boolean)
  .filter((line) => !/allow-border/.test(line))
  // Comment lines are prose ABOUT the rule, not a use of it. The ban is
  // documented in several files, and a guard that flags its own explanation
  // is noise that teaches people to ignore it.
  .filter((line) => {
    const code = line.split(':').slice(2).join(':').trim();
    return !code.startsWith('*') && !code.startsWith('//') && !code.startsWith('/*');
  });

if (allowed.length > 0) {
  console.error('SOLID BORDERS FOUND (Cinematic Midnight forbids them):');
  for (const line of allowed) console.error('  ' + line);
  console.error('Use surface contrast, blur or shadow instead, or annotate');
  console.error('the line with `allow-border` if it is a content divider.');
  failed = true;
}

if (failed) process.exit(1);
console.log('tokens mirror OK; no solid borders.');
