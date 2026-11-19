"""Positions and the Python bots' answers on them, for tests/ai_parity.test.js (which
checks the JavaScript port in js/ai/ gives the same answers):

    python3 tools/ai_parity_fixture.py        # writes tests/fixtures/ai_parity.json

Rerun after changing the maps or the Python bots. Games are alpha-beta fugitive vs
heuristic detectives, recorded in the page's record format.
"""
import json
import random
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ai import engine as E  # noqa: E402
from ai import fast as F  # noqa: E402
from ai import fast_tree as FT  # noqa: E402
from ai import policies as P  # noqa: E402
from ai.alphabeta import AlphaBetaFugitive  # noqa: E402
from ai.ismcts import ISMCTSDetectives  # noqa: E402
from ai.value import ValueModel  # noqa: E402

OUT = ROOT / 'tests' / 'fixtures' / 'ai_parity.json'


def turn_js(gm, turn):
    return ['double' if a == P.DOUBLE else [gm.ids[a[0]], E.TICKET_NAMES[a[1]]] for a in turn]


def main():
    value = ValueModel.load()
    W = F.full_weights(value)
    games = []
    for key in E.GameMap.keys():
        gm = E.GameMap.load(key)
        for k, seed in ((3, 1), (5, 2)):
            rng = random.Random(seed)
            s = E.new_game(gm, k, rng)
            rec = {'id': f'parity-{key}-{k}', 'mode': 'human-detectives', 'map': key, 'mapSeed': gm.seed,
                   'detectives': k, 'fugitiveStart': gm.ids[s.fug_pos],
                   'detectiveStarts': [gm.ids[p] for p in s.det_pos], 'history': []}
            fug = AlphaBetaFugitive(seed=seed)
            det = P.HeuristicDetectives(seed=seed, noise=0.1)
            watcher = ISMCTSDetectives(iterations=8, seed=0)
            checks = []
            while not s.over:
                c = {'upto': len(rec['history'])}
                c['value'] = float(value(s))
                c['danger'] = P.danger_vector(s).tolist()
                c['playout'] = float(F.playout_values([s.clone()], 2, W, fnoise=0, dnoise=0)[0])
                if s.phase == E.FUGITIVE_PHASE:
                    c['actions'] = [[gm.ids[v], t] for v, t in E.fugitive_actions(s)]
                    c['ranked'] = [turn_js(gm, t) for t in FT.ranked_turns(s)]
                    turn = fug.choose_turn(s)
                    c['ab_depth1'] = [[turn_js(gm, t), v] for t, v in fug.last['rankings'][0]]
                    c['ab_value'] = fug.last['value']
                    c['ab_turn'] = turn_js(gm, turn)
                    checks.append(c)
                    for a in turn:
                        if a == P.DOUBLE:
                            rec['history'].append({'side': 'F', 'type': 'double'})
                            E.use_double(s)
                        else:
                            rec['history'].append({'side': 'F', 'to': gm.ids[a[0]], 'ticket': E.TICKET_NAMES[a[1]]})
                            E.move_fugitive(s, *a)
                else:
                    pub = s.public_view()
                    mass = watcher.belief_mass(pub)
                    c['belief'] = {str(gm.ids[v]): float(mass[v]) for v in np.flatnonzero(mass > 1e-12)}
                    c['posterior'] = watcher.last_posterior.tolist()
                    c['det_actions'] = [[gm.ids[v], t] for v, t in E.detective_actions(s)]
                    c['det_scores'] = [[gm.ids[a[0]], a[1], x] for a, x in FT.det_scores(s, 0.3, 3)]
                    checks.append(c)
                    to, t = det.choose_move(pub)
                    rec['history'].append({'side': 'D', 'i': s.current, 'to': gm.ids[to], 'ticket': E.TICKET_NAMES[t]})
                    E.move_detective(s, to, t)
            rec['result'] = {'winner': {E.DETECTIVES_WIN: 'detectives', E.FUGITIVE_WINS: 'fugitive'}[s.winner],
                             'round': s.round}
            games.append({'record': rec, 'checks': checks})
            print(key, k, len(rec['history']), 'actions', len(checks), 'checks', rec['result'])
    OUT.write_text(json.dumps(games))
    print(f'wrote {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
