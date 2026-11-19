"""
Compiled leaf evaluation for ISMCTS (optional: needs numba, `pip install numba`).

`playout_values` does what ISMCTSDetectives._evaluate does with the batched engine: play
each leaf `rollout_rounds` rounds with the heuristic players, then score it with the value
model. It does it one game at a time in a compiled loop, instead of dozens of small numpy
operations per step, which is several times faster for search-sized batches.

Same rules, same heuristic players (ties broken by lowest station index, as in
ai/policies.py) and the same value features (ai/value.py). With noise 0 it gives the
batched engine's results exactly (ai/tests/test_fast.py); with noise it draws from
numba's own random stream, so individual playouts differ but not their statistics.

If numba is missing, AVAILABLE is False and ISMCTS uses the batched engine.
"""
import math

import numpy as np

from . import engine as E

try:
    from numba import njit
    AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only without numba
    AVAILABLE = False

    def njit(*args, **kwargs):
        if args and callable(args[0]):
            return args[0]
        return lambda f: f

FUG, DET, OVER = E.FUGITIVE_PHASE, E.DETECTIVE_PHASE, E.OVER
FUG_WIN, DET_WIN = E.FUGITIVE_WINS, E.DETECTIVES_WIN
NO_DBL, DBL_FIRST, DBL_SECOND = E.NO_DOUBLE, E.DOUBLE_FIRST, E.DOUBLE_SECOND
MAXR = E.MAX_ROUNDS
INF = E.INF
IS_REVEAL = np.zeros(MAXR + 2, dtype=np.bool_)
IS_REVEAL[sorted(E.REVEAL_ROUNDS)] = True
NEXT_REVEAL = np.array([min([r for r in E.REVEAL_ROUNDS if r > x], default=MAXR + 1)
                        for x in range(MAXR + 2)], dtype=np.int64)


class Tables:
    """Per-map arrays for the compiled code (cached on the GameMap)."""

    def __init__(self, gmap):
        n = gmap.n
        self.prop = np.ascontiguousarray(np.concatenate([gmap.adj[:3], gmap.adj_any[None]]))  # (4,N,N)
        self.dist = np.ascontiguousarray(gmap.dist)                                         # (8,N,N) uint8
        self.edge = np.ascontiguousarray(gmap.edge_count.astype(np.float64))                # (N,N)

        def padded(rows):
            w = max(1, max(len(r) for r in rows))
            out = np.full((n, w), -1, dtype=np.int64)
            for v, r in enumerate(rows):
                out[v, :len(r)] = r
            return out
        self.nbr_any = padded([np.flatnonzero(gmap.adj_any[v]) for v in range(n)])      # sorted
        self.nbr_basic = padded([np.flatnonzero(gmap.adj[:3].any(0)[v]) for v in range(n)])


def tables(gmap):
    t = getattr(gmap, '_fast_tables', None)
    if t is None:
        t = gmap._fast_tables = Tables(gmap)
    return t


@njit(cache=True)
def seed(s):
    np.random.seed(s)


# ---------------- rules (one game: arrays are that game's rows) ----------------

@njit(cache=True)
def _mask(tk):
    m = 0
    if tk[0] > 0:
        m |= 1
    if tk[1] > 0:
        m |= 2
    if tk[2] > 0:
        m |= 4
    return m


@njit(cache=True)
def _occupied(dp, v):
    for j in range(dp.shape[0]):
        if dp[j] == v:
            return True
    return False


@njit(cache=True)
def _danger(dp, dt, dist, out):
    n = out.shape[0]
    for v in range(n):
        out[v] = INF
    for j in range(dp.shape[0]):
        row = dist[_mask(dt[j]), dp[j]]
        for v in range(n):
            if row[v] < out[v]:
                out[v] = row[v]


