"""
Post-game review of a game against the computer (a record from js/ui.js, see
ai/human_games.py): what happened move by move, compared with what the bots would have
done, and a few plain-language lessons. The page shows it after the game (served by
ai.serve: POST /api/review).

    python3 -m ai.review data/games/<id>.json      # prints the review

Human fugitive: every turn is compared with the alpha-beta fugitive's choice (a 3-round
paranoid search; "forced loss" means the detectives can force a capture within its
horizon if they play perfectly), with the distance to the nearest detective, room to run,
how many stations the detectives had to consider, and how much weight their location
estimate put on the true station.
Pass and play ('hotseat'): both of the above, one for each side.
Human detectives: every detective move is compared with the ISMCTS detectives' choice from
the same public information, with the fugitive's true station (revealed now that the game
is over) and any move that could have caught it but didn't.
"""
import json
import sys

import numpy as np

from . import engine as E
from . import human_games as H
from . import policies as P
from .value import ValueModel

FORCED = 1e5          # alpha-beta scores beyond this are forced wins / losses
REVIEW_ITERATIONS = 384


def _ids(gm, xs):
    return [gm.ids[x] for x in xs]


def _turn_desc(gm, actions):
    out = []
    for a in actions:
        if a == P.DOUBLE:
            continue
        out.append({'to': gm.ids[a[0]], 'ticket': E.TICKET_NAMES[a[1]]})
    return {'double': P.DOUBLE in actions, 'moves': out}


def _verdict(mine, best):
    """How a fugitive turn compares with alpha-beta's best, in words."""
    if mine is None:
        return 'unusual', 'a move the search did not look at closely'
    if mine <= -FORCED and best > -FORCED:
        return 'blunder', 'lets the detectives force a capture; a safer move existed'
    if mine <= -FORCED:
        return 'lost', 'every move loses against perfect detectives here'
    gap = best - mine
    if gap < 1.5:
        return 'best', 'as good as the bot’s choice'
    if gap < 12:
        return 'ok', 'slightly worse than the bot’s choice'
    return 'weak', 'clearly worse than the bot’s choice'


def _nearest(s, pos=None):
    """Moves for the nearest detective to reach the fugitive with the tickets it has left
    (None if none can)."""
    m = s.map
    masks = [E.ticket_mask(t) for t in s.det_tickets]
    pos = s.fug_pos if pos is None else pos
    d = int(min(m.dist[mk, p, pos] for mk, p in zip(masks, s.det_pos)))
    return None if d >= E.INF else d


def review_fugitive(rec):
    from .alphabeta import AlphaBetaFugitive
    from .ismcts import ISMCTSDetectives
    gm = H._map(rec['map'])
    value = ValueModel.load()
    ab = AlphaBetaFugitive(seed=0)
    watcher = ISMCTSDetectives(iterations=8, seed=0)  # only its location estimate is used
    hist = rec['history']
    s = H.replay(rec, 0)
    turns = []
    j = 0
    while j < len(hist):
        a = hist[j]
        if a['side'] != 'F':
            H.apply(s, a)
            j += 1
            continue
        before = s.clone()
        p_before = value(before)
        acts, ms = [], 0
        while j < len(hist) and hist[j]['side'] == 'F':
            x = hist[j]
            acts.append(P.DOUBLE if x.get('type') == 'double' else (gm.index[x['to']], H.TICKET[x['ticket']]))
            ms += x.get('ms') or 0
            H.apply(s, x)
            j += 1
        bot = ab.choose_turn(before.clone())
        ranks = ab.last['rankings']
        best = ranks[-1][0][1]
        mine = next((v for t, v in ranks[-1] if list(t) == acts), None)
        if mine is None:
            mine = next((v for t, v in ranks[0] if list(t) == acts), None)
        same = list(bot) == acts
        kind, words = ('best', 'same as the bot') if same else _verdict(mine, best)
        row = {
            'move': before.round + 1, 'last': s.round, 'you': _turn_desc(gm, acts),
            'bot': _turn_desc(gm, bot), 'same': same, 'verdict': kind, 'why': words,
            'seconds': round(ms / 1000, 1), 'reveal': any(r in E.REVEAL_ROUNDS for r in range(before.round + 1, s.round + 1)),
            'p_caught_before': round(float(p_before), 2),
        }
        if not s.over:
            pub = s.public_view()
            mass = watcher.belief_mass(pub)
            cands = E.possible_locations(pub)
            order = np.argsort(-mass)
            row.update({
                'at': gm.ids[s.fug_pos], 'nearest': _nearest(s), 'room': P.room_to_run(s),
                'candidates': len(cands), 'estimate_on_you': round(float(mass[s.fug_pos]), 2),
                'estimate_rank': int(np.flatnonzero(order == s.fug_pos)[0]) + 1,
                'p_caught_after': round(float(value(s)), 2),
                'secret_on_reveal': any(t == E.SECRET and rev for (t, _, rev, _) in s.log[before.round:s.round]),
                'doubles_left': s.fug_tickets[E.DOUBLE],
            })
        else:
            row.update({'at': gm.ids[s.fug_pos], 'p_caught_after': 1.0 if s.winner == E.DETECTIVES_WIN else 0.0})
        turns.append(row)
        # the detectives' replies, until the next fugitive turn
    s_end = H.replay(rec)
    return {'side': 'fugitive', 'turns': turns, 'lessons': _fugitive_lessons(turns, rec),
            'summary': _summary(rec, s_end)}


