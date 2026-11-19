#!/usr/bin/env python3
"""Builds the offline dictionary (dict/*.json) from the Princeton WordNet database files.

Usage:  python3 -I scripts/build-dict.py /path/to/wordnet/dict  dict/

Input  : WordNet 3.x `data.*` and `index.*` files (e.g. from the npm package `wordnet-db`).
Output : one small JSON file per two-letter prefix (aa.json, ab.json, ...) so that only the file for the word being
         looked up has to be fetched, plus manifest.json. Each entry: lemma -> [[pos, definition, [examples], [synonyms]], ...]
WordNet is (c) Princeton University, used under the WordNet licence (see dict/WORDNET-LICENSE.txt).
"""
import json, os, re, sys, collections

src, out = sys.argv[1], sys.argv[2]
POS = {'noun': 'n', 'verb': 'v', 'adj': 'a', 'adv': 'r'}
MAX_PER_POS, MAX_EX, MAX_SYN = 8, 2, 4

def read_data(name):
    syn = {}
    with open(os.path.join(src, f'data.{name}'), encoding='utf-8') as f:
        for line in f:
            if line.startswith('  '):          # licence header
                continue
            head, _, gloss = line.partition('|')
            parts = head.split()
            offset, wcnt = parts[0], int(parts[3], 16)
            words = [re.sub(r'\(\w+\)$', '', parts[4 + 2 * i]).replace('_', ' ') for i in range(wcnt)]
            gloss = gloss.strip()
            m = re.search(r';\s+"', gloss)
            definition = gloss[:m.start()] if m else gloss
            examples = re.findall(r'"([^"]+)"', gloss[m.start():]) if m else []
            syn[offset] = (words, definition.strip(), examples)
    return syn

entries = collections.defaultdict(list)       # lemma -> [[pos, definition, examples, synonyms]]
weights = collections.defaultdict(list)       # lemma -> [(usage count of that part of speech, pos code, senses)]
for name, code in POS.items():
    data = read_data(name)
    with open(os.path.join(src, f'index.{name}'), encoding='utf-8') as f:
        for line in f:
            if line.startswith('  '):
                continue
            p = line.split()
            lemma = p[0].replace('_', ' ')
            n_synsets, n_ptr = int(p[2]), int(p[3])
            offsets = p[6 + n_ptr:6 + n_ptr + n_synsets]
            tagged = int(p[5 + n_ptr])                # how often this part of speech was seen in tagged text
            senses = []
            for off in offsets[:MAX_PER_POS]:
                if off not in data:
                    continue
                words, definition, examples = data[off]
                syns = [w for w in words if w.lower() != lemma][:MAX_SYN]
                senses.append([code, definition, examples[:MAX_EX], syns])
            if senses:
                weights[lemma].append((tagged, code, senses))

# most common part of speech first (run: verb before noun)
for lemma, groups in weights.items():
    for _, _, senses in sorted(groups, key=lambda g: -g[0]):
        entries[lemma].extend(senses)

def shard(lemma):
    a = lemma[0] if lemma[0].isascii() and lemma[0].isalpha() else '_'
    b = lemma[1] if len(lemma) > 1 and lemma[1].isascii() and lemma[1].isalpha() else '_'
    return (a + b).lower()

shards = collections.defaultdict(dict)
for lemma, senses in entries.items():
    shards[shard(lemma)][lemma] = senses

os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.endswith('.json'):
        os.remove(os.path.join(out, f))
sizes = {}
for key, d in shards.items():
    path = os.path.join(out, f'{key}.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    sizes[key] = os.path.getsize(path)
with open(os.path.join(out, 'manifest.json'), 'w') as f:
    json.dump({'source': 'Princeton WordNet', 'words': len(entries), 'shards': sorted(sizes)}, f, separators=(',', ':'))
print(f'{len(entries)} words in {len(shards)} files, {sum(sizes.values()) / 1e6:.1f} MB, largest {max(sizes.values()) / 1e3:.0f} KB')
