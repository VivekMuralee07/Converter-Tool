// Offline English dictionary built on Princeton WordNet (see dict/WORDNET-LICENSE.txt, scripts/build-dict.py).
// Words are stored in small files by their first two letters (dict/ru.json ...), so a lookup fetches one tiny file.
// Inflected forms (running, children, happier ...) are traced back to their base word.

const BASE = new URL('./dict/', import.meta.url);
export const POS_NAME = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };

const shards = new Map();           // two-letter key -> Promise<{ lemma: senses }>
export function shardKey(lemma) {
  const ok = (c) => c && /^[a-z]$/.test(c);
  return (ok(lemma[0]) ? lemma[0] : '_') + (ok(lemma[1]) ? lemma[1] : '_');
}
function loadShard(key) {
  if (!shards.has(key)) {
    shards.set(key, fetch(new URL(`${key}.json`, BASE)).then((r) => (r.ok ? r.json() : {})).catch(() => { shards.delete(key); throw new Error('Could not load the dictionary. Check your connection and try again.'); }));
    if (shards.size > 40) shards.delete(shards.keys().next().value); // keep memory small
  }
  return shards.get(key);
}
async function entry(lemma) { const s = await loadShard(shardKey(lemma)); return Object.prototype.hasOwnProperty.call(s, lemma) ? s[lemma] : null; }

/* ---------- inflected forms -> base words ---------- */
const IRREGULAR = {};
const irr = (base, forms) => forms.split(' ').forEach((f) => ((IRREGULAR[f] ||= []).push(base)));
irr('be', 'am is are was were been being'); irr('have', 'has had having'); irr('do', 'does did done doing'); irr('go', 'goes went gone going');
irr('say', 'said'); irr('make', 'made'); irr('take', 'took taken'); irr('come', 'came'); irr('see', 'saw seen'); irr('know', 'knew known'); irr('get', 'got gotten');
irr('give', 'gave given'); irr('find', 'found'); irr('think', 'thought'); irr('tell', 'told'); irr('become', 'became'); irr('leave', 'left'); irr('feel', 'felt');
irr('bring', 'brought'); irr('begin', 'began begun'); irr('keep', 'kept'); irr('hold', 'held'); irr('write', 'wrote written'); irr('stand', 'stood'); irr('hear', 'heard');
irr('mean', 'meant'); irr('meet', 'met'); irr('run', 'ran'); irr('pay', 'paid'); irr('sit', 'sat'); irr('speak', 'spoke spoken'); irr('lie', 'lay lain'); irr('lay', 'laid');
irr('lead', 'led'); irr('grow', 'grew grown'); irr('lose', 'lost'); irr('fall', 'fell fallen'); irr('send', 'sent'); irr('build', 'built'); irr('understand', 'understood');
irr('draw', 'drew drawn'); irr('break', 'broke broken'); irr('spend', 'spent'); irr('rise', 'rose risen'); irr('drive', 'drove driven'); irr('buy', 'bought'); irr('wear', 'wore worn');
irr('choose', 'chose chosen'); irr('seek', 'sought'); irr('fight', 'fought'); irr('catch', 'caught'); irr('teach', 'taught'); irr('throw', 'threw thrown'); irr('fly', 'flew flown');
irr('sing', 'sang sung'); irr('swim', 'swam swum'); irr('drink', 'drank drunk'); irr('eat', 'ate eaten'); irr('forget', 'forgot forgotten'); irr('hide', 'hid hidden');
irr('shake', 'shook shaken'); irr('wake', 'woke woken'); irr('sleep', 'slept'); irr('sell', 'sold'); irr('shoot', 'shot'); irr('steal', 'stole stolen'); irr('win', 'won');
irr('hang', 'hung'); irr('dig', 'dug'); irr('light', 'lit'); irr('swear', 'swore sworn'); irr('tear', 'tore torn'); irr('bear', 'bore born borne'); irr('bite', 'bit bitten');
irr('blow', 'blew blown'); irr('freeze', 'froze frozen'); irr('ride', 'rode ridden'); irr('ring', 'rang rung'); irr('sink', 'sank sunk'); irr('spin', 'spun'); irr('stick', 'stuck');
irr('strike', 'struck'); irr('sweep', 'swept'); irr('swing', 'swung'); irr('weep', 'wept'); irr('wind', 'wound'); irr('lend', 'lent'); irr('bend', 'bent'); irr('creep', 'crept');
irr('deal', 'dealt'); irr('flee', 'fled'); irr('forgive', 'forgave forgiven'); irr('shine', 'shone'); irr('slide', 'slid'); irr('spread', 'spread'); irr('undergo', 'underwent undergone');
irr('child', 'children'); irr('man', 'men'); irr('woman', 'women'); irr('mouse', 'mice'); irr('foot', 'feet'); irr('tooth', 'teeth'); irr('goose', 'geese'); irr('person', 'people');
irr('life', 'lives'); irr('wife', 'wives'); irr('knife', 'knives'); irr('leaf', 'leaves'); irr('wolf', 'wolves'); irr('half', 'halves'); irr('self', 'selves'); irr('shelf', 'shelves');
irr('thief', 'thieves'); irr('loaf', 'loaves'); irr('calf', 'calves'); irr('ox', 'oxen'); irr('die', 'dice'); irr('criterion', 'criteria'); irr('phenomenon', 'phenomena');
irr('datum', 'data'); irr('bacterium', 'bacteria'); irr('analysis', 'analyses'); irr('thesis', 'theses'); irr('crisis', 'crises'); irr('index', 'indices'); irr('matrix', 'matrices');
irr('good', 'better best'); irr('well', 'better best'); irr('bad', 'worse worst'); irr('many', 'more most'); irr('much', 'more most'); irr('little', 'less least');
irr('far', 'further furthest farther farthest'); irr('old', 'elder eldest');

