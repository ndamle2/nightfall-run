"""
Baseline players: the heuristic and random players from tools/simulate.js, in two forms.

  * scalar (one engine.GameState): HeuristicFugitive, HeuristicDetectives, RandomFugitive,
    RandomDetectives — bot objects for the arena, and the opponent model inside search.
  * batched (vec_engine.VecGames): vec_* functions, used for fast rollouts and simulation.

With noise=0 both forms make identical choices (ai/tests/test_vec_engine.py checks this).

Bot interface used throughout ai/:
  fugitive bots:   choose_turn(state) -> [DOUBLE?, (to, ticket), (to, ticket)?]
                   (state is the full GameState: the fugitive sees everything)
  detective bots:  choose_move(public_state) -> (to, ticket)
                   (public_state = state.public_view(): fug_pos is -1)
"""
import random

import numpy as np

from . import engine as E
from .vec_engine import IS_REVEAL, tables

DOUBLE = 'double'
DANGER_CAP = 4


def apply_turn(s, actions):
    """Applies a fugitive turn as returned by choose_turn."""
    for a in actions:
        if a == DOUBLE:
            E.use_double(s)
        else:
            E.move_fugitive(s, a[0], a[1])


def danger_vector(s):
    """(N,) fewest moves for the nearest detective to reach each station."""
    masks = [E.ticket_mask(t) for t in s.det_tickets]
    return s.map.dist[masks, s.det_pos].min(0)


def room_to_run(s, danger=None, depth=3):
    """Stations the fugitive can reach within `depth` moves strictly before any detective
    can (ferries ignored). Small values mean a dead end even if every exit is safe now."""
    if danger is None:
        danger = danger_vector(s)
    tk = s.fug_tickets
    mask = 7 if tk[E.SECRET] > 0 else E.ticket_mask(tk)
    if mask == 0:
        return 0
    fd = s.map.dist[mask, s.fug_pos]
    return int(((fd <= depth) & (fd < danger)).sum())


def belief_pref(s, beta):
    """(N,) relative odds of the fugitive choosing each station as its next destination:
    exp(beta * distance from the nearest detective, capped at 4), zero on a detective."""
    pref = np.exp(beta * np.minimum(danger_vector(s), DANGER_CAP).astype(float))
    pref[s.det_pos] = 0.0
    return pref


def belief_update(gmap, mass, entries, pref):
    """Moves a location estimate `mass` (N,) along log entries [(ticket, pos, reveal, _)],
    all made facing the same detectives (`pref` from belief_pref). Not normalized to the
    candidate set; returns a distribution (all zeros only if every route was ruled out)."""
    prop = tables(gmap).prop_f
    for t, p, rev, _ in entries:
        if rev:
            mass = np.zeros(gmap.n)
            mass[p] = 1.0
            continue
        A = prop[t]
        z = A @ pref                               # each source station's total odds
        src = np.divide(mass * (pref > 0), z, out=np.zeros(gmap.n), where=z > 0)
        mass = (src @ A) * pref
        tot = mass.sum()
        if tot > 0:
            mass = mass / tot
    return mass


def richest_ticket(tickets, options):
    """Most plentiful basic ticket among options (first wins ties); secret if none."""
    best = None
    for t in options:
        if t != E.SECRET and (best is None or tickets[t] > tickets[best]):
            best = t
    return E.SECRET if best is None else best


# ======================= scalar =======================