def _fugitive_lessons(turns, rec):
    out = []
    first_blunder = next((t for t in turns if t['verdict'] == 'blunder'), None)
    if first_blunder:
        b = first_blunder
        out.append(f"Turning point: move {b['move']}. Going to {b['you']['moves'][-1]['to']} let the detectives force a "
                   f"capture; the bot would have gone to {b['bot']['moves'][-1]['to']}.")
    bad_reveals = [t for t in turns if t['reveal'] and t.get('nearest') is not None and (t['nearest'] <= 2 or t['room'] < 8)]
    if bad_reveals:
        moves = ', '.join(str(t['last']) for t in bad_reveals)
        out.append(f"Reveal moves ({moves}): everyone saw where you were while a detective was close or you had little room. "
                   f"Before moves 3, 8, 13, 18 and 24, aim for a station 3+ moves from every detective with room to run.")
    wasted = [t for t in turns if t.get('secret_on_reveal')]
    if wasted:
        out.append(f"Secret ticket spent on a reveal move ({', '.join(str(t['last']) for t in wasted)}): the reveal shows your "
                   f"station anyway. Secrets hide the most right after a reveal.")
    dbl = [t for t in turns if t['you']['double']]
    later_tight = [t for t in turns if t.get('doubles_left') == 0 and (t.get('nearest') or 9) <= 1]
    if len(dbl) >= 2 and later_tight:
        out.append(f"Both doubles were gone by move {dbl[-1]['last']}, and later you were caught in a closing net with no way to jump out. "
                   f"Keeping one double for emergencies helps.")
    visited = []
    backtracks = []
    for t in turns:
        for mv in t['you']['moves']:
            if mv['to'] in visited[-4:] and mv['to'] not in backtracks:
                backtracks.append(mv['to'])
            visited.append(mv['to'])
    if len(backtracks) >= 2:
        out.append(f"You doubled back to stations you had just visited ({', '.join(map(str, backtracks[:4]))}), staying in the area "
                   f"the detectives were already closing on.")
    tracked = [t for t in turns if t.get('estimate_rank') == 1 and t.get('candidates', 0) >= 5]
    if len(tracked) >= 2:
        out.append(f"The detectives' best guess was exactly right after {len(tracked)} of your turns (moves "
                   f"{', '.join(str(t['last']) for t in tracked[:5])}): always running straight away from them is predictable.")
    adjacent = [t for t in turns if t.get('nearest') == 1]
    if adjacent:
        out.append(f"You ended {len(adjacent)} turn{'s' if len(adjacent) > 1 else ''} one move from a detective "
                   f"(moves {', '.join(str(t['last']) for t in adjacent[:5])}).")
    if not out:
        out.append('A clean game: no obvious mistakes by the bot’s measure.')
    return out