const RULES = [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ied', 'y'],
  ['ing', 'e'], ['ing', ''], ['er', ''], ['est', ''], ['er', 'e'], ['est', 'e'], ['ier', 'y'], ['iest', 'y'], ['ly', ''], ['ily', 'y']];

export function candidates(raw) {
  const w = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').replace(/'s$/, '').replace(/s'$/, 's');
  if (!w) return [];
  const out = [w];
  for (const b of IRREGULAR[w] || []) out.push(b);
  for (const [suf, rep] of RULES) {
    if (w.length > suf.length + 1 && w.endsWith(suf)) {
      const base = w.slice(0, -suf.length) + rep; out.push(base);
      if (rep === '' && /([^aeiou])\1$/.test(base)) out.push(base.slice(0, -1)); // stopped -> stopp -> stop
    }
  }
  if (w.includes('-')) out.push(w.replace(/-/g, ' '), w.replace(/-/g, ''));
  return [...new Set(out)];
}

// -> { word, lemma, senses, related } or null.  senses: [[pos, definition, examples[], synonyms[]], ...]
export async function lookup(raw) {
  const cands = candidates(raw), found = [];
  for (const c of cands) { const senses = await entry(c); if (senses) found.push({ lemma: c, senses }); }
  if (!found.length) return null;
  // "running", "stopped": the verb they come from is almost always what the reader wants first
  const w = cands[0];
  if (/(ing|ed)$/.test(w) && found[0].lemma === w) {
    const i = found.findIndex((f, k) => k > 0 && f.senses.some((s) => s[0] === 'v'));
    if (i > 0) found.unshift(...found.splice(i, 1));
  }
  return { word: raw.trim(), lemma: found[0].lemma, senses: found[0].senses, related: found.slice(1, 4).map((f) => f.lemma) };
}

/* ---------- offline copy: fetch every file once so lookups work without internet ---------- */
export async function saveForOffline(onProgress = () => {}) {
  const man = await (await fetch(new URL('manifest.json', BASE))).json(), keys = man.shards;
  let done = 0, next = 0;
  const worker = async () => { while (next < keys.length) { const k = keys[next++]; try { const r = await fetch(new URL(`${k}.json`, BASE)); await r.arrayBuffer(); } catch { throw new Error('The download was interrupted. Try again on a stable connection.'); } onProgress(++done / keys.length); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return keys.length;
}
