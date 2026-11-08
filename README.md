This is mostly just a PWA I needed for something, and needed on github pages to be able to install on my phone. To be honest, probably not something useful to most people (It's setup as a BYO Bible system). AI generated explanation below (in case someone else finds things useful.):



# 聖書 Reader

A reader for a Japanese Bible text file, one chapter per page, in the style of Readle:

- Furifont draws the furigana. The word analyzer's readings pick the right furigana where a kanji has several.
- Tap a word to see its dictionary form, reading, meanings, JLPT level, and grammar notes for the inflection, such as "passive" or "past".
- The **Vocabulary** tab lists every word in the chapter with its first meaning and how often it appears. Tap a word in the list to jump to it in the text.
- Chapters can be marked as read, and the library shows progress for each book.
- It's an installable PWA and works offline after the first load.

The Bible text is **not** included. You load your own file in the app, and it's stored only in that browser (IndexedDB). That keeps the hosted files free of the translation's copyright.

## Text format

One verse per line, starting with a book code and chapter:verse:

```
Gen 1:1 初めに、神は天地を創造された。
Gen 1:2 地は混沌であって、…
```

UTF-16 (with or without BOM), UTF-8 and Shift_JIS are all detected. Book codes match the JSD file (Gen … Rev, including `Sol` for Song of Songs and `Joe` for Joel). Unknown codes still load and are listed under their code.

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

Readings the analyzer gets wrong for this translation can be corrected in `READING_OVERRIDES` in `js/nlp.js` (currently 主 → しゅ, 言 → ことば).

## How the furigana are chosen

kuromoji (IPADIC) splits each verse into words and gives each word a reading. For each run of kanji, `js/nlp.js` then does one of three things:

- Leaves the run alone when Furifont's default reading already matches.
- Inserts one of Furifont's variation selectors (U+E01E1…) to pick the matching alternative from `fonts/FurifontSansVF.ivs.json`.
- Draws a small `<ruby>` itself when the font has no such reading. In that case it also turns off the font's own furigana for that run.

Words are grouped Readle-style: a verb keeps its endings (創造された), and a prefix or suffix stays with its noun. Runs of kanji are never split across words, so the font always sees whole words.

## Licences

- Furifont: SIL Open Font License 1.1 (`licenses/Furifont-OFL.txt`); its data credits are in `licenses/Furifont-DATA-LICENSE.md`.
- kuromoji.js and its IPADIC build: Apache 2.0 (`licenses/kuromoji-*`). `lib/kuromoji.js` is patched so it accepts dictionary files a server has already un-gzipped.
- JMdict / JMnedict: © EDRDG, CC BY-SA 4.0 (`licenses/JMdict-EDRDG-LICENSE.md`). The files in `dict/jm/` are derived from it and carry the same licence.
- JLPT levels: Jonathan Waller's lists (CC BY) via yomitan-jlpt-vocab.