@njit(cache=True)
def _fug_can_reach(prop, nbr_any, dp, fpos, ftk, v):
    """Legal ticket mask (bits 0..3) for the fugitive moving to neighbour v."""
    if _occupied(dp, v):
        return 0
    m = 0
    for t in range(4):
        if ftk[t] > 0 and prop[t, fpos, v]:
            m |= 1 << t
    return m


@njit(cache=True)
def _fug_has_move(prop, nbr_any, dp, fpos, ftk):
    for a in range(nbr_any.shape[1]):
        v = nbr_any[fpos, a]
        if v < 0:
            break
        if _fug_can_reach(prop, nbr_any, dp, fpos, ftk, v):
            return True
    return False


@njit(cache=True)
def _det_has_move(prop, nbr_basic, dp, dt, j):
    p = dp[j]
    for a in range(nbr_basic.shape[1]):
        v = nbr_basic[p, a]
        if v < 0:
            break
        if _occupied(dp, v):
            continue
        for t in range(3):
            if dt[j, t] > 0 and prop[t, p, v]:
                return True
    return False


@njit(cache=True)
def _finish(st, winner):
    st[0] = OVER      # phase
    st[4] = winner    # winner
    st[2] = -1        # current
    st[3] = NO_DBL    # double


# st = [phase, round, current, double, winner]

@njit(cache=True)
def _end_det_phase(prop, nbr_any, dp, ftk, fpos, st):
    st[2] = -1
    if st[1] >= MAXR:
        _finish(st, FUG_WIN)
        return
    st[0] = FUG
    if not _fug_has_move(prop, nbr_any, dp, fpos, ftk):
        _finish(st, DET_WIN)


@njit(cache=True)
def _advance(prop, nbr_any, nbr_basic, dp, dt, ftk, fpos, st):
    for j in range(st[2] + 1, dp.shape[0]):
        if _det_has_move(prop, nbr_basic, dp, dt, j):
            st[2] = j
            return
    _end_det_phase(prop, nbr_any, dp, ftk, fpos, st)


@njit(cache=True)
def _begin_det_phase(prop, nbr_any, nbr_basic, dp, dt, ftk, fpos, st):
    st[0] = DET
    any_move = False
    for j in range(dp.shape[0]):
        if _det_has_move(prop, nbr_basic, dp, dt, j):
            any_move = True
            break
    if not any_move:
        _finish(st, FUG_WIN)
        return
    st[2] = -1
    _advance(prop, nbr_any, nbr_basic, dp, dt, ftk, fpos, st)


@njit(cache=True)
def _move_fugitive(prop, nbr_any, nbr_basic, dp, dt, ftk, cand, tmp, pos, st, to, t):
    """pos: 1-element array holding the fugitive's station."""
    ftk[t] -= 1
    pos[0] = to
    st[1] += 1
    n = cand.shape[0]
    if IS_REVEAL[st[1]]:
        for v in range(n):
            cand[v] = False
        cand[to] = True
    else:
        for v in range(n):
            tmp[v] = False
        for u in range(n):
            if cand[u]:
                for a in range(nbr_any.shape[1]):
                    v = nbr_any[u, a]
                    if v < 0:
                        break
                    if prop[t, u, v]:
                        tmp[v] = True
        for v in range(n):
            cand[v] = tmp[v]
    if st[3] == DBL_FIRST:
        st[3] = DBL_SECOND
        if not _fug_has_move(prop, nbr_any, dp, to, ftk):
            _finish(st, DET_WIN)
        return
    st[3] = NO_DBL
    _begin_det_phase(prop, nbr_any, nbr_basic, dp, dt, ftk, to, st)


@njit(cache=True)
def _move_detective(prop, nbr_any, nbr_basic, dp, dt, ftk, fpos, st, to, t):
    i = st[2]
    dt[i, t] -= 1
    ftk[t] += 1
    dp[i] = to
    if to == fpos:
        _finish(st, DET_WIN)
        return
    _advance(prop, nbr_any, nbr_basic, dp, dt, ftk, fpos, st)


