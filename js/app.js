import { bookInfo, chapterLabelJa } from './books.js';
import { getMeta, getChapter, importBible, getBookChapter, saveBook, removeBook } from './store.js';
import { parseBookFile } from './bookparse.js';
import { initTokenizer, initIvs, analyzeVerse, lemmaReading, furiText, escapeHtml, kataToHira, toRomaji, isKatakanaWord, POS_EN } from './nlp.js';
import { initDict, lookup, downloadAll } from './dict.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- small persistent prefs (per device) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('br.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('br.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('br.' + k); } catch {} },
};
const DEFAULTS = { size: 22, gaps: true, verses: true, lines: false, furigana: true, theme: 'system' };
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
let readSet = new Set(store.get('read', []));

// Where you were in each text. Older versions stored only the Bible position as `last`.
function lastBible() {
  const l = store.get('lastBible', null) || store.get('last', null);
  return l && l.book ? { book: l.book, ch: l.ch, t: l.t || 0 } : null;
}
function lastBook() { return store.get('lastBook', null); }

const state = {
  books: [], source: null, book: null, // Bible books + source info; `book` = the non-Bible book's info
  libTab: 'OT', openBook: null, importMode: 'bible',
  kind: null, code: null, ch: null, // what's open in the reader: kind 'bible' (code, ch) or 'book' (ch = index)
  chunks: [], selected: -1, tab: 'story', heroEmpty: '',
  vocab: [], vocabSort: 'order', vocabNames: false, renderToken: 0,
};
const isBible = () => state.kind === 'bible';
const bookKey = i => `book:${state.book.id}#${i}`;

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

function twoTap(btn, confirmEl, action) {
  btn.addEventListener('click', () => {
    if (confirmEl.hidden) { confirmEl.hidden = false; return; }
    confirmEl.hidden = true;
    action();
  });
}

function bindSettings() {
  $('#set-size').addEventListener('input', e => { settings.size = +e.target.value; saveSettings(); });
  for (const [id, key] of [['#set-gaps', 'gaps'], ['#set-verses', 'verses'], ['#set-lines', 'lines'], ['#set-furigana', 'furigana']]) {
    $(id).addEventListener('change', e => { settings[key] = e.target.checked; saveSettings(); });
  }
  $('#set-theme').addEventListener('change', e => { settings.theme = e.target.value; saveSettings(); });
  const open = () => {
    updateSourceInfo();
    $$('.confirm').forEach(c => { c.hidden = true; });
    updateStorageStatus();
    $('#settings').showModal();
  };
  $('#lib-settings').addEventListener('click', open);
  $('#reader-settings').addEventListener('click', open);
  $('#settings').addEventListener('click', e => { if (e.target === $('#settings')) $('#settings').close(); });
  $('#reimport').addEventListener('click', () => { $('#settings').close(); location.hash = '#/import'; });
  $('#load-book').addEventListener('click', () => { $('#settings').close(); location.hash = '#/import-book'; });
  twoTap($('#remove-book'), $('#remove-confirm'), async () => {
    const id = state.book && state.book.id;
    await removeBook();
    if (id) { readSet = new Set([...readSet].filter(k => !k.startsWith(`book:${id}#`))); store.set('read', [...readSet]); }
    store.del('lastBook');
    state.book = null;
    updateSourceInfo();
    if (state.kind === 'book') location.hash = '#/'; else renderLibrary();
  });
  twoTap($('#reset-progress'), $('#reset-confirm'), () => {
    readSet = new Set(); store.set('read', []); renderLibrary(); updateMarkRead();
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
    updateStorageStatus();
  });
  if (store.get('dictSaved', false)) $('#offline-status').textContent = 'The whole dictionary is saved on this device.';
  $('#persist').addEventListener('click', async () => { await requestPersist(); updateStorageStatus(); });
}

const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function updateSourceInfo() {
  const s = state.source;
  $('#source-info').textContent = s
    ? `${s.name} · ${plural(s.chapters, 'chapter')} · ${plural(s.verses, 'verse')} · ${s.encoding}`
    : 'No Bible text loaded.';
  const b = state.book;
  $('#book-info').textContent = b
    ? `${b.title}${b.author ? ' · ' + b.author : ''} · ${plural(b.chapters.length, 'chapter')} · ${b.format}`
    : 'No book loaded.';
  $('#load-book').textContent = b ? 'Replace the book' : 'Load a book';
  $('#remove-book').hidden = !b;
}

