"""
Alpha-beta fugitive.

Paranoid search: inside the tree the detectives are assumed to know where the fugitive is
and to play against it, one ply per detective. That is pessimistic (they do not know), so
the evaluation also rewards a large public candidate set, which is the only thing that
makes hiding worth anything to this search, and when the deepest search says every option
loses, the bot falls back to the deepest search that still sees a way out.

Root options are every legal single move with each legal ticket, plus double-move routes.
Iterative deepening narrows the root to the most promising options before searching deeper.
Inside the tree the fugitive moves without doubles and with its richest basic ticket, and
each detective only considers its `det_beam` moves closest to the fugitive (plus any
capture), which keeps the per-round branching at about beam^k.
"""
import math
import random
import time

from . import engine as E
from .policies import DOUBLE, danger_vector, richest_ticket, room_to_run

WIN = 1_000_000.0

DEFAULT_WEIGHTS = {
    'dist': 10.0,     # per move of distance to the nearest detective (capped at dist_cap)
    'dist_cap': 5,
    'exits': 2.0,     # per legal destination at least 2 moves from every detective (capped)
    'exits_cap': 6,
    'cand': 2.0,      # per doubling of the public candidate set
    'secret': 3.0,    # per secret ticket still held, fading out over the last rounds
    'double': 25.0,   # per double-move card still held, fading out over the last rounds
                      # (10 spent doubles on small gains and got cornered later: 45% vs 17%
                      # detective wins against the heuristic detectives, 5 detectives)
    'fade': 8,        # tickets are worth full value until this many rounds remain
    'room': 3.0,      # per station the fugitive reaches first within room_depth moves (capped);
                      # 0 → 3 cut detective wins from 20.0% to 13.7% (heuristic detectives,
                      # 5 detectives, 600 games): it stops the fugitive walking into dead ends
    'room_cap': 30,
    'room_depth': 3,
}