# ---------------- heuristic players ----------------

@njit(cache=True)
def _terr_setup(T_dist, dp, dt, i, cands, nc, od, F):
    """Union territory (policies.team_territory): od = other detectives' distance to each
    station, F = fugitive distance from the nearest candidate."""
    n = od.shape[0]
    for v in range(n):
        od[v] = INF
        F[v] = INF
    for j in range(dp.shape[0]):
        if j != i:
            row = T_dist[_mask(dt[j]), dp[j]]
            for v in range(n):
                if row[v] < od[v]:
                    od[v] = row[v]
    for c in range(nc):
        row = T_dist[7, cands[c]]
        for v in range(n):
            if row[v] < F[v]:
                F[v] = row[v]


@njit(cache=True)
def _terr_count(T_dist, od, F, mask, v, h):
    row = T_dist[mask, v]
    cnt = 0
    for u in range(od.shape[0]):
        d = row[u] if row[u] < od[u] else od[u]
        if F[u] < d and F[u] <= h:
            cnt += 1
    return cnt


@njit(cache=True)
def _fug_best(prop, nbr_any, edge, dp, fpos, ftk, base, noise):
    best, best_sc = -1, -np.inf
    for a in range(nbr_any.shape[1]):
        v = nbr_any[fpos, a]
        if v < 0:
            break
        if _fug_can_reach(prop, nbr_any, dp, fpos, ftk, v):
            sc = base[v]
            if noise:
                sc += np.random.random() * noise
            if sc > best_sc:
                best, best_sc = v, sc
    return best


@njit(cache=True)
def _fug_ticket(prop, nbr_any, dp, fpos, ftk, to, round_now):
    lt = _fug_can_reach(prop, nbr_any, dp, fpos, ftk, to)
    if IS_REVEAL[round_now] and (lt >> 3) & 1:
        return 3
    t, best = 3, -1
    for x in range(3):
        if (lt >> x) & 1 and ftk[x] > best:
            t, best = x, ftk[x]
    return t


@njit(cache=True)
def _fugitive_turn(T_prop, T_dist, T_edge, nbr_any, nbr_basic, dp, dt, ftk, cand, tmp, dg,
                   base, pos, st, noise):
    _danger(dp, dt, T_dist, dg)
    n = dg.shape[0]
    for v in range(n):
        base[v] = 10.0 * min(dg[v], 4)
    # safe-exit count, needed only for the fugitive's possible destinations and their
    # second halves: compute it for every station (cheap relative to the rest)
    for v in range(n):
        s = 0.0
        for a in range(nbr_any.shape[1]):
            u = nbr_any[v, a]
            if u < 0:
                break
            if dg[u] >= 2:
                s += T_edge[v, u]
        base[v] += s
    to = _fug_best(T_prop, nbr_any, T_edge, dp, pos[0], ftk, base, noise)
    if (dg[to] <= 1 and st[0] == FUG and st[3] == NO_DBL and ftk[4] > 0 and st[1] <= MAXR - 2):
        ftk[4] -= 1
        st[3] = DBL_FIRST
    to = _fug_best(T_prop, nbr_any, T_edge, dp, pos[0], ftk, base, noise)
    t = _fug_ticket(T_prop, nbr_any, dp, pos[0], ftk, to, st[1])
    _move_fugitive(T_prop, nbr_any, nbr_basic, dp, dt, ftk, cand, tmp, pos, st, to, t)
    if st[0] == FUG and st[3] == DBL_SECOND:
        to = _fug_best(T_prop, nbr_any, T_edge, dp, pos[0], ftk, base, noise)
        t = _fug_ticket(T_prop, nbr_any, dp, pos[0], ftk, to, st[1])
        _move_fugitive(T_prop, nbr_any, nbr_basic, dp, dt, ftk, cand, tmp, pos, st, to, t)


