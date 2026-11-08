// Tokenizing (kuromoji), grouping tokens into readable "words", and choosing
// Furifont readings with variation selectors so the furigana match the analysis.

let tokenizerPromise = null;
let ivs = null;

export function initTokenizer(dicPath = 'dict/kuromoji/') {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      // global kuromoji from lib/kuromoji.js
      window.kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)));
    });
    tokenizerPromise.catch(() => { tokenizerPromise = null; });
  }
  return tokenizerPromise;
}

export async function initIvs(url = 'fonts/FurifontSansVF.ivs.json') {
  if (ivs) return ivs;
  try {
    const r = await fetch(url);
    const d = await r.json();
    const words = {};
    for (const [w, list] of Object.entries(d.words || {})) {
      words[w] = list.map(s => s.replace(/[^\[\]]*\[([^\]]*)\]/g, '$1'));
    }
    ivs = { kanji: d.kanji || {}, lone: d.lone || {}, words };
  } catch {
    ivs = { kanji: {}, lone: {}, words: {} };
  }
  return ivs;
}

// ---------- character helpers ----------

const HAN_RE = /[㐀-䶿一-鿿豈-﫿々〆〇ヶ\u{20000}-\u{3134F}]/u;
export const isHan = ch => HAN_RE.test(ch);
export const hasHan = s => [...s].some(isHan);
const KANA_ONLY = /^[ぁ-ゟ゠-ヿー]+$/;
const KATAKANA_ONLY = /^[゠-ヿー・]+$/;
export const isKatakanaWord = s => KATAKANA_ONLY.test(s);

export function kataToHira(s) {
  if (!s) return s;
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c >= 0x30A1 && c <= 0x30F6 ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}

const ROMA = {
  あ:'a',い:'i',う:'u',え:'e',お:'o',か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',
  た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',
  ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',ゐ:'i',ゑ:'e',を:'o',ん:'n',
  が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',
  ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',ゔ:'vu',
  ぁ:'a',ぃ:'i',ぅ:'u',ぇ:'e',ぉ:'o',
};
const DIGRAPH = { ゃ:'a', ゅ:'u', ょ:'o' };
export function toRomaji(kana) {
  const h = kataToHira(kana || '');
  let out = '';
  const chars = [...h];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], n = chars[i + 1];
    if (c === 'っ') { const nx = ROMA[n]; if (nx) out += nx[0] === 'c' ? 't' : nx[0]; continue; }
    if (c === 'ー') { out += out.slice(-1); continue; }
    if (c === '・') { out += ' '; continue; }
    if (n && DIGRAPH[n] && ROMA[c] && ROMA[c].endsWith('i') && c !== 'い') {
      const base = ROMA[c];
      const stem = /^(sh|ch|j)i$/.test(base) ? base.slice(0, -1) : base.slice(0, -1) + 'y';
      out += stem + DIGRAPH[n]; i++; continue;
    }
    if ('ぁぃぅぇぉ'.includes(c) && i > 0 && out) {
      // small vowels: ファ fa, ティ ti, ウィ wi, シェ she, ジェ je
      const v = ROMA[c];
      const prevKana = chars[i - 1];
      if (prevKana === 'う' || prevKana === 'ウ') out = out.slice(0, -1) + 'w' + v;
      else if (/(sh|ch|j)i$/.test(out)) out = out.slice(0, -1) + v;
      else out = out.slice(0, -1) + v;
      continue;
    }
    out += ROMA[c] || c;
  }
  return out;
}

// ---------- reading alignment ----------

// Split a token's surface into kanji runs and kana, and give each kanji run its reading.
// Returns [{text, han, reading}] where reading is null when it can't be aligned.
export function alignReading(surface, readingHira) {
  const groups = [];
  for (const ch of surface) {
    const h = isHan(ch);
    const last = groups[groups.length - 1];
    if (last && last.han === h) last.text += ch; else groups.push({ text: ch, han: h, reading: null });
  }
  if (!groups.some(g => g.han) || !readingHira) return groups;
  if (groups.length === 1) { groups[0].reading = readingHira; return groups; }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '^' + groups.map(g => (g.han ? '(.+?)' : esc(kataToHira(g.text)))).join('') + '$';
  const m = new RegExp(pattern, 'u').exec(readingHira);
  if (m) {
    let gi = 1;
    for (const g of groups) if (g.han) g.reading = m[gi++];
  }
  return groups;
}

// How to show `reading` over the kanji run `run` with Furifont:
//   '' = the font's default is already right (or we have no better information)
//   a variation selector = pick one of the font's alternative readings
//   null = the font has no such reading; draw our own ruby instead
function selectorFor(run, reading) {
  if (!ivs || !reading) return '';
  const cps = [...run];
  if (cps.length === 1) {
    const list = ivs.kanji[run];
    if (!list) return '';
    // `lone` is what the font shows over this kanji on its own; kanji missing from it show none
    if (reading === ivs.lone[run]) return '';
    const idx = list.indexOf(reading);
    return idx < 0 ? null : String.fromCodePoint(0xE01E1 + idx);
  }
  const list = ivs.words[run];
  if (!list) return '';
  const idx = list.indexOf(reading);
  if (idx === 0) return '';
  return idx < 0 ? null : String.fromCodePoint(0xE01E1 + idx);
}

