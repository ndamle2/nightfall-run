"""
Learned position value: P(detectives win | position), for scoring search leaves.

A logistic regression on hand-made features of a position *with the fugitive's station
known* (search leaves are determinized, so it always is). It is fitted to the outcomes of
games between the bots, recorded after every action:

    python3 -m ai.value fit [--games 60] [--workers 12]
    python3 -m ai.value fit --detectives ismcts --dopts '{"iterations":512,"rollout_rounds":0}' \
        --save-data gen1.npz --out ai/value_weights_gen1.json

which writes ai/value_weights.json (or --out) and prints held-out accuracy. ISMCTS loads that
file (or its value_path). Datasets saved with --save-data can be refitted or combined
without replaying games: --data a.npz,b.npz.
"""
import argparse
import json
import math
import os
import random
import time
from pathlib import Path

for _v in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_v, '1')

import numpy as np  # noqa: E402

from . import engine as E  # noqa: E402
from . import policies as P  # noqa: E402

WEIGHTS_FILE = Path(__file__).with_name('value_weights.json')
NEXT_REVEAL = [min([r for r in E.REVEAL_ROUNDS if r > x], default=E.MAX_ROUNDS + 1)
               for x in range(E.MAX_ROUNDS + 1)]

FEATURES = [
    'bias', 'd1_is1', 'd1_is2', 'd1_is3', 'd1_is4', 'd2', 'dmean', 'near2',
    'log_cand', 'cand_is1', 'rounds_left', 'to_reveal', 'safe_exits', 'moves',
    'doubles', 'secrets', 'det_tickets', 'det_phase', 'capture_threat', 'k',
    'room', 'room_small',
]
# Weights files fitted before these features existed list fewer; ValueModel uses the
# columns its file names, so older files keep working.


def features(s):
    """Feature vector of a non-terminal state whose fug_pos is known."""
    m = s.map
    f = s.fug_pos
    masks = [E.ticket_mask(t) for t in s.det_tickets]
    d = sorted(min(int(m.dist[mk, p, f]), 10) for mk, p in zip(masks, s.det_pos))
    d1 = d[0]
    d2 = d[1] if len(d) > 1 else 10
    danger = m.dist[masks, s.det_pos].min(0)
    dests = {to for to, _ in E.fugitive_actions(s)}
    safe = sum(1 for to in dests if danger[to] >= 2)
    n_cand = max(1, int(s.cand.sum()) - sum(1 for p in s.det_pos if s.cand[p]))
    det_phase = s.phase == E.DETECTIVE_PHASE
    threat = det_phase and any(
        int(m.dist[masks[i], s.det_pos[i], f]) == 1 for i in range(max(s.current, 0), s.n))
    nxt = NEXT_REVEAL[s.round]
    room = P.room_to_run(s, danger)
    return [
        1.0, d1 == 1, d1 == 2, d1 == 3, d1 == 4, d2 / 10, sum(d) / (10 * len(d)),
        sum(1 for x in d if x <= 2) / 5,
        math.log2(n_cand) / 7, n_cand == 1, (E.MAX_ROUNDS - s.round) / 24, (nxt - s.round) / 5,
        min(safe, 8) / 8, min(len(dests), 12) / 12,
        s.fug_tickets[E.DOUBLE] / 2, min(s.fug_tickets[E.SECRET], 5) / 5,
        sum(sum(t) for t in s.det_tickets) / (22 * s.n), det_phase, threat, s.n / 5,
        min(room, 30) / 30, room <= 4,
    ]


class ValueModel:
    def __init__(self, weights, names=None):
        names = names or FEATURES[:len(weights)]
        unknown = set(names) - set(FEATURES)
        if unknown:
            raise ValueError(f'unknown value features {sorted(unknown)}: refit the weights')
        self.w = np.asarray(weights, dtype=float)
        self.cols = np.array([FEATURES.index(n) for n in names])

    @classmethod
    def load(cls, path=WEIGHTS_FILE):
        if not Path(path).exists():
            raise FileNotFoundError(f'{path} is missing: run `python3 -m ai.value fit` first')
        data = json.loads(Path(path).read_text())
        return cls(data['weights'], data['features'])

    def __call__(self, s):
        """P(detectives win) for state s (fug_pos known)."""
        if s.over:
            return float(s.winner == E.DETECTIVES_WIN)
        z = float(np.dot(self.w, np.asarray(features(s), dtype=float)[self.cols]))
        return 1.0 / (1.0 + math.exp(-z))


# ---------- fitting ----------