@njit(cache=True)
def _detective_move(T_prop, T_dist, nbr_any, nbr_basic, dp, dt, ftk, cand, cands, pos, st, noise,
                    terr, h, od, F):
    i = st[2]
    p = dp[i]
    k = dp.shape[0]
    nc = 0
    for v in range(cand.shape[0]):
        if cand[v] and not _occupied(dp, v):
            cands[nc] = v
            nc += 1
    if terr != 0 and nc:
        _terr_setup(T_dist, dp, dt, i, cands, nc, od, F)
    best_v, best_t, best_sc = -1, -1, np.inf
    left = np.empty(3, dtype=np.int64)
    for a in range(nbr_basic.shape[1]):
        v = nbr_basic[p, a]
        if v < 0:
            break
        if _occupied(dp, v):
            continue
        t, most = -1, -1
        for x in range(3):
            if dt[i, x] > 0 and T_prop[x, p, v] and dt[i, x] > most:
                t, most = x, dt[i, x]
        if t < 0:
            continue
        is_cand = cand[v]  # v is unoccupied here
        if is_cand:
            sc = -1000.0
        elif nc:
            for x in range(3):
                left[x] = dt[i, x] - (1 if x == t else 0)
            row = T_dist[_mask(left), v]
            mn, sm = INF, 0
            for c in range(nc):
                d = row[cands[c]]
                if d < mn:
                    mn = d
                sm += d if d < 12 else 12
            sc = 3 * mn + sm / nc
            if terr != 0:
                sc = sc + terr * _terr_count(T_dist, od, F, _mask(left), v, h)
        else:
            sc = 0.0
        near = 0
        for j in range(k):
            if j != i and T_dist[7, v, dp[j]] <= 1:
                near += 1
        sc += 0.75 * near
        if noise:
            sc += np.random.random() * noise
        if sc < best_sc:
            best_v, best_t, best_sc = v, t, sc
    _move_detective(T_prop, nbr_any, nbr_basic, dp, dt, ftk, pos[0], st, best_v, best_t)


# ---------------- value features (ai/value.py) ----------------

@njit(cache=True)
def _value(T_prop, T_dist, nbr_any, dp, dt, ftk, cand, dg, fpos, st, W):
    k = dp.shape[0]
    n = cand.shape[0]
    _danger(dp, dt, T_dist, dg)
    d = np.empty(k, dtype=np.int64)
    for j in range(k):
        x = T_dist[_mask(dt[j]), dp[j], fpos]
        d[j] = x if x < 10 else 10
    d.sort()
    d1 = d[0]
    d2 = d[1] if k > 1 else 10
    dests, safe = 0, 0
    for a in range(nbr_any.shape[1]):
        v = nbr_any[fpos, a]
        if v < 0:
            break
        if _fug_can_reach(T_prop, nbr_any, dp, fpos, ftk, v):
            dests += 1
            if dg[v] >= 2:
                safe += 1
    nc = 0
    for v in range(n):
        if cand[v]:
            nc += 1
    for j in range(k):
        if cand[dp[j]]:
            nc -= 1
    if nc < 1:
        nc = 1
    det_phase = st[0] == DET
    threat = False
    if det_phase:
        for j in range(max(st[2], 0), k):
            if T_dist[_mask(dt[j]), dp[j], fpos] == 1:
                threat = True
    rnd = st[1]
    if ftk[3] > 0:
        fm = 7
    else:
        fm = _mask(ftk)
    room = 0
    if fm:
        row = T_dist[fm, fpos]
        for v in range(n):
            if row[v] <= 3 and row[v] < dg[v]:
                room += 1
    sum_d, near2, tick = 0, 0, 0
    for j in range(k):
        sum_d += d[j]
        if d[j] <= 2:
            near2 += 1
        tick += dt[j, 0] + dt[j, 1] + dt[j, 2]
    f = np.empty(22)
    f[0] = 1.0
    f[1] = d1 == 1
    f[2] = d1 == 2
    f[3] = d1 == 3
    f[4] = d1 == 4
    f[5] = d2 / 10
    f[6] = sum_d / (10 * k)
    f[7] = near2 / 5
    f[8] = math.log2(nc) / 7
    f[9] = nc == 1
    f[10] = (MAXR - rnd) / 24
    f[11] = (NEXT_REVEAL[rnd] - rnd) / 5
    f[12] = min(safe, 8) / 8
    f[13] = min(dests, 12) / 12
    f[14] = ftk[4] / 2
    f[15] = min(ftk[3], 5) / 5
    f[16] = tick / (22 * k)
    f[17] = det_phase
    f[18] = threat
    f[19] = k / 5
    f[20] = min(room, 30) / 30
    f[21] = room <= 4
    z = 0.0
    for x in range(22):
        z += W[x] * f[x]
    return 1.0 / (1.0 + math.exp(-z))