const NO_FURIGANA = String.fromCodePoint(0xE01E0);
export const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Given segments [{text, han, reading}], produce display HTML: selectors inserted for
// the font, or explicit <ruby> where the font doesn't know the reading.
export function withSelectors(segments) {
  // merge neighbouring kanji segments into the runs the browser will shape together
  const runs = [];
  for (const s of segments) {
    const last = runs[runs.length - 1];
    if (last && last.han && s.han) {
      last.text += s.text;
      last.reading = last.reading != null && s.reading != null ? last.reading + s.reading : null;
    } else runs.push({ ...s });
  }
  let out = '';
  for (const r of runs) {
    if (!r.han) { out += escapeHtml(r.text); continue; }
    const vs = selectorFor(r.text, r.reading);
    const cps = [...r.text];
    if (vs === '') out += escapeHtml(r.text);
    else if (vs === null) out += `<ruby>${escapeHtml(cps[0] + NO_FURIGANA + cps.slice(1).join(''))}<rt>${escapeHtml(r.reading)}</rt></ruby>`;
    else out += escapeHtml(cps[0] + vs + cps.slice(1).join(''));
  }
  return out;
}

export function furiText(surface, reading) {
  return withSelectors(alignReading(surface, kataToHira(reading)));
}

// ---------- grouping tokens into words ----------

const AUX_NOTES = {
  'た': 'past', 'だ': 'past', 'ない': 'negative', 'ぬ': 'negative', 'ん': 'negative', 'ず': 'negative',
  'ます': 'polite', 'れる': 'passive / potential / respectful', 'られる': 'passive / potential / respectful',
  'せる': 'causative', 'させる': 'causative', 'たい': 'want to', 'う': 'volitional (let\'s / will)',
  'よう': 'volitional (let\'s / will)', 'まい': 'will not', 'らしい': 'seems', 'そうだ': 'looks like / hearsay',
  'べし': 'should / must', 'ごとし': 'like / as', 'り': 'perfect (classical)', 'き': 'past (classical)', 'けり': 'past (classical)',
  'む': 'volitional (classical)', 'たり': 'perfect (classical)', 'なり': 'copula (classical)',
};
const AUX_VERB_NOTES = {
  'いる': '〜ている: ongoing or resulting state', 'しまう': '〜てしまう: completely / regrettably', 'おく': '〜ておく: in advance',
  'くる': '〜てくる: toward / begins', 'いく': '〜ていく: onward', 'ゆく': '〜てゆく: onward', 'ある': '〜てある: has been done',
  'くださる': '〜てください: please', 'くれる': '〜てくれる: for me/us', 'もらう': '〜てもらう: have someone do',
  'やる': '〜てやる: for someone', 'あげる': '〜てあげる: for someone', 'みる': '〜てみる: try',
  'いただく': '〜ていただく: humbly receive', 'おる': '〜ておる: ongoing (formal)', 'なさる': 'respectful do',
};

function isInflectional(t, chunk) {
  const head = chunk.head;
  const headPos = head ? head.pos : '';
  const last = chunk.tokens[chunk.tokens.length - 1];
  const verbal = headPos === '動詞' || headPos === '形容詞' || headPos === '助動詞' || chunk.suru;
  if (t.pos === '助動詞') {
    if (verbal) return true;
    // 〜ます after a verb attached above; nouns keep だ/です separate
    return false;
  }
  if (t.pos === '動詞' && t.pos_detail_1 === '接尾') return verbal || last.pos === '動詞';
  if (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && /^(て|で|ば)$/.test(t.surface_form)) return verbal;
  if (t.pos === '動詞' && t.pos_detail_1 === '非自立') return /^(て|で)$/.test(last.surface_form) && verbal;
  if (t.pos === '形容詞' && t.pos_detail_1 === '非自立') return verbal;
  return false;
}

function newChunk(t) {
  return { tokens: [t], head: t.pos === '接頭詞' ? null : t, prefixOnly: t.pos === '接頭詞', suru: false, notes: [] };
}

