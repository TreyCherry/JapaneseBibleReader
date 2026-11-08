This is mostly just a PWA I needed for something, and needed on github pages to be able to install on my phone. To be honest, probably not something useful to most people (It's setup as a BYO Bible system). AI generated explanation below (in case someone else finds things useful.):



# 聖書 Reader

A reader for a Japanese Bible text file, one chapter per page, in the style of Readle:

- Furifont draws the furigana. The word analyzer's readings pick the right furigana where a kanji has several.
- Tap a word to see its dictionary form, reading, meanings, JLPT level, and grammar notes for the inflection, such as "passive" or "past".
- The **Vocabulary** tab lists every word in the chapter with its first meaning and how often it appears. Tap a word in the list to jump to it in the text.
- Chapters can be marked as read, and the library shows progress for each book.
- It's an installable PWA and works offline after the first load.
- One non-Bible book can be loaded alongside the Bible (see below).

The Bible text is **not** included. You load your own file in the app, and it's stored only in that browser (IndexedDB). That keeps the hosted files free of the translation's copyright.

## Text format

One verse per line, starting with a book code and chapter:verse:

```
Gen 1:1 初めに、神は天地を創造された。
Gen 1:2 地は混沌であって、…
```

UTF-16 (with or without BOM), UTF-8 and Shift_JIS are all detected. Book codes match the JSD file (Gen … Rev, including `Sol` for Song of Songs and `Joe` for Joel). Unknown codes still load and are listed under their code.

## A second book

The library's **本 Book** tab holds one non-Bible book at a time. Loading another book replaces it; the Bible is never touched.

- **EPUB:** chapters come from the book's sections. Table-of-contents titles are used when present, short title pages are folded into the next section, and the publisher's own furigana (`<rt>`) are dropped so the reader's readings are used throughout.
- **Text** (UTF-8, UTF-16 or Shift_JIS): Aozora Bunko files are recognised. Their header and 底本 footer are removed, ruby markup (《》, ｜) and ［＃…］ notes are stripped, and 大見出し / 中見出し marks become chapters. Other text files are split at headings such as 第一章, プロローグ or a lone number. A file with no headings is cut into pages of about 4,000 characters.
- Chapters over 12,000 characters are split into parts so they analyse quickly.

The book gets the same furigana, word card and vocabulary tab, but none of the Bible-specific rules. That means no reading overrides (主 → しゅ and the rest), no 光あれ fix-up, and no curated Bible names or senses in the dictionary results. The general grammar handling, like keeping 〜よ commands on their verb, applies to both.

## Hosting

Service workers only run over HTTPS or on `localhost`, so serve the folder rather than opening `index.html` directly.

**GitHub Pages (simplest for a phone):** push this folder to a repository, then go to Settings → Pages and deploy from the branch. Open the URL on your phone, load the text file, and use "Add to Home screen" or "Install app".

**Locally:**

```
python3 -m http.server 8000      # or: bunx serve .
```

Then open http://localhost:8000.

## First run and offline use

| What | Size | When it downloads |
| --- | --- | --- |
| App, Furifont (variable WOFF2) | ~6.5 MB | On install |
| kuromoji analyzer dictionary | ~18 MB | On install |
| JMdict shards (96 files) | ~12 MB gzipped | As words are looked up, or all at once from Settings → "Save the whole dictionary" |

## Keeping the data

After each import, and on start-up in Chrome, the app calls `navigator.storage.persist()`. Chrome grants it silently based on how much the app is used (installing it to the home screen helps); Firefox shows a prompt. Once granted, the browser won't clear the app's data on its own. Settings → Offline shows whether storage is protected and how much is used, with a button to ask again.

## Updating the app

The service worker serves cached files first. After changing any file, bump `VERSION` in `sw.js` so phones pick up the change.

## Dictionary

`js/dict.js` is the only module that knows the dictionary format. The reader calls `lookup(keys, readingHint)` and gets back a ranked list of entries:

```js
{ k: ['創造'], r: ['そうぞう'], s: [[['noun', 'suru noun'], ['creation'], ['misc']]], c: 1, j: 1 }
```

To use a different dictionary, either produce the same shard format or replace `lookup()` in `dict.js`.

The bundled data is built by `tools/build_dict.py` from JMdict (via the `jamdict-data` PyPI package), Furifont's JLPT list, and two curated files:

- `tools/names.json`: Bible names in 新共同訳 spelling → English. These take priority, because the general name dictionary gives things like "Davide" for ダビデ.
- `tools/terms.json`: Bible-specific senses that JMdict lacks, such as 言 read ことば, "the Word" of John 1.

```
pip download jamdict-data --no-deps     # unpack, then xz -d jamdict.db.xz
python3 tools/build_dict.py jamdict.db path/to/furifont/packages/dictionary/raw/jlpt.json tools/names.json dict
```

Readings the analyzer gets wrong for this translation can be corrected in `READING_OVERRIDES` in `js/nlp.js` (currently 主 → しゅ, 言 → ことば, 所 → ところ, standalone 日 → ひ).

## How the furigana are chosen

kuromoji (IPADIC) splits each verse into words and gives each word a reading. For each run of kanji, `js/nlp.js` then does one of three things:

- Leaves the run alone when Furifont's default reading already matches.
- Inserts one of Furifont's variation selectors (U+E01E1…) to pick the matching alternative from `fonts/FurifontSansVF.ivs.json`.
- Draws a small `<ruby>` itself when the font has no such reading. In that case it also turns off the font's own furigana for that run.

Words are grouped Readle-style: a verb keeps its endings (創造された), and a prefix or suffix stays with its noun. Runs of kanji are never split across words, so the font always sees whole words.

## Licences

- Furifont: SIL Open Font License 1.1 (`licenses/Furifont-OFL.txt`); its data credits are in `licenses/Furifont-DATA-LICENSE.md`.
- fflate (EPUB unzipping): MIT (`licenses/fflate-LICENSE.txt`).
- kuromoji.js and its IPADIC build: Apache 2.0 (`licenses/kuromoji-*`). `lib/kuromoji.js` is patched so it accepts dictionary files a server has already un-gzipped.
- JMdict / JMnedict: © EDRDG, CC BY-SA 4.0 (`licenses/JMdict-EDRDG-LICENSE.md`). The files in `dict/jm/` are derived from it and carry the same licence.
- JLPT levels: Jonathan Waller's lists (CC BY) via yomitan-jlpt-vocab.
