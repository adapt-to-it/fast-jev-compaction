# Banco di prova delle regole, passo 3: punteggio delle varianti contro le etichette dei giudici.
# Uso: python3 -I examples/rules/score.py /tmp/rules-eval/v2 [variante...]
# Per ogni variante prova le regole di scelta (soglia, distanza dalla migliore, massimo),
# sceglie la migliore sui casi di taratura e la riporta sui casi da parte.
import json, glob, os, sys, itertools

root = sys.argv[1]
labels, holdout, project = {}, {}, {}
for f in glob.glob(f'{root}/*/labels-*.json'):
    for x in json.load(open(f)):
        labels[x['id']] = (set(x['needed']), set(x.get('related', [])))
for f in glob.glob(f'{root}/*/cases.json'):
    for c in json.load(open(f)):
        holdout[c['id']] = c['holdout']; project[c['id']] = c['id'].split('-')[0]
# Introduzione di un file (il testo prima del primo titolo): sempre reinserita, fuori dalla scelta.
always = {}
for f in glob.glob(f'{root}/*/units.json'):
    p = f.split('/')[-2]
    always[p] = {u['id'] for u in json.load(open(f)) if not u['title']}
for i, (need, rel) in list(labels.items()):
    a = always.get(i.split('-')[0], set())
    labels[i] = (need - a, rel | a)

def select(probs, t, m, k, skip=frozenset()):
    ranked = sorted(((p, u) for u, p in probs.items() if u != 'none' and p is not None and u not in skip), reverse=True)
    if not ranked: return []
    top = ranked[0][0]
    if probs.get('none', 0) > top: return []
    return [u for p, u in ranked if p >= max(t, top - m)][:k]

def score(res, ids, rule):
    wrong_cases = miss = needed = chosen = success = 0
    for i in ids:
        need, rel = labels[i]
        s = set(select(res[i], *rule, skip=always[project[i]]))
        wrong_cases += bool(s - need - rel)
        success += not (s - need - rel) and (bool(s & need) or not need)
        miss += len(need - s); needed += len(need); chosen += len(s)
    n = len(ids) or 1
    return {'errori': wrong_cases / n, 'recall': 1 - miss / max(needed, 1), 'scelte': chosen / n, 'riusciti': success / n}

def key(s):  # casi riusciti (nessuna unità sbagliata e almeno una necessaria), poi recall
    return (-s['riusciti'], -s['recall'])

variants = sys.argv[2:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(f'{root}/results/*.json'))
grid = list(itertools.product([0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], [0.02, 0.05, 0.1, 0.2, 1.0], [1, 2, 3, 5, 8]))
for v in variants:
    res = json.load(open(f'{root}/results/{v}.json'))
    ok = [i for i in res if i in labels and 'error' not in res[i]]
    errs = len([i for i in res if 'error' in res[i]])
    dev = [i for i in ok if not holdout[i]]; hold = [i for i in ok if holdout[i]]
    best = min(grid, key=lambda r: key(score(res, dev, r)))
    d, h = score(res, dev, best), score(res, hold, best)
    print(f'\n{v}: {len(dev)} taratura, {len(hold)} da parte, {errs} errori di chiamata; regola soglia={best[0]} distanza={best[1]} max={best[2]}')
    print(f'  taratura: riusciti {d["riusciti"]:.0%}, con scelte sbagliate {d["errori"]:.0%}, decisioni necessarie trovate {d["recall"]:.0%}, unità scelte {d["scelte"]:.1f}')
    print(f'  da parte: riusciti {h["riusciti"]:.0%}, con scelte sbagliate {h["errori"]:.0%}, decisioni necessarie trovate {h["recall"]:.0%}, unità scelte {h["scelte"]:.1f}')
    for p in sorted(set(project[i] for i in ok)):
        s = score(res, [i for i in ok if project[i] == p], best)
        print(f'    {p}: riusciti {s["riusciti"]:.0%}, sbagliati {s["errori"]:.0%}, trovate {s["recall"]:.0%}, scelte {s["scelte"]:.1f}')
    if '-v' in sys.argv[2:] or len(variants) == 1:
        for i in ok:
            s = set(select(res[i], *best, skip=always[project[i]])); need, rel = labels[i]
            if s - need - rel or need - s:
                print(f'    {i}: sbagliate {sorted(s - need - rel)} mancate {sorted(need - s)}')
