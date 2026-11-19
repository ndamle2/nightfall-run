"""Behaviour checks for the search bots.

    python3 -m unittest ai.tests.test_bots
"""
import random
import unittest

import numpy as np

from ai import engine as E
from ai import policies as P
from ai.alphabeta import AlphaBetaFugitive, WIN
from ai.ismcts import ISMCTSDetectives


def random_midgame(gm, k, rng, rounds):
    """Random play until the fugitive has made `rounds` moves; None if the game ended."""
    s = E.new_game(gm, k, rng)
    fug, det = P.RandomFugitive(seed=rng.random(), p_double=0), P.RandomDetectives(seed=rng.random())
    while not s.over and not (s.phase == E.FUGITIVE_PHASE and s.round >= rounds):
        if s.phase == E.FUGITIVE_PHASE:
            P.apply_turn(s, fug.choose_turn(s))
        else:
            E.move_detective(s, *det.choose_move(s.public_view()))
    return None if s.over else s


def capturable(s):
    """Could some detective step onto the fugitive this round?"""
    return any(s.map.adj[t, p, s.fug_pos] and tk[t] > 0
               for p, tk in zip(s.det_pos, s.det_tickets) for t in range(3))


class AlphaBeta(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gm = E.GameMap.load('twin')

    def test_legal_and_only_risks_capture_when_forced(self):
        rng = random.Random(11)
        bot = AlphaBetaFugitive(depth=1, det_beam=3, seed=1)
        checked = forced = 0
        while checked < 60:
            s = random_midgame(self.gm, rng.choice((3, 4, 5)), rng, rng.randint(0, 20))
            if s is None or s.double != E.NO_DOUBLE:
                continue
            turn = bot.choose_turn(s)
            after = s.clone()
            P.apply_turn(after, turn)  # raises if illegal
            checked += 1
            if not after.over and capturable(after):
                # every option must have allowed a capture
                for _, c in bot.root_options(s):
                    self.assertLess(bot._value(c, 1, -np.inf, np.inf, 1), -WIN / 2)
                forced += 1
        self.assertLess(forced, checked)

    def test_no_secret_on_reveal_round_when_basic_works(self):
        rng = random.Random(13)
        bot = AlphaBetaFugitive(depth=1, seed=2)
        seen = 0
        while seen < 6:
            s = random_midgame(self.gm, 4, rng, rng.choice([2, 7, 12, 17]))  # next move reveals
            if s is None or s.double != E.NO_DOUBLE or s.fug_tickets[E.SECRET] == 0:
                continue
            singles = [o[0] for o in bot.root_options(s) if len(o[0]) == 1]
            basic = {to for to, t in E.fugitive_actions(s) if t != E.SECRET}
            for (to, t), in singles:
                self.assertFalse(t == E.SECRET and to in basic)
            seen += 1

    def test_room_to_run(self):
        """Counts stations the fugitive reaches first; never more than it can reach, zero
        when every station within reach is at least as close to a detective."""
        rng = random.Random(17)
        for _ in range(40):
            s = random_midgame(self.gm, 4, rng, rng.randint(0, 20))
            if s is None:
                continue
            room = P.room_to_run(s)
            fd = self.gm.dist[7, s.fug_pos]
            self.assertLessEqual(room, int((fd <= 3).sum()))
            self.assertGreaterEqual(room, 1 if s.fug_tickets[E.SECRET] or any(s.fug_tickets[:3]) else 0)

    def test_depth_two_runs(self):
        rng = random.Random(4)
        bot = AlphaBetaFugitive(depth=2, det_beam=2, seed=2)
        for _ in range(5):
            s = random_midgame(self.gm, 5, rng, 6)
            if s is not None:
                P.apply_turn(s.clone(), bot.choose_turn(s))
                self.assertEqual(bot.last['depth'], 2)


class ISMCTS(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gm = E.GameMap.load('twin')

    def test_takes_known_capture(self):
        rng = random.Random(7)
        bot = ISMCTSDetectives(iterations=128, seed=3)
        done = 0
        while done < 8:
            s = random_midgame(self.gm, 4, rng, rng.randint(1, 18))
            if s is None:
                continue
            # pretend the fugitive was just revealed next to detective 0
            nb = [v for t in range(3) if s.det_tickets[0][t] > 0 for v in self.gm.nbr[t][s.det_pos[0]]
                  if v not in s.det_pos]
            if not nb:
                continue
            v = rng.choice(nb)
            s.fug_pos = v
            c = np.zeros(self.gm.n, dtype=bool)
            c[v] = True
            s.cand = c
            s.phase, s.current = E.DETECTIVE_PHASE, 0
            to, t = bot.choose_move(s.public_view())
            self.assertEqual(to, v)
            E.move_detective(s, to, t)  # legal
            self.assertEqual(s.winner, E.DETECTIVES_WIN)
            done += 1

    def test_ranked_turns_start_with_heuristic_choice(self):
        """The bandit model's first turn is the noise-free heuristic's turn, and every
        ranked turn is legal."""
        from ai.ismcts import ranked_turns
        rng = random.Random(21)
        heur = P.HeuristicFugitive(noise=0)
        n = 0
        while n < 60:
            s = random_midgame(self.gm, rng.choice((3, 5)), rng, rng.randint(0, 21))
            if s is None or s.double != E.NO_DOUBLE:
                continue
            turns = ranked_turns(s)
            for turn in turns:
                P.apply_turn(s.clone(), turn)  # raises if illegal
            self.assertEqual(len({tuple(t) for t in turns}), len(turns))
            self.assertEqual(turns[0], heur.choose_turn(s))
            n += 1

    def test_leaf_modes_take_known_capture(self):
        """Value-model leaves, short playouts and plain UCB all still find a sure capture."""
        rng = random.Random(8)
        bots = [ISMCTSDetectives(iterations=128, belief='model', search_belief='both', seed=0),
                ISMCTSDetectives(iterations=128, rollout_rounds=0, seed=1),
                ISMCTSDetectives(iterations=128, rollout_rounds=2, seed=2),
                ISMCTSDetectives(iterations=128, prior='none', rollout_rounds=0, seed=3)]
        done = 0
        while done < 4:
            s = random_midgame(self.gm, 4, rng, rng.randint(1, 18))
            if s is None:
                continue
            nb = [v for t in range(3) if s.det_tickets[0][t] > 0 for v in self.gm.nbr[t][s.det_pos[0]]
                  if v not in s.det_pos]
            if not nb:
                continue
            v = rng.choice(nb)
            s.fug_pos = v
            c = np.zeros(self.gm.n, dtype=bool)
            c[v] = True
            s.cand = c
            s.phase, s.current = E.DETECTIVE_PHASE, 0
            for bot in bots:
                self.assertEqual(bot.choose_move(s.public_view())[0], v)
            done += 1

    def test_prior_is_a_distribution_favouring_the_heuristic(self):
        from ai.ismcts import heuristic_prior
        rng = random.Random(3)
        n = 0
        while n < 20:
            s = random_midgame(self.gm, 4, rng, rng.randint(1, 18))
            if s is None:
                continue
            P.apply_turn(s, P.RandomFugitive(seed=n).choose_turn(s))
            if s.over:
                continue
            acts, prior = heuristic_prior(s.public_view(), 1.0)
            self.assertAlmostEqual(sum(prior), 1.0)
            self.assertEqual(sorted(acts), sorted((to, P.richest_ticket(s.det_tickets[s.current], ts))
                                                  for to, ts in E.group_moves(E.detective_actions(s))))
            best = P.HeuristicDetectives(noise=0).choose_move(s.public_view())
            self.assertEqual(prior[acts.index(best)], max(prior))
            n += 1

    def test_play_until_round(self):
        from ai.vec_engine import VecGames, play
        g = VecGames.new(self.gm, 50, 4, np.random.default_rng(1))
        play(g, P.vec_heuristic_fugitive(), P.vec_heuristic_detective(), np.random.default_rng(2),
             until_round=5)
        live = g.phase != E.OVER
        # a double move can step past the limit by one
        self.assertTrue(((g.round[live] == 5) | (g.round[live] == 6)).all())
        self.assertTrue((g.phase[live] == E.FUGITIVE_PHASE).all())

    def test_belief_model_is_consistent(self):
        """belief='model' / 'fitted' is a distribution over the candidate set that never
        rules out where the fugitive really is, and resets for a new game."""
        rng = random.Random(23)
        for belief in ('model', 'fitted', 'mix'):
            self._belief_consistent(rng, ISMCTSDetectives(iterations=32, belief=belief, seed=6))

    def _belief_consistent(self, rng, bot):
        for g in range(3):
            s = E.new_game(self.gm, 4, rng)
            fug, det = P.HeuristicFugitive(seed=g), P.HeuristicDetectives(seed=g)
            while not s.over:
                if s.phase == E.FUGITIVE_PHASE:
                    P.apply_turn(s, fug.choose_turn(s))
                else:
                    pub = s.public_view()
                    mass = bot.belief_mass(pub)
                    self.assertAlmostEqual(mass.sum(), 1.0)
                    self.assertTrue((mass[~E.possible_mask(pub)] == 0).all())
                    self.assertGreater(mass[s.fug_pos], 0)
                    E.move_detective(s, *det.choose_move(pub))
        s = None
        while s is None:
            s = random_midgame(self.gm, 4, rng, 5)
        P.apply_turn(s, P.RandomFugitive(seed=1).choose_turn(s))
        if not s.over:
            self.assertIn(bot.choose_move(s.public_view()), E.detective_actions(s))

    def test_estimate_in_search(self):
        """search_belief 'prior' and 'both' still take a sure capture, and the batched
        heuristic detectives with a location estimate pick the same move as the scalar
        scorer given that estimate."""
        from ai.vec_engine import VecGames
        rng = random.Random(31)
        bots = [ISMCTSDetectives(iterations=128, belief='model', search_belief=sb, seed=i)
                for i, sb in enumerate(('prior', 'both'))]
        states, masses, done = [], [], 0
        nr = np.random.default_rng(4)
        while done < 4 or len(states) < 40:
            s = random_midgame(self.gm, 4, rng, rng.randint(1, 18))
            if s is None:
                continue
            P.apply_turn(s, P.RandomFugitive(seed=done).choose_turn(s))
            if s.over:
                continue
            m = nr.random(self.gm.n) ** 4 * E.possible_mask(s)
            states.append(s)
            masses.append(m / m.sum())
            if done < 4:
                for bot in bots:
                    self.assertIn(bot.choose_move(s.public_view()), E.detective_actions(s))
                done += 1
        for team, cover in ((0.0, 0.0), (2.0, 6.0)):
            g = VecGames.from_states(states)
            g.mass = np.stack(masses)
            P.vec_heuristic_detective(noise=0, team=team, cover=cover)(g, np.arange(len(states)), nr)
            for b, (s, m) in enumerate(zip(states, masses)):
                sc = dict((a[0], v) for a, v in P.HeuristicDetectives.scores(s, m, team, cover))
                # equal up to float rounding (float32 in the batched version)
                self.assertLess(sc[g.det_pos[b, s.current]] - min(sc.values()), 1e-4)

    def test_tree_reuse(self):
        """reuse='round' / 'game': every move legal, later detectives in a round start from
        the previous detective's subtree, and 'total' keeps the root at the budget."""
        for reuse, budget in (('round', 'add'), ('game', 'total')):
            rng = random.Random(12)
            s = E.new_game(self.gm, 3, rng)
            fug = P.HeuristicFugitive(seed=1)
            bot = ISMCTSDetectives(iterations=128, reuse=reuse, reuse_budget=budget, seed=3)
            reused = []
            while not s.over and s.round < 8:
                if s.phase == E.FUGITIVE_PHASE:
                    P.apply_turn(s, fug.choose_turn(s))
                    continue
                first = s.current == 0
                mv = bot.choose_move(s.public_view())
                self.assertIn(mv, E.detective_actions(s))
                if not first:
                    reused.append(bot.last['reused'])
                if budget == 'total' and bot.last['reused'] < 128:
                    self.assertGreaterEqual(bot.last['reused'] + bot.last['iterations'], 128)
                E.move_detective(s, *mv)
            self.assertGreater(sum(reused) / len(reused), 20)

    def test_team_territory(self):
        """The union territory (any candidate) is an upper bound on the expected one."""
        rng = random.Random(14)
        n = 0
        while n < 15:
            s = random_midgame(self.gm, 4, rng, rng.randint(2, 18))
            if s is None:
                continue
            P.apply_turn(s, P.RandomFugitive(seed=n).choose_turn(s))
            if s.over:
                continue
            cands = np.flatnonzero(E.possible_mask(s))
            moves = E.group_moves(E.detective_actions(s))
            tos = np.array([to for to, _ in moves])
            masks = np.array([E.ticket_mask(s.det_tickets[s.current])] * len(tos))
            u = P.team_territory(s, cands, tos, masks, 3, 'union')
            e = P.team_territory(s, cands, tos, masks, 3, 'expected')
            self.assertTrue((e <= u + 1e-9).all())
            n += 1

    def test_heuristic_model_still_works(self):
        rng = random.Random(2)
        bot = ISMCTSDetectives(iterations=64, fugitive_model='heuristic', seed=5)
        s = None
        while s is None:
            s = random_midgame(self.gm, 3, rng, 4)
        P.apply_turn(s, P.RandomFugitive(seed=1).choose_turn(s))
        if not s.over:
            self.assertIn(bot.choose_move(s.public_view()), E.detective_actions(s))

    def test_legal_moves_from_public_view(self):
        rng = random.Random(9)
        bot = ISMCTSDetectives(iterations=64, seed=4)
        n = 0
        while n < 10:
            s = random_midgame(self.gm, 3, rng, rng.randint(1, 15))
            if s is None:
                continue
            P.apply_turn(s, P.RandomFugitive(seed=n).choose_turn(s))
            if s.over:
                continue
            pub = s.public_view()
            self.assertEqual(pub.fug_pos, -1)
            to, t = bot.choose_move(pub)
            self.assertIn((to, t), E.detective_actions(s))
            n += 1


class Arena(unittest.TestCase):
    def test_small_match(self):
        from ai import arena
        res = arena.run_matches('alphabeta', 'ismcts', ['twin'], [3], 2, workers=1,
                                fopts={'depth': 1}, dopts={'iterations': 32}, progress=False)
        self.assertEqual(len(res), 2)
        self.assertTrue(all(r['winner'] in (E.FUGITIVE_WINS, E.DETECTIVES_WIN) for r in res))


if __name__ == '__main__':
    unittest.main()
