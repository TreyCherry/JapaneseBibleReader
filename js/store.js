// Text import (decode + parse the verse-per-line file) and IndexedDB storage.
import { bookInfo } from './books.js';

const DB_NAME = 'bible-reader';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export async function getMeta(key) {
  try {
    const db = await openDb();
    return await reqP(db.transaction('meta').objectStore('meta').get(key));
  } catch { return undefined; }
}

export async function setMeta(key, value) {
  return tx('meta', 'readwrite', s => { s.put(value, key); });
}

export async function getChapter(book, ch) {
  const db = await openDb();
  return reqP(db.transaction('chapters').objectStore('chapters').get(`${book}.${ch}`));
}

export async function clearAll() {
  await tx('chapters', 'readwrite', s => { s.clear(); });
  await tx('meta', 'readwrite', s => { s.clear(); });
}

// ---------- decoding ----------

export function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  const tryDecode = (enc, fatal) => new TextDecoder(enc, { fatal }).decode(b);
  if (b[0] === 0xFF && b[1] === 0xFE) return { text: tryDecode('utf-16le'), encoding: 'UTF-16LE' };
  if (b[0] === 0xFE && b[1] === 0xFF) return { text: tryDecode('utf-16be'), encoding: 'UTF-16BE' };
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { text: tryDecode('utf-8'), encoding: 'UTF-8' };
  // No BOM: look for the NUL bytes that ASCII leaves behind in UTF-16.
  let oddNul = 0, evenNul = 0;
  const n = Math.min(b.length, 4000);
  for (let i = 0; i < n; i++) if (b[i] === 0) (i & 1 ? oddNul++ : evenNul++);
  if (oddNul > n / 20) return { text: tryDecode('utf-16le'), encoding: 'UTF-16LE' };
  if (evenNul > n / 20) return { text: tryDecode('utf-16be'), encoding: 'UTF-16BE' };
  try { return { text: tryDecode('utf-8', true), encoding: 'UTF-8' }; } catch {}
  try { return { text: tryDecode('shift_jis', true), encoding: 'Shift_JIS' }; } catch {}
  return { text: tryDecode('utf-8'), encoding: 'UTF-8 (with errors)' };
}

const LINE_RE = /^\s*([1-3]?[A-Za-z]+)\s+(\d+):(\d+)\s?(.*)$/;

export function parseBible(text) {
  const chapters = new Map(); // "Gen.1" -> {book, ch, verses: [[v, text]]}
  const order = [];
  let last = null, skipped = 0;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/^﻿/, '');
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      if (last) last[1] += line.trim(); else skipped++;
      continue;
    }
    const [, book, chS, vS, body] = m;
    const key = `${book}.${+chS}`;
    let c = chapters.get(key);
    if (!c) { c = { book, ch: +chS, verses: [] }; chapters.set(key, c); order.push(key); }
    last = [+vS, body.trim()];
    c.verses.push(last);
  }
  return { chapters, order, skipped };
}

// Rough check for text that was mangled before it reached us (replacement characters).
export function damageRatio(text) {
  const sample = text.slice(0, 200000);
  const bad = (sample.match(/�/g) || []).length;
  return bad / Math.max(1, sample.length);
}

export async function importBible(file, onProgress = () => {}) {
  const buf = await file.arrayBuffer();
  const { text, encoding } = decodeBytes(buf);
  const damage = damageRatio(text);
  const { chapters, order, skipped } = parseBible(text);
  if (!order.length) throw new Error('No verses found. Each line should start with a label like "Gen 1:1".');
  if (damage > 0.01) throw new Error(`This file looks damaged (${(damage * 100).toFixed(1)}% unreadable characters). Try the original file, or save it again as UTF-8 or UTF-16.`);

  await clearAll();
  const books = [];
  const byBook = new Map();
  for (const key of order) {
    const c = chapters.get(key);
    if (!byBook.has(c.book)) { const b = { code: c.book, chapters: [] }; byBook.set(c.book, b); books.push(b); }
    byBook.get(c.book).chapters.push(c.ch);
  }
  books.sort((a, b) => bookInfo(a.code).index - bookInfo(b.code).index);

  const BATCH = 100;
  for (let i = 0; i < order.length; i += BATCH) {
    const slice = order.slice(i, i + BATCH);
    await tx('chapters', 'readwrite', s => { for (const k of slice) s.put(chapters.get(k), k); });
    onProgress(Math.min(1, (i + BATCH) / order.length));
  }
  let verseCount = 0;
  for (const c of chapters.values()) verseCount += c.verses.length;
  const source = { name: file.name, size: file.size, encoding, importedAt: Date.now(), chapters: order.length, verses: verseCount, skipped };
  await setMeta('books', books);
  await setMeta('source', source);
  return source;
}