@njit(cache=True)
def _playouts(T_prop, T_dist, T_edge, nbr_any, nbr_basic, det_pos, det_tk, fug_pos, fug_tk,
              state, cand, until, W, fnoise, dnoise, terr, h, out):
    B, n = cand.shape
    od = np.empty(n, dtype=np.int64)
    F = np.empty(n, dtype=np.int64)
    tmp = np.empty(n, dtype=np.bool_)
    dg = np.empty(n, dtype=np.uint8)
    base = np.empty(n)
    cands = np.empty(n, dtype=np.int64)
    pos = np.empty(1, dtype=np.int64)
    for b in range(B):
        dp, dt, ftk, cd, st = det_pos[b], det_tk[b], fug_tk[b], cand[b], state[b]
        pos[0] = fug_pos[b]
        while st[0] != OVER:
            if st[0] == FUG:
                if st[1] >= until[b]:
                    break
                _fugitive_turn(T_prop, T_dist, T_edge, nbr_any, nbr_basic, dp, dt, ftk, cd, tmp,
                               dg, base, pos, st, fnoise)
            else:
                _detective_move(T_prop, T_dist, nbr_any, nbr_basic, dp, dt, ftk, cd, cands, pos, st,
                                dnoise, terr, h, od, F)
        fug_pos[b] = pos[0]
        if st[0] == OVER:
            out[b] = 1.0 if st[4] == DET_WIN else 0.0
        else:
            out[b] = _value(T_prop, T_dist, nbr_any, dp, dt, ftk, cd, dg, pos[0], st, W)


def pack(states):
    """Arrays for a list of GameStates (same map and detective count), copied."""
    B = len(states)
    k = states[0].n
    det_pos = np.array([s.det_pos for s in states], dtype=np.int64).reshape(B, k)
    det_tk = np.array([s.det_tickets for s in states], dtype=np.int64).reshape(B, k, 3)
    fug_pos = np.array([s.fug_pos for s in states], dtype=np.int64)
    fug_tk = np.array([s.fug_tickets for s in states], dtype=np.int64)
    state = np.array([(s.phase, s.round, s.current, s.double, s.winner) for s in states], dtype=np.int64)
    cand = np.stack([s.cand for s in states])
    return det_pos, det_tk, fug_pos, fug_tk, state, cand


def full_weights(value_model):
    """The value model's weights as a vector over all 22 features (zeros where unused)."""
    W = np.zeros(22)
    W[value_model.cols] = value_model.w
    return W


def playout_values(states, rounds, W, fnoise=0.5, dnoise=0.1, packed=None, terr=0.0, terr_h=3):
    """P(detectives win) for each live state, after `rounds` rounds of heuristic play
    (None: to the end), scored by the value model with weights W (full_weights). terr: the
    playout detectives' territory weight (HeuristicDetectives terr, union mode)."""
    T = tables(states[0].map)
    det_pos, det_tk, fug_pos, fug_tk, state, cand = packed or pack(states)
    until = (state[:, 1] + rounds) if rounds is not None else np.full(len(states), 10 ** 6)
    out = np.empty(len(states))
    _playouts(T.prop, T.dist, T.edge, T.nbr_any, T.nbr_basic, det_pos, det_tk, fug_pos, fug_tk,
              state, cand, until.astype(np.int64), W, float(fnoise), float(dnoise), float(terr),
              int(terr_h), out)
    return out


