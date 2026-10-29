// Turning a non-Bible book (plain text, Aozora Bunko text, or EPUB) into chapters of paragraphs.
import { decodeBytes } from './store.js';

const MAX_CHAPTER_CHARS = 12000; // longer chapters are split into parts so they analyze quickly
const PAGE_CHARS = 4000;         // used when a text file has no headings at all

// ---------- shared ----------

function cleanPara(s) {
  // leading full-width spaces are the book's own indent; the reader indents paragraphs itself
  return s.replace(/[\s　]+$/u, '').replace(/^[ \t　]+/u, '').replace(/[ \t]{2,}/g, ' ');
}

function splitLong(ch) {
  const total = ch.paras.reduce((n, p) => n + p.length, 0);
  if (total <= MAX_CHAPTER_CHARS) return [ch];
  const parts = [];
  let cur = [], size = 0;
  for (const p of ch.paras) {
    if (size + p.length > MAX_CHAPTER_CHARS && cur.length) { parts.push(cur); cur = []; size = 0; }
    cur.push(p); size += p.length;
  }
  if (cur.length) parts.push(cur);
  return parts.map((paras, i) => ({ title: `${ch.title} (${i + 1}/${parts.length})`, paras }));
}

const norm = t => t.replace(/[\s\u3000]+/gu, '');

function finish(book) {
  // the chapter heading usually repeats as the first paragraph; the reader already shows it as the title
  for (const c of book.chapters) {
    const k = c.paras.slice(0, 3).findIndex(p => norm(p) === norm(c.title));
    if (k >= 0) c.paras.splice(k, 1);
  }
  book.chapters = book.chapters
    .filter(c => c.paras.some(p => p.trim()))
    .flatMap(splitLong);
  if (!book.chapters.length) throw new Error('No readable text was found in this file.');
  book.chars = book.chapters.reduce((n, c) => n + c.paras.reduce((m, p) => m + p.length, 0), 0);
  return book;
}

// ---------- plain text / Aozora Bunko ----------

const HEADING_RE = /^[\s　]*((第[一二三四五六七八九十百千〇零\d０-９]+[章話回節部編幕]).{0,24}|(序章|終章|序|跋|プロローグ|エピローグ|あとがき|まえがき|はじめに|おわりに)[\s　]*.{0,20}|(chapter|part)\s+[\divxlc]+.{0,30}|[一二三四五六七八九十]{1,3}|[\d０-９]{1,3}[.．]?)[\s　]*$/i;

function stripAozora(text) {
  const lines = text.split(/\r\n|\n|\r/);
  // header block between the first two dashed lines holds the notation explanation
  const dash = [];
  for (let i = 0; i < Math.min(lines.length, 80); i++) if (/^-{10,}\s*$/.test(lines[i])) dash.push(i);
  let head = [];
  let body = lines;
  if (dash.length >= 2) { head = lines.slice(0, dash[0]); body = lines.slice(dash[1] + 1); }
  const foot = body.findIndex(l => /^底本[：:]/.test(l));
  if (foot >= 0) body = body.slice(0, foot);
  return { head: head.map(l => l.trim()).filter(Boolean), body };
}

function cleanAozoraLine(line) {
  return line
    .replace(/※［＃[^］]*］/g, '')
    .replace(/［＃[^］]*］/g, '')
    .replace(/《[^》]*》/g, '')
    .replace(/｜/g, '');
}

export function parseText(text, fileName) {
  const aozora = /《[^》]+》|［＃/.test(text.slice(0, 200000));
  let title = fileName.replace(/\.[^.]+$/, '');
  let author = '';
  let lines;
  if (aozora) {
    const { head, body } = stripAozora(text);
    if (head[0]) title = head[0];
    if (head[1]) author = head[head.length - 1];
    lines = body;
  } else lines = text.split(/\r\n|\n|\r/);

  // Aozora heading annotations are the most reliable chapter markers
  const marked = [];
  if (aozora) {
    lines.forEach((l, i) => {
      const m = /［＃「([^」]+)」は(大|中)見出し］/.exec(l);
      if (m) marked.push({ i, level: m[2], title: m[1] });
    });
  }
  let heads;
  if (marked.some(h => h.level === '大') && marked.filter(h => h.level === '大').length >= 2) heads = marked.filter(h => h.level === '大');
  else if (marked.length >= 2) heads = marked;
  else {
    heads = [];
    lines.forEach((l, i) => {
      const t = cleanAozoraLine(l).trim();
      if (t && t.length <= 40 && HEADING_RE.test(t)) heads.push({ i, title: t });
    });
    if (heads.length < 2) heads = [];
  }

  const paraOf = l => cleanPara(aozora ? cleanAozoraLine(l) : l);
  const chapters = [];
  if (heads.length) {
    const before = lines.slice(0, heads[0].i).map(paraOf).filter(p => p.trim());
    if (before.join('').length > 200) chapters.push({ title: 'Opening', paras: before });
    heads.forEach((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
      chapters.push({ title: h.title, paras: lines.slice(h.i + 1, end).map(paraOf).filter(p => p.trim()) });
    });
  } else {
    // no headings: cut into pages at paragraph breaks
    let cur = [], size = 0, n = 1;
    for (const l of lines) {
      const p = paraOf(l);
      if (!p.trim()) continue;
      cur.push(p); size += p.length;
      if (size >= PAGE_CHARS) { chapters.push({ title: `${n++}`, paras: cur }); cur = []; size = 0; }
    }
    if (cur.length) chapters.push({ title: `${n}`, paras: cur });
  }
  return finish({ title, author, format: aozora ? 'Aozora Bunko text' : 'Text', chapters });
}

