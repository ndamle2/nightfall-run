"""Batched engine and batched heuristics against the scalar engine (itself checked against JS).

    python3 -m unittest ai.tests.test_vec_engine
"""
import random
import unittest

import numpy as np

from ai import engine as E
from ai import policies as P
from ai.vec_engine import VecGames, REASONS


def same(test, s, g, b, where):
    got = g.to_state(b)
    for f in ('det_pos', 'det_tickets', 'fug_pos', 'fug_tickets', 'phase', 'round', 'current',
              'double', 'winner', 'reason'):
        test.assertEqual(getattr(got, f), getattr(s, f), f'{where}: {f}')
    test.assertTrue(np.array_equal(got.cand, s.cand), f'{where}: cand')


class VecEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.maps = [E.GameMap.load(k) for k in E.GameMap.keys()]

    def test_lockstep_random_play(self):
        """Random actions picked on scalar games, applied to both engines; states and legal
        moves must agree at every step."""
        rng = random.Random(5)
        steps = 0
        for gm in self.maps:
            for k in (1, 3, 5):
                B = 40
                scal = [E.new_game(gm, k, rng) for _ in range(B)]
                g = VecGames.from_states(scal)
                while True:
                    live = [b for b in range(B) if not scal[b].over]
                    if not live:
                        break
                    idx = np.array(live)
                    # legal-move masks agree
                    fi = np.array([b for b in live if scal[b].phase == E.FUGITIVE_PHASE], dtype=np.int64)
                    di = np.array([b for b in live if scal[b].phase == E.DETECTIVE_PHASE], dtype=np.int64)
                    for sub, fn, acts in ((fi, g.fugitive_legal, E.fugitive_actions),
                                          (di, g.detective_legal, E.detective_actions)):
                        if len(sub):
                            L = fn(sub)
                            for row, b in enumerate(sub):
                                want = sorted(acts(scal[b]))
                                got = sorted(zip(*np.nonzero(L[row])))
                                self.assertEqual([(int(a), int(t)) for a, t in got], want)
                    np.testing.assert_array_equal(g.can_double(idx), [E.can_use_double(scal[b]) for b in live])
                    dbl, fmv, dmv = [], [], []
                    for b in live:
                        s = scal[b]
                        if s.phase == E.FUGITIVE_PHASE:
                            if E.can_use_double(s) and rng.random() < 0.2:
                                dbl.append(b)
                                E.use_double(s)
                            else:
                                to, t = rng.choice(E.fugitive_actions(s))
                                fmv.append((b, to, t))
                                E.move_fugitive(s, to, t)
                        else:
                            to, t = rng.choice(E.detective_actions(s))
                            dmv.append((b, to, t))
                            E.move_detective(s, to, t)
                    g.use_double(np.array(dbl, dtype=np.int64))
                    for lst, fn in ((fmv, g.move_fugitive), (dmv, g.move_detective)):
                        if lst:
                            a = np.array(lst)
                            fn(a[:, 0], a[:, 1], a[:, 2])
                    for b in live:
                        same(self, scal[b], g, b, f'{gm.key} k={k} game {b}')
                    steps += len(live)
        self.assertGreater(steps, 20000)

    def test_heuristics_agree_without_noise(self):
        """Noise-free heuristic players make identical games in both forms."""
        fug_v, det_v = P.vec_heuristic_fugitive(noise=0), P.vec_heuristic_detective(noise=0)
        fug_s, det_s = P.HeuristicFugitive(noise=0), P.HeuristicDetectives(noise=0)
        nprng = np.random.default_rng(0)
        rng = random.Random(1)
        for gm in self.maps:
            for k in (3, 5):
                B = 30
                scal = [E.new_game(gm, k, rng) for _ in range(B)]
                g = VecGames.from_states(scal)
                while True:
                    live = [b for b in range(B) if not scal[b].over]
                    if not live:
                        break
                    fi = np.array([b for b in live if scal[b].phase == E.FUGITIVE_PHASE], dtype=np.int64)
                    di = np.array([b for b in live if scal[b].phase == E.DETECTIVE_PHASE], dtype=np.int64)
                    for b in fi:
                        P.apply_turn(scal[b], fug_s.choose_turn(scal[b]))
                    for b in di:
                        E.move_detective(scal[b], *det_s.choose_move(scal[b].public_view()))
                    if len(fi):
                        fug_v(g, fi, nprng)
                    if len(di):
                        det_v(g, di, nprng)
                    for b in live:
                        same(self, scal[b], g, b, f'{gm.key} k={k} game {b}')

    def test_new_and_play(self):
        gm = self.maps[0]
        rng = np.random.default_rng(3)
        g = VecGames.new(gm, 500, 4, rng)
        self.assertTrue(((g.fug_pos[:, None] != g.det_pos).all()))
        from ai.vec_engine import play
        play(g, P.vec_heuristic_fugitive(), P.vec_heuristic_detective(), rng)
        self.assertTrue((g.phase == E.OVER).all())
        self.assertEqual(set(REASONS[r] for r in g.reason) - set(REASONS), set())


if __name__ == '__main__':
    unittest.main()
