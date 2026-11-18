"""
Nightfall Run rules engine, Python port of js/engine.js.

The rules match the JS engine move for move (ai/tests/test_engine_parity.py replays games
recorded from it). Stations are addressed by index 0..N-1 internally; GameMap.ids / .index
convert to and from the station ids used by the JS side.

One game at a time, built for tree search: states are small, clone() is cheap, and the
public candidate set ("where could the fugitive be?") is maintained incrementally instead
of being replayed from the log. For many games stepped together see ai/vec_engine.py.
"""
import json
import random
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MAPS_DIR = ROOT / 'js' / 'maps'

MAX_ROUNDS = 24
REVEAL_ROUNDS = frozenset((3, 8, 13, 18, 24))
TRANSPORTS = ('cab', 'tram', 'metro', 'ferry')
TICKET_NAMES = ('cab', 'tram', 'metro', 'secret', 'double')
CAB, TRAM, METRO, FERRY = 0, 1, 2, 3
SECRET, DOUBLE = 3, 4  # fugitive ticket slots: cab, tram, metro, secret, double
DETECTIVE_TICKETS = (10, 8, 4)
FUGITIVE_TICKETS = (4, 3, 3)  # plus one secret per detective and DOUBLE_CARDS doubles
DOUBLE_CARDS = 2
INF = 99

# phase / winner / double-move codes
FUGITIVE_PHASE, DETECTIVE_PHASE, OVER = 0, 1, 2
NO_WINNER, FUGITIVE_WINS, DETECTIVES_WIN = 0, 1, 2
NO_DOUBLE, DOUBLE_FIRST, DOUBLE_SECOND = 0, 1, 2

# finish reasons (the JS engine stores the equivalent sentence)
R_NO_WAY_OUT = 'no_way_out'          # fugitive had no move at the start
R_CORNERED_DOUBLE = 'cornered_double'  # no legal second half of a double move
R_DETS_STUCK = 'detectives_stuck'    # no detective can move
R_SURVIVED = 'survived'              # all MAX_ROUNDS moves made
R_SURROUNDED = 'surrounded'          # fugitive has no legal move on its turn
R_CAUGHT = 'caught'


class GameMap:
    """Static board data plus precomputed tables shared by every game on that board."""

    def __init__(self, data):
        self.key = data.get('key', '')
        self.name = data.get('name', self.key)
        self.ids = sorted(s['id'] for s in data['stations'])
        self.index = {sid: i for i, sid in enumerate(self.ids)}
        n = self.n = len(self.ids)
        adj = np.zeros((4, n, n), dtype=bool)
        for e in data['edges']:
            t = TRANSPORTS.index(e['type'])
            a, b = self.index[e['a']], self.index[e['b']]
            adj[t, a, b] = adj[t, b, a] = True
        self.adj = adj                      # (4, N, N) by transport
        self.adj_any = adj.any(0)           # what a secret ticket can reach
        self.edge_count = adj.sum(0).astype(np.float32)  # links between two stations, all transports
        # neighbour tuples per transport, sorted: nbr[t][v]
        self.nbr = [[tuple(np.flatnonzero(adj[t, v]).tolist()) for v in range(n)] for t in range(4)]
        self.starts = [self.index[s] for s in data['starts']]
        self.dist = self._distances()

    def _distances(self):
        """dist[mask][u, v]: fewest moves u→v using only ticket types in mask
        (bit0 cab, bit1 tram, bit2 metro). Unreachable, or mask 0, is INF."""
        n = self.n
        dist = np.full((8, n, n), INF, dtype=np.uint8)
        for mask in range(1, 8):
            a = np.zeros((n, n), dtype=np.float32)
            for t in range(3):
                if mask & (1 << t):
                    a += self.adj[t]
            a = a > 0
            d = dist[mask]
            reached = np.eye(n, dtype=bool)
            frontier = reached.copy()
            d[reached] = 0
            step = 0
            while True:
                step += 1
                nxt = (frontier.astype(np.float32) @ a.astype(np.float32) > 0) & ~reached
                if not nxt.any():
                    break
                d[nxt] = step
                reached |= nxt
                frontier = nxt
        return dist

    @classmethod
    def load(cls, key):
        """Loads js/maps/<key>.js (the generated browser file) directly."""
        text = (MAPS_DIR / f'{key}.js').read_text()
        start = text.index('{', text.index('MAP_DATA'))
        data, _ = json.JSONDecoder().raw_decode(text, start)
        return cls(data)

    @staticmethod
    def keys():
        """Map keys in the order index.html loads them (the first one is the default)."""
        html = (ROOT / 'index.html').read_text()
        import re
        keys = re.findall(r'js/maps/([\w-]+)\.js', html)
        return keys or sorted(p.stem for p in MAPS_DIR.glob('*.js'))