# ---------------- alpha-beta search (ai/alphabeta.py) ----------------
# Same tree as AlphaBetaFugitive._value: fugitive moves without doubles, each destination
# once with its richest basic ticket (else secret), most distant from the detectives first;
# detectives one ply each, capture if in reach, else the det_beam moves ending closest to
# the fugitive. Ws = [dist, dist_cap, exits, exits_cap, cand, secret, double, fade, room,
# room_cap, room_depth, WIN].

@njit(cache=True)
def _richest(tk, lt):
    """Richest basic ticket among the legal mask lt (first wins ties), else secret (3)."""
    t, best = 3, -1
    for x in range(3):
        if (lt >> x) & 1 and tk[x] > best:
            t, best = x, tk[x]
    return t


@njit(cache=True)
def _ab_eval(T_prop, T_dist, nbr_any, dp, dt, ftk, cand, fpos, st, Ws, dg):
    _danger(dp, dt, T_dist, dg)
    d = dg[fpos]
    exits = 0
    for a in range(nbr_any.shape[1]):
        v = nbr_any[fpos, a]
        if v < 0:
            break
        if _fug_can_reach(T_prop, nbr_any, dp, fpos, ftk, v) and dg[v] >= 2:
            exits += 1
    nc = 0
    n = cand.shape[0]
    for v in range(n):
        if cand[v]:
            nc += 1
    for j in range(dp.shape[0]):
        if cand[dp[j]]:
            nc -= 1
    fade = min(1.0, (MAXR - st[1]) / Ws[7])
    room = 0
    if Ws[8] != 0:
        fm = 7 if ftk[3] > 0 else _mask(ftk)
        if fm:
            row = T_dist[fm, fpos]
            depth = Ws[10]
            for v in range(n):
                if row[v] <= depth and row[v] < dg[v]:
                    room += 1
        room = min(room, Ws[9])
    return (Ws[0] * min(d, Ws[1])
            + Ws[8] * room
            + Ws[2] * min(exits, Ws[3])
            + Ws[4] * math.log2(max(nc, 1))
            + fade * (Ws[5] * ftk[3] + Ws[6] * ftk[4]))