// ---------- persistent storage ----------
async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

async function updateStorageStatus() {
  const el = $('#storage-status'), btn = $('#persist');
  if (!navigator.storage || !navigator.storage.persisted) {
    el.textContent = 'This browser doesn\'t report whether storage is protected.'; btn.hidden = true; return;
  }
  let persisted = false, usage = null;
  try { persisted = await navigator.storage.persisted(); } catch {}
  try { const est = await navigator.storage.estimate(); usage = est.usage; } catch {}
  const used = usage != null ? ` Using about ${Math.max(1, Math.round(usage / 1e6))} MB.` : '';
  el.textContent = persisted
    ? `Protected: the browser won't clear this app's data on its own.${used}`
    : `Not protected yet: the browser may clear this app's data if the device runs low on space.${used}`;
  btn.hidden = persisted;
}

// ---------- routing ----------
function show(view) {
  for (const v of ['import', 'library', 'reader']) $('#view-' + v).hidden = v !== view;
}

async function route() {
  const h = location.hash || '#/';
  const hasAny = state.books.length || state.book;
  if (h.startsWith('#/import-book')) { showImport('book'); return; }
  if (h.startsWith('#/import')) { showImport('bible'); return; }
  if (!hasAny) { location.replace('#/import'); return; }
  let m = /^#\/read\/([^/]+)\/(\d+)/.exec(h);
  if (m) { await openBibleChapter(decodeURIComponent(m[1]), +m[2]); return; }
  m = /^#\/book\/(\d+)/.exec(h);
  if (m) { await openBookChapter(+m[1]); return; }
  state.kind = null;
  document.title = '聖書 Reader';
  show('library'); renderLibrary();
}

// ---------- import ----------
const IMPORT_TEXT = {
  bible: {
    eyebrow: 'Japanese Bible Reader', title: '聖書を読む',
    lede: 'Load your Japanese Bible text file. It\'s read on this device and stored here, so it works offline afterwards.',
    sub: 'or drop it here · UTF-8, UTF-16 or Shift_JIS', accept: '.txt,text/plain',
    formatLabel: 'Expected format, one verse per line',
    format: 'Gen 1:1 初めに、神は天地を創造された。\nGen 1:2 地は混沌であって、…',
    other: 'Load a different book instead',
  },
  book: {
    eyebrow: 'A book beside the Bible', title: '本を読む',
    lede: 'Load a Japanese book to read alongside the Bible. One book is kept at a time; loading another replaces it. The Bible stays as it is.',
    sub: 'or drop it here · EPUB, or a text file (Aozora Bunko format works)', accept: '.txt,.epub,text/plain,application/epub+zip',
    formatLabel: 'How chapters are found',
    format: 'EPUB: each section of the book.\nText: headings such as 第一章 or Aozora Bunko 見出し marks; otherwise pages of about 4,000 characters.',
    other: 'Load the Bible text instead',
  },
};

function showImport(mode) {
  state.importMode = mode;
  const t = IMPORT_TEXT[mode];
  $('#import-eyebrow').textContent = t.eyebrow;
  $('#import-title').textContent = t.title;
  $('#import-lede').textContent = t.lede;
  $('#import-sub').textContent = t.sub;
  $('#import-format-label').textContent = t.formatLabel;
  $('#import-format').textContent = t.format;
  $('#import-format').classList.toggle('ja', mode === 'bible');
  $('#file-input').accept = t.accept;
  $('#file-input').value = '';
  $('#import-other').textContent = t.other;
  show('import');
  $('#import-cancel').hidden = !(state.books.length || state.book);
  $('#import-status').hidden = true;
  document.title = '聖書 Reader';
}

