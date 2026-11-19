"""The bot server (ai/serve.py) and game records (ai/human_games.py).

    python3 -m unittest ai.tests.test_serve      (the record round-trip needs Node)
"""
import json
import random
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from ai import engine as E
from ai import human_games as H
from ai import serve

ROOT = Path(__file__).resolve().parents[2]


def js_records():
    """Bot-vs-bot games played and recorded by the browser code (tests/bots.test.js)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / 'records.json'
        subprocess.run(['node', 'tests/bots.test.js', '--dump', str(out)], cwd=ROOT, check=True,
                       capture_output=True)
        return json.loads(out.read_text())


R_VERDICTS = {'best', 'ok', 'weak', 'blunder', 'lost', 'unusual'}


def winner_name(s):
    return {E.DETECTIVES_WIN: 'detectives', E.FUGITIVE_WINS: 'fugitive'}.get(s.winner)


@unittest.skipUnless(shutil.which('node'), 'needs Node')
class Records(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = js_records()

    def test_browser_records_replay(self):
        """Every record the page builds replays through the Python engine to the same end."""
        for r in self.records:
            s = H.replay(r)
            self.assertTrue(s.over, r['id'])
            self.assertEqual(winner_name(s), r['result']['winner'], r['id'])
            self.assertEqual(s.round, r['result']['round'], r['id'])

    def test_training_format(self):
        games = H.as_training_games(self.records)
        self.assertEqual(len(games), sum(r['mode'] == 'human-fugitive' for r in self.records))
        for g, r in zip(games, [r for r in self.records if r['mode'] == 'human-fugitive']):
            fmoves = [a for a in r['history'] if a['side'] == 'F' and a.get('type') != 'double']
            self.assertEqual(sum(len(t['true']) for t in g['turns']), len(fmoves))
            for t in g['turns']:
                self.assertEqual(len(t['entries']), len(t['true']))
                self.assertIn(len(t['true']), (1, 2))

    def test_bot_moves_are_legal(self):
        """The server's bots answer mid-game positions from browser records with legal moves."""
        rng = random.Random(4)
        for r in rng.sample(self.records, 6):
            cut = rng.randrange(len(r['history']))
            # cut at a turn boundary the page would ask at (not inside a fugitive turn)
            while cut > 0 and r['history'][cut - 1]['side'] == 'F' and r['history'][cut]['side'] == 'F':
                cut -= 1
            rec = dict(r, id=f"{r['id']}-cut", history=r['history'][:cut])
            s = H.replay(rec)
            if s.over:
                continue
            acts = serve.bot_move(rec)
            for a in acts:
                H.apply(s, a)           # raises if illegal
            if acts[0]['side'] == 'F':
                self.assertTrue(s.over or s.phase == E.DETECTIVE_PHASE)
            else:
                self.assertEqual(len(acts), 1)

    def test_review(self):
        """A review for both kinds of game: one row per fugitive turn / detective round, and
        at least one lesson."""
        from ai import review as R
        for mode in ('human-fugitive', 'human-detectives'):
            r = next(x for x in self.records if x['mode'] == mode and len(x['history']) > 20)
            out = R.review(r)
            self.assertTrue(out['lessons'])
            s = H.replay(r)
            if mode == 'human-fugitive':
                self.assertEqual(out['side'], 'fugitive')
                self.assertEqual(out['turns'][-1]['last'], s.round)
                self.assertTrue(all(t['verdict'] in R_VERDICTS for t in out['turns']))
            else:
                self.assertEqual(out['side'], 'detectives')
                dmoves = sum(len(x['moves']) for x in out['rounds'])
                self.assertEqual(dmoves, sum(a['side'] == 'D' for a in r['history']))
            json.dumps(out)  # JSON-ready
        hot = dict(next(x for x in self.records if len(x['history']) > 20), mode='hotseat')
        out = R.review(hot)
        self.assertEqual(out['side'], 'both')
        self.assertTrue(out['fugitive']['lessons'] and out['detectives']['lessons'])

    def test_rejects_bad_records(self):
        r = dict(self.records[0])
        bad = dict(r, history=[{'side': 'D', 'i': 0, 'to': r['detectiveStarts'][0], 'ticket': 'cab'}])
        with self.assertRaises(ValueError):
            H.replay(bad)
        with self.assertRaises(ValueError):
            H.replay(dict(r, mapSeed=-1))


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.saved_dir = serve.DATA_DIR
        serve.DATA_DIR = Path(cls.tmp)
        serve.DETECTIVE_BOT = {'name': 'ismcts', 'opts': {'iterations': 64}}
        serve.Handler.quiet = True
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), partial(serve.Handler, directory=str(ROOT)))
        cls.url = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        serve.DATA_DIR = cls.saved_dir
        serve.DETECTIVE_BOT = {'name': 'ismcts', 'opts': {}}
        shutil.rmtree(cls.tmp)

    def post(self, path, obj):
        req = urllib.request.Request(self.url + path, json.dumps(obj).encode(),
                                     {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def get(self, path):
        try:
            with urllib.request.urlopen(self.url + path) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def new_record(self, k=4, seed=0):
        gm = E.GameMap.load('twin')
        s = E.new_game(gm, k, random.Random(seed))
        return {'schema': 1, 'id': f'servertest{seed}', 'mode': 'human-detectives', 'map': 'twin',
                'mapSeed': gm.seed, 'detectives': k, 'fugitiveStart': gm.ids[s.fug_pos],
                'detectiveStarts': [gm.ids[p] for p in s.det_pos], 'history': []}

    def test_static_and_ping(self):
        code, body = self.get('/index.html')
        self.assertEqual(code, 200)
        self.assertIn(b'js/bots.js', body)
        code, body = self.get('/api/ping')
        self.assertEqual(json.loads(body)['ok'], True)
        self.assertEqual(self.get('/data/games/x.json')[0], 404)
        self.assertEqual(self.get('/ai/serve.py')[0], 404)

    def test_play_a_game_over_http(self):
        """Bot fugitive and bot detectives take turns through the API until the game ends;
        the record is saved after every move."""
        rec = self.new_record(seed=3)
        for _ in range(200):
            code, d = self.post('/api/move', {'record': rec})
            self.assertEqual(code, 200, d)
            rec['history'].extend(d['actions'])
            if H.replay(rec).over:
                break
        self.assertTrue(H.replay(rec).over)
        saved = json.loads((Path(self.tmp) / f"{rec['id']}.json").read_text())
        self.assertEqual(len(saved['history']), len(rec['history']) - len(d['actions']))
        code, d = self.post('/api/record', {'record': rec})
        self.assertEqual(code, 200)
        self.assertEqual(H.load([self.tmp])[0]['history'], rec['history'])

    def test_review_endpoint(self):
        rec = self.new_record(seed=7)
        rec['mode'] = 'human-fugitive'
        for _ in range(200):
            code, d = self.post('/api/move', {'record': rec})
            rec['history'].extend(d['actions'])
            if H.replay(rec).over:
                break
        code, d = self.post('/api/review', {'record': rec})
        self.assertEqual(code, 200, d)
        self.assertEqual(d['side'], 'fugitive')
        self.assertTrue(d['lessons'])

    def test_errors(self):
        rec = self.new_record(seed=5)
        rec['history'] = [{'side': 'F', 'to': rec['detectiveStarts'][0], 'ticket': 'cab'}]
        code, d = self.post('/api/move', {'record': rec})
        self.assertEqual(code, 400)
        code, d = self.post('/api/record', {'record': dict(rec, id='../../etc')})
        self.assertEqual(code, 400)


if __name__ == '__main__':
    unittest.main()
