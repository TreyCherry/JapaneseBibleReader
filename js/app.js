import { bookInfo, chapterLabelJa } from './books.js';
import { getMeta, getChapter, importBible, setMeta } from './store.js';
import { initTokenizer, initIvs, analyzeVerse, lemmaReading, furiText, escapeHtml, kataToHira, toRomaji, isKatakanaWord, POS_EN } from './nlp.js';
import { initDict, lookup, downloadAll } from './dict.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- small persistent prefs (per device) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('br.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('br.' + k, JSON.stringify(v)); } catch {} },
};
const DEFAULTS = { size: 22, gaps: true, verses: true, lines: false, furigana: true, theme: 'system' };
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
let readSet = new Set(store.get('read', []));

const state = {
  books: [], source: null, testament: 'OT', openBook: null,
  book: null, ch: null, chunks: [], analyzed: false, selected: -1, tab: 'story',
  vocab: [], vocabSort: 'order', vocabNames: false, renderToken: 0,
};

// ---------- settings ----------
function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--text-size', settings.size + 'px');
  root.classList.toggle('gaps', settings.gaps);
  root.classList.toggle('hide-vn', !settings.verses);
  root.classList.toggle('lines', settings.lines);
  root.classList.toggle('no-furigana', !settings.furigana);
  if (settings.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', settings.theme);
  $('#set-size').value = settings.size; $('#set-size-out').textContent = settings.size;
  $('#set-gaps').checked = settings.gaps; $('#set-verses').checked = settings.verses;
  $('#set-lines').checked = settings.lines; $('#set-furigana').checked = settings.furigana;
  $('#set-theme').value = settings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--hero-a').trim() || '#141819';
}
function saveSettings() { store.set('settings', settings); applySettings(); }

function bindSettings() {
  $('#set-size').addEventListener('input', e => { settings.size = +e.target.value; saveSettings(); });
  for (const [id, key] of [['#set-gaps', 'gaps'], ['#set-verses', 'verses'], ['#set-lines', 'lines'], ['#set-furigana', 'furigana']]) {
    $(id).addEventListener('change', e => { settings[key] = e.target.checked; saveSettings(); });
  }
  $('#set-theme').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); });
  const open = () => { updateSourceInfo(); $('#reset-confirm').hidden = true; $('#settings').showModal(); };
  $('#lib-settings').addEventListener('click', open);
  $('#reader-settings').addEventListener('click', open);
  $('#settings').addEventListener('click', e => { if (e.target === $('#settings')) $('#settings').close(); });
  $('#reimport').addEventListener('click', () => { $('#settings').close(); location.hash = '#/import'; });
  $('#reset-progress').addEventListener('click', () => {
    if ($('#reset-confirm').hidden) { $('#reset-confirm').hidden = false; return; }
    readSet = new Set(); store.set('read', []); $('#reset-confirm').hidden = true;
    $('#reset-confirm').hidden = true; renderLibrary(); updateMarkRead();
  });
  $('#dl-dict').addEventListener('click', async () => {
    const btn = $('#dl-dict'); btn.disabled = true;
    const bar = $('#dl-bar'); bar.hidden = false;
    try {
      await downloadAll(p => { bar.firstElementChild.style.width = (p * 100).toFixed(0) + '%'; });
      $('#offline-status').textContent = 'The whole dictionary is saved on this device.';
      store.set('dictSaved', true);
    } catch {
      $('#offline-status').textContent = 'Some dictionary files could not be saved. Check the connection and try again.';
    }
    btn.disabled = false;
  });
  if (store.get('dictSaved', false)) $('#offline-status').textContent = 'The whole dictionary is saved on this device.';
}

function updateSourceInfo() {
  const s = state.source;
  $('#source-info').textContent = s
    ? `${s.name} · ${s.chapters.toLocaleString()} chapters · ${s.verses.toLocaleString()} verses · ${s.encoding}`
    : 'No text loaded.';
}

// ---------- routing ----------
function show(view) {
  for (const v of ['import', 'library', 'reader']) $('#view-' + v).hidden = v !== view;
}

