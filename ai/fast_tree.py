"""
Compiled pieces of the ISMCTS tree walk (optional, needs numba; see ai/fast.py).

det_scores: HeuristicDetectives.scores(s) without the location-estimate / team options,
the heuristic scores behind the PUCT prior. Same moves, same order, same values.
"""
import numpy as np

from . import fast as F
from .fast import njit, _mask, _occupied, INF


@njit(cache=True)
def _det_scores(T_prop, T_dist, nbr_basic, dp, dt, i, cand, tos, tks, scores, cands):
    p = dp[i]
    k = dp.shape[0]
    nc = 0
    for v in range(cand.shape[0]):
        if cand[v] and not _occupied(dp, v):
            cands[nc] = v
            nc += 1
    left = np.empty(3, dtype=np.int64)
    m = 0
    for a in range(nbr_basic.shape[1]):
        v = nbr_basic[p, a]
        if v < 0:
            break
        blocked = False
        for j in range(k):
            if j != i and dp[j] == v:
                blocked = True
        if blocked:
            continue
        t, most = -1, -1
        for x in range(3):
            if dt[i, x] > 0 and T_prop[x, p, v] and dt[i, x] > most:
                t, most = x, dt[i, x]
        if t < 0:
            continue
        if nc:
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
        else:
            sc = 0.0
        if cand[v]:   # v is not occupied by another detective, nor by i (not a neighbour)
            sc = -1000.0
        near = 0
        for j in range(k):
            if j != i and T_dist[7, v, dp[j]] <= 1:
                near += 1
        tos[m] = v
        tks[m] = t
        scores[m] = sc + 0.75 * near
        m += 1
    return m


def det_scores(s):
    """[((to, ticket), score)] as HeuristicDetectives.scores(s)."""
    T = F.tables(s.map)
    w = T.nbr_basic.shape[1]
    tos = np.empty(w, dtype=np.int64)
    tks = np.empty(w, dtype=np.int64)
    scores = np.empty(w)
    cands = np.empty(s.map.n, dtype=np.int64)
    dp = np.array(s.det_pos, dtype=np.int64)
    dt = np.array(s.det_tickets, dtype=np.int64)
    m = _det_scores(T.prop, T.dist, T.nbr_basic, dp, dt, s.current, s.cand, tos, tks, scores, cands)
    return [((int(tos[j]), int(tks[j])), float(scores[j])) for j in range(m)]


# ---------- ranked_turns (ai/ismcts.py) ----------

SECRET_PENALTY = 2.0
DOUBLE_PENALTY = 15.0
DOUBLE_FIRSTS, DOUBLE_SECONDS = 3, 2


@njit(cache=True)
def _tk_choice(ftk, lt, rnd):
    """ranked_turns' ticket(): secret right after a reveal (if legal), else richest basic."""
    if F.IS_REVEAL[rnd] and (lt >> 3) & 1:
        return 3
    t, best = 3, -1
    for x in range(3):
        if (lt >> x) & 1 and ftk[x] > best:
            t, best = x, ftk[x]
    return t


@njit(cache=True)
def _dests(T_prop, nbr_any, dp, fpos, ftk, vs, lts):
    m = 0
    for a in range(nbr_any.shape[1]):
        v = nbr_any[fpos, a]
        if v < 0:
            break
        lt = F._fug_can_reach(T_prop, nbr_any, dp, fpos, ftk, v)
        if lt:
            vs[m] = v
            lts[m] = lt
            m += 1
    return m


