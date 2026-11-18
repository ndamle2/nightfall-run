"""Compiled leaf evaluation (ai/fast.py) against the batched engine and the value model.

    python3 -m unittest ai.tests.test_fast      (skipped without numba)
"""
import random
import unittest

import numpy as np

from ai import engine as E
from ai import fast
from ai import policies as P
from ai.value import ValueModel
from ai.vec_engine import VecGames, play


def positions(gm, rng, count):
    """Mid-game positions in both phases (some mid-way through the detectives' round)."""
    out = []
    while len(out) < count:
        k = rng.choice((2, 3, 4, 5))
        s = E.new_game(gm, k, rng)
        fug, det = P.RandomFugitive(seed=rng.random()), P.RandomDetectives(seed=rng.random())
        stop = rng.randint(0, 40)
        steps = 0
        while not s.over and steps < stop:
            if s.phase == E.FUGITIVE_PHASE:
                P.apply_turn(s, fug.choose_turn(s))
            else:
                E.move_detective(s, *det.choose_move(s.public_view()))
            steps += 1
        if not s.over and s.double == E.NO_DOUBLE:
            out.append(s)
    return out


@unittest.skipUnless(fast.AVAILABLE, 'numba not installed')
class FastPlayouts(unittest.TestCase):
    def test_matches_batched_engine_without_noise(self):
        value = ValueModel.load()
        W = fast.full_weights(value)
        for key in ('twin', 'quarter'):
            gm = E.GameMap.load(key)
            rng = random.Random(3)
            sts = positions(gm, rng, 300)
            for rounds in (0, 2, None):
                for k in sorted({s.n for s in sts}):
                    group = [s for s in sts if s.n == k]
                    g = VecGames.from_states(group)
                    until = None if rounds is None else np.array([s.round + rounds for s in group])
                    play(g, P.vec_heuristic_fugitive(noise=0), P.vec_heuristic_detective(noise=0),
                         np.random.default_rng(0), until_round=until)
                    ref = [float(g.winner[j] == E.DETECTIVES_WIN) if g.phase[j] == E.OVER
                           else value(g.to_state(j)) for j in range(len(group))]
                    packed = fast.pack(group)
                    got = fast.playout_values(group, rounds, W, 0.0, 0.0, packed=packed)
                    np.testing.assert_allclose(got, ref, atol=1e-12, err_msg=f'{key} k={k} rounds={rounds}')
                    det_pos, det_tk, fug_pos, fug_tk, state, cand = packed
                    np.testing.assert_array_equal(det_pos, g.det_pos)
                    np.testing.assert_array_equal(fug_pos, g.fug_pos)
                    np.testing.assert_array_equal(cand, g.cand)
                    np.testing.assert_array_equal(state[:, 0], g.phase)
                    np.testing.assert_array_equal(state[:, 1], g.round)

    def test_noisy_playouts_agree_statistically(self):
        """With the default noise, win rates over many playouts match the batched engine."""
        gm = E.GameMap.load('twin')
        rng = random.Random(5)
        sts = [s for s in positions(gm, rng, 60) if s.n == 4][:20] or positions(gm, rng, 20)
        W = fast.full_weights(ValueModel.load())
        fast.seed(1)
        reps = 200
        batch = [s for s in sts for _ in range(reps)]
        got = fast.playout_values(batch, None, W).reshape(len(sts), reps).mean(1)
        g = VecGames.from_states(batch)
        play(g, P.vec_heuristic_fugitive(), P.vec_heuristic_detective(), np.random.default_rng(1))
        ref = (g.winner == E.DETECTIVES_WIN).reshape(len(sts), reps).mean(1)
        self.assertLess(np.abs(got - ref).mean(), 0.05)


@unittest.skipUnless(fast.AVAILABLE, 'numba not installed')
class FastTree(unittest.TestCase):
    def test_alphabeta_same_tree(self):
        """Compiled alpha-beta: same turns and the same number of nodes as the Python search."""
        from ai.alphabeta import AlphaBetaFugitive
        from ai.tests.test_bots import random_midgame
        for key in ('twin', 'quarter'):
            gm = E.GameMap.load(key)
            rng = random.Random(8)
            n = 0
            while n < 12:
                s = random_midgame(gm, rng.choice((3, 4, 5)), rng, rng.randint(0, 20))
                if s is None or s.double != E.NO_DOUBLE:
                    continue
                for depth in (2, 3) if n < 4 else (2,):
                    a = AlphaBetaFugitive(depth=depth, fast=False, seed=n)
                    b = AlphaBetaFugitive(depth=depth, fast=True, seed=n)
                    self.assertEqual(a.choose_turn(s), b.choose_turn(s))
                    self.assertEqual(a.nodes, b.nodes)
                    self.assertEqual(a.last['rankings'], b.last['rankings'])
                n += 1

    def test_prior_scores_and_ranked_turns(self):
        from ai.fast_tree import det_scores, ranked_turns
        from ai.ismcts import ranked_turns as py_ranked
        for key in ('twin', 'harbour'):
            gm = E.GameMap.load(key)
            for s in positions(gm, random.Random(9), 400):
                if s.phase == E.DETECTIVE_PHASE:
                    self.assertEqual(det_scores(s), P.HeuristicDetectives.scores(s))
                else:
                    self.assertEqual(ranked_turns(s), py_ranked(s))


if __name__ == '__main__':
    unittest.main()
