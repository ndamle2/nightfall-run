"""
ISMCTS detectives (information-set Monte Carlo tree search with determinization).

The detectives never see the fugitive, so every iteration starts by *determinizing*:
sample a station from the public candidate set and pretend the fugitive is there. All
samples share one tree, so a move is judged by how it does across the places the fugitive
could be, not by how it does against one guess.

Tree:
  * detective nodes: the detective to move picks a destination (with its most plentiful
    ticket); chosen by UCB1 on the detectives' win rate.
  * fugitive moves: the fugitive acts in the sampled world, and the child is keyed only by
    what the detectives would observe, the ticket(s) and the station on reveal rounds.
    Different hidden moves that look the same land in the same node, which is what keeps
    this an information-set tree. How the fugitive picks its turn is `fugitive_model`:
      'bandit' (default): an adaptive opponent. Each fugitive node keeps one bandit per
          true fugitive station (that station plus the node fixes everything the fugitive
          knows), over whole turns ranked by the heuristic: single moves, secret-ticket
          variants and a few double routes. It starts with the heuristic's favourite and
          widens to the next-ranked turns as it is visited (progressive widening), keeping
          whichever hurt the detectives most. So the detectives plan against a fugitive
          that answers their moves, not against one fixed policy.
      'heuristic': the heuristic fugitive with extra noise (`model_noise`), a fixed model.

Detective moves are chosen by PUCT with a prior from the heuristic detectives' move scores
(`prior='heuristic'`), so the search starts from the heuristic's choice and leaves it only
when the evidence says so; `prior='none'` is plain UCB1.

Leaves are scored by `rollout_rounds` (default 2): None plays to the end with the heuristic players in
the batched engine (ai/vec_engine.py); 0 scores the leaf with the learned value model
(ai/value.py); R > 0 plays R rounds and then scores with the value model. Leaves are
evaluated `batch` at a time; virtual loss spreads one batch over different branches.
"""
import math
import random
import time

import numpy as np

from . import engine as E
from . import policies as P
from .vec_engine import VecGames, play

# Ranking of fugitive turns for the bandit model, in heuristic score units
# (10 = one move of distance from the nearest detective).
SECRET_PENALTY = 2.0    # a secret ticket instead of a basic one, same destination
DOUBLE_PENALTY = 15.0   # spending a double when a single move is safe enough
DOUBLE_FIRSTS, DOUBLE_SECONDS = 3, 2   # double routes considered: best firsts × best seconds


class Node:
    __slots__ = ('children', 'untried', 'acts', 'prior', 'kids', 'n', 'w', 'fug', 'mass')

    def __init__(self):
        self.children = {}    # UCB detective nodes {action: Node}; fugitive nodes {observation: Node}
        self.untried = None   # UCB detective nodes: actions not expanded yet (best first)
        self.acts = None      # PUCT detective nodes: actions, their prior, child or None
        self.prior = None
        self.kids = None
        self.n = 0
        self.w = 0.0          # detective wins (or win probability from the value model)
        self.fug = None       # fugitive-to-move nodes, bandit model: {true station: FugBandit}
        self.mass = None      # search_belief: location estimate after this node's public moves


class FugBandit:
    __slots__ = ('turns', 'n', 'w', 'total')

    def __init__(self, turns):
        self.turns = turns
        self.n = [0] * len(turns)
        self.w = [0.0] * len(turns)   # fugitive wins
        self.total = 0


def ranked_turns(s):
    """Whole fugitive turns for state s, best first by the heuristic's scoring. The first
    one is what the noise-free heuristic fugitive would play."""
    m = s.map
    dg = P.danger_vector(s)
    base = 10.0 * np.minimum(dg, P.DANGER_CAP) + m.edge_count @ (dg >= 2).astype(np.float32)
    groups = E.group_moves(E.fugitive_actions(s))

    def ticket(state, tickets):
        if state.round in E.REVEAL_ROUNDS and E.SECRET in tickets:
            return E.SECRET  # hide right after a reveal
        return P.richest_ticket(state.fug_tickets, tickets)

    entries = []
    for to, tickets in groups:
        t = ticket(s, tickets)
        entries.append((base[to], [(to, t)]))
        if E.SECRET in tickets and t != E.SECRET:
            entries.append((base[to] - SECRET_PENALTY, [(to, E.SECRET)]))
    if groups and E.can_use_double(s):
        cornered = max(dg[to] for to, _ in groups) <= 1
        bonus = DOUBLE_PENALTY + 1 if cornered else -DOUBLE_PENALTY
        start = s.clone()
        E.use_double(start)
        for v1, ts1 in sorted(groups, key=lambda g: -base[g[0]])[:DOUBLE_FIRSTS]:
            t1 = ticket(start, ts1)
            mid = start.clone()
            E.move_fugitive(mid, v1, t1, check=False)
            if mid.over:
                continue
            seconds = E.group_moves(E.fugitive_actions(mid))
            for v2, ts2 in sorted(seconds, key=lambda g: -base[g[0]])[:DOUBLE_SECONDS]:
                entries.append((base[v2] + bonus, [P.DOUBLE, (v1, t1), (v2, ticket(mid, ts2))]))
    entries.sort(key=lambda e: -e[0])  # stable: ties keep station order, like the heuristic
    return [turn for _, turn in entries]


