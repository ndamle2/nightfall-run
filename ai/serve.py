"""
Serves the game with the Python bots behind it, and records human-vs-bot games.

    python3 -m ai.serve                 # first free port from 8000 up; opens the browser
    python3 -m ai.serve --port 8080 --no-browser

The page (index.html) works on its own too, with simpler bots that run in the browser; served
from here it asks this process for the bots' moves instead:

    GET  /api/ping     {"ok": true, "bots": {...}}
    POST /api/move     {"record": <game record>} -> {"actions": [...], "ms": ...}
    POST /api/record   {"record": <game record>} -> {"ok": true}
    POST /api/review   {"record": <finished game record>} -> post-game review (ai/review.py)

A game record (built by js/ui.js) is the whole game so far: map, start stations, and every
action in order ({"side": "F", "to", "ticket"} / {"side": "F", "type": "double"} /
{"side": "D", "i", "to", "ticket"}, station ids as on the map, plus "ms" thinking time).
The server replays it through ai/engine.py, so a bot only ever acts on a position the rules
engine agrees with, and the detective bot only gets state.public_view().

Every record the page sends is saved to data/games/<id>.json (overwritten as the game goes
on, so abandoned games are kept too). ai.human_games loads them back.
"""
import argparse
import json
import re
import threading
import time
import webbrowser
from collections import OrderedDict
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import engine as E
from .human_games import replay, TICKET

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'data' / 'games'
ID_RE = re.compile(r'^[A-Za-z0-9_-]{6,64}$')

FUGITIVE_BOT = {'name': 'alphabeta', 'opts': {}}
DETECTIVE_BOT = {'name': 'ismcts', 'opts': {}}

_lock = threading.Lock()          # the bots are CPU-bound; one move at a time
_bots = OrderedDict()             # game id -> bot (ISMCTS keeps its estimate and tree per game)
MAX_BOTS = 32


def _bot(game_id, side):
    key = (game_id, side)
    bot = _bots.get(key)
    if bot is None:
        if side == 'F':
            from .alphabeta import AlphaBetaFugitive
            bot = AlphaBetaFugitive(**FUGITIVE_BOT['opts'])
        else:
            from .ismcts import ISMCTSDetectives
            bot = ISMCTSDetectives(**DETECTIVE_BOT['opts'])
        _bots[key] = bot
        while len(_bots) > MAX_BOTS:
            _bots.popitem(last=False)
    _bots.move_to_end(key)
    return bot


def bot_move(record):
    """The bot's next actions for the position the record reaches, as JSON-ready dicts:
    the fugitive's whole turn, or the current detective's single move."""
    s = replay(record)
    if s.over:
        raise ValueError('the game is over')
    ids = s.map.ids
    if s.phase == E.FUGITIVE_PHASE:
        if s.double != E.NO_DOUBLE:
            raise ValueError('the record stops halfway through a double move')
        turn = _bot(record['id'], 'F').choose_turn(s)
        out = []
        for a in turn:
            if a == 'double':
                out.append({'side': 'F', 'type': 'double'})
            else:
                out.append({'side': 'F', 'to': ids[a[0]], 'ticket': E.TICKET_NAMES[a[1]]})
        return out
    to, t = _bot(record['id'], 'D').choose_move(s.public_view())
    return [{'side': 'D', 'i': s.current, 'to': ids[to], 'ticket': E.TICKET_NAMES[t]}]


_save_lock = threading.Lock()


def save_record(record):
    """Writes data/games/<id>.json. Requests can arrive out of order (the page saves at the
    end of a turn while asking for the next bot move), and a game's history only grows once
    sent (undo happens before), so an older, shorter copy never replaces a newer one."""
    gid = record.get('id', '')
    if not ID_RE.match(gid):
        raise ValueError('bad game id')
    if not isinstance(record.get('history'), list):
        raise ValueError('record without history')
    record = dict(record, savedAt=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    path = DATA_DIR / f'{gid}.json'
    with _save_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if path.exists():
            try:
                old = json.loads(path.read_text())
                if len(old.get('history', [])) > len(record['history']) or (
                        old.get('result') and not record.get('result')
                        and len(old.get('history', [])) == len(record['history'])):
                    return
            except ValueError:
                pass
        tmp = DATA_DIR / f'.{gid}.{threading.get_ident()}.tmp'
        tmp.write_text(json.dumps(record, indent=1))
        tmp.replace(path)


class Handler(SimpleHTTPRequestHandler):
    quiet = False

    def log_message(self, fmt, *args):
        if not self.quiet and not str(args[0]).startswith(('GET /js', 'GET /css', 'GET /api/ping')):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/ping':
            return self._json(200, {'ok': True, 'bots': {'fugitive': FUGITIVE_BOT, 'detectives': DETECTIVE_BOT}})
        if path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        if path.startswith(('/data/', '/ai/', '/.')):
            return self._json(404, {'error': 'not found'})
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n > 2_000_000:
                raise ValueError('request too large')
            record = json.loads(self.rfile.read(n))['record']
            if path == '/api/move':
                t = time.perf_counter()
                with _lock:
                    actions = bot_move(record)
                ms = round(1000 * (time.perf_counter() - t))
                save_record(record)
                return self._json(200, {'actions': actions, 'ms': ms})
            if path == '/api/record':
                save_record(record)
                return self._json(200, {'ok': True})
            if path == '/api/review':
                from .review import review
                save_record(record)
                with _lock:
                    return self._json(200, review(record))
            return self._json(404, {'error': 'not found'})
        except Exception as e:  # report to the page, which falls back to its own bots
            if not self.quiet:
                self.log_error('%s: %r', path, e)
            return self._json(400, {'error': str(e)})


def warm_up():
    """Compile the numba code and load the models before the first real request."""
    import random
    from .alphabeta import AlphaBetaFugitive
    from .ismcts import ISMCTSDetectives
    gm = E.GameMap.load(E.GameMap.keys()[0])
    s = E.new_game(gm, 4, random.Random(0))
    AlphaBetaFugitive(**FUGITIVE_BOT['opts']).choose_turn(s)
    from .policies import apply_turn, HeuristicFugitive
    apply_turn(s, HeuristicFugitive(seed=0).choose_turn(s))
    ISMCTSDetectives(**{**DETECTIVE_BOT['opts'], 'iterations': 64}).choose_move(s.public_view())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--port', type=int, default=None,
                    help='port to listen on (default: the first free one from 8000 up)')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--data', help='where to save game records (default data/games)')
    a = ap.parse_args(argv)
    global DATA_DIR
    if a.data:
        DATA_DIR = Path(a.data).resolve()
    handler = partial(Handler, directory=str(ROOT))
    if a.port is not None:
        try:
            httpd = ThreadingHTTPServer((a.host, a.port), handler)
        except OSError as e:
            raise SystemExit(f'Cannot listen on {a.host}:{a.port} ({e.strerror}). '
                             f'Leave out --port to use the first free one.')
    else:
        httpd = None
        for port in [*range(8000, 8100), 0]:   # 0: any free port the system picks
            try:
                httpd = ThreadingHTTPServer((a.host, port), handler)
                break
            except OSError:
                continue
        if httpd is None:
            raise SystemExit(f'Cannot find a free port on {a.host}.')
    port = httpd.server_address[1]
    print('Loading the bots…', flush=True)
    warm_up()
    url = f'http://{a.host}:{port}/'
    print(f'Nightfall Run at {url}  (games are saved to {DATA_DIR}; Ctrl+C to stop)', flush=True)
    if not a.no_browser:
        threading.Timer(0.5, webbrowser.open, (url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
