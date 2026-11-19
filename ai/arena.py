"""
Bot-vs-bot matches through the scalar engine, spread over worker processes.

    python3 -m ai.arena --fugitive alphabeta --detectives heuristic --games 200
    python3 -m ai.arena -f heuristic -d ismcts --dets 4 --maps twin --games 100 --workers 12

Fugitive bots:   random, heuristic, alphabeta
Detective bots:  random, heuristic, ismcts
Bot options go in as JSON: --fopts '{"depth": 2}'  --dopts '{"iterations": 2000}'

Detective bots only ever see state.public_view() (no fugitive position), unless --oracle is
given: a diagnostic where the detectives' candidate set is the fugitive's true station, to
measure how much of their losing comes from not knowing where it is.
"""
import argparse
import json
import os
import random
import sys
import time

for _v in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_v, '1')  # one BLAS thread per worker process

import numpy as np  # noqa: E402

from . import engine as E  # noqa: E402
from . import policies as P  # noqa: E402

_MAPS = {}


def get_map(key):
    if key not in _MAPS:
        _MAPS[key] = E.GameMap.load(key)
    return _MAPS[key]


def make_fugitive(name, seed, opts):
    if name == 'random':
        return P.RandomFugitive(seed=seed, **opts)
    if name == 'heuristic':
        return P.HeuristicFugitive(seed=seed, **opts)
    if name == 'alphabeta':
        from .alphabeta import AlphaBetaFugitive
        return AlphaBetaFugitive(seed=seed, **opts)
    raise ValueError(f'unknown fugitive bot {name}')


def make_detectives(name, seed, opts):
    if name == 'random':
        return P.RandomDetectives(seed=seed, **opts)
    if name == 'heuristic':
        return P.HeuristicDetectives(seed=seed, **opts)
    if name == 'ismcts':
        from .ismcts import ISMCTSDetectives
        return ISMCTSDetectives(seed=seed, **opts)
    raise ValueError(f'unknown detective bot {name}')


def detective_view(s, oracle=False):
    view = s.public_view()
    if oracle:
        c = np.zeros(s.map.n, dtype=bool)
        c[s.fug_pos] = True
        view.cand = c
    return view


def play_game(gmap, k, fug, det, rng, oracle=False):
    """One game; returns (state, seconds spent by fugitive bot, by detective bot, decisions,
    the fugitive's room to run after each detective round)."""
    s = E.new_game(gmap, k, rng)
    tf = td = 0.0
    nf = nd = 0
    rooms = []  # the fugitive's room to run (true position) after each detective round
    while not s.over:
        if s.phase == E.FUGITIVE_PHASE:
            t = time.perf_counter()
            actions = fug.choose_turn(s)
            tf += time.perf_counter() - t
            nf += 1
            P.apply_turn(s, actions)
        else:
            t = time.perf_counter()
            to, tk = det.choose_move(detective_view(s, oracle))
            td += time.perf_counter() - t
            nd += 1
            E.move_detective(s, to, tk)
            if s.phase == E.FUGITIVE_PHASE:
                rooms.append(P.room_to_run(s))
    return s, tf, td, nf, nd, rooms


def _worker(job):
    key, k, seed, fname, fopts, dname, dopts, oracle = job
    gmap = get_map(key)
    fug = make_fugitive(fname, seed * 2 + 1, fopts)
    det = make_detectives(dname, seed * 2 + 2, dopts)
    s, tf, td, nf, nd, rooms = play_game(gmap, k, fug, det, random.Random(seed), oracle)
    return {'map': key, 'k': k, 'winner': s.winner, 'round': s.round, 'reason': s.reason,
            'room': sum(rooms) / len(rooms) if rooms else 0.0,
            'tf': tf, 'td': td, 'nf': nf, 'nd': nd}