class HeuristicFugitive:
    """Maximise distance to the nearest detective, then safe exits; double when every move
    ends next to a detective; secret ticket right after a reveal; else richest ticket."""

    def __init__(self, seed=None, noise=0.5):
        self.rng = random.Random(seed)
        self.noise = noise

    def choose_turn(self, state):
        s = state.clone()
        m = s.map
        dg = danger_vector(s)
        exits = m.edge_count @ (dg >= 2).astype(np.float32)
        base = 10.0 * np.minimum(dg, DANGER_CAP) + exits

        def best():
            bv, bs = None, -np.inf
            for to, _ in E.group_moves(E.fugitive_actions(s)):
                sc = base[to] + self.rng.random() * self.noise
                if sc > bs:
                    bv, bs = to, sc
            return bv

        out = []
        if dg[best()] <= 1 and E.can_use_double(s):
            E.use_double(s)
            out.append(DOUBLE)
        while True:
            to = best()
            options = [t for (v, t) in E.fugitive_actions(s) if v == to]
            after_reveal = s.round in E.REVEAL_ROUNDS
            t = E.SECRET if after_reveal and E.SECRET in options else richest_ticket(s.fug_tickets, options)
            E.move_fugitive(s, to, t, check=False)
            out.append((to, t))
            if s.over or s.double != E.DOUBLE_SECOND:
                return out


class HeuristicDetectives:
    """Step onto a candidate station if one is in reach, else close in on the candidate set
    (3 × nearest + mean distance), keep apart from each other, spend the richest ticket.

    Team terms (0 = off, the original heuristic): `team` × mean over candidates of the
    distance from the closest detective, counting this one at its new station, so a move
    only gains on candidates this detective would be closest to; `cover` × share of
    candidates some detective could step onto next turn (subtracted: more is better)."""

    def __init__(self, seed=None, noise=0.1, team=0.0, cover=0.0):
        self.rng = random.Random(seed)
        self.noise = noise
        self.team = team
        self.cover = cover

    def choose_move(self, s):
        best, best_score = None, np.inf
        for a, score in self.scores(s, team=self.team, cover=self.cover):
            score += self.rng.random() * self.noise
            if score < best_score:
                best, best_score = a, score
        return best

    @staticmethod
    def scores(s, mass=None, team=0.0, cover=0.0):
        """[((to, ticket), score)] for the detective to move, lower is better, no noise.
        mass: optional (N,) location estimate. The mean distance is then weighted by it, and
        stepping onto a likelier candidate scores better (-1000 - 100 * its share)."""
        m = s.map
        i = s.current
        tk = s.det_tickets[i]
        pm = E.possible_mask(s)
        cands = np.flatnonzero(pm)
        nc = len(cands)
        wc = None
        if mass is not None and nc:
            wc = mass[cands]
            wc = wc / wc.sum() if wc.sum() > 0 else None
        others = [p for j, p in enumerate(s.det_pos) if j != i]
        moves = E.group_moves(E.detective_actions(s))
        if not moves:
            return []
        tos = np.array([to for to, _ in moves])
        tks = [richest_ticket(tk, ts) for _, ts in moves]
        masks = np.array([E.ticket_mask([x - (j == t) for j, x in enumerate(tk)]) for t in tks])
        if nc:
            d = m.dist[masks[:, None], tos[:, None], cands[None, :]].astype(np.int64)   # (M,nc)
            if wc is None:
                score = 3 * d.min(1) + np.minimum(d, 12).sum(1) / nc
            else:
                score = 3 * d.min(1) + np.minimum(d, 12) @ wc
            if team or cover:
                w = wc if wc is not None else np.full(nc, 1.0 / nc)
                od = np.full(nc, E.INF, dtype=np.int64)
                for j, p in enumerate(s.det_pos):
                    if j != i:
                        od = np.minimum(od, m.dist[E.ticket_mask(s.det_tickets[j]), p, cands])
                td = np.minimum(d, od[None, :])
                score = score + team * (np.minimum(td, 12) @ w) - cover * ((td <= 1) @ w)
        else:
            score = np.zeros(len(moves))
        on = pm[tos]
        if on.any():
            score = score.astype(float)
            if wc is None:
                score[on] = -1000.0
            else:
                score[on] = -1000.0 - 100.0 * wc[np.searchsorted(cands, tos[on])]
        if others:
            score = score + 0.75 * (m.dist[7][tos[:, None], np.array(others)[None, :]] <= 1).sum(1)
        return [((int(to), t), float(x)) for to, t, x in zip(tos, tks, score)]