def ticket_mask(tickets):
    """Bitmask of the basic ticket types still held (index into GameMap.dist)."""
    return (tickets[0] > 0) | ((tickets[1] > 0) << 1) | ((tickets[2] > 0) << 2)


class GameState:
    """One game. Fields mirror the JS state; positions are station indices.

    cand is the public candidate set *before* removing the stations detectives stand on,
    exactly as js possibleLocations propagates it; possible_mask() applies that last step.
    """

    __slots__ = ('map', 'n', 'det_pos', 'det_tickets', 'det_start', 'fug_pos', 'fug_start',
                 'fug_tickets', 'phase', 'round', 'current', 'double', 'log', 'winner',
                 'reason', 'cand')

    def clone(self):
        s = GameState.__new__(GameState)
        s.map = self.map
        s.n = self.n
        s.det_pos = self.det_pos[:]
        s.det_tickets = self.det_tickets[:]  # inner lists are copy-on-write (move_detective)
        s.det_start = self.det_start
        s.fug_pos = self.fug_pos
        s.fug_start = self.fug_start
        s.fug_tickets = self.fug_tickets[:]
        s.phase = self.phase
        s.round = self.round
        s.current = self.current
        s.double = self.double
        s.log = self.log[:]
        s.winner = self.winner
        s.reason = self.reason
        s.cand = self.cand  # never mutated in place, so sharing is safe
        return s

    def public_view(self):
        """A copy with everything the detectives cannot see blanked out (-1)."""
        s = self.clone()
        s.fug_pos = -1
        s.fug_start = -1
        s.log = [(t, p if rev else -1, rev, dbl) for (t, p, rev, dbl) in self.log]
        return s

    @property
    def over(self):
        return self.phase == OVER


def new_game(gmap, n_detectives, rng=None, fug_start=None, det_starts=None):
    """Deals start stations like createGame (shuffle the start pool, detectives first).
    fug_start / det_starts (station indices) override the deal, for replays and tests."""
    if not 1 <= n_detectives <= 5:
        raise ValueError('A game needs 1–5 detectives.')
    if len(gmap.starts) < n_detectives + 1:
        raise ValueError('Not enough start stations.')
    rng = rng or random.Random()
    pool = gmap.starts[:]
    rng.shuffle(pool)
    det = list(det_starts) if det_starts is not None else pool[:n_detectives]
    fug = fug_start if fug_start is not None else pool[n_detectives]
    s = GameState.__new__(GameState)
    s.map = gmap
    s.n = n_detectives
    s.det_pos = det[:]
    s.det_start = tuple(det)
    s.det_tickets = [list(DETECTIVE_TICKETS) for _ in range(n_detectives)]
    s.fug_pos = fug
    s.fug_start = fug
    s.fug_tickets = list(FUGITIVE_TICKETS) + [n_detectives, DOUBLE_CARDS]
    s.phase = FUGITIVE_PHASE
    s.round = 0
    s.current = -1
    s.double = NO_DOUBLE
    s.log = []  # (ticket, pos, reveal, double)
    s.winner = NO_WINNER
    s.reason = ''
    cand = np.zeros(gmap.n, dtype=bool)
    cand[gmap.starts] = True
    cand[list(s.det_start)] = False
    s.cand = cand
    if not fugitive_actions(s):
        _finish(s, DETECTIVES_WIN, R_NO_WAY_OUT)
    return s


# ---------- move generation ----------

def fugitive_actions(s):
    """Legal fugitive moves as (to, ticket) pairs, in JS order (by station, then
    cab, tram, metro, secret). Cannot land on a detective."""
    m = s.map
    pos, tk = s.fug_pos, s.fug_tickets
    blocked = s.det_pos
    out = []
    for t in (CAB, TRAM, METRO):
        if tk[t] > 0:
            for nb in m.nbr[t][pos]:
                if nb not in blocked:
                    out.append((nb, t))
    if tk[SECRET] > 0:
        seen = set()
        for t in (CAB, TRAM, METRO, FERRY):
            for nb in m.nbr[t][pos]:
                if nb not in blocked and nb not in seen:
                    seen.add(nb)
                    out.append((nb, SECRET))
    out.sort(key=lambda a: (a[0], a[1]))
    return out


def detective_actions(s, i=None):
    """Legal (to, ticket) pairs for detective i (default: the one to move). May land on
    the fugitive, not on another detective."""
    if i is None:
        i = s.current
    m = s.map
    pos, tk = s.det_pos[i], s.det_tickets[i]
    others = [p for j, p in enumerate(s.det_pos) if j != i]
    out = []
    for t in (CAB, TRAM, METRO):
        if tk[t] > 0:
            for nb in m.nbr[t][pos]:
                if nb not in others:
                    out.append((nb, t))
    out.sort()
    return out