def run_matches(fname, dname, maps, dets, games, workers=None, fopts=None, dopts=None, seed=0,
                progress=True, oracle=False):
    jobs = []
    for key in maps:
        for k in dets:
            for i in range(games):
                # same seed → same start positions, whichever bots are playing
                jobs.append((key, k, seed + 1000 * k + i, fname, fopts or {}, dname, dopts or {}, oracle))
    results = []
    workers = workers or max(1, (os.cpu_count() or 2) - 2)
    t0 = time.perf_counter()
    if workers == 1:
        it = map(_worker, jobs)
    else:
        import multiprocessing as mp
        pool = mp.get_context('spawn').Pool(workers)
        it = pool.imap_unordered(_worker, jobs)
    for n, r in enumerate(it, 1):
        results.append(r)
        if progress and (n % max(1, len(jobs) // 20) == 0 or n == len(jobs)):
            print(f'\r  {n}/{len(jobs)} games, {time.perf_counter() - t0:.0f}s', end='', file=sys.stderr)
    if progress:
        print(file=sys.stderr)
    if workers != 1:
        pool.close()
    return results


def summarize(results, maps, dets):
    rows = []
    for key in maps:
        for k in dets:
            rs = [r for r in results if r['map'] == key and r['k'] == k]
            if not rs:
                continue
            n = len(rs)
            dw = [r for r in rs if r['winner'] == E.DETECTIVES_WIN]
            p = len(dw) / n
            rows.append({
                'map': key, 'k': k, 'n': n, 'det_win': p, 'ci': 1.96 * (p * (1 - p) / n) ** 0.5,
                'capture_round': float(np.mean([r['round'] for r in dw])) if dw else float('nan'),
                'survived': sum(r['reason'] == E.R_SURVIVED for r in rs),
                'stuck': sum(r['reason'] == E.R_DETS_STUCK for r in rs),
                'fug_ms': 1000 * sum(r['tf'] for r in rs) / max(1, sum(r['nf'] for r in rs)),
                'det_ms': 1000 * sum(r['td'] for r in rs) / max(1, sum(r['nd'] for r in rs)),
            })
    return rows


def print_rows(rows, title):
    print(title)
    print(f"{'map':<10}{'dets':>5}{'games':>7}{'det win':>10}{'':>8}{'capt rd':>9}"
          f"{'survived':>10}{'stuck':>7}{'fug ms/turn':>13}{'det ms/move':>13}")
    for r in rows:
        print(f"{r['map']:<10}{r['k']:>5}{r['n']:>7}{100 * r['det_win']:>9.1f}% ±{100 * r['ci']:<5.1f}"
              f"{r['capture_round']:>9.1f}{r['survived']:>10}{r['stuck']:>7}{r['fug_ms']:>13.1f}{r['det_ms']:>13.1f}")
    tot = sum(r['n'] for r in rows)
    if len(rows) > 1:
        p = sum(r['det_win'] * r['n'] for r in rows) / tot
        print(f"{'all':<10}{'':>5}{tot:>7}{100 * p:>9.1f}% ±{196 * (p * (1 - p) / tot) ** 0.5:<5.1f}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('-f', '--fugitive', default='heuristic')
    ap.add_argument('-d', '--detectives', default='heuristic')
    ap.add_argument('--fopts', default='{}', help='JSON keyword arguments for the fugitive bot')
    ap.add_argument('--dopts', default='{}', help='JSON keyword arguments for the detective bot')
    ap.add_argument('--maps', default='twin')
    ap.add_argument('--dets', default='4')
    ap.add_argument('--games', type=int, default=100, help='games per map and detective count')
    ap.add_argument('--workers', type=int, default=None)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--json', help='also write per-game results here')
    ap.add_argument('--oracle', action='store_true', help='diagnostic: detectives see the true station')
    a = ap.parse_args(argv)
    maps = E.GameMap.keys() if a.maps == 'all' else a.maps.split(',')
    dets = [int(x) for x in a.dets.split(',')]
    fopts, dopts = json.loads(a.fopts), json.loads(a.dopts)
    res = run_matches(a.fugitive, a.detectives, maps, dets, a.games, a.workers, fopts, dopts, a.seed,
                      oracle=a.oracle)
    print_rows(summarize(res, maps, dets),
               f'fugitive={a.fugitive} {a.fopts}  vs  detectives={a.detectives} {a.dopts}'
               + ('  [ORACLE]' if a.oracle else ''))
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(res, fh)


if __name__ == '__main__':
    main()