async function handleFile(file) {
  if (!file) return;
  const st = $('#import-status');
  st.hidden = false; st.className = 'status';
  st.innerHTML = `Reading <strong>${escapeHtml(file.name)}</strong>…<div class="bar"><span></span></div>`;
  const progress = p => { const b = st.querySelector('.bar span'); if (b) b.style.width = (p * 100).toFixed(0) + '%'; };
  const persisting = requestPersist(); // ask while the file pick still counts as a user action
  try {
    if (state.importMode === 'book') {
      const parsed = await parseBookFile(file);
      const info = await saveBook(parsed, file, progress);
      state.book = info;
      st.textContent = `Loaded "${info.title}": ${info.chapters.length} chapters.`;
      state.libTab = 'BOOK';
      const lb = lastBook();
      location.hash = lb && lb.id === info.id ? '#/' : '#/book/0';
    } else {
      const src = await importBible(file, progress);
      state.books = await getMeta('books'); state.source = src;
      st.textContent = `Loaded ${src.chapters.toLocaleString()} chapters and ${src.verses.toLocaleString()} verses.`;
      const first = state.books[0];
      location.hash = lastBible() ? '#/' : `#/read/${first.code}/${first.chapters[0]}`;
    }
  } catch (e) {
    st.className = 'status error';
    st.textContent = e.message || String(e);
  }
  await persisting;
}

function bindImport() {
  $('#file-input').addEventListener('change', e => handleFile(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  $('#import-cancel').addEventListener('click', () => { location.hash = '#/'; });
  $('#import-other').addEventListener('click', () => { location.hash = state.importMode === 'bible' ? '#/import-book' : '#/import'; });
}

// ---------- library ----------
function continueTarget() {
  const lb = lastBible(), lk = lastBook();
  const bibleOk = lb && state.books.some(b => b.code === lb.book);
  const bookOk = lk && state.book && lk.id === state.book.id && lk.i < state.book.chapters.length;
  if (bibleOk && (!bookOk || (lb.t || 0) >= (lk.t || 0))) {
    const bi = bookInfo(lb.book);
    return { hash: `#/read/${lb.book}/${lb.ch}`, title: `${bi.ja} ${chapterLabelJa(lb.book, lb.ch)}`, sub: `${bi.en} ${lb.ch}` };
  }
  if (bookOk) {
    return { hash: `#/book/${lk.i}`, title: state.book.chapters[lk.i], sub: `${state.book.title} · ${lk.i + 1} of ${state.book.chapters.length}` };
  }
  return null;
}

function renderLibrary() {
  const cont = $('#continue');
  const target = continueTarget();
  if (target) {
    cont.hidden = false;
    cont.innerHTML = `<button class="continue" type="button" id="continue-btn">
      <span class="c-text"><span class="c-label">Continue</span><br><span class="c-title ja">${escapeHtml(target.title)}</span><br>
      <span class="c-sub">${escapeHtml(target.sub)}</span></span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>`;
    $('#continue-btn').onclick = () => { location.hash = target.hash; };
  } else cont.hidden = true;

  const lb = lastBible();
  if (!state.openBook && lb) { state.openBook = lb.book; }
  if (!state.books.length && state.libTab !== 'BOOK') state.libTab = 'BOOK';
  $('#seg-ot').hidden = $('#seg-nt').hidden = !state.books.length;
  $$('.seg-btn[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === state.libTab));
  $('#book-list').hidden = state.libTab === 'BOOK';
  $('#book-panel').hidden = state.libTab !== 'BOOK';
  if (state.libTab === 'BOOK') { renderBookPanel(); return; }

  const list = $('#book-list');
  const books = state.books.filter(b => (bookInfo(b.code).testament === 'NT' ? 'NT' : 'OT') === state.libTab);
  list.innerHTML = books.map(b => {
    const bi = bookInfo(b.code);
    const done = b.chapters.filter(c => readSet.has(`${b.code}.${c}`)).length;
    const open = state.openBook === b.code;
    const grid = open ? `<div class="ch-grid">${b.chapters.map(c => {
      const cls = ['ch-btn'];
      if (readSet.has(`${b.code}.${c}`)) cls.push('read');
      if (lb && lb.book === b.code && lb.ch === c) cls.push('current');
      return `<button class="${cls.join(' ')}" data-book="${b.code}" data-ch="${c}" type="button">${c}</button>`;
    }).join('')}</div>` : '';
    return `<li><button class="book-row" data-open="${b.code}" type="button" aria-expanded="${open}">
      <span class="book-ja ja">${escapeHtml(bi.ja)}</span>
      <span class="book-progress${done === b.chapters.length ? ' done' : ''}">${done}/${b.chapters.length}</span>
      <span class="book-en">${escapeHtml(bi.en)}</span></button>${grid}</li>`;
  }).join('');
}

function renderBookPanel() {
  const panel = $('#book-panel');
  const b = state.book;
  if (!b) {
    panel.innerHTML = `<div class="book-empty">
      <p class="book-empty-title">No book loaded</p>
      <p class="hint">Add one Japanese book (EPUB or text) to read alongside the Bible. It gets the same furigana, word lookup and vocabulary list.</p>
      <a class="btn" href="#/import-book">Load a book</a></div>`;
    return;
  }
  const lk = lastBook();
  const done = b.chapters.filter((_, i) => readSet.has(`book:${b.id}#${i}`)).length;
  panel.innerHTML = `<div class="book-card">
      <p class="book-card-title ja">${escapeHtml(b.title)}</p>
      ${b.author ? `<p class="book-card-author ja">${escapeHtml(b.author)}</p>` : ''}
      <p class="hint">${plural(b.chapters.length, 'chapter')} · ${done} read · ${escapeHtml(b.format)}</p>
    </div>
    <ol class="toc">${b.chapters.map((t, i) => {
      const read = readSet.has(`book:${b.id}#${i}`);
      const cur = lk && lk.id === b.id && lk.i === i;
      return `<li><a class="toc-row${read ? ' read' : ''}${cur ? ' current' : ''}" href="#/book/${i}">
        <span class="toc-n">${i + 1}</span><span class="toc-title ja">${escapeHtml(t)}</span>
        ${read ? '<svg viewBox="0 0 24 24" aria-label="Read"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : ''}</a></li>`;
    }).join('')}</ol>`;
}

function bindLibrary() {
  $$('.seg-btn[data-t]').forEach(b => b.addEventListener('click', () => { state.libTab = b.dataset.t; renderLibrary(); }));
  $('#book-list').addEventListener('click', e => {
    const ch = e.target.closest('.ch-btn');
    if (ch) { location.hash = `#/read/${ch.dataset.book}/${ch.dataset.ch}`; return; }
    const row = e.target.closest('[data-open]');
    if (row) {
      state.openBook = state.openBook === row.dataset.open ? null : row.dataset.open;
      renderLibrary();
      const again = $(`[data-open="${row.dataset.open}"]`);
      if (again) again.scrollIntoView({ block: 'nearest' });
    }
  });
}