def review_detectives(rec):
    from .ismcts import ISMCTSDetectives
    gm = H._map(rec['map'])
    value = ValueModel.load()
    bot = ISMCTSDetectives(iterations=REVIEW_ITERATIONS, seed=0)
    hist = rec['history']
    s = H.replay(rec, 0)
    rounds = []
    cur = None
    for a in hist:
        if a['side'] == 'F':
            if cur is not None:
                rounds.append(cur)
                cur = None
            H.apply(s, a)
            continue
        if cur is None:
            pub = s.public_view()
            cur = {'move': s.round, 'fugitive_at': gm.ids[s.fug_pos], 'candidates': len(E.possible_locations(pub)),
                   'p_caught_before': round(float(value(s)), 2), 'moves': []}
        i = s.current
        pub = s.public_view()
        to, t = bot.choose_move(pub)
        reach = {nb for tk in range(3) if s.det_tickets[i][tk] > 0 for nb in s.map.nbr[tk][s.det_pos[i]]}
        could_catch = s.fug_pos in reach and s.fug_pos not in [p for k, p in enumerate(s.det_pos) if k != i]
        frm = gm.ids[s.det_pos[i]]
        H.apply(s, a)
        cur['moves'].append({
            'detective': i + 1, 'from': frm, 'to': a['to'], 'ticket': a['ticket'],
            'bot': {'to': gm.ids[to], 'ticket': E.TICKET_NAMES[t]}, 'same': gm.ids[to] == a['to'],
            'missed_catch': could_catch and not s.over, 'caught': s.over and s.winner == E.DETECTIVES_WIN,
            'distance_after': None if s.over else _nearest_from(s, i),
            'seconds': round((a.get('ms') or 0) / 1000, 1),
        })
        if s.over:
            break
    if cur is not None:
        rounds.append(cur)
    for r in rounds:
        r['closest'] = min((m['distance_after'] for m in r['moves'] if m['distance_after'] is not None), default=None)
    s_end = H.replay(rec)
    return {'side': 'detectives', 'rounds': rounds, 'lessons': _detective_lessons(rounds, s_end),
            'summary': _summary(rec, s_end), 'route': _ids(gm, [s_end.fug_start] + [p for (_, p, _, _) in s_end.log])}


def _nearest_from(s, i):
    """Moves from detective i to the fugitive along any line (tickets aside)."""
    return int(s.map.dist[7, s.det_pos[i], s.fug_pos])


def _detective_lessons(rounds, s_end):
    out = []
    moves = [m for r in rounds for m in r['moves']]
    missed = [(r, m) for r in rounds for m in r['moves'] if m['missed_catch']]
    for r, m in missed[:3]:
        out.append(f"Missed catch after move {r['move']}: Detective {m['detective']} could have stepped onto the fugitive "
                   f"at {r['fugitive_at']} but went to {m['to']}.")
    if moves:
        agree = sum(m['same'] for m in moves) / len(moves)
        out.append(f"Your moves matched the bot detectives' choice {round(100 * agree)}% of the time.")
    if rounds:
        closest = min((r['closest'] for r in rounds if r['closest'] is not None), default=None)
        late = [r for r in rounds if r['candidates'] >= 25]
        if late:
            out.append(f"The fugitive got away from you most around move {max(late, key=lambda r: r['candidates'])['move']}: "
                       f"{max(r['candidates'] for r in rounds)} stations were possible. Closing in right after a reveal, "
                       f"before the possibilities multiply, is what wins.")
        if s_end.winner != E.DETECTIVES_WIN and closest is not None:
            out.append(f"Closest you got: {closest} move{'s' if closest != 1 else ''} from the fugitive.")
    return out


def _summary(rec, s):
    r = rec.get('result') or {}
    return {'winner': r.get('winner'), 'reason': r.get('reason'), 'moves': s.round, 'map': rec['map'],
            'detectives': rec['detectives'], 'mode': rec['mode']}


def review(rec):
    """The review for the human side(s): 'human-fugitive', 'human-detectives', or 'hotseat'
    (pass and play: people on both sides, so both reviews)."""
    mode = rec.get('mode')
    if mode == 'human-fugitive':
        return review_fugitive(rec)
    if mode == 'human-detectives':
        return review_detectives(rec)
    if mode == 'hotseat':
        f, d = review_fugitive(rec), review_detectives(rec)
        return {'side': 'both', 'fugitive': f, 'detectives': d, 'summary': f['summary']}
    raise ValueError(f'cannot review a game of mode {mode!r}')


def main(argv=None):
    paths = (argv if argv is not None else sys.argv[1:])
    for rec in H.load(paths or None):
        print(json.dumps(review(rec), indent=1))


if __name__ == '__main__':
    main()