def group_moves(actions):
    """[(to, ticket)] → [(to, (tickets...))] like the JS {to, tickets} lists."""
    out = []
    for to, t in actions:
        if out and out[-1][0] == to:
            out[-1][1].append(t)
        else:
            out.append((to, [t]))
    return [(to, tuple(ts)) for to, ts in out]


def _detective_can_move(s, i):
    m = s.map
    pos, tk = s.det_pos[i], s.det_tickets[i]
    for t in (CAB, TRAM, METRO):
        if tk[t] > 0:
            for nb in m.nbr[t][pos]:
                if nb not in s.det_pos:  # own station is never a neighbour
                    return True
    return False


def _fugitive_can_move(s):
    m = s.map
    pos, tk = s.fug_pos, s.fug_tickets
    any_ticket = tk[SECRET] > 0
    for t in (CAB, TRAM, METRO, FERRY):
        if any_ticket or (t < 3 and tk[t] > 0):
            for nb in m.nbr[t][pos]:
                if nb not in s.det_pos:
                    return True
    return False


# ---------- fugitive actions ----------

def can_use_double(s):
    return (s.phase == FUGITIVE_PHASE and s.winner == NO_WINNER and s.double == NO_DOUBLE
            and s.fug_tickets[DOUBLE] > 0 and s.round <= MAX_ROUNDS - 2)


def use_double(s):
    if not can_use_double(s):
        raise ValueError('A double move cannot be played now.')
    s.fug_tickets[DOUBLE] -= 1
    s.double = DOUBLE_FIRST
    return s


def move_fugitive(s, to, ticket, check=True):
    if check:
        if s.phase != FUGITIVE_PHASE or s.winner:
            raise ValueError('It is not the fugitive’s turn.')
        if (to, ticket) not in fugitive_actions(s):
            raise ValueError(f'Illegal fugitive move {(to, ticket)}.')
    s.fug_tickets[ticket] -= 1
    s.fug_pos = to
    s.round += 1
    reveal = s.round in REVEAL_ROUNDS
    s.log.append((ticket, to, reveal, s.double != NO_DOUBLE))
    m = s.map
    if reveal:
        c = np.zeros(m.n, dtype=bool)
        c[to] = True
        s.cand = c
    else:
        a = m.adj_any if ticket == SECRET else m.adj[ticket]
        s.cand = a[s.cand].any(0)
    if s.double == DOUBLE_FIRST:
        s.double = DOUBLE_SECOND
        if not _fugitive_can_move(s):
            _finish(s, DETECTIVES_WIN, R_CORNERED_DOUBLE)
        return s
    s.double = NO_DOUBLE
    _begin_detective_phase(s)
    return s


# ---------- detective actions ----------

def _begin_detective_phase(s):
    s.phase = DETECTIVE_PHASE
    if not any(_detective_can_move(s, i) for i in range(s.n)):
        _finish(s, FUGITIVE_WINS, R_DETS_STUCK)
        return
    s.current = -1
    _advance_detective(s)


def _advance_detective(s):
    for i in range(s.current + 1, s.n):
        if _detective_can_move(s, i):
            s.current = i
            return
    _end_detective_phase(s)


def _end_detective_phase(s):
    s.current = -1
    if s.round >= MAX_ROUNDS:
        _finish(s, FUGITIVE_WINS, R_SURVIVED)
        return
    s.phase = FUGITIVE_PHASE
    if not _fugitive_can_move(s):
        _finish(s, DETECTIVES_WIN, R_SURROUNDED)


def move_detective(s, to, ticket, check=True):
    if check:
        if s.phase != DETECTIVE_PHASE or s.winner:
            raise ValueError('It is not the detectives’ turn.')
        if (to, ticket) not in detective_actions(s):
            raise ValueError(f'Illegal detective move {(to, ticket)}.')
    i = s.current
    s.det_tickets[i] = tk = s.det_tickets[i][:]  # copy-on-write: clones share nothing mutable
    tk[ticket] -= 1
    s.fug_tickets[ticket] += 1  # spent detective tickets go to the fugitive
    s.det_pos[i] = to
    if to == s.fug_pos:
        _finish(s, DETECTIVES_WIN, R_CAUGHT)
        return s
    _advance_detective(s)
    return s


def _finish(s, winner, reason):
    s.phase = OVER
    s.winner = winner
    s.reason = reason
    s.current = -1
    s.double = NO_DOUBLE


# ---------- public information ----------

def possible_mask(s):
    """Bool (N,) of stations the fugitive could be at, from public information only."""
    c = s.cand.copy()
    c[s.det_pos] = False
    return c


def possible_locations(s):
    return np.flatnonzero(possible_mask(s)).tolist()


def last_reveal(s):
    for entry in reversed(s.log):
        if entry[2]:
            return entry
    return None