class RandomFugitive:
    def __init__(self, seed=None, p_double=0.08):
        self.rng = random.Random(seed)
        self.p_double = p_double

    def choose_turn(self, state):
        s = state.clone()
        out = []
        if E.can_use_double(s) and self.rng.random() < self.p_double:
            E.use_double(s)
            out.append(DOUBLE)
        while True:
            to, tickets = self.rng.choice(E.group_moves(E.fugitive_actions(s)))
            t = self.rng.choice(tickets)
            E.move_fugitive(s, to, t, check=False)
            out.append((to, t))
            if s.over or s.double != E.DOUBLE_SECOND:
                return out


class RandomDetectives:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    def choose_move(self, s):
        to, tickets = self.rng.choice(E.group_moves(E.detective_actions(s)))
        return to, self.rng.choice(tickets)


# ======================= batched =======================

def _first_max(scores):
    return scores.argmax(1)


def _vec_fugitive_ticket(g, idx, legal, to):
    """Ticket for moving to `to` in games idx: secret right after a reveal (if legal), else
    the most plentiful legal basic ticket, else secret."""
    r = np.arange(len(idx))
    lt = legal[r, to]                                       # (b,4)
    vals = np.where(lt[:, :3], g.fug_tk[idx, :3], -1)
    t = vals.argmax(1)
    t[vals.max(1) < 0] = E.SECRET
    after_reveal = IS_REVEAL[g.round[idx]]
    t[after_reveal & lt[:, E.SECRET]] = E.SECRET
    return t


def vec_heuristic_fugitive(noise=0.5):
    def turn(g, idx, rng):
        dg = g.danger(idx)                                   # (b,N)
        safe = (dg >= 2).astype(np.float32)
        base = 10.0 * np.minimum(dg, DANGER_CAP) + safe @ g.T.edge_count.T

        def best(sub, sub_rows):
            legal = g.fugitive_legal(sub)
            sc = base[sub_rows] + (rng.random(legal.shape[:2]) * noise if noise else 0.0)
            sc = np.where(legal.any(2), sc, -np.inf)
            return legal, _first_max(sc)

        rows = np.arange(len(idx))
        _, to = best(idx, rows)
        dbl = (dg[rows, to] <= 1) & g.can_double(idx)
        g.use_double(idx[dbl])
        legal, to = best(idx, rows)
        g.move_fugitive(idx, to, _vec_fugitive_ticket(g, idx, legal, to))
        second = (g.phase[idx] == E.FUGITIVE_PHASE) & (g.double[idx] == E.DOUBLE_SECOND)
        if second.any():
            sub = idx[second]
            legal, to = best(sub, rows[second])
            g.move_fugitive(sub, to, _vec_fugitive_ticket(g, sub, legal, to))
    return turn