// ---------- reader ----------
function bibleNeighbours(code, ch) {
  const flat = [];
  for (const b of state.books) for (const c of b.chapters) flat.push([b.code, c]);
  const i = flat.findIndex(([b, c]) => b === code && c === ch);
  const label = p => (p[0] === code ? `${p[1]}` : `${bookInfo(p[0]).en} ${p[1]}`);
  const nav = p => p && { hash: `#/read/${p[0]}/${p[1]}`, label: label(p) };
  return { prev: nav(i > 0 ? flat[i - 1] : null), next: nav(i >= 0 && i < flat.length - 1 ? flat[i + 1] : null) };
}

function readKey() { return isBible() ? `${state.code}.${state.ch}` : bookKey(state.ch); }

function updateMarkRead() {
  const btn = $('#mark-read');
  if (!btn || !state.kind) return;
  const on = readSet.has(readKey());
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('span').textContent = on ? 'Read' : 'Mark as read';
}

async function openBibleChapter(code, ch) {
  show('reader');
  const token = ++state.renderToken;
  const data = await getChapter(code, ch);
  if (token !== state.renderToken) return;
  if (!data) { location.replace('#/'); return; }
  const bi = bookInfo(code);
  store.set('lastBible', { book: code, ch, t: Date.now() });
  state.libTab = bi.testament === 'NT' ? 'NT' : 'OT';
  state.openBook = code;
  await openReading(token, {
    kind: 'bible', code, ch,
    titleHtml: `${escapeHtml(bi.ja)} ${escapeHtml(chapterLabelJa(code, ch))}`,
    sub: `${bi.en} ${ch} · ${data.verses.length} verses`,
    docTitle: `${bi.en} ${ch}`,
    heroEmpty: `<p class="hero-word">${escapeHtml(bi.ja)}</p><p class="hero-en">${escapeHtml(bi.en)} · Chapter ${ch}</p>`,
    units: data.verses,
    ...bibleNeighbours(code, ch),
  });
}

