"""
Batched rules engine: B games on one map, stored as numpy arrays and stepped together.

Same rules as ai/engine.py (checked against it in ai/tests/test_vec_engine.py). Games in a
batch can be in different phases; every step function takes `idx`, the indices of the games
it applies to, and those games must be in the right phase for it. This is what fast
rollouts use now and what an RL environment would wrap later.

Arrays (k = detectives per game, N = stations):
  det_pos (B,k)  det_tk (B,k,3)   fug_pos (B,)   fug_tk (B,5)   cand (B,N) bool
  phase, round, current, double, winner, reason  (B,) small ints, codes from ai.engine
"""
import numpy as np

from . import engine as E

REASONS = ('', E.R_NO_WAY_OUT, E.R_CORNERED_DOUBLE, E.R_DETS_STUCK, E.R_SURVIVED,
           E.R_SURROUNDED, E.R_CAUGHT)
RC = {r: i for i, r in enumerate(REASONS)}
REVEALS = np.array(sorted(E.REVEAL_ROUNDS))
IS_REVEAL = np.zeros(E.MAX_ROUNDS + 2, dtype=bool)  # IS_REVEAL[round]
IS_REVEAL[REVEALS] = True


class MapTables:
    """Per-map arrays the batched code needs, built once per GameMap and cached on it."""

    def __init__(self, gmap):
        self.n = gmap.n
        self.adj3 = gmap.adj[:3]                                  # (3,N,N) bool, basic tickets
        prop = np.concatenate([gmap.adj[:3], gmap.adj_any[None]])  # by fugitive ticket 0..3
        self.prop = prop
        self.prop_f = prop.astype(np.float32)                     # for candidate propagation
        self.dist = gmap.dist                                     # (8,N,N) uint8
        self.edge_count = gmap.edge_count                         # (N,N) float32
        basic = gmap.adj[:3].any(0)
        deg = basic.sum(1)
        self.max_deg = int(deg.max())
        nbr = np.full((self.n, self.max_deg), -1, dtype=np.int64)
        for v in range(self.n):
            nb = np.flatnonzero(basic[v])
            nbr[v, :len(nb)] = nb
        self.nbr_basic = nbr                                      # (N,D) sorted, -1 padded
        self.dist12f = np.minimum(self.dist, 12).astype(np.float32)  # (8,N,N) capped, for matmul
        # reach_count[mask, u]: distinct stations a detective at u can move to holding the
        # ticket types in mask (bit t = transport t), ignoring other pieces
        self.reach_count = np.array([(gmap.adj[[t for t in range(3) if mk >> t & 1]].any(0)).sum(1)
                                     if mk else np.zeros(self.n, dtype=np.int64)
                                     for mk in range(8)])


def tables(gmap):
    t = getattr(gmap, '_vec_tables', None)
    if t is None:
        t = gmap._vec_tables = MapTables(gmap)
    return t


