#!/usr/bin/env python3
"""Build the sharded dictionary used by the Bible reader PWA.

Inputs:
  jamdict.db     JMdict + JMnedict (from the jamdict-data PyPI package)
  jlpt.json      Furifont's yomitan-jlpt-vocab list (word, furigana spec, level)
  names.json     curated Bible names {katakana: english}

Output (in OUT_DIR):
  jm/NN.json     shards: {"e": {id: entry}, "k": {key: [id, ...]}}
  manifest.json  {"format": "jm-shards-1", "shards": N, ...}

Shard of a key = FNV-1a over its UTF-16 code units, mod N (same function in dict.js).
"""
import json, os, re, sqlite3, sys, collections

DB, JLPT, NAMES, OUT = sys.argv[1:5]
TERMS = os.path.join(os.path.dirname(NAMES), 'terms.json')
N_SHARDS = 96
MAX_SENSES = 5
MAX_GLOSS = 4
INCLUDE_NE = False

def fnv1a(s):
    h = 0x811C9DC5
    b = s.encode('utf-16-le')
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

POS_RULES = [
    (r"^noun \(common\)", "noun"),
    (r"takes the aux\. verb suru", "suru noun"),
    (r"^suru verb", "suru verb"),
    (r"^su verb", "su verb"),
    (r"^expressions", "expression"),
    (r"genitive case particle 'no'", "no-adj"),
    (r"^adjectival nouns", "na-adj"),
    (r"^archaic/formal form of na-adjective", "nari-adj"),
    (r"^transitive verb", "transitive"),
    (r"^intransitive verb", "intransitive"),
    (r"^Ichidan verb", "ichidan verb"),
    (r"^Godan verb", "godan verb"),
    (r"^Kuru verb", "kuru verb"),
    (r"^(Nidan|Yodan) verb", "archaic verb"),
    (r"^irregular (nu|ru) verb", "irregular verb"),
    (r"^adverb taking the 'to'", "adverb (to)"),
    (r"^adverb", "adverb"),
    (r"^adjective \(keiyoushi\)", "i-adj"),
    (r"'(ku|shiku)' adjective", "archaic adj"),
    (r"'taru' adjective", "taru-adj"),
    (r"^noun or verb acting prenominally", "prenominal"),
    (r"^noun, used as a prefix", "prefix"),
    (r"^noun, used as a suffix", "suffix"),
    (r"^interjection", "interjection"),
    (r"^pre-noun adjectival", "pre-noun adj"),
    (r"^auxiliary adjective", "aux adj"),
    (r"^auxiliary verb", "aux verb"),
    (r"^auxiliary", "auxiliary"),
    (r"^(suffix|prefix|pronoun|counter|particle|conjunction|copula|numeric)$", None),
    (r"^(unclassified|verb unspecified)$", None),
]

def short_pos(p):
    for pat, rep in POS_RULES:
        if re.search(pat, p):
            return rep if rep else p.split(' ')[0]
    return p

MISC = {
    'word usually written using kana alone': 'usually kana',
    'archaism': 'archaic',
    'obsolete term': 'obsolete',
    'honorific or respectful (sonkeigo) language': 'honorific',
    'humble (kenjougo) language': 'humble',
    'polite (teineigo) language': 'polite',
    'literary or formal term': 'formal',
    'poetical term': 'poetic',
    'yojijukugo': 'four-character idiom',
    'idiomatic expression': 'idiom',
    'proverb': 'proverb',
    'colloquialism': 'colloquial',
    'derogatory': 'derogatory',
    'historical term': 'historical',
    'dated term': 'dated',
    'rare': 'rare',
    'obscure term': 'obscure',
    'onomatopoeic or mimetic word': 'onomatopoeia',
}

COMMON_TAGS = {'news1', 'ichi1', 'spec1', 'spec2', 'gai1'}

def kata2hira(s):
    return ''.join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in s)

def jlpt_reading(word, spec):
    if not spec:
        return word
    rep = {}
    for part in spec.split(';'):
        pos, rd = part.split(':', 1)
        if '-' in pos:
            a, b = map(int, pos.split('-'))
        else:
            a = b = int(pos)
        rep[a] = (b, rd)
    out, i = [], 0
    while i < len(word):
        if i in rep:
            b, rd = rep[i]
            out.append(rd)
            i = b + 1
        else:
            out.append(word[i])
            i += 1
    return kata2hira(''.join(out))