export function groupTokens(tokens) {
  const chunks = [];
  let cur = null;
  for (const t of tokens) {
    if (!cur) { cur = newChunk(t); continue; }
    const last = cur.tokens[cur.tokens.length - 1];
    let attach = false;
    if (cur.prefixOnly && t.pos !== '記号' && t.pos !== '助詞' && t.word_type !== 'UNKNOWN') {
      attach = true; cur.head = t; cur.prefixOnly = false;
    } else if (t.pos === '名詞' && t.pos_detail_1 === '接尾' && cur.head && cur.head.pos === '名詞') {
      attach = true;
    } else if (t.pos === '名詞' && t.pos_detail_1 === '数' && last.pos === '名詞' && last.pos_detail_1 === '数') {
      attach = true;
    } else if (t.pos === '動詞' && t.basic_form === 'する' && last.pos === '名詞' && last.pos_detail_1 === 'サ変接続' && cur.head === last) {
      attach = true; cur.suru = true; cur.notes.push('する verb');
    } else if (t.pos === '助動詞' && cur.head && cur.head.pos === '助動詞') {
      attach = true; // であった, である, でした ...
    } else if (t.pos === '動詞' && last.pos === '助動詞' && cur.head && cur.head.pos === '助動詞' && /^(ある|あっ)/.test(t.surface_form)) {
      attach = true; // で + あっ + た
    } else if (isInflectional(t, cur)) {
      attach = true;
      if (t.pos === '助動詞' && AUX_NOTES[t.basic_form]) cur.notes.push(AUX_NOTES[t.basic_form]);
      else if (t.pos === '動詞' && t.pos_detail_1 === '接尾' && AUX_NOTES[t.basic_form]) cur.notes.push(AUX_NOTES[t.basic_form]);
      else if (t.pos === '動詞' && t.pos_detail_1 === '非自立' && AUX_VERB_NOTES[t.basic_form]) cur.notes.push(AUX_VERB_NOTES[t.basic_form]);
      else if (t.pos === '形容詞' && t.basic_form === 'ない') cur.notes.push('negative');
      else if (t.surface_form === 'ば') cur.notes.push('conditional (if)');
      else if (/^(て|で)$/.test(t.surface_form)) cur.notes.push('て-form (and / then)');
    }
    if (attach) cur.tokens.push(t);
    else { chunks.push(cur); cur = newChunk(t); }
  }
  if (cur) chunks.push(cur);

  // keep kanji runs whole: merge chunks that meet kanji-to-kanji
  const merged = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    const prevText = prev ? prev.tokens.map(t => t.surface_form).join('') : '';
    const text = c.tokens.map(t => t.surface_form).join('');
    if (prev && prevText && isHan([...prevText].pop()) && isHan([...text][0]) && prev.head && c.head
        && prev.head.pos !== '記号' && c.head.pos !== '記号') {
      prev.tokens.push(...c.tokens);
      prev.merged = true;
      prev.notes.push(...c.notes);
    } else merged.push(c);
  }
  return merged.map(finishChunk);
}

const NON_LEXICAL = new Set(['記号', '助詞', '助動詞', 'フィラー']);

// Readings this Bible uses where the analyzer guesses otherwise (nouns only).
const READING_OVERRIDES = { '主': 'シュ', '言': 'コトバ' };

function finishChunk(c) {
  for (const t of c.tokens) {
    if (t.pos === '名詞' && READING_OVERRIDES[t.surface_form]) t.reading = READING_OVERRIDES[t.surface_form];
  }
  const head = c.head || c.tokens[0];
  const surface = c.tokens.map(t => t.surface_form).join('');
  const display = withSelectors(c.tokens.flatMap(t => alignReading(t.surface_form, kataToHira(t.reading))));
  const reading = c.tokens.map(t => t.reading || t.surface_form).join('');
  let lemma = head.basic_form && head.basic_form !== '*' ? head.basic_form : head.surface_form;
  // compound content (prefix + noun, noun + suffix, merged kanji runs)
  const content = [];
  for (const t of c.tokens) {
    if (t.pos === '名詞' || t.pos === '接頭詞' || (c.merged && isHan([...t.surface_form][0]))) content.push(t);
    else break;
  }
  const compound = content.length > 1 ? content.map(t => t.surface_form).join('') : null;
  const compoundReading = compound ? kataToHira(content.map(t => t.reading || t.surface_form).join('')) : null;
  const punct = head.pos === '記号' && c.tokens.every(t => t.pos === '記号');
  const lexical = !punct && !(NON_LEXICAL.has(head.pos) && c.tokens.length === 1);
  const isName = head.pos === '名詞' && (head.pos_detail_1 === '固有名詞' || (head.word_type === 'UNKNOWN' && isKatakanaWord(head.surface_form)));
  return {
    surface, display, reading: kataToHira(reading), lemma, compound, compoundReading,
    pos: head.pos, posDetail: head.pos_detail_1, head, tokens: c.tokens,
    notes: [...new Set(c.notes)], punct, lexical, isName, suru: c.suru,
  };
}

const lemmaReadingCache = new Map();
export async function lemmaReading(lemma) {
  if (lemmaReadingCache.has(lemma)) return lemmaReadingCache.get(lemma);
  const t = await initTokenizer();
  const toks = t.tokenize(lemma);
  const r = toks.every(x => x.reading) ? kataToHira(toks.map(x => x.reading).join('')) : (KANA_ONLY.test(lemma) ? kataToHira(lemma) : null);
  lemmaReadingCache.set(lemma, r);
  return r;
}

export async function analyzeVerse(text) {
  const t = await initTokenizer();
  return groupTokens(t.tokenize(text));
}

export const POS_EN = {
  '名詞': 'noun', '動詞': 'verb', '形容詞': 'i-adjective', '副詞': 'adverb', '連体詞': 'pre-noun adjectival',
  '接続詞': 'conjunction', '感動詞': 'interjection', '助詞': 'particle', '助動詞': 'auxiliary', '接頭詞': 'prefix', '記号': 'symbol',
};