class VecGames:
    def __init__(self, gmap, B, k):
        self.map = gmap
        self.T = tables(gmap)
        self.B, self.k, self.N = B, k, gmap.n
        self.det_pos = np.zeros((B, k), dtype=np.int64)
        self.det_tk = np.zeros((B, k, 3), dtype=np.int16)
        self.fug_pos = np.zeros(B, dtype=np.int64)
        self.fug_tk = np.zeros((B, 5), dtype=np.int16)
        self.phase = np.zeros(B, dtype=np.int8)
        self.round = np.zeros(B, dtype=np.int16)
        self.current = np.full(B, -1, dtype=np.int8)
        self.double = np.zeros(B, dtype=np.int8)
        self.winner = np.zeros(B, dtype=np.int8)
        self.reason = np.zeros(B, dtype=np.int8)
        self.cand = np.zeros((B, gmap.n), dtype=bool)
        self.rows = np.arange(B)
        # optional (B,N) location estimate, kept up to date by move_fugitive like
        # policies.belief_update; the heuristic detectives use it when set
        self.mass = None
        self.belief_beta = 2.0

    # ---------- construction ----------

    @classmethod
    def new(cls, gmap, B, k, rng):
        """B fresh games, start stations dealt like engine.new_game."""
        g = cls(gmap, B, k)
        starts = np.array(gmap.starts)
        order = np.argsort(rng.random((B, len(starts))), axis=1)
        dealt = starts[order]
        g.det_pos[:] = dealt[:, :k]
        g.fug_pos[:] = dealt[:, k]
        g.det_tk[:] = E.DETECTIVE_TICKETS
        g.fug_tk[:] = list(E.FUGITIVE_TICKETS) + [k, E.DOUBLE_CARDS]
        g.cand[:, starts] = True
        g.cand[g.rows[:, None], g.det_pos] = False
        stuck = ~g.fugitive_legal(g.rows).any((1, 2))
        g._finish(g.rows[stuck], E.DETECTIVES_WIN, E.R_NO_WAY_OUT)
        return g

    @classmethod
    def from_states(cls, states):
        """Batch of copies of engine.GameState objects (same map and detective count)."""
        s0 = states[0]
        g = cls(s0.map, len(states), s0.n)
        for b, s in enumerate(states):
            g.det_pos[b] = s.det_pos
            g.det_tk[b] = s.det_tickets
            g.fug_pos[b] = s.fug_pos
            g.fug_tk[b] = s.fug_tickets
            g.phase[b] = s.phase
            g.round[b] = s.round
            g.current[b] = s.current
            g.double[b] = s.double
            g.winner[b] = s.winner
            g.reason[b] = RC[s.reason]
            g.cand[b] = s.cand
        return g

    def to_state(self, b):
        """Game b as an engine.GameState (log left empty: the batch does not keep one)."""
        s = E.GameState.__new__(E.GameState)
        s.map = self.map
        s.n = self.k
        s.det_pos = self.det_pos[b].tolist()
        s.det_tickets = self.det_tk[b].tolist()
        s.det_start = ()
        s.fug_pos = int(self.fug_pos[b])
        s.fug_start = -1
        s.fug_tickets = self.fug_tk[b].tolist()
        s.phase = int(self.phase[b])
        s.round = int(self.round[b])
        s.current = int(self.current[b])
        s.double = int(self.double[b])
        s.log = []
        s.winner = int(self.winner[b])
        s.reason = REASONS[self.reason[b]]
        s.cand = self.cand[b].copy()
        return s

    # ---------- queries ----------

    def occupied(self, idx):
        occ = np.zeros((len(idx), self.N), dtype=bool)
        occ[np.arange(len(idx))[:, None], self.det_pos[idx]] = True
        return occ

    def possible_mask(self, idx):
        """(b,N) public candidate stations for games idx."""
        return self.cand[idx] & ~self.occupied(idx)

    def fugitive_legal(self, idx):
        """(b,N,4) bool: fugitive may move to station v with ticket t (cab,tram,metro,secret)."""
        T = self.T
        pos = self.fug_pos[idx]
        has = self.fug_tk[idx, :4] > 0                       # (b,4)
        legal = T.prop[:, pos].transpose(1, 2, 0) & has[:, None, :]
        legal &= ~self.occupied(idx)[:, :, None]
        return legal

    def detective_legal(self, idx):
        """(b,N,3) bool for the detective to move in each game of idx."""
        T = self.T
        i = self.current[idx].astype(np.int64)
        pos = self.det_pos[idx, i]
        has = self.det_tk[idx, i] > 0                        # (b,3)
        legal = T.adj3[:, pos].transpose(1, 2, 0) & has[:, None, :]
        legal &= ~self.occupied(idx)[:, :, None]              # own station is never a neighbour
        return legal

    def detective_has_move(self, idx):
        """(b,k) bool: detective i has at least one legal move."""
        T = self.T
        pos = self.det_pos[idx]
        tk = self.det_tk[idx]
        mask = (tk[..., 0] > 0) | ((tk[..., 1] > 0) << 1) | ((tk[..., 2] > 0) << 2)
        # more reachable stations than other detectives: some move is free (fast path)
        out = T.reach_count[mask, pos] >= self.k
        slow = np.flatnonzero(~out.all(1))
        if len(slow):
            sub = idx[slow]
            reach = T.adj3[:, self.det_pos[sub]]                  # (3,b,k,N)
            has = (self.det_tk[sub] > 0).transpose(2, 0, 1)[..., None]
            reach = (reach & has).any(0) & ~self.occupied(sub)[:, None, :]
            out[slow] = reach.any(2)
        return out

    def can_double(self, idx):
        return ((self.phase[idx] == E.FUGITIVE_PHASE) & (self.double[idx] == E.NO_DOUBLE)
                & (self.fug_tk[idx, E.DOUBLE] > 0) & (self.round[idx] <= E.MAX_ROUNDS - 2))

    def danger(self, idx):
        """(b,N): fewest moves for the nearest detective to reach each station, given the
        ticket types each detective still holds."""
        tk = self.det_tk[idx]
        mask = (tk[..., 0] > 0) | ((tk[..., 1] > 0) << 1) | ((tk[..., 2] > 0) << 2)
        return self.T.dist[mask, self.det_pos[idx]].min(1)

    # ---------- actions ----------

    def use_double(self, idx):
        if len(idx) == 0:
            return
        assert self.can_double(idx).all(), 'double move not allowed'
        self.fug_tk[idx, E.DOUBLE] -= 1
        self.double[idx] = E.DOUBLE_FIRST

    def move_fugitive(self, idx, to, ticket):
        """Unchecked: (to, ticket) must be legal (see fugitive_legal)."""
        if len(idx) == 0:
            return
        to = np.asarray(to, dtype=np.int64)
        ticket = np.asarray(ticket, dtype=np.int64)
        self.fug_tk[idx, ticket] -= 1
        self.fug_pos[idx] = to
        self.round[idx] += 1
        rnd = self.round[idx]
        reveal = IS_REVEAL[rnd]
        cand = self.cand[idx].astype(np.float32)
        nxt = np.empty((len(idx), self.N), dtype=bool)
        for t in range(4):
            sel = ticket == t
            if sel.any():
                nxt[sel] = cand[sel] @ self.T.prop_f[t] > 0
        nxt[reveal] = False
        nxt[np.flatnonzero(reveal), to[reveal]] = True
        self.cand[idx] = nxt
        if self.mass is not None:
            self._update_mass(idx, ticket, nxt)
        first = self.double[idx] == E.DOUBLE_FIRST
        fi = idx[first]
        self.double[fi] = E.DOUBLE_SECOND
        cornered = ~self.fugitive_legal(fi).any((1, 2))
        self._finish(fi[cornered], E.DETECTIVES_WIN, E.R_CORNERED_DOUBLE)
        rest = idx[~first]
        self.double[rest] = E.NO_DOUBLE
        self._begin_detective_phase(rest)

    def _update_mass(self, idx, ticket, cand):
        b = len(idx)
        pref = np.exp(self.belief_beta * np.minimum(self.danger(idx), 4).astype(np.float32))
        pref[np.arange(b)[:, None], self.det_pos[idx]] = 0.0
        src = self.mass[idx] * (pref > 0)
        out = np.empty_like(src)
        for t in range(4):
            sel = ticket == t
            if sel.any():
                A = self.T.prop_f[t]
                z = pref[sel] @ A.T
                out[sel] = (np.divide(src[sel], z, out=np.zeros_like(z), where=z > 0) @ A) * pref[sel]
        out *= cand
        tot = out.sum(1, keepdims=True)
        out = np.where(tot > 0, out / np.where(tot > 0, tot, 1), cand / np.maximum(cand.sum(1, keepdims=True), 1))
        self.mass[idx] = out

    def move_detective(self, idx, to, ticket):
        """Unchecked: (to, ticket) must be legal for the detective to move (detective_legal)."""
        if len(idx) == 0:
            return
        to = np.asarray(to, dtype=np.int64)
        ticket = np.asarray(ticket, dtype=np.int64)
        i = self.current[idx].astype(np.int64)
        self.det_tk[idx, i, ticket] -= 1
        self.fug_tk[idx, ticket] += 1
        self.det_pos[idx, i] = to
        caught = to == self.fug_pos[idx]
        self._finish(idx[caught], E.DETECTIVES_WIN, E.R_CAUGHT)
        self._advance(idx[~caught])

    # ---------- turn bookkeeping ----------

    def _begin_detective_phase(self, idx):
        if len(idx) == 0:
            return
        self.phase[idx] = E.DETECTIVE_PHASE
        stuck = ~self.detective_has_move(idx).any(1)
        self._finish(idx[stuck], E.FUGITIVE_WINS, E.R_DETS_STUCK)
        rest = idx[~stuck]
        self.current[rest] = -1
        self._advance(rest)

    def _advance(self, idx):
        if len(idx) == 0:
            return
        ok = self.detective_has_move(idx) & (np.arange(self.k)[None, :] > self.current[idx][:, None])
        has = ok.any(1)
        self.current[idx[has]] = ok[has].argmax(1)
        self._end_detective_phase(idx[~has])

    def _end_detective_phase(self, idx):
        if len(idx) == 0:
            return
        self.current[idx] = -1
        done = self.round[idx] >= E.MAX_ROUNDS
        self._finish(idx[done], E.FUGITIVE_WINS, E.R_SURVIVED)
        rest = idx[~done]
        self.phase[rest] = E.FUGITIVE_PHASE
        stuck = ~self.fugitive_legal(rest).any((1, 2))
        self._finish(rest[stuck], E.DETECTIVES_WIN, E.R_SURROUNDED)

    def _finish(self, idx, winner, reason):
        if len(idx) == 0:
            return
        self.phase[idx] = E.OVER
        self.winner[idx] = winner
        self.reason[idx] = RC[reason]
        self.current[idx] = -1
        self.double[idx] = E.NO_DOUBLE


def play(g, fugitive_turn, detective_move, rng, max_iters=10_000, until_round=None):
    """Runs every game in g to the end. fugitive_turn(g, idx, rng) plays one whole fugitive
    turn (both halves of a double) for games idx; detective_move(g, idx, rng) moves the
    current detective in each game of idx.
    until_round: stop each game once at least that many fugitive moves have been made (a
    double move can step one past it) and the detectives have answered (a scalar, or one per game)."""
    for _ in range(max_iters):
        f = g.phase == E.FUGITIVE_PHASE
        if until_round is not None:
            f &= g.round < until_round
        f = np.flatnonzero(f)
        d = np.flatnonzero(g.phase == E.DETECTIVE_PHASE)
        if len(f) == 0 and len(d) == 0:
            return g
        if len(f):
            fugitive_turn(g, f, rng)
        if len(d):
            detective_move(g, d, rng)
    raise RuntimeError('games did not finish')