def vec_heuristic_detective(noise=0.1, team=0.0, cover=0.0):
    """Batched HeuristicDetectives (same team / cover terms)."""
    def move(g, idx, rng):
        T = g.T
        b = len(idx)
        r = np.arange(b)
        i = g.current[idx].astype(np.int64)
        tk = g.det_tk[idx, i]                                # (b,3)
        legal = g.detective_legal(idx)                       # (b,N,3)
        dest = T.nbr_basic[g.det_pos[idx, i]]                # (b,D), -1 padded
        dsafe = np.maximum(dest, 0)
        lt = legal[r[:, None], dsafe] & (dest >= 0)[..., None]   # (b,D,3)
        valid = lt.any(2)
        vals = np.where(lt, tk[:, None, :], -1)
        t = vals.argmax(2)                                   # richest legal ticket
        left = tk[:, None, :] - (np.arange(3)[None, None, :] == t[..., None])
        mask = (left[..., 0] > 0) | ((left[..., 1] > 0) << 1) | ((left[..., 2] > 0) << 2)
        pm = g.possible_mask(idx)                            # (b,N)
        step = pm[r[:, None], dsafe]
        nc = pm.sum(1)
        d = T.dist[mask, dsafe]                              # (b,D,N) uint8, INF = 99
        # nearest candidate: non-candidates pushed past INF (99 + 100 still fits in uint8)
        mn = (d + np.where(pm, np.uint8(0), np.uint8(100))[:, None, :]).min(2).astype(np.int64)
        if g.mass is None:
            sm = np.matmul(T.dist12f[mask, dsafe], pm.astype(np.float32)[:, :, None])[..., 0]
            with np.errstate(invalid='ignore', divide='ignore'):
                score = np.where(nc[:, None] > 0, 3 * mn + sm.astype(np.int64) / nc[:, None], 0.0)
            if team or cover:
                w = pm / np.maximum(nc, 1)[:, None]
        else:  # weight by the location estimate, as HeuristicDetectives.scores(s, mass)
            w = g.mass[idx] * pm
            tot = w.sum(1, keepdims=True)
            w = np.where(tot > 0, w / np.where(tot > 0, tot, 1), pm / np.maximum(nc, 1)[:, None])
            sm = np.einsum('bdn,bn->bd', np.minimum(d, np.uint8(12)).astype(np.float32), w.astype(np.float32))
            score = np.where(nc[:, None] > 0, 3 * mn + sm, 0.0)
        if team or cover:
            tk_all = g.det_tk[idx]                           # (b,k,3)
            masks = (tk_all[..., 0] > 0) | ((tk_all[..., 1] > 0) << 1) | ((tk_all[..., 2] > 0) << 2)
            od = T.dist[masks, g.det_pos[idx]]               # (b,k,N)
            od = np.where((np.arange(g.k)[None, :] == i[:, None])[..., None], np.uint8(E.INF), od).min(1)
            td = np.minimum(d, od[:, None, :])               # (b,D,N)
            wf = w.astype(np.float32)
            score = (score + team * np.einsum('bdn,bn->bd', np.minimum(td, np.uint8(12)).astype(np.float32), wf)
                     - cover * np.einsum('bdn,bn->bd', (td <= 1).astype(np.float32), wf))
        if g.mass is None:
            score = np.where(step, -1000.0, score)
        else:
            score = np.where(step, -1000.0 - 100.0 * w[r[:, None], dsafe], score)
        near = T.dist[7][dsafe[:, :, None], g.det_pos[idx][:, None, :]] <= 1   # (b,D,k)
        near &= (np.arange(g.k)[None, None, :] != i[:, None, None])
        score = score + 0.75 * near.sum(2)
        if noise:
            score = score + rng.random(score.shape) * noise
        score = np.where(valid, score, np.inf)
        j = score.argmin(1)
        g.move_detective(idx, dest[r, j], t[r, j])
    return move


def vec_random_fugitive(p_double=0.08):
    def turn(g, idx, rng):
        dbl = g.can_double(idx) & (rng.random(len(idx)) < p_double)
        g.use_double(idx[dbl])
        sub = idx
        while len(sub):
            legal = g.fugitive_legal(sub)
            to = np.where(legal.any(2), rng.random(legal.shape[:2]), -1).argmax(1)
            lt = legal[np.arange(len(sub)), to]
            t = np.where(lt, rng.random(lt.shape), -1).argmax(1)
            g.move_fugitive(sub, to, t)
            sub = sub[(g.phase[sub] == E.FUGITIVE_PHASE) & (g.double[sub] == E.DOUBLE_SECOND)]
    return turn


def vec_random_detective():
    def move(g, idx, rng):
        legal = g.detective_legal(idx)
        to = np.where(legal.any(2), rng.random(legal.shape[:2]), -1).argmax(1)
        lt = legal[np.arange(len(idx)), to]
        t = np.where(lt, rng.random(lt.shape), -1).argmax(1)
        g.move_detective(idx, to, t)
    return move