async function openBookChapter(i) {
  show('reader');
  const token = ++state.renderToken;
  const b = state.book;
  const data = b && await getBookChapter(i);
  if (token !== state.renderToken) return;
  if (!data) { location.replace('#/'); return; }
  store.set('lastBook', { id: b.id, i, t: Date.now() });
  state.libTab = 'BOOK';
  const n = b.chapters.length;
  const short = t => (t.length > 14 ? t.slice(0, 13) + '…' : t);
  await openReading(token, {
    kind: 'book', code: null, ch: i,
    titleHtml: escapeHtml(data.title),
    sub: `${b.title} · ${i + 1} of ${n}`,
    docTitle: `${b.title} ${i + 1}`,
    heroEmpty: `<p class="hero-word">${escapeHtml(b.title)}</p><p class="hero-en">${b.author ? `<span class="ja">${escapeHtml(b.author)}</span> · ` : ''}${i + 1} of ${n}</p>`,
    units: data.paras.map(p => [null, p]),
    prev: i > 0 ? { hash: `#/book/${i - 1}`, label: short(b.chapters[i - 1]) } : null,
    next: i < n - 1 ? { hash: `#/book/${i + 1}`, label: short(b.chapters[i + 1]) } : null,
  });
}

function unitOpen(label) {
  return label == null
    ? '<span class="verse para">'
    : `<span class="verse" data-v="${label}"><span class="vn">${label}</span>`;
}