def heuristic_prior(s, temp, mass=None, team=0.0, cover=0.0, scorer=None):
    """Detective actions and a softmax prior over the heuristic's move scores (lower score =
    better). Stepping onto a candidate station scores -1000 there; for the prior it counts
    as 3 points better than the best other move, so it is favoured but not certain. With a
    location estimate `mass`, scores use it, and a step onto a candidate counts as 2 to 4
    points better, by its probability relative to the likeliest candidate."""
    scored = scorer(s) if scorer is not None else P.HeuristicDetectives.scores(s, mass, team, cover)
    acts = [a for a, _ in scored]
    sc = np.array([x for _, x in scored], dtype=float)
    other = sc[sc > -500]
    if len(other):
        steps = sc <= -500
        if mass is None or not steps.any():
            sc = np.maximum(sc, other.min() - 3)
        else:
            w = (-sc[steps] - 1000) / 100
            sc[steps] = other.min() - 2 - 2 * (w / w.max() if w.max() > 0 else 0.5)
    z = np.exp(-(sc - sc.min()) / temp)
    return acts, (z / z.sum()).tolist()


def _det_actions(s, order_bot):
    """Current detective's destinations, each with its richest legal ticket, ordered with
    the heuristic's favourite first (expanded first)."""
    tk = s.det_tickets[s.current]
    acts = [(to, P.richest_ticket(tk, ts)) for to, ts in E.group_moves(E.detective_actions(s))]
    first = order_bot.choose_move(s)
    acts.sort(key=lambda a: a != first)
    return acts


def _restrict(mass, cand):
    """mass limited to the candidate set and normalized; uniform there if it has none."""
    out = mass * cand
    if out.sum() <= 0:  # the model ruled out everything still possible: fall back
        out = cand.astype(float)
    return out / out.sum()


