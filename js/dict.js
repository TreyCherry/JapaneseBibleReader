// Dictionary access. The reader only calls lookup(); a different dictionary can be
// plugged in later by replacing this module (or adding another format branch below).
//
// Format "jm-shards-1" (built by tools/build_dict.py from JMdict):
//   dict/manifest.json  {format, shards, ...}
//   dict/jm/NN.json     {"e": {id: entry}, "k": {key: [id | "NN:id", ...]}}
//   entry: {k: [kanji], r: [kana], s: [[pos[], gloss[], misc[]?]], c?: common, j?: JLPT level 1-5,
//           b?: curated Bible name gloss, n?: [[type, gloss]] (names)}

let manifest = null;
const shardCache = new Map();

export async function initDict(base = 'dict/') {
  if (manifest) return manifest;
  const res = await fetch(base + 'manifest.json');
  if (!res.ok) throw new Error('Dictionary manifest missing');
  manifest = await res.json();
  manifest.base = base;
  return manifest;
}

export function dictInfo() { return manifest; }

function fnv1a(s) {
  let h = 0x811C9DC5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function shardUrl(i) {
  return `${manifest.base}jm/${String(i).padStart(2, '0')}.json`;
}

function getShard(i) {
  if (!shardCache.has(i)) {
    const p = fetch(shardUrl(i)).then(r => {
      if (!r.ok) throw new Error('shard ' + i);
      return r.json();
    });
    p.catch(() => shardCache.delete(i));
    shardCache.set(i, p);
  }
  return shardCache.get(i);
}

export function allShardUrls() {
  return Array.from({ length: manifest.shards }, (_, i) => shardUrl(i));
}

const keyCache = new Map();

export async function lookupKey(key) {
  if (!key) return [];
  if (keyCache.has(key)) return keyCache.get(key);
  const p = (async () => {
    await initDict();
    const si = fnv1a(key) % manifest.shards;
    const sh = await getShard(si);
    const refs = sh.k[key] || [];
    const out = [];
    for (const ref of refs) {
      const c = ref.indexOf(':');
      if (c < 0) { if (sh.e[ref]) out.push({ id: ref, ...sh.e[ref] }); continue; }
      const other = await getShard(+ref.slice(0, c));
      const id = ref.slice(c + 1);
      if (other.e[id]) out.push({ id, ...other.e[id] });
    }
    return out;
  })();
  keyCache.set(key, p);
  p.catch(() => keyCache.delete(key));
  return p;
}

// Look up several candidate keys in order; rank entries by how well they fit the reading.
// opts.bible = false leaves out the curated Bible names (b) and Bible senses (p).
export async function lookup(keys, readingHint, opts = { bible: true }) {
  const seen = new Set();
  const results = [];
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    if (!key) continue;
    let entries;
    try { entries = await lookupKey(key); } catch { entries = []; }
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!opts.bible && (e.b || e.p)) continue;
      let score = 0;
      if (e.b) score += 1000;
      if (e.p && readingHint && e.r && e.r.includes(readingHint)) score += 500;
      if (readingHint && e.r && e.r.includes(readingHint)) score += 200;
      if (e.k && e.k[0] === key) score += 40;
      else if (e.k && e.k.includes(key)) score += 25;
      else if (!e.k || !e.k.length) score += e.r && e.r[0] === key ? 30 : 0;
      if (e.c) score += 30;
      if (e.j) score += 5 + e.j;
      if (e.s && e.s.some(s => s[2] && s[2].includes('usually kana')) && e.r && e.r.includes(key)) score += 20;
      score -= ki * 300; // earlier keys win
      results.push({ entry: e, key, score });
    }
    if (results.length && ki === 0 && results.some(r => r.score > 150)) break;
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(r => r.entry);
}

// Fetch every shard so the dictionary works offline (the service worker caches them).
export async function downloadAll(onProgress = () => {}) {
  await initDict();
  const urls = allShardUrls();
  let done = 0;
  const queue = urls.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const u = queue.shift();
      const r = await fetch(u, { cache: 'reload' }).catch(() => null);
      if (r && r.ok) await r.arrayBuffer();
      done++;
      onProgress(done / urls.length);
    }
  });
  await Promise.all(workers);
}
