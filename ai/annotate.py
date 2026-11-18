"""
Plays one game and records, for every decision, what each bot considered and why: a move
log with numbers, for looking for strategic mistakes.

    python3 -m ai.annotate [--map twin] [--dets 4] [--seed 0] [--json out.json]
        [-f alphabeta] [--fopts '{}'] [-d ismcts] [--dopts '{}']

Fugitive turns: the bot's top options with search scores, what the heuristic fugitive
  would have played, and distance / candidate-set / exit counts before and after.
Detective moves: (ISMCTS) visit counts, win estimates and prior of the top moves, the
  heuristic's choice, and the move the same search picks when shown the true station
  ("oracle"), plus true distances before and after.
Every action: the value model's P(detectives win) for the true position, so large swings
  mark the decisive moves.
"""
import argparse
import json
import random

import numpy as np

from . import engine as E
from . import policies as P
from .arena import make_fugitive, make_detectives, detective_view
from .value import ValueModel

TK = ('cab', 'tram', 'metro', 'secret')


def reach1(s, i):
    """Stations detective i can move to next (tickets permitting)."""
    m = s.map
    out = set()
    for t in range(3):
        if s.det_tickets[i][t] > 0:
            out.update(m.nbr[t][s.det_pos[i]])
    return out


def snapshot(s, value):
    """Position metrics from the true state."""
    m = s.map
    ids = m.ids
    cands = E.possible_locations(s)
    covered = set().union(*(reach1(s, i) for i in range(s.n)))
    masks = [E.ticket_mask(t) for t in s.det_tickets]
    dists = [int(m.dist[mk, p, s.fug_pos]) for mk, p in zip(masks, s.det_pos)]
    danger = m.dist[masks, s.det_pos].min(0)
    dests = {to for to, _ in E.fugitive_actions(s)} if not s.over else set()
    return {
        'fug': ids[s.fug_pos], 'dets': [ids[p] for p in s.det_pos],
        'cand': len(cands), 'cand_covered': sum(1 for c in cands if c in covered),
        'fug_in_reach': s.fug_pos in covered, 'det_dists': dists,
        'safe_exits': sum(1 for d in dests if danger[d] >= 2), 'exits': len(dests),
        'p_det': round(value(s), 3) if not s.over else float(s.winner == E.DETECTIVES_WIN),
        'fug_tickets': dict(zip(E.TICKET_NAMES, s.fug_tickets)),
        'det_tickets': [list(t) for t in s.det_tickets],
    }