async function route() {
  const h = location.hash || '#/';
  if (!state.books.length && !h.startsWith('#/import')) { location.replace('#/import'); return; }
  const m = /^#\/read\/([^/]+)\/(\d+)/.exec(h);
  if (h.startsWith('#/import')) { showImport(); return; }
  if (m) { await openChapter(decodeURIComponent(m[1]), +m[2]); return; }
  show('library'); renderLibrary();
}

// ---------- import ----------
function showImport() {
  show('import');
  $('#import-cancel').hidden = !state.books.length;
  $('#import-status').hidden = true;
}

async function handleFile(file) {
  if (!file) return;
  const st = $('#import-status');
  st.hidden = false; st.className = 'status';
  st.innerHTML = `Reading <strong>${escapeHtml(file.name)}</strong>…<div class="bar"><span></span></div>`;
  try {
    const src = await importBible(file, p => { const b = st.querySelector('.bar span'); if (b) b.style.width = (p * 100).toFixed(0) + '%'; });
    state.books = await getMeta('books'); state.source = src;
    st.innerHTML = `Loaded ${src.chapters.toLocaleString()} chapters and ${src.verses.toLocaleString()} verses.`;
    const first = state.books[0];
    location.hash = store.get('last', null) ? '#/' : `#/read/${first.code}/${first.chapters[0]}`;
  } catch (e) {
    st.className = 'status error';
    st.textContent = e.message || String(e);
  }
}