def _record_game(job):
    key, k, seed, fname, dname, dopts = job
    from .arena import get_map, make_fugitive, make_detectives
    gm = get_map(key)
    rng = random.Random(seed)
    fug = make_fugitive(fname, seed * 2 + 1, {})
    det = make_detectives(dname, seed * 2 + 2, dopts)
    s = E.new_game(gm, k, rng)
    rows = []
    while not s.over:
        if s.phase == E.FUGITIVE_PHASE:
            P.apply_turn(s, fug.choose_turn(s))
        else:
            E.move_detective(s, *det.choose_move(s.public_view()))
        if not s.over:
            rows.append(features(s))
    return rows, float(s.winner == E.DETECTIVES_WIN)


def record(fugitives, detectives, dopts, games, workers, seed):
    """Plays the games and returns (X, y, game id per row)."""
    import multiprocessing as mp
    combos = [(key, k, fname) for key in E.GameMap.keys() for k in (3, 4, 5)
              for fname in fugitives for _ in range(games)]
    jobs = [(key, k, seed + 7919 * j, fname, detectives, dopts) for j, (key, k, fname) in enumerate(combos)]
    t0 = time.perf_counter()
    with mp.get_context('spawn').Pool(workers or max(1, (os.cpu_count() or 2) - 2)) as pool:
        out = pool.map(_record_game, jobs, chunksize=2)
    X = np.array([row for rows, _ in out for row in rows], dtype=float)
    y = np.array([win for rows, win in out for _ in rows], dtype=float)
    gid = np.array([j for j, (rows, _) in enumerate(out) for _ in rows])
    print(f'{len(out)} games ({detectives} detectives), {len(y)} positions in {time.perf_counter() - t0:.0f}s')
    return X, y, gid


def fit_logistic(X, y, l2=1e-3, iters=50):
    """Newton's method (IRLS) with a small ridge penalty (not on the bias)."""
    w = np.zeros(X.shape[1])
    reg = np.full(X.shape[1], l2 * len(y))
    reg[0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + reg * w
        H = (X * (p * (1 - p))[:, None]).T @ X + np.diag(reg)
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def log_loss(p, y):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['fit'])
    ap.add_argument('--games', type=int, default=60, help='games per map, detective count and fugitive bot')
    ap.add_argument('--fugitives', default='alphabeta,heuristic')
    ap.add_argument('--detectives', default='heuristic', help='detective bot playing the recorded games')
    ap.add_argument('--dopts', default='{}', help='JSON options for the detective bot')
    ap.add_argument('--data', help='fit on saved datasets (comma-separated .npz) instead of playing games')
    ap.add_argument('--save-data', help='save the recorded dataset here (.npz)')
    ap.add_argument('--out', default=str(WEIGHTS_FILE))
    ap.add_argument('--workers', type=int, default=None)
    ap.add_argument('--seed', type=int, default=10_000)
    a = ap.parse_args(argv)
    if a.data:
        parts = [np.load(p) for p in a.data.split(',')]
        X = np.concatenate([d['X'] for d in parts])
        y = np.concatenate([d['y'] for d in parts])
        offs = np.cumsum([0] + [d['gid'].max() + 1 for d in parts[:-1]])
        gid = np.concatenate([d['gid'] + o for d, o in zip(parts, offs)])
        print(f'{len(y)} positions from {a.data}')
    else:
        X, y, gid = record(a.fugitives.split(','), a.detectives, json.loads(a.dopts), a.games,
                           a.workers, a.seed)
        if a.save_data:
            np.savez_compressed(a.save_data, X=X, y=y, gid=gid)
            print(f'saved {a.save_data}')
    rng = np.random.default_rng(0)
    test = rng.random(gid.max() + 1)[gid] < 0.2  # held out by game, not by position
    w = fit_logistic(X[~test], y[~test])
    p = 1 / (1 + np.exp(-X[test] @ w))
    yte = y[test]
    base = np.full_like(yte, y[~test].mean())
    print(f'held-out positions: {len(yte)}, detective win rate {yte.mean():.3f}')
    print(f'log loss  base rate {log_loss(base, yte):.4f}   model {log_loss(p, yte):.4f}')
    print(f'accuracy  base rate {max(yte.mean(), 1 - yte.mean()):.3f}   model {np.mean((p > 0.5) == yte):.3f}')
    names = FEATURES[:X.shape[1]]  # datasets saved before newer features have fewer columns
    for name, wi in zip(names, w):
        print(f'  {name:<15}{wi:+.3f}')
    Path(a.out).write_text(json.dumps({'features': names, 'weights': w.tolist(), 'positions': len(y),
                                       'source': a.data or f'{a.detectives} {a.dopts} vs {a.fugitives}'},
                                      indent=1))
    print(f'wrote {a.out}')


if __name__ == '__main__':
    main()