@njit(cache=True)
def _ranked(T_prop, T_dist, T_edge, nbr_any, dp, dt, ftk, fpos, rnd, can_double,
            sc, kind, v1s, t1s, v2s, t2s):
    n = T_edge.shape[0]
    dg = np.empty(n, dtype=np.uint8)
    F._danger(dp, dt, T_dist, dg)
    w = nbr_any.shape[1]
    vs = np.empty(w, dtype=np.int64)
    lts = np.empty(w, dtype=np.int64)
    g = _dests(T_prop, nbr_any, dp, fpos, ftk, vs, lts)
    base = np.empty(n)
    # base only matters at the fugitive's destinations and their neighbours' destinations
    for v in range(n):
        base[v] = np.nan
    m = 0
    for a in range(g):
        v, lt = vs[a], lts[a]
        b = _base_at(T_edge, nbr_any, dg, base, v)
        t = _tk_choice(ftk, lt, rnd)
        sc[m], kind[m], v1s[m], t1s[m] = b, 0, v, t
        m += 1
        if (lt >> 3) & 1 and t != 3:
            sc[m], kind[m], v1s[m], t1s[m] = b - SECRET_PENALTY, 0, v, 3
            m += 1
    if g and can_double:
        cornered = True
        for a in range(g):
            if dg[vs[a]] > 1:
                cornered = False
        bonus = DOUBLE_PENALTY + 1 if cornered else -DOUBLE_PENALTY
        ftk1 = ftk.copy()
        ftk1[4] -= 1
        keys = np.empty(g)
        for a in range(g):
            keys[a] = -_base_at(T_edge, nbr_any, dg, base, vs[a])
        firsts = np.argsort(keys, kind='mergesort')[:DOUBLE_FIRSTS]
        vs2 = np.empty(w, dtype=np.int64)
        lts2 = np.empty(w, dtype=np.int64)
        for f in range(firsts.shape[0]):
            v1, lt1 = vs[firsts[f]], lts[firsts[f]]
            t1 = _tk_choice(ftk1, lt1, rnd)
            ftk2 = ftk1.copy()
            ftk2[t1] -= 1
            g2 = _dests(T_prop, nbr_any, dp, v1, ftk2, vs2, lts2)
            if g2 == 0:
                continue  # cornered after the first half: the game would end
            keys2 = np.empty(g2)
            for a in range(g2):
                keys2[a] = -_base_at(T_edge, nbr_any, dg, base, vs2[a])
            seconds = np.argsort(keys2, kind='mergesort')[:DOUBLE_SECONDS]
            for q in range(seconds.shape[0]):
                v2, lt2 = vs2[seconds[q]], lts2[seconds[q]]
                sc[m] = _base_at(T_edge, nbr_any, dg, base, v2) + bonus
                kind[m], v1s[m], t1s[m] = 1, v1, t1
                v2s[m], t2s[m] = v2, _tk_choice(ftk2, lt2, rnd + 1)
                m += 1
    return m


@njit(cache=True)
def _base_at(T_edge, nbr_any, dg, base, v):
    """10 · min(danger, 4) + links to stations at least 2 moves from every detective."""
    if np.isnan(base[v]):
        s = 0.0
        for a in range(nbr_any.shape[1]):
            u = nbr_any[v, a]
            if u < 0:
                break
            if dg[u] >= 2:
                s += T_edge[v, u]
        base[v] = 10.0 * min(dg[v], 4) + s
    return base[v]


def ranked_turns(s):
    """Same list as ismcts.ranked_turns(s)."""
    from .engine import can_use_double, SECRET
    from .policies import DOUBLE
    T = F.tables(s.map)
    cap = 2 * T.nbr_any.shape[1] + DOUBLE_FIRSTS * DOUBLE_SECONDS
    sc = np.empty(cap)
    kind, v1s, t1s, v2s, t2s = (np.empty(cap, dtype=np.int64) for _ in range(5))
    dp = np.array(s.det_pos, dtype=np.int64)
    dt = np.array(s.det_tickets, dtype=np.int64)
    ftk = np.array(s.fug_tickets, dtype=np.int64)
    m = _ranked(T.prop, T.dist, T.edge, T.nbr_any, dp, dt, ftk, s.fug_pos, s.round,
                can_use_double(s), sc, kind, v1s, t1s, v2s, t2s)
    order = np.argsort(-sc[:m], kind='stable')
    out = []
    for j in order:
        if kind[j] == 0:
            out.append([(int(v1s[j]), int(t1s[j]))])
        else:
            out.append([DOUBLE, (int(v1s[j]), int(t1s[j])), (int(v2s[j]), int(t2s[j]))])
    return out