def fmt_turn(m, actions):
    out = []
    for a in actions:
        out.append('DOUBLE' if a == P.DOUBLE else f'{TK[a[1]]}→{m.ids[a[0]]}')
    return ' '.join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--map', default='twin')
    ap.add_argument('--dets', type=int, default=4)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('-f', '--fugitive', default='alphabeta')
    ap.add_argument('--fopts', default='{}')
    ap.add_argument('-d', '--detectives', default='ismcts')
    ap.add_argument('--dopts', default='{}')
    ap.add_argument('--json')
    a = ap.parse_args(argv)
    gm = E.GameMap.load(a.map)
    ids = gm.ids
    fug = make_fugitive(a.fugitive, a.seed * 2 + 1, json.loads(a.fopts))
    det = make_detectives(a.detectives, a.seed * 2 + 2, json.loads(a.dopts))
    oracle = make_detectives(a.detectives, a.seed * 2 + 3, json.loads(a.dopts)) if a.detectives == 'ismcts' else None
    heur_f = P.HeuristicFugitive(noise=0)
    heur_d = P.HeuristicDetectives(noise=0)
    value = ValueModel.load()
    s = E.new_game(gm, a.dets, random.Random(a.seed))
    log = {'map': a.map, 'dets': a.dets, 'seed': a.seed, 'start': snapshot(s, value), 'events': []}
    st = log['start']
    print(f"{gm.name}, {a.dets} detectives. Fugitive starts {st['fug']}, detectives {st['dets']}, "
          f"{st['cand']} candidate starts. P(det win) {st['p_det']:.2f}\n")
    while not s.over:
        if s.phase == E.FUGITIVE_PHASE:
            before = snapshot(s, value)
            turn = fug.choose_turn(s)
            h = heur_f.choose_turn(s)
            P.apply_turn(s, turn)
            after = snapshot(s, value)
            ev = {'type': 'fugitive', 'round': s.round, 'turn': fmt_turn(gm, turn),
                  'heuristic': fmt_turn(gm, h), 'before': before, 'after': after}
            if hasattr(fug, 'last') and 'rankings' in fug.last:
                L = fug.last
                ev['search'] = {'depth': L['depth'], 'options': L['options'], 'nodes': L['nodes'],
                                'value': round(L['value'], 1),
                                'top_depth1': [(fmt_turn(gm, t), round(v, 1)) for t, v in L['rankings'][0][:4]],
                                'top_deepest': [(fmt_turn(gm, t), round(v, 1)) for t, v in L['rankings'][-1][:4]]}
            log['events'].append(ev)
            rev = ' REVEAL' if any(e[2] for e in s.log[-(len(turn) - (P.DOUBLE in turn)):]) else ''
            print(f"R{s.round:>2} F  {ev['turn']:<28}{rev:<7} dist→nearest {min(before['det_dists'])}→"
                  f"{min(after['det_dists'])}  cand {before['cand']}→{after['cand']}  "
                  f"safe exits {after['safe_exits']}/{after['exits']}  P(det) {before['p_det']:.2f}→{after['p_det']:.2f}"
                  + ('' if ev['heuristic'] == ev['turn'] else f"   [heuristic: {ev['heuristic']}]"))
            if 'search' in ev:
                sr = ev['search']
                print(f"      search d{sr['depth']} {sr['options']} options {sr['nodes']} nodes; "
                      f"depth-1 top: " + ', '.join(f'{t} {v}' for t, v in sr['top_depth1'][:3]))
        else:
            i = s.current
            before = snapshot(s, value)
            view = s.public_view()
            mv = det.choose_move(view)
            hm = heur_d.choose_move(view)
            om = oracle.choose_move(detective_view(s, oracle=True)) if oracle else None
            dist_before = before['det_dists'][i]
            E.move_detective(s, *mv)
            after = snapshot(s, value) if not s.over else {'p_det': 1.0, 'det_dists': [0] * s.n,
                                                             'cand': 0, 'cand_covered': 0}
            mask = E.ticket_mask(s.det_tickets[i])
            d_after = 0 if s.over and s.winner == E.DETECTIVES_WIN else int(gm.dist[mask, mv[0], s.fug_pos])
            ev = {'type': 'detective', 'round': s.round, 'det': i, 'move': f'{TK[mv[1]]}→{ids[mv[0]]}',
                  'heuristic': f'{TK[hm[1]]}→{ids[hm[0]]}',
                  'oracle': f'{TK[om[1]]}→{ids[om[0]]}' if om else None,
                  'true_dist': [dist_before, d_after], 'before': before, 'after': after}
            if hasattr(det, 'last') and 'children' in det.last:
                L = det.last
                pr = L.get('prior', {})
                ev['search'] = {'iterations': L['iterations'],
                                'top': [(f'{TK[x[1]]}→{ids[x[0]]}', n, q, round(pr.get(x, 0), 2))
                                        for x, n, q in L['children'][:4]]}
            log['events'].append(ev)
            flags = []
            if ev['heuristic'] != ev['move']:
                flags.append(f"heuristic: {ev['heuristic']}")
            if om and ev['oracle'] != ev['move']:
                od = int(gm.dist[7, om[0], s.fug_pos]) if not s.over else 0
                flags.append(f"oracle: {ev['oracle']} (dist {od})")
            print(f"    D{i} {ev['move']:<12} true dist {dist_before}→{d_after}  "
                  f"P(det) {before['p_det']:.2f}→{after['p_det']:.2f}"
                  + (f"   [{'; '.join(flags)}]" if flags else ''))
            if 'search' in ev:
                print('         ' + ', '.join(f'{m} n={n} q={q:.2f} p={p}' for m, n, q, p in ev['search']['top'][:3]))
            if s.phase == E.FUGITIVE_PHASE or s.over:
                if not s.over:
                    print(f"      after detectives: cand {after['cand']}, {after['cand_covered']} of them in "
                          f"detectives' reach; fugitive {'IN' if after['fug_in_reach'] else 'not in'} reach; "
                          f"P(det) {after['p_det']:.2f}")
    log['result'] = {'winner': 'detectives' if s.winner == E.DETECTIVES_WIN else 'fugitive',
                     'reason': s.reason, 'round': s.round}
    print(f"\nResult: {log['result']['winner']} ({s.reason}) after {s.round} fugitive moves")
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(log, fh, indent=1, default=str)


if __name__ == '__main__':
    main()
