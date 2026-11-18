"""Replays games recorded from js/engine.js through ai/engine.py and checks every state.

    python3 -m unittest ai.tests.test_engine_parity
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from ai import engine as E

ROOT = Path(__file__).resolve().parents[2]
PHASES = {'fugitive': E.FUGITIVE_PHASE, 'detectives': E.DETECTIVE_PHASE, 'over': E.OVER}
WINNERS = {None: E.NO_WINNER, 'fugitive': E.FUGITIVE_WINS, 'detectives': E.DETECTIVES_WIN}
DOUBLES = {None: E.NO_DOUBLE, 'first': E.DOUBLE_FIRST, 'second': E.DOUBLE_SECOND}
TICKET = {name: i for i, name in enumerate(E.TICKET_NAMES)}
REASONS = [
    ('started with no way out', E.R_NO_WAY_OUT),
    ('cornered halfway', E.R_CORNERED_DOUBLE),
    ('None of the detectives can move', E.R_DETS_STUCK),
    ('stayed free', E.R_SURVIVED),
    ('surrounded', E.R_SURROUNDED),
    ('caught the fugitive', E.R_CAUGHT),
]


def reason_code(text):
    if not text:
        return ''
    for needle, code in REASONS:
        if needle in text:
            return code
    raise AssertionError(f'unknown JS reason: {text}')


def record_traces(games_per_config):
    if not shutil.which('node'):
        raise unittest.SkipTest('node is not installed')
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / 'traces.json'
        subprocess.run(['node', str(ROOT / 'tools' / 'trace_games.js'), str(games_per_config), str(out)],
                       check=True, cwd=ROOT)
        return json.loads(out.read_text())


class EngineParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.traces = record_traces(25)
        cls.maps = {}

    def gmap(self, key):
        if key not in self.maps:
            self.maps[key] = E.GameMap.load(key)
        return self.maps[key]

    def check_snapshot(self, s, snap, where):
        m = s.map
        ids = m.ids
        got = {
            'phase': s.phase, 'round': s.round, 'current': s.current, 'double': s.double,
            'winner': s.winner, 'reason': s.reason,
            'fpos': ids[s.fug_pos], 'ftk': s.fug_tickets,
            'dpos': [ids[p] for p in s.det_pos], 'dtk': [list(t) for t in s.det_tickets],
            'cands': [ids[i] for i in E.possible_locations(s)],
        }
        want = {
            'phase': PHASES[snap['phase']], 'round': snap['round'], 'current': snap['current'],
            'double': DOUBLES[snap['double']], 'winner': WINNERS[snap['winner']],
            'reason': reason_code(snap['reason']),
            'fpos': snap['fpos'],
            'ftk': [snap['ftk'][k] for k in E.TICKET_NAMES],
            'dpos': snap['dpos'],
            'dtk': [[t['cab'], t['tram'], t['metro']] for t in snap['dtk']],
            'cands': snap['cands'],
        }
        self.assertEqual(got, want, where)

    def test_replays_match_js(self):
        totals = {'games': 0, 'steps': 0, 'doubles': 0}
        reasons = set()
        for gi, tr in enumerate(self.traces):
            m = self.gmap(tr['map'])
            ix = m.index
            s = E.new_game(m, tr['nDet'], fug_start=ix[tr['fugStart']],
                           det_starts=[ix[p] for p in tr['detStarts']])
            self.check_snapshot(s, tr['initial'], f'game {gi} initial')
            for si, step in enumerate(tr['steps']):
                where = f'game {gi} ({tr["map"]}, {tr["nDet"]} dets) step {si}'
                # legal moves
                if s.phase == E.FUGITIVE_PHASE:
                    legal = E.group_moves(E.fugitive_actions(s))
                else:
                    legal = E.group_moves(E.detective_actions(s))
                want = [(ix[mv['to']], tuple(TICKET[t] for t in mv['tickets'])) for mv in step['legal']]
                self.assertEqual(legal, want, where + ' legal moves')
                self.assertEqual(E.can_use_double(s), step['canDouble'], where + ' canDouble')
                # action
                a = step['action']
                if a[0] == 'double':
                    E.use_double(s)
                    totals['doubles'] += 1
                elif a[0] == 'f':
                    E.move_fugitive(s, ix[a[1]], TICKET[a[2]])
                else:
                    E.move_detective(s, ix[a[1]], TICKET[a[2]])
                self.check_snapshot(s, step['after'], where + ' after ' + str(a))
                totals['steps'] += 1
            self.assertTrue(s.over)
            reasons.add(s.reason)
            totals['games'] += 1
        # the traces must exercise every way a game can end that random play reaches
        for r in (E.R_CAUGHT, E.R_SURVIVED, E.R_DETS_STUCK):
            self.assertIn(r, reasons)
        self.assertGreater(totals['doubles'], 50)
        print(f"\n  parity: {totals['games']} games, {totals['steps']} steps, "
              f"{totals['doubles']} doubles, endings {sorted(reasons)}")


if __name__ == '__main__':
    unittest.main()