class AlphaBetaFugitive:
    def __init__(self, depth=2, det_beam=2, root_keep=8, time_limit=None, weights=None,
                 doubles=True, fast=True, seed=None):
        """fast: run the tree search compiled (ai/fast.py) when numba is installed; same
        tree, same values, much faster."""
        self.depth = depth
        self.det_beam = det_beam
        self.root_keep = root_keep
        self.time_limit = time_limit
        self.w = {**DEFAULT_WEIGHTS, **(weights or {})}
        self.doubles = doubles
        self.rng = random.Random(seed)
        self.nodes = 0
        self.last = {}
        from . import fast as F
        self.fast = fast and F.AVAILABLE
        if self.fast:
            self._Ws = F.ab_weights(self.w, WIN)

    # ---------- evaluation ----------

    def evaluate(self, s):
        """Static value of a non-terminal state, from the fugitive's point of view."""
        w = self.w
        m = s.map
        dg = danger_vector(s)
        d = int(dg[s.fug_pos])
        exits = 0
        seen = set()
        for to, _ in E.fugitive_actions(s):
            if to not in seen:
                seen.add(to)
                if dg[to] >= 2:
                    exits += 1
        n_cand = int(s.cand.sum()) - sum(1 for p in s.det_pos if s.cand[p])
        fade = min(1.0, (E.MAX_ROUNDS - s.round) / w['fade'])
        room = min(room_to_run(s, dg, w['room_depth']), w['room_cap']) if w['room'] else 0
        return (w['dist'] * min(d, w['dist_cap'])
                + w['room'] * room
                + w['exits'] * min(exits, w['exits_cap'])
                + w['cand'] * math.log2(max(n_cand, 1))
                + fade * (w['secret'] * s.fug_tickets[E.SECRET] + w['double'] * s.fug_tickets[E.DOUBLE]))

    @staticmethod
    def terminal(s, ply):
        # Prefer late captures and early wins.
        return WIN - ply if s.winner == E.FUGITIVE_WINS else -WIN + ply

    # ---------- tree ----------

    def _fugitive_children(self, s):
        """In-tree fugitive moves: each destination once, richest basic ticket (else secret),
        most distant from the detectives first."""
        by_dest = {}
        for to, t in E.fugitive_actions(s):
            by_dest.setdefault(to, []).append(t)
        dg = danger_vector(s)
        out = []
        for to, ts in by_dest.items():
            out.append((-int(dg[to]), to, richest_ticket(s.fug_tickets, ts)))
        out.sort()
        return [(to, t) for _, to, t in out]

    def _detective_children(self, s):
        """The current detective's beam: capture first, then the moves that end closest to
        the fugitive (with the tickets they would have left)."""
        m = s.map
        i = s.current
        tk = s.det_tickets[i]
        by_dest = {}
        for to, t in E.detective_actions(s):
            by_dest.setdefault(to, []).append(t)
        scored = []
        for to, ts in by_dest.items():
            t = richest_ticket(tk, ts)
            if to == s.fug_pos:
                return [(to, t)]  # paranoid: a capture in reach is always taken
            left = list(tk)
            left[t] -= 1
            scored.append((int(m.dist[E.ticket_mask(left), to, s.fug_pos]), to, t))
        scored.sort()
        return [(to, t) for _, to, t in scored[:self.det_beam]]

    def _value(self, s, rounds, alpha, beta, ply):
        self.nodes += 1
        if s.phase == E.OVER:
            return self.terminal(s, ply)
        if s.phase == E.FUGITIVE_PHASE:
            if rounds == 0:
                return self.evaluate(s)
            best = -math.inf
            for to, t in self._fugitive_children(s):
                c = s.clone()
                E.move_fugitive(c, to, t, check=False)
                v = self._value(c, rounds, alpha, beta, ply + 1)
                if v > best:
                    best = v
                if best > alpha:
                    alpha = best
                if alpha >= beta:
                    break
            return best
        best = math.inf
        for to, t in self._detective_children(s):
            c = s.clone()
            E.move_detective(c, to, t, check=False)
            r = rounds - 1 if c.phase != E.DETECTIVE_PHASE else rounds
            v = self._value(c, r, alpha, beta, ply + 1)
            if v < best:
                best = v
            if best < beta:
                beta = best
            if alpha >= beta:
                break
        return best

    def _search(self, c, depth, alpha):
        """Value of root option state c searched `depth` rounds deep (beta = +inf)."""
        if self.fast:
            from .fast import ab_value
            import numpy as np
            nodes = np.zeros(1, dtype=np.int64)
            v = ab_value(c, depth, alpha, math.inf, 1, self.det_beam, self._Ws, nodes)
            self.nodes += int(nodes[0])
            return v
        return self._value(c, depth, alpha, math.inf, 1)

    # ---------- root ----------

    def root_options(self, s):
        """[(actions, state after the fugitive's turn)] for every option considered."""
        opts = []
        acts = E.fugitive_actions(s)
        reveal_next = (s.round + 1) in E.REVEAL_ROUNDS
        has_basic = {to for to, t in acts if t != E.SECRET}
        for to, t in acts:
            if t == E.SECRET and reveal_next and to in has_basic:
                continue  # the station is shown anyway: a secret ticket would be wasted
            c = s.clone()
            E.move_fugitive(c, to, t, check=False)
            opts.append(([(to, t)], c))
        if self.doubles and E.can_use_double(s):
            base = s.clone()
            E.use_double(base)
            firsts = {}
            for to, t in E.fugitive_actions(base):
                firsts.setdefault(to, []).append(t)
            for v1, ts1 in firsts.items():
                t1 = richest_ticket(base.fug_tickets, ts1)
                mid = base.clone()
                E.move_fugitive(mid, v1, t1, check=False)
                if mid.over:
                    continue
                seconds = {}
                for to, t in E.fugitive_actions(mid):
                    seconds.setdefault(to, []).append(t)
                for v2, ts2 in seconds.items():
                    tickets = {richest_ticket(mid.fug_tickets, ts2)}
                    if E.SECRET in ts2 and (mid.round + 1) not in E.REVEAL_ROUNDS:
                        tickets.add(E.SECRET)
                    for t2 in tickets:
                        c = mid.clone()
                        E.move_fugitive(c, v2, t2, check=False)
                        opts.append(([DOUBLE, (v1, t1), (v2, t2)], c))
        return opts

    def choose_turn(self, state):
        if state.phase != E.FUGITIVE_PHASE or state.double != E.NO_DOUBLE:
            raise ValueError('choose_turn expects the start of a fugitive turn')
        t0 = time.perf_counter()
        self.nodes = 0
        opts = self.root_options(state)
        jitter = [self.rng.random() * 1e-3 for _ in opts]
        order = list(range(len(opts)))
        results = []  # per depth: (best value, best index, complete)
        per_depth = []  # per depth: {option index: score}
        for depth in range(1, self.depth + 1):
            if depth > 1:
                order = order[:self.root_keep]
            scores = {}
            alpha = -math.inf
            for j in order:
                actions, c = opts[j]
                # depth 1 scores every option exactly (needed for ranking); deeper ones only
                # need to beat the best so far.
                a = -math.inf if depth == 1 else alpha
                v = self._search(c, depth, a) + jitter[j]
                scores[j] = v
                alpha = max(alpha, v)
                if self.time_limit and depth > 1 and time.perf_counter() - t0 > self.time_limit:
                    break
            complete = len(scores) == len(order)
            best = max(scores, key=scores.get)
            results.append((scores[best], best, complete))
            per_depth.append(dict(scores))
            order = sorted(scores, key=scores.get, reverse=True) + [j for j in order if j not in scores]
            if not complete:
                break
            if self.time_limit and time.perf_counter() - t0 > self.time_limit:
                break
        # Deepest search that still sees an escape; if none do, the deepest one (latest capture).
        pick = results[-1]
        for value, idx, complete in reversed(results):
            if value > -WIN / 2 and complete:
                pick = (value, idx, complete)
                break
        value, idx, _ = pick
        # Rankings for inspection. Depth-1 scores are exact for every option; at deeper levels
        # only the best is exact, the rest are upper bounds (alpha-beta cut them off).
        self.last = {'value': value, 'depth': len(results), 'options': len(opts),
                     'nodes': self.nodes, 'time': time.perf_counter() - t0, 'chosen': idx,
                     'rankings': [sorted(((opts[j][0], v) for j, v in sc.items()), key=lambda x: -x[1])
                                  for sc in per_depth]}
        return list(opts[idx][0])