def main():
    c = sqlite3.connect(DB)
    os.makedirs(os.path.join(OUT, 'jm'), exist_ok=True)

    jlpt = {}
    for w, spec, lvl in json.load(open(JLPT, encoding='utf-8')):
        jlpt[(w, jlpt_reading(w, spec))] = lvl

    kanji = collections.defaultdict(list)
    kcommon = set()
    for kid, idseq, text in c.execute('select ID, idseq, text from Kanji order by ID'):
        kanji[idseq].append((kid, text))
    for kid, tag in c.execute('select kid, text from KJP'):
        if tag in COMMON_TAGS:
            kcommon.add(kid)
    kana = collections.defaultdict(list)
    rcommon = set()
    for rid, idseq, text in c.execute('select ID, idseq, text from Kana order by ID'):
        kana[idseq].append((rid, text))
    for rid, tag in c.execute('select kid, text from KNP'):
        if tag in COMMON_TAGS:
            rcommon.add(rid)

    senses = collections.defaultdict(list)
    for sid, idseq in c.execute('select ID, idseq from Sense order by ID'):
        senses[idseq].append(sid)
    pos = collections.defaultdict(list)
    for sid, t in c.execute('select sid, text from pos'):
        sp = short_pos(t)
        if sp not in pos[sid]:
            pos[sid].append(sp)
    misc = collections.defaultdict(list)
    for sid, t in c.execute('select sid, text from misc'):
        if t in MISC:
            misc[sid].append(MISC[t])
    gloss = collections.defaultdict(list)
    for sid, lang, t in c.execute("select sid, lang, text from SenseGloss where lang is null or lang='' or lang='eng'"):
        gloss[sid].append(t)

    shards = [{'e': {}, 'k': {}} for _ in range(N_SHARDS)]

    def add(key, eid, entry, home=None):
        """Store entry in its home shard; other keys point at it as "NN:id"."""
        si = fnv1a(key) % N_SHARDS
        sh = shards[si]
        if home is None or home == si:
            sh['e'][eid] = entry
            ref = eid
        else:
            ref = '%d:%s' % (home, eid)
        lst = sh['k'].setdefault(key, [])
        if ref not in lst:
            lst.append(ref)

    n_entries = 0
    for (idseq,) in c.execute('select idseq from Entry'):
        ks = kanji.get(idseq, [])
        rs = kana.get(idseq, [])
        if not rs:
            continue
        common = any(k[0] in kcommon for k in ks) or any(r[0] in rcommon for r in rs)
        ss = []
        last_pos = []
        for sid in senses.get(idseq, []):
            g = gloss.get(sid)
            if not g:
                continue
            p = pos.get(sid) or last_pos  # JMdict: POS carries over from the previous sense
            last_pos = p
            s = [p, g[:MAX_GLOSS]]
            if misc.get(sid):
                s.append(misc[sid])
            ss.append(s)
            if len(ss) >= MAX_SENSES:
                break
        if not ss:
            continue
        e = {'k': [k[1] for k in ks], 'r': [r[1] for r in rs], 's': ss}
        if common:
            e['c'] = 1
        lv = 0
        for k in ([k[1] for k in ks] or [r[1] for r in rs]):
            for r in rs:
                lv = max(lv, jlpt.get((k, r[1]), 0))
        if lv:
            e['j'] = lv
        eid = str(idseq)
        # Kana spellings are keys only when the word is (often) written in kana;
        # kanji words are found by their kanji form. Keeps each entry in ~1 shard.
        usually_kana = any('usually kana' in (x[2] if len(x) > 2 else []) for x in ss)
        keys = set(e['k'])
        if not e['k'] or usually_kana or common or lv:
            keys |= set(e['r'])
        primary = (e['k'] or e['r'])[0]
        home = fnv1a(primary) % N_SHARDS
        shards[home]['e'][eid] = e
        for key in sorted(keys):
            add(key, eid, e, home)
        n_entries += 1

    # JMnedict: katakana-only names (Bible names are written in katakana)
    kat = re.compile('^[゠-ヿ]+$')
    ne_trans = collections.defaultdict(list)
    q = '''select tr.idseq, t.text, g.text from NETranslation tr
           join NETransGloss g on g.tid = tr.ID
           left join NETransType t on t.tid = tr.ID'''
    for idseq, typ, g in c.execute(q):
        lst = ne_trans[idseq]
        if len(lst) < 3 and [typ, g] not in lst:
            lst.append([typ or '', g])
    if not INCLUDE_NE:
        ne_trans = {}
    has_kanji = set(r[0] for r in c.execute('select distinct idseq from NEKanji'))
    n_names = 0
    for idseq, text in c.execute('select idseq, text from NEKana'):
        if idseq in has_kanji or not kat.match(text) or idseq not in ne_trans:
            continue
        add(text, 'n' + str(idseq), {'r': [text], 'n': ne_trans[idseq]})
        n_names += 1

    # Curated Bible names take priority over JMnedict
    names = json.load(open(NAMES, encoding='utf-8'))
    for i, (kana_name, info) in enumerate(names.items()):
        e = {'r': [kana_name], 'b': info}
        sh = shards[fnv1a(kana_name) % N_SHARDS]
        eid = 'b' + str(i)
        sh['e'][eid] = e
        sh['k'].setdefault(kana_name, []).insert(0, eid)

    # Curated Bible readings/senses that JMdict lacks (marked p: preferred)
    if os.path.exists(TERMS):
        for i, t in enumerate(json.load(open(TERMS, encoding='utf-8'))):
            e = {'k': t['k'], 'r': t['r'], 's': t['s'], 'p': 1}
            eid = 't' + str(i)
            home = fnv1a((e['k'] or e['r'])[0]) % N_SHARDS
            shards[home]['e'][eid] = e
            for key in set(e['k']) | set(e['r']):
                si = fnv1a(key) % N_SHARDS
                ref = eid if si == home else '%d:%s' % (home, eid)
                shards[si]['k'].setdefault(key, []).insert(0, ref)

    total = 0
    for i, sh in enumerate(shards):
        p = os.path.join(OUT, 'jm', '%02d.json' % i)
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(sh, f, ensure_ascii=False, separators=(',', ':'))
        total += os.path.getsize(p)
    manifest = {
        'format': 'jm-shards-1',
        'shards': N_SHARDS,
        'hash': 'fnv1a-utf16',
        'sources': {
            'JMdict': dict(c.execute("select key, value from meta where key like 'jmdict%'").fetchall()),
            'JMnedict': dict(c.execute("select key, value from meta where key like 'jmnedict%'").fetchall()),
            'JLPT': 'yomitan-jlpt-vocab (via Furifont)',
        },
        'entries': n_entries,
        'names': n_names,
    }
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    print('entries', n_entries, 'names', n_names, 'bytes', total)

main()
