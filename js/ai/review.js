/*
 * Nightfall Run — post-game review (JavaScript port of ai/review.py; same fields, same
 * wording, so the page shows either one the same way).
 *
 * Human fugitive: every turn compared with the alpha-beta fugitive's choice, with the
 * distance to the nearest detective, room to run, how many stations the detectives had to
 * consider and how much weight their location estimate put on the true station.
 * Human detectives: every detective move compared with the ISMCTS detectives' choice from
 * the same public information, with the fugitive's true station and any missed catch.
 * Pass and play ('hotseat'): both.
 */
(function (root, factory) {
  const req = typeof require === 'function' ? require : null;
  const api = factory(
    root.AICore || req('./core.js'), root.AIAlphaBeta || req('./alphabeta.js'),
    root.AIISMCTS || req('./ismcts.js'), root.AIWeights || req('./weights.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIReview = api;
})(typeof self !== 'undefined' ? self : this, function (C, AB, IS, WEIGHTS) {
  'use strict';

  const FORCED = 1e5;  // alpha-beta scores beyond this are forced wins / losses
  const REVIEW_ITERATIONS = 384;
  const r2 = (x) => Math.round(x * 100) / 100;
  const r1 = (x) => Math.round(x * 10) / 10;

  function turnDesc(T, turn) {
    return {
      double: turn[0] === 'double',
      moves: turn.filter((a) => a !== 'double').map(([to, t]) => ({ to: T.ids[to], ticket: C.TICKET_NAMES[t] })),
    };
  }

  function verdict(mine, best) {
    if (mine == null) return ['unusual', 'a move the search did not look at closely'];
    if (mine <= -FORCED && best > -FORCED) return ['blunder', 'lets the detectives force a capture; a safer move existed'];
    if (mine <= -FORCED) return ['lost', 'every move loses against perfect detectives here'];
    const gap = best - mine;
    if (gap < 1.5) return ['best', 'as good as the bot’s choice'];
    if (gap < 12) return ['ok', 'slightly worse than the bot’s choice'];
    return ['weak', 'clearly worse than the bot’s choice'];
  }

  function nearest(T, s) {
    let d = C.INF;
    for (let j = 0; j < s.k; j++) d = Math.min(d, T.dist[C.maskOf(s.detTk, 3 * j) * T.nn + s.detPos[j] * T.n + s.fugPos]);
    return d >= C.INF ? null : d;
  }

  const valueOf = (T, s, W) => C.value(T, s, W);

  function reviewFugitive(T, rec) {
    const W = C.valueWeights(WEIGHTS.value);
    const ab = new AB.AlphaBetaFugitive({ seed: 0 });
    const watcher = new IS.ISMCTSDetectives({ iterations: 8, seed: 0, valueWeights: WEIGHTS.value, moveWeights: WEIGHTS.move });
    const hist = rec.history;
    const s = C.replay(T, rec, 0);
    const turns = [];
    let j = 0;
    while (j < hist.length) {
      const a = hist[j];
      if (a.side !== 'F') { C.applyAction(T, s, a); j++; continue; }
      const before = C.clone(s);
      const pBefore = valueOf(T, before, W);
      const acts = [];
      let ms = 0;
      while (j < hist.length && hist[j].side === 'F') {
        const x = hist[j];
        acts.push(x.type === 'double' ? 'double' : [T.index[x.to], C.TICKET[x.ticket]]);
        ms += x.ms || 0;
        C.applyAction(T, s, x);
        j++;
      }
      const bot = ab.chooseTurn(T, C.clone(before));
      const ranks = ab.last.rankings;
      const deepest = ranks[ranks.length - 1];
      const best = deepest[0][1];
      const key = JSON.stringify(acts);
      let hit = deepest.find(([t]) => JSON.stringify(t) === key);
      if (!hit) hit = ranks[0].find(([t]) => JSON.stringify(t) === key);
      const mine = hit ? hit[1] : null;
      const same = JSON.stringify(bot) === key;
      const [kind, words] = same ? ['best', 'same as the bot'] : verdict(mine, best);
      let reveal = false;
      for (let r = before.round + 1; r <= s.round; r++) if (C.IS_REVEAL[r]) reveal = true;
      const row = {
        move: before.round + 1, last: s.round, you: turnDesc(T, acts), bot: turnDesc(T, bot), same,
        verdict: kind, why: words, seconds: r1(ms / 1000), reveal, p_caught_before: r2(pBefore),
      };
      if (s.phase !== C.OVER) {
        const pub = C.publicView(s);
        const mass = watcher.beliefMass(T, pub);
        const cands = C.possibleLocations(pub);
        const mine2 = mass[s.fugPos];
        let rank = 1;
        for (let v = 0; v < T.n; v++) if (mass[v] > mine2 || (mass[v] === mine2 && v < s.fugPos)) rank++;
        Object.assign(row, {
          at: T.ids[s.fugPos], nearest: nearest(T, s), room: C.roomToRun(T, s, C.danger(T, s, new Uint8Array(T.n))),
          candidates: cands.length, estimate_on_you: r2(mine2), estimate_rank: rank,
          p_caught_after: r2(valueOf(T, s, W)),
          secret_on_reveal: s.log.slice(before.round, s.round).some(([t, , rev]) => t === C.SECRET && rev),
          doubles_left: s.fugTk[C.DOUBLE],
        });
      } else {
        Object.assign(row, { at: T.ids[s.fugPos], p_caught_after: s.winner === C.DET_WIN ? 1.0 : 0.0 });
      }
      turns.push(row);
    }
    const end = C.replay(T, rec);
    return { side: 'fugitive', turns, lessons: fugitiveLessons(turns), summary: summary(rec, end) };
  }

  function fugitiveLessons(turns) {
    const out = [];
    const b = turns.find((t) => t.verdict === 'blunder');
    if (b) {
      out.push(`Turning point: move ${b.move}. Going to ${b.you.moves[b.you.moves.length - 1].to} let the detectives force a ` +
        `capture; the bot would have gone to ${b.bot.moves[b.bot.moves.length - 1].to}.`);
    }
    const badReveals = turns.filter((t) => t.reveal && t.nearest != null && (t.nearest <= 2 || t.room < 8));
    if (badReveals.length) {
      out.push(`Reveal moves (${badReveals.map((t) => t.last).join(', ')}): everyone saw where you were while a detective was close or you had little room. ` +
        'Before moves 3, 8, 13, 18 and 24, aim for a station 3+ moves from every detective with room to run.');
    }
    const wasted = turns.filter((t) => t.secret_on_reveal);
    if (wasted.length) {
      out.push(`Secret ticket spent on a reveal move (${wasted.map((t) => t.last).join(', ')}): the reveal shows your ` +
        'station anyway. Secrets hide the most right after a reveal.');
    }
    const dbl = turns.filter((t) => t.you.double);
    const laterTight = turns.filter((t) => t.doubles_left === 0 && (t.nearest || 9) <= 1);
    if (dbl.length >= 2 && laterTight.length) {
      out.push(`Both doubles were gone by move ${dbl[dbl.length - 1].last}, and later you were caught in a closing net with no way to jump out. ` +
        'Keeping one double for emergencies helps.');
    }
    const visited = [], backtracks = [];
    for (const t of turns) {
      for (const mv of t.you.moves) {
        if (visited.slice(-4).includes(mv.to) && !backtracks.includes(mv.to)) backtracks.push(mv.to);
        visited.push(mv.to);
      }
    }
    if (backtracks.length >= 2) {
      out.push(`You doubled back to stations you had just visited (${backtracks.slice(0, 4).join(', ')}), staying in the area ` +
        'the detectives were already closing on.');
    }
    const tracked = turns.filter((t) => t.estimate_rank === 1 && (t.candidates || 0) >= 5);
    if (tracked.length >= 2) {
      out.push(`The detectives' best guess was exactly right after ${tracked.length} of your turns (moves ` +
        `${tracked.slice(0, 5).map((t) => t.last).join(', ')}): always running straight away from them is predictable.`);
    }
    const adjacent = turns.filter((t) => t.nearest === 1);
    if (adjacent.length) {
      out.push(`You ended ${adjacent.length} turn${adjacent.length > 1 ? 's' : ''} one move from a detective ` +
        `(moves ${adjacent.slice(0, 5).map((t) => t.last).join(', ')}).`);
    }
    if (!out.length) out.push('A clean game: no obvious mistakes by the bot’s measure.');
    return out;
  }

  function reviewDetectives(T, rec) {
    const W = C.valueWeights(WEIGHTS.value);
    const bot = new IS.ISMCTSDetectives({ iterations: REVIEW_ITERATIONS, seed: 0, valueWeights: WEIGHTS.value, moveWeights: WEIGHTS.move });
    const s = C.replay(T, rec, 0);
    const rounds = [];
    let cur = null;
    for (const a of rec.history) {
      if (a.side === 'F') {
        if (cur) { rounds.push(cur); cur = null; }
        C.applyAction(T, s, a);
        continue;
      }
      if (!cur) {
        cur = {
          move: s.round, fugitive_at: T.ids[s.fugPos], candidates: C.possibleLocations(C.publicView(s)).length,
          p_caught_before: r2(valueOf(T, s, W)), moves: [],
        };
      }
      const i = s.current;
      const [to, t] = bot.chooseMove(T, C.publicView(s));
      const reach = new Set();
      for (let x = 0; x < 3; x++) if (s.detTk[3 * i + x] > 0) for (const v of T.nbr[x][s.detPos[i]]) reach.add(v);
      let others = false;
      for (let j = 0; j < s.k; j++) if (j !== i && s.detPos[j] === s.fugPos) others = true;
      const couldCatch = reach.has(s.fugPos) && !others;
      const frm = T.ids[s.detPos[i]];
      C.applyAction(T, s, a);
      const over = s.phase === C.OVER;
      cur.moves.push({
        detective: i + 1, from: frm, to: a.to, ticket: a.ticket,
        bot: { to: T.ids[to], ticket: C.TICKET_NAMES[t] }, same: T.ids[to] === a.to,
        missed_catch: couldCatch && !over, caught: over && s.winner === C.DET_WIN,
        distance_after: over ? null : T.dist[7 * T.nn + s.detPos[i] * T.n + s.fugPos],
        seconds: r1((a.ms || 0) / 1000),
      });
      if (over) break;
    }
    if (cur) rounds.push(cur);
    for (const r of rounds) {
      const ds = r.moves.map((m) => m.distance_after).filter((x) => x != null);
      r.closest = ds.length ? Math.min(...ds) : null;
    }
    const end = C.replay(T, rec);
    return {
      side: 'detectives', rounds, lessons: detectiveLessons(rounds, end), summary: summary(rec, end),
      route: [end.fugStart, ...end.log.map(([, p]) => p)].map((v) => T.ids[v]),
    };
  }

  function detectiveLessons(rounds, end) {
    const out = [];
    const moves = rounds.flatMap((r) => r.moves);
    const missed = rounds.flatMap((r) => r.moves.filter((m) => m.missed_catch).map((m) => [r, m]));
    for (const [r, m] of missed.slice(0, 3)) {
      out.push(`Missed catch after move ${r.move}: Detective ${m.detective} could have stepped onto the fugitive ` +
        `at ${r.fugitive_at} but went to ${m.to}.`);
    }
    if (moves.length) {
      const agree = moves.filter((m) => m.same).length / moves.length;
      out.push(`Your moves matched the bot detectives' choice ${Math.round(100 * agree)}% of the time.`);
    }
    if (rounds.length) {
      const cl = rounds.map((r) => r.closest).filter((x) => x != null);
      const closest = cl.length ? Math.min(...cl) : null;
      const late = rounds.filter((r) => r.candidates >= 25);
      if (late.length) {
        const peak = late.reduce((a, b) => (b.candidates > a.candidates ? b : a));
        out.push(`The fugitive got away from you most around move ${peak.move}: ` +
          `${Math.max(...rounds.map((r) => r.candidates))} stations were possible. Closing in right after a reveal, ` +
          'before the possibilities multiply, is what wins.');
      }
      if (end.winner !== C.DET_WIN && closest != null) {
        out.push(`Closest you got: ${closest} move${closest !== 1 ? 's' : ''} from the fugitive.`);
      }
    }
    return out;
  }

  function summary(rec, s) {
    const r = rec.result || {};
    return { winner: r.winner ?? null, reason: r.reason ?? null, moves: s.round, map: rec.map, detectives: rec.detectives, mode: rec.mode };
  }

  /** The review for the human side(s) of a finished game record. */
  function review(T, rec) {
    if (rec.mode === 'human-fugitive') return reviewFugitive(T, rec);
    if (rec.mode === 'human-detectives') return reviewDetectives(T, rec);
    if (rec.mode === 'hotseat') {
      const f = reviewFugitive(T, rec), d = reviewDetectives(T, rec);
      return { side: 'both', fugitive: f, detectives: d, summary: f.summary };
    }
    throw new Error(`cannot review a game of mode ${rec.mode}`);
  }

  return { review, reviewFugitive, reviewDetectives, REVIEW_ITERATIONS };
});