class ISMCTSDetectives:
    def __init__(self, iterations=3072, time_limit=None, batch=64, c=0.7, belief='mix',
                 fugitive_model='bandit', widen=1.0, model_noise=3.0, prior='heuristic',
                 c_puct=1.5, prior_temp=1.0, rollout_rounds=2, value_path=None, belief_beta=2.0, move_path=None,
                 search_belief='none', team=0.0, cover=0.0, fast=True, reuse='game',
                 reuse_budget='add', prior_terr=0.3, playout_terr=0.0, terr_h=3, seed=None):
        """iterations / time_limit: search budget per move (time_limit wins if both set);
            3072 (1536 before the compiled code: 2x gained 6 points against alpha-beta).
        belief: where the fugitive probably is, within the public candidate set:
            'uniform'; 'far' (weights by distance to the nearest detective now); or 'model',
            which follows the public log move by move, assuming at each move the fugitive
            picked among the stations its ticket reaches with odds exp(belief_beta * distance
            from the nearest detective, capped at 4). The bot keeps that estimate between calls,
            so use one bot per game (a new game is detected and resets it). 'model' with
            belief_beta 2: 44.6% vs 32.9% for 'uniform' against alpha-beta (240 games each).
            'fitted': the same filter with a move model fitted to recorded alpha-beta games
            (ai/move_weights.json, or move_path; policies.move_features): odds over each
            (ticket, destination) pair, so the ticket used is evidence too. On held-out
            games it puts 0.345 on the true station on average vs 0.270 for 'model'.
            'mix': both move models (fitted, and 'model's runs-from-detectives odds as a
            joint model), each filtering on its own, weighted by how well each predicted
            what was seen so far this game. Near the better of the two against either
            fugitive: alpha-beta (fitted 0.332, 'model' 0.266, mix 0.330) and the
            heuristic fugitive (0.353, 0.394, 0.380). Default 'mix': against alpha-beta
            (twin + quarter, 240 games each) 43.8% vs 37.9% for 'model' with 4 detectives,
            72.1% vs 62.5% with 5 ('fitted': 41.3% / 69.2%).
        search_belief (belief='model' only, so pass belief='model' with it): where else
            the estimate is used, besides sampling: 'none'; 'prior' (the PUCT prior's heuristic scores, at every tree node,
            with the estimate carried along each node's public moves); 'both' (the prior and
            the heuristic detectives in leaf playouts).
        team, cover: team-coverage terms of the heuristic detectives (see
            policies.HeuristicDetectives), used in the PUCT prior and in playouts.
        fast: evaluate leaves with the compiled code in ai/fast.py when numba is installed
            (same playouts, several times faster); not used with search_belief='both' or
            team/cover, which only the batched engine implements.
        reuse: keep the search tree from one decision to the next, so the detectives act on
            one shared plan: 'none'; 'round' (the next detective starts from the subtree
            under the move just made, while the round lasts); 'game' (also across the
            fugitive's turn, through the branch matching what it was seen to do). Default
            'game': 35.0% vs 26.3% for 'none' against alpha-beta (4 detectives, 240 games).
            The bot keeps the tree between calls, so use one bot per game.
        reuse_budget: with reuse, 'add' runs `iterations` new iterations on top of the reused
            tree; 'total' stops once the root has `iterations` visits in all.
        prior_terr / playout_terr: weight per station of the fugitive's territory (union
            mode, policies.team_territory, within terr_h moves) in the heuristic scores
            behind the PUCT prior / in the playout detectives' moves. A team objective:
            a move is judged by how much room it leaves the fugitive given where the other
            detectives stand. Default prior_terr 0.3 (31.3% vs 26.3%; with reuse='game'
            37.9%, and 62.5% vs 52.1% with 5 detectives); playout_terr 0 (no gain, +40% time).
        fugitive_model: 'bandit' or 'heuristic' (see the module docstring).
        widen: bandit model, turns considered = 1 + widen * sqrt(visits).
        model_noise: heuristic model, randomness in heuristic score units.
        prior: 'heuristic' (PUCT, exploration constant c_puct, prior softmax temperature
            prior_temp in heuristic score units) or 'none' (UCB1 with constant c).
        rollout_rounds: None (play leaves to the end), 0 (value model only) or R (play R
            rounds, then value model).
        value_path: value-model weights (default ai/value_weights.json)."""
        self.iterations = iterations
        self.time_limit = time_limit
        self.batch = batch
        self.c = c
        self.belief = belief
        self.belief_beta = belief_beta
        self.search_belief = search_belief if belief == 'model' else 'none'
        self._mem = None  # belief='model'/'fitted': [game key, log entries processed, mass (N,)]
        self._move_ws = None   # 'fitted' / 'mix': the move models' weight vectors
        if belief in ('fitted', 'mix'):
            import json
            from pathlib import Path
            d = json.loads(Path(move_path or Path(__file__).with_name('move_weights.json')).read_text())
            if tuple(d['features']) != P.MOVE_FEATS:
                raise ValueError('move_weights.json does not match policies.MOVE_FEATS')
            self._move_ws = [np.array(d['weights'])]
            if belief == 'mix':
                runs = np.zeros(len(P.MOVE_FEATS))
                runs[P.MOVE_FEATS.index('dg')] = belief_beta
                self._move_ws.append(runs)
        self.fugitive_model = fugitive_model
        self.widen = widen
        self.prior = prior
        self.c_puct = c_puct
        self.prior_temp = prior_temp
        self.rollout_rounds = rollout_rounds
        self.value = None
        if rollout_rounds is not None:
            from .value import ValueModel
            self.value = ValueModel.load(value_path) if value_path else ValueModel.load()
        self.rng = random.Random(seed)
        self.nprng = np.random.default_rng(seed)
        self.model = P.HeuristicFugitive(seed=self.rng.random(), noise=model_noise)
        self.order_bot = P.HeuristicDetectives(seed=self.rng.random(), noise=0)
        from . import fast as F
        self.fast = (fast and F.AVAILABLE and self.value is not None
                     and self.search_belief != 'both' and not team and not cover)
        if self.fast:
            self._W = F.full_weights(self.value)
            F.seed(self.rng.randrange(2 ** 31))
        # compiled tree pieces: identical results, used whenever numba is available
        self.prior_terr, self.playout_terr, self.terr_h = prior_terr, playout_terr, terr_h
        self._scorer, self._ranked = None, ranked_turns
        if fast and F.AVAILABLE:
            from . import fast_tree as FT
            self._ranked = FT.ranked_turns
            if self.search_belief == 'none' and not team and not cover:
                self._scorer = (lambda st: FT.det_scores(st, prior_terr, terr_h)) if prior_terr \
                    else FT.det_scores
        if playout_terr and not self.fast:
            raise ValueError('playout_terr needs the compiled playouts (numba, fast=True)')
        if self._scorer is None and prior_terr:
            self._scorer = lambda st: P.HeuristicDetectives.scores(st, None, team, cover,
                                                                   prior_terr, terr_h)
        self.roll_fug = P.vec_heuristic_fugitive()
        self.team, self.cover = team, cover
        self.roll_det = P.vec_heuristic_detective(team=team, cover=cover)
        self.last = {}
        self.reuse, self.reuse_budget = reuse, reuse_budget
        self._carry = None  # (public-state signature expected next, node) for reuse

    # ---------- belief ----------

    def belief_mass(self, s):
        """belief 'model' / 'fitted' / 'mix': (N,) probability of each station, zero outside the candidates.

        Updated once per new log entry, on the first call after the fugitive's move, when the
        detectives still stand where the fugitive saw them (both halves of a double faced the
        same detectives)."""
        m = s.map
        key = (s.map.key, s.det_start)
        if self._move_ws is not None:
            return self._mixture_mass(s, key)
        if self._mem is None or self._mem[0] != key or self._mem[1] > len(s.log):
            mass = np.zeros(m.n)
            mass[m.starts] = 1.0
            mass[list(s.det_start)] = 0.0
            self._mem = [key, 0, mass / mass.sum()]
        _, done, mass = self._mem
        if done < len(s.log):
            mass = P.belief_update(m, mass, s.log[done:], P.belief_pref(s, self.belief_beta))
            self._mem = [key, len(s.log), mass]
        return _restrict(mass, E.possible_mask(s))

    def _mixture_mass(self, s, key):
        """belief 'fitted' / 'mix': _mem = [key, entries done, [mass per model], log posterior]."""
        m = s.map
        K = len(self._move_ws)
        if self._mem is None or self._mem[0] != key or self._mem[1] > len(s.log):
            mass = np.zeros(m.n)
            mass[m.starts] = 1.0
            mass[list(s.det_start)] = 0.0
            mass /= mass.sum()
            self._mem = [key, 0, [mass.copy() for _ in range(K)], np.zeros(K)]
        _, done, masses, logpost = self._mem
        if done < len(s.log):
            new = s.log[done:]
            # the tickets and round before each new entry (detectives as they stand now)
            tk = list(s.fug_tickets)
            for t, *_ in new:
                tk[t] += 1
            before, rnd = [], s.round - len(new)
            for t, *_ in new:
                before.append((tk[:], rnd))
                tk[t] -= 1
                rnd += 1
            masses, logpost = list(masses), logpost.copy()
            for k, w in enumerate(self._move_ws):
                masses[k], ev = P.belief_update_joint(
                    m, masses[k], new,
                    lambda j, w=w: P.move_odds(m, s.det_pos, s.det_tickets, before[j][0], before[j][1], w),
                    evidence=True)
                logpost[k] += ev
            logpost -= logpost.max()
            self._mem = [key, len(s.log), masses, logpost]
        post = np.exp(logpost)
        post /= post.sum()
        self.last_posterior = post
        mix = sum(p * mk for p, mk in zip(post, masses))
        return _restrict(mix, E.possible_mask(s))

    def _sampler(self, s):
        cands = E.possible_locations(s)
        if not cands:
            raise ValueError('no candidate stations for the fugitive')
        if self.belief in ('model', 'fitted', 'mix'):
            mass = self.belief_mass(s)  # always, so no log entry is skipped
            if len(cands) == 1:
                return lambda: cands[0]
            w = mass[cands].tolist()
        elif self.belief == 'uniform' or len(cands) == 1:
            return lambda: self.rng.choice(cands)
        else:
            dg = P.danger_vector(s)[cands].astype(float)
            w = np.minimum(dg, 4) ** 2
            w = (w / w.sum()).tolist()
        return lambda: self.rng.choices(cands, w)[0]

    # ---------- search ----------

    def _fugitive_turn(self, s, node, picks):
        if self.fugitive_model != 'bandit':
            return self.model.choose_turn(s)
        if node.fug is None:
            node.fug = {}
        fb = node.fug.get(s.fug_pos)
        if fb is None:
            fb = node.fug[s.fug_pos] = FugBandit(self._ranked(s))
        width = min(len(fb.turns), 1 + int(self.widen * math.sqrt(fb.total)))
        pick = -1
        for i in range(width):
            if fb.n[i] == 0:
                pick = i
                break
        if pick < 0:
            log_n = math.log(fb.total)
            best_u = -1.0
            for i in range(width):
                u = fb.w[i] / fb.n[i] + self.c * math.sqrt(log_n / fb.n[i])
                if u > best_u:
                    pick, best_u = i, u
        fb.total += 1
        fb.n[pick] += 1  # virtual loss for the fugitive until backed up
        picks.append((fb, pick))
        return fb.turns[pick]

    def _select(self, s, root):
        """Walks one determinized state down the tree; returns (leaf state, path, picks,
        location estimate at the leaf or None)."""
        node = root
        path = [root]
        picks = []
        mass = root.mass
        root.n += 1  # virtual loss: counted as a visit with no win until backed up
        while not s.over:
            if s.phase == E.DETECTIVE_PHASE and self.prior == 'heuristic':
                if node.acts is None:
                    node.acts, node.prior = heuristic_prior(s, self.prior_temp, mass, self.team, self.cover,
                                                              self._scorer)
                    node.kids = [None] * len(node.acts)
                sq = math.sqrt(node.n)
                fpu = node.w / node.n  # unvisited moves start at the parent's value
                pick, best_u = 0, -math.inf
                for i, kid in enumerate(node.kids):
                    if kid is None:
                        u = fpu + self.c_puct * node.prior[i] * sq
                    else:
                        u = kid.w / kid.n + self.c_puct * node.prior[i] * sq / (1 + kid.n)
                    if u > best_u:
                        pick, best_u = i, u
                a = node.acts[pick]
                E.move_detective(s, a[0], a[1], check=False)
                kid = node.kids[pick]
                if kid is None:
                    kid = node.kids[pick] = Node()
                    kid.n += 1
                    path.append(kid)
                    return s, path, picks, mass
                node = kid
            elif s.phase == E.DETECTIVE_PHASE:
                if node.untried is None:
                    node.untried = _det_actions(s, self.order_bot)
                if node.untried:
                    a = node.untried.pop(0)
                    child = node.children[a] = Node()
                    E.move_detective(s, a[0], a[1], check=False)
                    child.n += 1
                    path.append(child)
                    return s, path, picks, mass
                log_n = math.log(node.n)
                best, best_u = None, -1.0
                for a, ch in node.children.items():
                    u = ch.w / ch.n + self.c * math.sqrt(log_n / ch.n)
                    if u > best_u:
                        best, best_u = a, u
                E.move_detective(s, best[0], best[1], check=False)
                node = node.children[best]
            else:
                actions = self._fugitive_turn(s, node, picks)
                P.apply_turn(s, actions)
                moves = len(actions) - (P.DOUBLE in actions)
                # what the detectives see: ticket per move, station only on reveal rounds
                key = tuple((t, p if rev else -1) for (t, p, rev, _) in s.log[-moves:])
                child = node.children.get(key)
                if child is None:
                    child = node.children[key] = Node()
                if mass is not None:
                    if child.mass is None:  # same public moves, same detectives: same estimate
                        child.mass = P.belief_update(s.map, mass, s.log[-moves:],
                                                     P.belief_pref(s, self.belief_beta))
                    mass = child.mass
                node = child
            node.n += 1
            path.append(node)
        return s, path, picks, mass

    def _evaluate(self, states, masses=None):
        """P(detectives win) for each leaf state (masses: location estimates for playouts)."""
        wins = [float(s.winner == E.DETECTIVES_WIN) for s in states]
        live = [i for i, s in enumerate(states) if not s.over]
        if not live:
            return wins
        if self.rollout_rounds == 0:
            for i in live:
                wins[i] = self.value(states[i])
            return wins
        if self.fast:
            from .fast import playout_values
            vals = playout_values([states[i] for i in live], self.rollout_rounds, self._W,
                                  terr=self.playout_terr, terr_h=self.terr_h)
            for j, i in enumerate(live):
                wins[i] = float(vals[j])
            return wins
        g = VecGames.from_states([states[i] for i in live])
        if masses is not None and self.search_belief == 'both':
            g.belief_beta = self.belief_beta
            g.mass = np.stack([_restrict(masses[i], states[i].cand) for i in live])
        until = None
        if self.rollout_rounds is not None:
            until = np.array([states[i].round + self.rollout_rounds for i in live])
        play(g, self.roll_fug, self.roll_det, self.nprng, until_round=until)
        for j, i in enumerate(live):
            if g.phase[j] == E.OVER:
                wins[i] = float(g.winner[j] == E.DETECTIVES_WIN)
            else:
                wins[i] = self.value(g.to_state(j))
        return wins

    def choose_move(self, public):
        if public.phase != E.DETECTIVE_PHASE:
            raise ValueError('choose_move expects a detective to move')
        t0 = time.perf_counter()
        root = self._reused_root(public) if self.reuse != 'none' else None
        reused = 0 if root is None else root.n
        if root is None:
            root = Node()
        sample = self._sampler(public)
        if self.search_belief != 'none':
            root.mass = self.belief_mass(public)
        budget = self.iterations - (reused if self.reuse_budget == 'total' else 0)
        done = 0
        while budget > 0:
            leaves = []
            for _ in range(self.batch):
                s = public.clone()
                s.fug_pos = sample()
                leaves.append(self._select(s, root))
            wins = self._evaluate([x[0] for x in leaves], [x[3] for x in leaves])
            for (_, path, picks, _), w in zip(leaves, wins):
                for node in path:
                    node.w += w
                for fb, i in picks:
                    fb.w[i] += 1.0 - w
            done += len(leaves)
            if self.time_limit is not None:
                if time.perf_counter() - t0 >= self.time_limit:
                    break
            elif done >= budget:
                break
            if self._root_moves(root) == 1:
                break  # only one legal move
        kids = self._root_children(root)
        if not kids:  # reused root with no explored move and no budget left
            return self._fresh_move(public)
        best = max(kids, key=lambda kv: kv[1].n)
        if self.reuse != 'none':
            self._remember(public, best)
        self.last = {
            'iterations': done, 'reused': reused, 'time': time.perf_counter() - t0,
            'value': best[1].w / best[1].n,
            'children': sorted(((a, ch.n, round(ch.w / ch.n, 3)) for a, ch in kids), key=lambda x: -x[1]),
            'prior': dict(zip(root.acts, root.prior)) if root.acts is not None else {},
        }
        return best[0]

    # ---------- tree reuse ----------

    @staticmethod
    def _sig(s):
        return (s.map.key, s.det_start, tuple(s.det_pos), tuple(tuple(t) for t in s.det_tickets),
                s.round, len(s.log), s.current, s.phase)

    def _remember(self, public, best):
        """Keeps the chosen move's subtree, with the public state it expects next."""
        (to, t), node = best
        after = public.clone()
        E.move_detective(after, to, t, check=False)
        self._carry = None if after.over else (after, node)

    def _reused_root(self, public):
        carry, self._carry = self._carry, None
        if carry is None:
            return None
        after, node = carry
        if after.phase == E.DETECTIVE_PHASE:
            return node if self._sig(after) == self._sig(public) else None
        if self.reuse != 'game':
            return None
        # the round ended in the tree: follow the fugitive's observed turn
        moves = len(public.log) - len(after.log)
        if (moves not in (1, 2) or public.log[:len(after.log)] != after.log
                or tuple(public.det_pos) != tuple(after.det_pos)
                or [list(x) for x in public.det_tickets] != [list(x) for x in after.det_tickets]):
            return None
        key = tuple((t, p if rev else -1) for (t, p, rev, _) in public.log[-moves:])
        return node.children.get(key)

    def _fresh_move(self, public):
        saved, self.reuse = self.reuse, 'none'
        try:
            return self.choose_move(public)
        finally:
            self.reuse = saved

    @staticmethod
    def _root_children(root):
        if root.acts is not None:
            return [(a, k) for a, k in zip(root.acts, root.kids) if k is not None]
        return list(root.children.items())

    @staticmethod
    def _root_moves(root):
        if root.acts is not None:
            return len(root.acts)
        return len(root.children) + (len(root.untried) if root.untried else 0)
