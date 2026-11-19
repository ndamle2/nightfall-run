"""
Game records from the website (js/ui.js), for analysis and for fitting models to how
people play.

A record (schema 1) is one game, human against bot or (mode "hotseat") pass and play:

    {"schema": 1, "id": "...", "mode": "human-fugitive" | "human-detectives" | "hotseat",
     "map": "twin", "mapSeed": 12345, "detectives": 4,
     "fugitiveStart": 117, "detectiveStarts": [13, 54, 90, 141],     # station ids
     "history": [{"side": "F", "type": "double", "ms": 812},
                 {"side": "F", "to": 120, "ticket": "cab", "ms": 2310},
                 {"side": "D", "i": 0, "to": 14, "ticket": "tram", "ms": 4120}, ...],
     "bots": {"engine": "server" | "browser", ...}, "result": {"winner", "reason", "round"} | null,
     "created", "updated", "savedAt"}

"ms" is thinking time: from when the move could first be made to when it was made (for the
bot, its compute time). The server saves records to data/games/; when the page runs
without the server it keeps them in the browser, and the setup screen can download them as
one JSON file (a list of records). load() reads either.

    python3 -m ai.human_games [path ...]     # summary of the recorded games
"""
import json
import sys
from pathlib import Path

from . import engine as E

TICKET = {name: i for i, name in enumerate(E.TICKET_NAMES)}
DEFAULT_DIR = Path(__file__).resolve().parent.parent / 'data' / 'games'

_maps = {}


def _map(key):
    if key not in _maps:
        _maps[key] = E.GameMap.load(key)
    return _maps[key]


def replay(record, upto=None):
    """The GameState after the record's first `upto` actions (all by default). Raises
    ValueError if an action is illegal or the map has changed since the game was played."""
    gm = _map(record['map'])
    if record.get('mapSeed') is not None and gm.seed not in (None, record['mapSeed']):
        raise ValueError('the map has been regenerated since this game was played')
    ix = gm.index
    if any(x not in ix for x in [record['fugitiveStart'], *record['detectiveStarts']]):
        raise ValueError('unknown start station')
    s = E.new_game(gm, int(record['detectives']), fug_start=ix[record['fugitiveStart']],
                   det_starts=[ix[d] for d in record['detectiveStarts']])
    hist = record['history'] if upto is None else record['history'][:upto]
    for a in hist:
        apply(s, a)
    return s


def apply(s, a):
    """Plays one record action on GameState s (checked against the rules)."""
    ix = s.map.index
    if s.over:
        raise ValueError('action after the end of the game')
    if a['side'] == 'F':
        if a.get('type') == 'double':
            E.use_double(s)
        else:
            E.move_fugitive(s, ix[a['to']], TICKET[a['ticket']])
    else:
        if s.phase != E.DETECTIVE_PHASE or a.get('i', s.current) != s.current:
            raise ValueError('detective move out of turn')
        E.move_detective(s, ix[a['to']], TICKET[a['ticket']])


def load(paths=None):
    """Records from files or directories (default data/games/): each file is one record or a
    list of records (the browser's download)."""
    paths = [Path(p) for p in (paths or [DEFAULT_DIR])]
    out = []
    for p in paths:
        files = sorted(p.glob('*.json')) if p.is_dir() else [p]
        for f in files:
            d = json.loads(f.read_text())
            out.extend(d if isinstance(d, list) else [d])
    # the same game can arrive both from the server and from a download: keep the longest
    best = {}
    for r in out:
        k = r.get('id')
        if k not in best or len(r['history']) > len(best[k]['history']):
            best[k] = r
    return list(best.values())


def fugitive_turns(record):
    """Per fugitive turn, the position it faced and what it did, in the format the location
    model is fitted on (det_pos, det_tickets, fug_tickets, fug_pos, round, turn, entries,
    true; station indices). Only for records where the fugitive's moves are known (always:
    the record holds the full game)."""
    s = replay(record, 0)
    turns, cur = [], None
    for j, a in enumerate(record['history']):
        if a['side'] == 'F' and cur is None:
            cur = dict(det_pos=s.det_pos[:], det_tickets=[list(t) for t in s.det_tickets],
                       fug_tickets=s.fug_tickets[:], fug_pos=s.fug_pos, round=s.round,
                       nlog=len(s.log), turn=[], ms=[])
        apply(s, a)
        if a['side'] == 'F':
            cur['turn'].append('double' if a.get('type') == 'double' else (s.fug_pos, TICKET[a['ticket']]))
            cur['ms'].append(a.get('ms'))
            if s.phase != E.FUGITIVE_PHASE or s.over:
                cur['entries'] = s.public_view().log[cur['nlog']:]
                cur['true'] = [p for (_, p, _, _) in s.log[cur['nlog']:]]
                turns.append(cur)
                cur = None
    return turns


def as_training_games(records):
    """Records as loc_collect-style games (for fitting a move model to human fugitives)."""
    out = []
    for r in records:
        if r.get('mode') not in ('human-fugitive', 'hotseat'):   # a person played the fugitive
            continue
        s0 = replay(r, 0)
        s = replay(r)
        out.append(dict(key=r['map'], k=int(r['detectives']), seed=r['id'], det='human',
                        det_start=s0.det_start, turns=fugitive_turns(r),
                        winner=s.winner if s.over else None))
    return out


def summary(records):
    lines = [f'{len(records)} recorded games']
    for mode in ('human-fugitive', 'human-detectives', 'hotseat'):
        rs = [r for r in records if r.get('mode') == mode]
        done = [r for r in rs if r.get('result')]
        if mode == 'hotseat':
            fw = sum(r['result']['winner'] == 'fugitive' for r in done)
            lines.append(f'  {mode:<17} {len(rs):4d} games, {len(done)} finished, fugitive won {fw}')
            continue
        human_side = 'fugitive' if mode == 'human-fugitive' else 'detectives'
        wins = sum(r['result']['winner'] == human_side for r in done)
        lines.append(f'  {mode:<17} {len(rs):4d} games, {len(done)} finished, human won {wins}')
    return '\n'.join(lines)


if __name__ == '__main__':
    recs = load(sys.argv[1:] or None)
    bad = 0
    for r in recs:
        try:
            replay(r)
        except Exception as e:
            bad += 1
            print('cannot replay', r.get('id'), e)
    print(summary(recs) + (f'\n  {bad} could not be replayed' if bad else ''))