function bindImport() {
  $('#file-input').addEventListener('change', e => handleFile(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  $('#import-cancel').addEventListener('click', () => { location.hash = '#/'; });
}

// ---------- library ----------
function renderLibrary() {
  const last = store.get('last', null);
  const cont = $('#continue');
  if (last && state.books.some(b => b.code === last.book)) {
    const bi = bookInfo(last.book);
    cont.hidden = false;
    cont.innerHTML = `<button class="continue" type="button" id="continue-btn">
      <span><span class="c-label">Continue</span><br><span class="c-title ja">${escapeHtml(bi.ja)} ${escapeHtml(chapterLabelJa(last.book, last.ch))}</span><br>
      <span class="c-sub">${escapeHtml(bi.en)} ${last.ch}</span></span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>`;
    $('#continue-btn').onclick = () => { location.hash = `#/read/${last.book}/${last.ch}`; };
    if (!state.openBook) { state.openBook = last.book; state.testament = bookInfo(last.book).testament === 'NT' ? 'NT' : 'OT'; }
  } else cont.hidden = true;

  $$('.seg-btn[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === state.testament));
  const list = $('#book-list');
  const books = state.books.filter(b => (bookInfo(b.code).testament === 'NT' ? 'NT' : 'OT') === state.testament);
  list.innerHTML = books.map(b => {
    const bi = bookInfo(b.code);
    const done = b.chapters.filter(c => readSet.has(`${b.code}.${c}`)).length;
    const open = state.openBook === b.code;
    const grid = open ? `<div class="ch-grid">${b.chapters.map(c => {
      const cls = ['ch-btn'];
      if (readSet.has(`${b.code}.${c}`)) cls.push('read');
      if (last && last.book === b.code && last.ch === c) cls.push('current');
      return `<button class="${cls.join(' ')}" data-book="${b.code}" data-ch="${c}" type="button">${c}</button>`;
    }).join('')}</div>` : '';
    return `<li><button class="book-row" data-open="${b.code}" type="button" aria-expanded="${open}">
      <span class="book-ja ja">${escapeHtml(bi.ja)}</span>
      <span class="book-progress${done === b.chapters.length ? ' done' : ''}">${done}/${b.chapters.length}</span>
      <span class="book-en">${escapeHtml(bi.en)}</span></button>${grid}</li>`;
  }).join('');
}

function bindLibrary() {
  $$('.seg-btn[data-t]').forEach(b => b.addEventListener('click', () => { state.testament = b.dataset.t; renderLibrary(); }));
  $('#book-list').addEventListener('click', e => {
    const ch = e.target.closest('.ch-btn');
    if (ch) { location.hash = `#/read/${ch.dataset.book}/${ch.dataset.ch}`; return; }
    const row = e.target.closest('[data-open]');
    if (row) {
      state.openBook = state.openBook === row.dataset.open ? null : row.dataset.open;
      renderLibrary();
      const li = row.closest('li');
      const again = $(`[data-open="${row.dataset.open}"]`);
      if (again) again.scrollIntoView({ block: 'nearest' });
      void li;
    }
  });
}

// ---------- reader ----------
function neighbours(book, ch) {
  const flat = [];
  for (const b of state.books) for (const c of b.chapters) flat.push([b.code, c]);
  const i = flat.findIndex(([b, c]) => b === book && c === ch);
  return { prev: i > 0 ? flat[i - 1] : null, next: i >= 0 && i < flat.length - 1 ? flat[i + 1] : null };
}

function navLabel(pair) {
  if (!pair) return '';
  const bi = bookInfo(pair[0]);
  return pair[0] === state.book ? `${pair[1]}` : `${bi.en} ${pair[1]}`;
}

function updateMarkRead() {
  const btn = $('#mark-read');
  if (!btn || !state.book) return;
  const on = readSet.has(`${state.book}.${state.ch}`);
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('span').textContent = on ? 'Read' : 'Mark as read';
}

async function openChapter(book, ch) {
  show('reader');
  const token = ++state.renderToken;
  const data = await getChapter(book, ch);
  if (token !== state.renderToken) return;
  if (!data) { location.replace('#/'); return; }
  Object.assign(state, { book, ch, chunks: [], analyzed: false, selected: -1, vocab: [] });
  store.set('last', { book, ch });
  const bi = bookInfo(book);
  $('#story-title').innerHTML = `${escapeHtml(bi.ja)} ${escapeHtml(chapterLabelJa(book, ch))}`;
  $('#story-sub').textContent = `${bi.en} ${ch} · ${data.verses.length} verses`;
  document.title = `${bi.en} ${ch} · 聖書 Reader`;
  updateMarkRead();
  const { prev, next } = neighbours(book, ch);
  const pb = $('#prev-ch'), nb = $('#next-ch');
  pb.hidden = !prev; nb.hidden = !next;
  pb.querySelector('span').textContent = navLabel(prev);
  nb.querySelector('span').textContent = navLabel(next);
  pb.onclick = () => prev && (location.hash = `#/read/${prev[0]}/${prev[1]}`);
  nb.onclick = () => next && (location.hash = `#/read/${next[0]}/${next[1]}`);
  setTab('story');
  $('#scroller').scrollTop = 0;
  renderHeroEmpty(data);

  // plain text first, so reading can start before the analyzer is ready
  $('#text').innerHTML = data.verses.map(([v, t]) => `<span class="verse" data-v="${v}"><span class="vn">${v}</span>${escapeHtml(t)}</span>`).join('');
  $('#vocab-count').textContent = '';
  $('#vocab-list').innerHTML = '<li class="empty">Preparing the word list…</li>';

  const note = $('#analyzer-note');
  let slow = setTimeout(() => {
    note.hidden = false;
    note.textContent = 'Loading the word analyzer. The first time, this downloads about 18 MB; after that it opens from this device.';
  }, 400);
  try {
    await Promise.all([initTokenizer(), initIvs()]);
  } catch (e) {
    clearTimeout(slow);
    note.hidden = false;
    note.textContent = 'The word analyzer could not load, so words can\'t be selected yet. Check the connection and reopen the chapter.';
    return;
  }
  clearTimeout(slow);
  note.hidden = true;
  if (token !== state.renderToken) return;

  const verses = [];
  for (const [v, t] of data.verses) verses.push([v, await analyzeVerse(t)]);
  if (token !== state.renderToken) return;
  const chunks = [];
  let html = '';
  for (const [v, cs] of verses) {
    html += `<span class="verse" data-v="${v}"><span class="vn">${v}</span>`;
    for (const c of cs) {
      c.verse = v;
      if (c.punct) { html += `<span class="p punc">${c.display}</span>`; continue; }
      c.index = chunks.length; chunks.push(c);
      html += `<span class="w" data-i="${c.index}">${c.display}</span>`;
    }
    html += '</span>';
  }
  state.chunks = chunks; state.analyzed = true;
  $('#text').innerHTML = html;
  buildVocab(token);
}

function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(t => { t.classList.toggle('on', t.dataset.tab === tab); t.setAttribute('aria-selected', String(t.dataset.tab === tab)); });
  $('#panel-story').hidden = tab !== 'story';
  $('#panel-vocab').hidden = tab !== 'vocab';
}

// ---------- word card ----------
function renderHeroEmpty(data) {
  const bi = bookInfo(state.book);
  $('#hero').innerHTML = `<div class="hero-empty">
    <p class="hero-word">${escapeHtml(bi.ja)}</p>
    <p class="hero-en">${escapeHtml(bi.en)} · ${data ? '' : ''}Chapter ${state.ch}</p>
    <p class="hint">Tap any word to see its meaning.</p></div>`;
}

function senseHtml(s) {
  const [pos, gl, misc] = s;
  return `<li>${pos && pos.length ? `<span class="sense-pos">${escapeHtml(pos.join(', '))}</span>` : ''}${escapeHtml(gl.join('; '))}${misc && misc.length ? `<span class="sense-misc">${escapeHtml(misc.join(', '))}</span>` : ''}</li>`;
}

function headwordFor(entry, key) {
  // a word written in kana stays in kana
  if (!/[\u3400-\u9FFF]/.test(key) && entry.r && entry.r.includes(key)) return key;
  if (entry.k && entry.k.length) return entry.k.includes(key) ? key : entry.k[0];
  return entry.r[0];
}

function readingFor(entry, hint) {
  if (!entry.r) return '';
  return hint && entry.r.includes(hint) ? hint : entry.r[0];
}

async function lookupChunk(c) {
  if (c._lookup) return c._lookup;
  c._lookup = (async () => {
    const keys = [];
    if (c.compound) keys.push(c.compound);
    keys.push(c.lemma);
    if (c.head.surface_form !== c.lemma) keys.push(c.head.surface_form);
    if (c.suru && !keys.includes(c.head.surface_form)) keys.push(c.head.surface_form);
    let hint = c.compound ? c.compoundReading : await lemmaReading(c.lemma);
    if (c.lemma === c.head.surface_form && c.head.reading && !c.compound) hint = kataToHira(c.head.reading);
    const entries = await lookup(keys, hint);
    // a compound match only counts if it's a real entry for the whole compound
    return { entries, hint, keys };
  })();
  return c._lookup;
}

async function selectChunk(i, { scroll = false } = {}) {
  const prev = $('.w.sel');
  if (prev) prev.classList.remove('sel');
  state.selected = i;
  const el = $(`.w[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('sel');
  if (scroll) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const c = state.chunks[i];
  const myToken = state.renderToken;
  const hero = $('#hero');
  const posEn = POS_EN[c.pos] || c.pos;
  hero.innerHTML = `<p class="hero-word">${c.display}</p><p class="hint">Looking up…</p>`;
  let res;
  try { res = await lookupChunk(c); } catch { res = { entries: [], hint: null }; }
  if (state.selected !== i || myToken !== state.renderToken) return;
  const { entries, hint } = res;
  const e = entries[0];
  const notes = c.notes.map(n => `<span class="chip note">${escapeHtml(n)}</span>`).join('');
  let html = '';
  if (e && e.b) {
    html = `<p class="hero-word">${furiText(c.surface, null)}</p>
      <p class="hero-reading">${escapeHtml(toRomaji(c.surface))}</p>
      <div class="chips"><span class="chip">name</span></div>
      <ol class="senses"><li>${escapeHtml(e.b)}</li></ol>`;
  } else if (e) {
    const key = c.compound && e.k && e.k.includes(c.compound) ? c.compound : c.lemma;
    const head = headwordFor(e, key);
    const rd = readingFor(e, hint);
    const headHtml = furiText(head, rd);
    const written = c.surface !== head ? `<p class="hero-written">As written: <span class="ja">${c.display}</span></p>` : '';
    const isKanaHead = !/[㐀-鿿]/.test(head);
    const firstPos = e.s[0] && e.s[0][0] && e.s[0][0][0];
    html = `<p class="hero-word">${headHtml}</p>
      ${isKatakanaWord(head) ? `<p class="hero-reading">${escapeHtml(toRomaji(head))}</p>` : isKanaHead ? '' : `<p class="hero-reading rd-kana"><span class="ja">${escapeHtml(rd)}</span></p>`}
      ${written}
      <div class="chips"><span class="chip">${escapeHtml(firstPos || posEn)}</span>${e.j ? `<span class="chip jlpt">N${e.j}</span>` : ''}${notes}</div>
      <ol class="senses">${e.s.map(senseHtml).join('')}</ol>`;
    const alts = entries.slice(1, 3);
    if (alts.length) {
      html += `<div class="more-entries"><span class="label">Other matches</span>${alts.map(a => {
        if (a.b) return `<div class="alt">${escapeHtml(a.b)}</div>`;
        const h = headwordFor(a, key);
        return `<div class="alt"><span class="ja">${furiText(h, a.r[0])}</span><span class="alt-r">${escapeHtml(a.r[0])}</span>${escapeHtml(a.s[0][1].slice(0, 3).join('; '))}</div>`;
      }).join('')}</div>`;
    }
  } else if (c.isName || isKatakanaWord(c.surface)) {
    html = `<p class="hero-word">${c.display}</p>
      <p class="hero-reading">${escapeHtml(toRomaji(c.surface))}</p>
      <div class="chips"><span class="chip">katakana</span>${notes}</div>
      <p class="hint">Not in the dictionary. Katakana words in the Bible are usually names of people or places; the romanization above may help you recognise it.</p>`;
  } else {
    html = `<p class="hero-word">${c.display}</p>
      <p class="hero-reading rd-kana"><span class="ja">${escapeHtml(c.reading)}</span></p>
      <div class="chips"><span class="chip">${escapeHtml(posEn)}</span>${notes}</div>
      <p class="hint">No dictionary entry found for ${escapeHtml(c.lemma)}.</p>`;
  }
  hero.innerHTML = html;
  hero.scrollTop = 0;
}

function bindReader() {
  $('#back').addEventListener('click', () => { location.hash = '#/'; });
  $('#text').addEventListener('click', e => {
    const w = e.target.closest('.w');
    if (!w) return;
    const i = +w.dataset.i;
    if (i === state.selected) {
      w.classList.remove('sel'); state.selected = -1;
      getChapter(state.book, state.ch).then(renderHeroEmpty);
      return;
    }
    selectChunk(i);
  });
  $$('.tab').forEach(t => t.addEventListener('click', () => { setTab(t.dataset.tab); $('#scroller').scrollTop = 0; }));
  $('#mark-read').addEventListener('click', () => {
    const k = `${state.book}.${state.ch}`;
    if (readSet.has(k)) readSet.delete(k); else readSet.add(k);
    store.set('read', [...readSet]);
    updateMarkRead();
  });
  $$('.seg-btn[data-sort]').forEach(b => b.addEventListener('click', () => {
    state.vocabSort = b.dataset.sort;
    $$('.seg-btn[data-sort]').forEach(x => x.classList.toggle('on', x === b));
    renderVocab();
  }));
  $('#vocab-names').addEventListener('change', e => { state.vocabNames = e.target.checked; renderVocab(); });
  $('#vocab-list').addEventListener('click', e => {
    const li = e.target.closest('[data-first]');
    if (!li) return;
    setTab('story');
    const i = +li.dataset.first;
    requestAnimationFrame(() => selectChunk(i, { scroll: true }));
  });
  document.addEventListener('keydown', e => {
    if ($('#view-reader').hidden || $('#settings').open) return;
    if (e.key === 'Escape' && state.selected >= 0) { $('.w.sel')?.classList.remove('sel'); state.selected = -1; getChapter(state.book, state.ch).then(renderHeroEmpty); }
  });
}

// ---------- vocabulary ----------
async function buildVocab(token) {
  const groups = new Map();
  for (const c of state.chunks) {
    if (!c.lexical) continue;
    const key = (c.compound || c.lemma) + '|' + (c.compound ? 'c' : c.pos);
    let g = groups.get(key);
    if (!g) { g = { key, first: c.index, count: 0, chunk: c, name: c.isName || isKatakanaWord(c.surface) }; groups.set(key, g); }
    g.count++;
  }
  state.vocab = [...groups.values()];
  $('#vocab-count').textContent = state.vocab.length ? `(${state.vocab.length})` : '';
  renderVocab();
  // look up in small parallel batches
  const queue = state.vocab.slice();
  const work = async () => {
    while (queue.length) {
      if (token !== state.renderToken) return;
      const g = queue.shift();
      try { g.res = await lookupChunk(g.chunk); } catch { g.res = { entries: [] }; }
      if (g.res.entries[0] && g.res.entries[0].b) g.name = true;
    }
  };
  let timer = setInterval(() => token === state.renderToken && renderVocab(), 700);
  await Promise.all(Array.from({ length: 4 }, work));
  clearInterval(timer);
  if (token === state.renderToken) renderVocab();
}

function renderVocab() {
  let items = state.vocab.filter(g => state.vocabNames || !g.name);
  if (state.vocabSort === 'freq') items = items.slice().sort((a, b) => b.count - a.count || a.first - b.first);
  if (!items.length) { $('#vocab-list').innerHTML = '<li class="empty">No words to show.</li>'; return; }
  $('#vocab-list').innerHTML = items.map(g => {
    const c = g.chunk;
    const e = g.res && g.res.entries[0];
    let word, reading = '', gloss = '', jlpt = '';
    if (e && e.b) { word = escapeHtml(c.surface); gloss = escapeHtml(e.b); reading = escapeHtml(toRomaji(c.surface)); }
    else if (e) {
      const key = c.compound && e.k && e.k.includes(c.compound) ? c.compound : c.lemma;
      const head = headwordFor(e, key);
      const rd = readingFor(e, g.res.hint);
      word = furiText(head, rd);
      reading = /[㐀-鿿]/.test(head) ? escapeHtml(rd) : (isKatakanaWord(head) ? escapeHtml(toRomaji(head)) : '');
      gloss = escapeHtml(e.s[0][1].slice(0, 3).join('; '));
      if (e.j) jlpt = `<span class="chip jlpt">N${e.j}</span>`;
    } else {
      word = furiText(c.compound || c.lemma, c.compound ? c.compoundReading : null);
      gloss = g.res ? (g.name ? 'Name (katakana)' : 'Not in the dictionary') : '…';
      if (isKatakanaWord(c.surface)) reading = escapeHtml(toRomaji(c.surface));
    }
    return `<li class="vocab-item" data-first="${g.first}" tabindex="0">
      <span class="vocab-word">${word}${reading ? `<span class="r">${reading}</span>` : ''}</span>
      <span class="vocab-gloss">${gloss}</span>
      <span class="vocab-meta">${jlpt}<span class="n">×${g.count}</span></span></li>`;
  }).join('');
}

// ---------- start ----------
async function start() {
  applySettings();
  bindSettings(); bindImport(); bindLibrary(); bindReader();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applySettings);
  try { state.books = (await getMeta('books')) || []; state.source = (await getMeta('source')) || null; } catch { state.books = []; }
  window.addEventListener('hashchange', route);
  await route();
  initDict().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // warm up the analyzer in the background
  if (state.books.length) setTimeout(() => { initTokenizer().catch(() => {}); initIvs(); }, 300);
}

start();