// ---------- EPUB ----------

function parseXml(str, type = 'application/xhtml+xml') {
  let doc = new DOMParser().parseFromString(str, type);
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(str, 'text/html');
  return doc;
}

function resolvePath(base, href) {
  const parts = base.split('/').slice(0, -1);
  for (const seg of decodeURIComponent(href.split('#')[0]).split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dt,dd,figcaption,pre';

function docParagraphs(doc) {
  doc.querySelectorAll('rt,rp,script,style,nav[epub\\:type="toc"]').forEach(e => e.remove());
  const body = doc.body || doc.documentElement;
  const blocks = [...body.querySelectorAll(BLOCKS)].filter(el => !el.querySelector(BLOCKS));
  let texts;
  if (blocks.length) texts = blocks.map(el => el.textContent);
  else texts = (body.textContent || '').split(/\n+/);
  return texts.map(t => cleanPara(t.replace(/\s*\n\s*/g, ''))).filter(t => t.trim());
}

export async function parseEpub(buf, fileName) {
  if (!window.fflate) throw new Error('The EPUB reader did not load.');
  const files = window.fflate.unzipSync(new Uint8Array(buf));
  const text = p => {
    const f = files[p];
    return f ? new TextDecoder('utf-8').decode(f) : null;
  };
  const container = text('META-INF/container.xml');
  if (!container) throw new Error('This doesn\'t look like an EPUB file (META-INF/container.xml is missing).');
  const opfPath = parseXml(container, 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  const opf = parseXml(text(opfPath) || '', 'application/xml');
  const meta = sel => opf.getElementsByTagName(sel)[0]?.textContent?.trim() || '';
  const title = meta('dc:title') || fileName.replace(/\.[^.]+$/, '');
  const author = meta('dc:creator');

  const manifest = new Map();
  for (const it of opf.getElementsByTagName('item')) {
    manifest.set(it.getAttribute('id'), { href: resolvePath(opfPath, it.getAttribute('href')), type: it.getAttribute('media-type'), props: it.getAttribute('properties') || '' });
  }

  // table of contents labels, from EPUB 3 nav or EPUB 2 NCX
  const tocTitles = new Map();
  const navItem = [...manifest.values()].find(m => m.props.includes('nav'));
  if (navItem && text(navItem.href)) {
    const nav = parseXml(text(navItem.href));
    for (const a of nav.querySelectorAll('nav a[href]')) {
      const p = resolvePath(navItem.href, a.getAttribute('href'));
      if (!tocTitles.has(p)) tocTitles.set(p, a.textContent.trim());
    }
  }
  const ncxId = opf.getElementsByTagName('spine')[0]?.getAttribute('toc');
  const ncx = ncxId && manifest.get(ncxId);
  if (ncx && text(ncx.href)) {
    const doc = parseXml(text(ncx.href), 'application/xml');
    for (const np of doc.getElementsByTagName('navPoint')) {
      const src = np.getElementsByTagName('content')[0]?.getAttribute('src');
      const label = np.getElementsByTagName('text')[0]?.textContent?.trim();
      if (src && label) { const p = resolvePath(ncx.href, src); if (!tocTitles.has(p)) tocTitles.set(p, label); }
    }
  }

  const chapters = [];
  let pending = null; // short sections (title pages, dividers) are folded into the next one
  for (const ref of opf.getElementsByTagName('itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !/html|xml/.test(item.type || '')) continue;
    const src = text(item.href);
    if (!src) continue;
    const doc = parseXml(src);
    const heading = doc.querySelector('h1,h2,h3')?.textContent?.replace(/\s+/g, ' ').trim();
    const paras = docParagraphs(doc);
    if (!paras.length) continue;
    const titleHere = tocTitles.get(item.href) || heading || '';
    const size = paras.join('').length;
    if (pending) {
      // a short title page or divider was held back: its text joins this section, under this section's title
      pending.paras.push(...paras);
      if (tocTitles.get(item.href) || !pending.title) pending.title = titleHere;
    }
    else pending = { title: titleHere, paras };
    if (size >= 300 || pending.paras.join('').length >= 300) { chapters.push(pending); pending = null; }
  }
  if (pending) chapters.push(pending);
  chapters.forEach((c, i) => { if (!c.title) c.title = `${i + 1}`; });
  return finish({ title, author, format: 'EPUB', chapters });
}

export async function parseBookFile(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf.slice(0, 4));
  if (b[0] === 0x50 && b[1] === 0x4B) return parseEpub(buf, file.name);
  const { text, encoding } = decodeBytes(buf);
  const book = parseText(text, file.name);
  book.encoding = encoding;
  return book;
}