// Shared by the Bible and the book. `units` are [verse number | null, text].
async function openReading(token, cfg) {
  Object.assign(state, { kind: cfg.kind, code: cfg.code, ch: cfg.ch, chunks: [], selected: -1, vocab: [], heroEmpty: cfg.heroEmpty });
  $('#story-title').innerHTML = cfg.titleHtml;
  $('#story-sub').textContent = cfg.sub;
  document.title = `${cfg.docTitle} · 聖書 Reader`;
  $('#view-reader').classList.toggle('is-book', cfg.kind === 'book');
  $('#back').setAttribute('aria-label', cfg.kind === 'book' ? 'Back to the library' : 'Back to books');
  updateMarkRead();
  const pb = $('#prev-ch'), nb = $('#next-ch');
  pb.hidden = !cfg.prev; nb.hidden = !cfg.next;
  pb.querySelector('span').textContent = cfg.prev ? cfg.prev.label : '';
  nb.querySelector('span').textContent = cfg.next ? cfg.next.label : '';
  pb.onclick = () => cfg.prev && (location.hash = cfg.prev.hash);
  nb.onclick = () => cfg.next && (location.hash = cfg.next.hash);
  setTab('story');
  $('#scroller').scrollTop = 0;
  renderHeroEmpty();

  // plain text first, so reading can start before the analyzer is ready
  $('#text').innerHTML = cfg.units.map(([v, t]) => `${unitOpen(v)}${escapeHtml(t)}</span>`).join('');
  $('#vocab-count').textContent = '';
  $('#vocab-list').innerHTML = '<li class="empty">Preparing the word list…</li>';

  const note = $('#analyzer-note');
  const slow = setTimeout(() => {
    note.hidden = false;
    note.textContent = 'Loading the word analyzer. The first time, this downloads about 18 MB; after that it opens from this device.';
  }, 400);
  try {
    await Promise.all([initTokenizer(), initIvs()]);
  } catch {
    clearTimeout(slow);
    note.hidden = false;
    note.textContent = 'The word analyzer could not load, so words can\'t be selected yet. Check the connection and reopen the chapter.';
    return;
  }
  clearTimeout(slow);
  note.hidden = true;
  if (token !== state.renderToken) return;

  const opts = { bible: cfg.kind === 'bible' };
  const analyzed = [];
  for (const [v, t] of cfg.units) {
    analyzed.push([v, await analyzeVerse(t, opts)]);
    if (token !== state.renderToken) return;
  }
  const chunks = [];
  let html = '';
  for (const [v, cs] of analyzed) {
    html += unitOpen(v);
    for (const c of cs) {
      if (c.punct) { html += `<span class="p punc">${c.display}</span>`; continue; }
      c.index = chunks.length; chunks.push(c);
      html += `<span class="w" data-i="${c.index}">${c.display}</span>`;
    }
    html += '</span>';
  }
  state.chunks = chunks;
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
function renderHeroEmpty() {
  $('#hero').innerHTML = `<div class="hero-empty">${state.heroEmpty}<p class="hint">Tap any word to see its meaning.</p></div>`;
}

function clearSelection() {
  $('.w.sel')?.classList.remove('sel');
  state.selected = -1;
  renderHeroEmpty();
}

function senseHtml(s) {
  const [pos, gl, misc] = s;
  return `<li>${pos && pos.length ? `<span class="sense-pos">${escapeHtml(pos.join(', '))}</span>` : ''}${escapeHtml(gl.join('; '))}${misc && misc.length ? `<span class="sense-misc">${escapeHtml(misc.join(', '))}</span>` : ''}</li>`;
}

function headwordFor(entry, key) {
  // a word written in kana stays in kana
  if (!/[㐀-鿿]/.test(key) && entry.r && entry.r.includes(key)) return key;
  if (entry.k && entry.k.length) return entry.k.includes(key) ? key : entry.k[0];
  return entry.r[0];
}

function readingFor(entry, hint) {
  if (!entry.r) return '';
  return hint && entry.r.includes(hint) ? hint : entry.r[0];
}

async function lookupChunk(c) {
  if (c._lookup) return c._lookup;
  const opts = { bible: isBible() };
  c._lookup = (async () => {
    const keys = [];
    if (c.compound) keys.push(c.compound);
    keys.push(c.lemma);
    if (c.head.surface_form !== c.lemma) keys.push(c.head.surface_form);
    if (c.suru && !keys.includes(c.head.surface_form)) keys.push(c.head.surface_form);
    let hint = c.compound ? c.compoundReading : await lemmaReading(c.lemma);
    if (c.lemma === c.head.surface_form && c.head.reading && !c.compound) hint = kataToHira(c.head.reading);
    const entries = await lookup(keys, hint, opts);
    return { entries, hint, keys };
  })();
  return c._lookup;
}

async function selectChunk(i, { scroll = false } = {}) {
  $('.w.sel')?.classList.remove('sel');
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
    const why = isBible()
      ? 'Katakana words in the Bible are usually names of people or places; the romanization above may help you recognise it.'
      : 'Katakana words like this are usually names or loanwords; the romanization above may help you recognise it.';
    html = `<p class="hero-word">${c.display}</p>
      <p class="hero-reading">${escapeHtml(toRomaji(c.surface))}</p>
      <div class="chips"><span class="chip">katakana</span>${notes}</div>
      <p class="hint">Not in the dictionary. ${why}</p>`;
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
    if (i === state.selected) { clearSelection(); return; }
    selectChunk(i);
  });
  $$('.tab').forEach(t => t.addEventListener('click', () => { setTab(t.dataset.tab); $('#scroller').scrollTop = 0; }));
  $('#mark-read').addEventListener('click', () => {
    const k = readKey();
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
    if (e.key === 'Escape' && state.selected >= 0) clearSelection();
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
  const queue = state.vocab.slice();
  const work = async () => {
    while (queue.length) {
      if (token !== state.renderToken) return;
      const g = queue.shift();
      try { g.res = await lookupChunk(g.chunk); } catch { g.res = { entries: [] }; }
      if (g.res.entries[0] && g.res.entries[0].b) g.name = true;
    }
  };
  const timer = setInterval(() => token === state.renderToken && renderVocab(), 700);
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
      reading = /[㐀-鿿]/.test(head) ? `<span class="rd-kana">${escapeHtml(rd)}</span>` : (isKatakanaWord(head) ? escapeHtml(toRomaji(head)) : '');
      gloss = escapeHtml(e.s[0][1].slice(0, 3).join('; '));
      if (e.j) jlpt = `<span class="chip jlpt">N${e.j}</span>`;
    } else {
      word = furiText(c.compound || c.lemma, c.compound ? c.compoundReading : null);
      gloss = g.res ? (g.name ? 'Name or loanword (katakana)' : 'Not in the dictionary') : '…';
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
  try {
    state.books = (await getMeta('books')) || [];
    state.source = (await getMeta('source')) || null;
    state.book = (await getMeta('book')) || null;
  } catch { state.books = []; }
  const lb = lastBible(), lk = lastBook();
  if (!state.books.length || (lk && state.book && (lk.t || 0) > ((lb && lb.t) || 0))) state.libTab = 'BOOK';
  window.addEventListener('hashchange', route);
  await route();
  initDict().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Chrome decides without a prompt, based on how much the app is used; Firefox only asks after an import.
  if ((state.books.length || state.book) && !/firefox/i.test(navigator.userAgent)) requestPersist();
  if (state.books.length || state.book) setTimeout(() => { initTokenizer().catch(() => {}); initIvs(); }, 300);
}

start();