@njit(cache=True)
def _ab_value(T_prop, T_dist, nbr_any, nbr_basic, dp, dt, ftk, cand, fpos, st, rounds,
              alpha, beta, ply, beam, Ws, nodes):
    nodes[0] += 1
    WIN = Ws[11]
    if st[0] == OVER:
        return WIN - ply if st[4] == FUG_WIN else -WIN + ply
    n = cand.shape[0]
    tmp = np.empty(n, dtype=np.bool_)
    if st[0] == FUG:
        dg = np.empty(n, dtype=np.uint8)
        if rounds == 0:
            return _ab_eval(T_prop, T_dist, nbr_any, dp, dt, ftk, cand, fpos, st, Ws, dg)
        _danger(dp, dt, T_dist, dg)
        # children: (−danger, station) ascending
        m = nbr_any.shape[1]
        cv = np.empty(m, dtype=np.int64)
        ck = np.empty(m, dtype=np.int64)
        ct = np.empty(m, dtype=np.int64)
        c = 0
        for a in range(m):
            v = nbr_any[fpos, a]
            if v < 0:
                break
            lt = _fug_can_reach(T_prop, nbr_any, dp, fpos, ftk, v)
            if lt:
                cv[c] = v
                ck[c] = -np.int64(dg[v]) * 1000 + v
                ct[c] = _richest(ftk, lt)
                c += 1
        order = np.argsort(ck[:c], kind='mergesort')
        best = -np.inf
        pos = np.empty(1, dtype=np.int64)
        for o in range(c):
            x = order[o]
            dp2, dt2, ftk2, cand2, st2 = dp.copy(), dt.copy(), ftk.copy(), cand.copy(), st.copy()
            pos[0] = fpos
            _move_fugitive(T_prop, nbr_any, nbr_basic, dp2, dt2, ftk2, cand2, tmp, pos, st2, cv[x], ct[x])
            v = _ab_value(T_prop, T_dist, nbr_any, nbr_basic, dp2, dt2, ftk2, cand2, pos[0], st2,
                          rounds, alpha, beta, ply + 1, beam, Ws, nodes)
            if v > best:
                best = v
            if best > alpha:
                alpha = best
            if alpha >= beta:
                break
        return best
    # detective: capture if in reach, else the beam closest to the fugitive
    i = st[2]
    p = dp[i]
    m = nbr_basic.shape[1]
    cv = np.empty(m, dtype=np.int64)
    ck = np.empty(m, dtype=np.int64)
    ct = np.empty(m, dtype=np.int64)
    left = np.empty(3, dtype=np.int64)
    c = 0
    capture = -1
    for a in range(m):
        v = nbr_basic[p, a]
        if v < 0:
            break
        # detective_actions: may land on the fugitive, not on another detective
        blocked = False
        for j in range(dp.shape[0]):
            if j != i and dp[j] == v:
                blocked = True
        if blocked:
            continue
        lt = 0
        for x in range(3):
            if dt[i, x] > 0 and T_prop[x, p, v]:
                lt |= 1 << x
        if not lt:
            continue
        t = _richest(dt[i], lt)
        if v == fpos:
            capture = c
            cv[c], ct[c], ck[c] = v, t, 0
            c += 1
            break
        for x in range(3):
            left[x] = dt[i, x] - (1 if x == t else 0)
        cv[c] = v
        ct[c] = t
        ck[c] = np.int64(T_dist[_mask(left), v, fpos]) * 1000 + v
        c += 1
    if capture >= 0:
        order = np.array([capture])
    else:
        order = np.argsort(ck[:c], kind='mergesort')[:beam]
    best = np.inf
    for o in range(order.shape[0]):
        x = order[o]
        dp2, dt2, ftk2, st2 = dp.copy(), dt.copy(), ftk.copy(), st.copy()
        _move_detective(T_prop, nbr_any, nbr_basic, dp2, dt2, ftk2, fpos, st2, cv[x], ct[x])
        r = rounds - 1 if st2[0] != DET else rounds
        v = _ab_value(T_prop, T_dist, nbr_any, nbr_basic, dp2, dt2, ftk2, cand, fpos, st2,
                      r, alpha, beta, ply + 1, beam, Ws, nodes)
        if v < best:
            best = v
        if best < beta:
            beta = best
        if alpha >= beta:
            break
    return best


def ab_weights(w, win):
    return np.array([w['dist'], w['dist_cap'], w['exits'], w['exits_cap'], w['cand'], w['secret'],
                     w['double'], w['fade'], w['room'], w['room_cap'], w['room_depth'], win],
                    dtype=np.float64)


def ab_value(s, rounds, alpha, beta, ply, beam, Ws, nodes):
    """AlphaBetaFugitive._value for GameState s, compiled. nodes: 1-element int64 counter."""
    T = tables(s.map)
    det_pos, det_tk, fug_pos, fug_tk, state, cand = pack([s])
    return _ab_value(T.prop, T.dist, T.nbr_any, T.nbr_basic, det_pos[0], det_tk[0], fug_tk[0],
                     cand[0], int(fug_pos[0]), state[0], rounds, float(alpha), float(beta), ply,
                     beam, Ws, nodes)
