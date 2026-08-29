/**
 * Regression suite for the bilingual profanity filter.
 *
 *   npm run check:profanity
 *
 * Both halves matter equally. The SHOULD PASS list is not padding — a filter
 * that blocks "a masterclass in tension" or a review of Dick Van Dyke is worse
 * than no filter, because the author is given no usable reason and simply
 * loses their review. Every entry there is a real false positive that this
 * suite caught during development.
 *
 * Transpiles the TS source in-memory (typescript is already a devDependency)
 * so there is no test-runner dependency to install.
 */
import { readFileSync } from 'fs';
import ts from 'typescript';
const src = readFileSync('src/lib/profanity.ts', 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = await import('data:text/javascript;charset=utf-8;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const { checkProfanity } = mod;

const shouldBlock = [
  'this movie is fucking terrible','what a piece of shit','f.u.c.k this','fuuuuuck me',
  'sh1t movie','you are an @sshole','b i t c h','הסרט הזה חרא','איזה שרמוטה','בן זונה של סרט',
  // Stacked Hebrew prefixes: ו + ה. Regression for a miss the SQL assertion
  // suite caught, present in this client filter too.
  'והשרמוטה הזאת','שהזונה הזאת',
  'הזין הזה','FUCK','MoThErFuCkEr',
];
const shouldPass = [
  'a masterclass in tension','Scunthorpe is in England','the grass was greener',
  'he assesses the situation','a hell of a performance','damn good film',
  'this analysis is thorough','classic cinema','passable but forgettable',
  'סרט מצוין ומרגש','הסדרה הזאת פשוט מדהימה','בסך הכל סרט טוב','המשחק של השחקנים היה חזק',
  'cocktail hour','Dick Van Dyke was great','Titanic','assassin',
];
let fails = 0;
console.log('--- SHOULD BLOCK ---');
for (const s of shouldBlock) { const r = checkProfanity(s); const ok = !r.clean; if(!ok) fails++; console.log((ok?'ok    ':'MISS  ')+'| '+s+(ok?'   ['+r.matches.join(',')+']':'')); }
console.log('--- SHOULD PASS ---');
for (const s of shouldPass) { const r = checkProfanity(s); const ok = r.clean; if(!ok) fails++; console.log((ok?'ok    ':'FALSE+')+'| '+s+(ok?'':'   <-- blocked by ['+r.matches.join(',')+']')); }
console.log('\nfailures: '+fails);
