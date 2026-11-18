"""
Batched heuristic-vs-heuristic simulation, the numpy counterpart of tools/simulate.js.

    python3 -m ai.simulate [games] [--maps twin,harbour] [--dets 3,4,5] [--mode heuristic|random]
"""
import argparse
import time

import numpy as np

from . import engine as E
from . import policies as P
from .vec_engine import VecGames, play, RC


def run(gmap, k, games, mode, seed):
    rng = np.random.default_rng(seed)
    g = VecGames.new(gmap, games, k, rng)
    if mode == 'heuristic':
        play(g, P.vec_heuristic_fugitive(), P.vec_heuristic_detective(), rng)
    else:
        play(g, P.vec_random_fugitive(), P.vec_random_detective(), rng)
    return g


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('games', nargs='?', type=int, default=1000)
    ap.add_argument('--maps', default=','.join(E.GameMap.keys()))
    ap.add_argument('--dets', default='3,4,5')
    ap.add_argument('--mode', default='heuristic', choices=['heuristic', 'random'])
    ap.add_argument('--seed', type=int, default=1234)
    a = ap.parse_args(argv)
    print(f'{a.games} games per row, {a.mode} players. Detective win % (±95% CI), avg capture round,')
    print('fugitive wins split into survived / detectives stuck.\n')
    print(f"{'map':<14}{'dets':>5}{'det win':>10}{'':>8}{'capture rd':>11}   survived / stuck   games/s")
    for key in a.maps.split(','):
        gm = E.GameMap.load(key)
        for k in map(int, a.dets.split(',')):
            t0 = time.perf_counter()
            g = run(gm, k, a.games, a.mode, a.seed + k)
            dt = time.perf_counter() - t0
            n = a.games
            dw = g.winner == E.DETECTIVES_WIN
            p = dw.mean()
            ci = 1.96 * np.sqrt(p * (1 - p) / n)
            rd = g.round[dw].mean() if dw.any() else float('nan')
            surv = (g.reason == RC[E.R_SURVIVED]).sum()
            stuck = (g.reason == RC[E.R_DETS_STUCK]).sum()
            print(f'{gm.name:<14}{k:>5}{100 * p:>9.1f}% ±{100 * ci:<5.1f}{rd:>11.1f}   {surv:>8} / {stuck:<6}'
                  f'{n / dt:>10.0f}')


if __name__ == '__main__':
    main()
