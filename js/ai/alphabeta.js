/*
 * Nightfall Run — alpha-beta fugitive (JavaScript port of ai/alphabeta.py with the tree
 * search of ai/fast.py _ab_value; same tree, same evaluation, same choices up to the
 * random tie-break).
 *
 * Paranoid search: inside the tree the detectives are assumed to know where the fugitive
 * is. The evaluation rewards distance, safe exits, room to run, a large public candidate
 * set and tickets kept; when the deepest search says every option loses, the bot falls
 * back to the deepest search that still sees a way out.
 */
(function (root, factory) {
  const api = factory(root.AICore || (typeof require === 'function' ? require('./core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIAlphaBeta = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const WIN = 1e6;
  const DEFAULT_WEIGHTS = {
    dist: 10, dist_cap: 5, exits: 2, exits_cap: 6, cand: 2, secret: 3, double: 25, fade: 8,
    room: 3, room_cap: 30, room_depth: 3,
  };

  function evaluate(T, s, w, dg) {
    C.danger(T, s, dg);
    const f = s.fugPos;
    const d = dg[f];
    let exits = 0;
    for (const v of T.nbrAny[f]) if (C.fugReach(T, s, v) && dg[v] >= 2) exits++;
    let nc = 0;
    for (let v = 0; v < T.n; v++) if (s.cand[v]) nc++;
    for (let j = 0; j < s.k; j++) if (s.cand[s.detPos[j]]) nc--;
    const fade = Math.min(1, (C.MAX_ROUNDS - s.round) / w.fade);
    const room = w.room ? Math.min(C.roomToRun(T, s, dg, w.room_depth), w.room_cap) : 0;
    return w.dist * Math.min(d, w.dist_cap) + w.room * room + w.exits * Math.min(exits, w.exits_cap) +
      w.cand * Math.log2(Math.max(nc, 1)) + fade * (w.secret * s.fugTk[3] + w.double * s.fugTk[4]);
  }

  class AlphaBetaFugitive {
    constructor({ depth = 3, detBeam = 2, rootKeep = 8, timeLimit = null, weights = null, doubles = true, seed } = {}) {
      this.depth = depth;
      this.detBeam = detBeam;
      this.rootKeep = rootKeep;
      this.timeLimit = timeLimit;
      this.w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
      this.doubles = doubles;
      this.rng = C.makeRng(seed);
      this.nodes = 0;
      this.last = {};
    }

    value(T, s, rounds, alpha, beta, ply, dg) {
      this.nodes++;
      if (s.phase === C.OVER) return s.winner === C.FUG_WIN ? WIN - ply : -WIN + ply;
      if (s.phase === C.FUG) {
        if (rounds === 0) return evaluate(T, s, this.w, dg);
        C.danger(T, s, dg);
        // children: each destination once, richest basic ticket (else secret), farthest
        // from the detectives first (ties: lower station)
        const kids = [];
        for (const v of T.nbrAny[s.fugPos]) {
          const lt = C.fugReach(T, s, v);
          if (lt) kids.push([-dg[v] * 1000 + v, v, C.richest(s.fugTk, 0, lt)]);
        }
        kids.sort((a, b) => a[0] - b[0]);
        let best = -Infinity;
        for (const [, v, t] of kids) {
          const c = C.clone(s);
          C.moveFugitive(T, c, v, t);
          const x = this.value(T, c, rounds, alpha, beta, ply + 1, dg);
          if (x > best) best = x;
          if (best > alpha) alpha = best;
          if (alpha >= beta) break;
        }
        return best;
      }
      // detective: capture if in reach, else the beam of moves ending closest to the fugitive
      const i = s.current;
      const p = s.detPos[i];
      const kids = [];
      const left = [0, 0, 0];
      let capture = null;
      for (const v of T.nbrBasic[p]) {
        let blocked = false;
        for (let j = 0; j < s.k; j++) if (j !== i && s.detPos[j] === v) blocked = true;
        if (blocked) continue;
        let lt = 0;
        for (let x = 0; x < 3; x++) if (s.detTk[3 * i + x] > 0 && T.prop[x * T.nn + p * T.n + v]) lt |= 1 << x;
        if (!lt) continue;
        const t = C.richest(s.detTk, 3 * i, lt);
        if (v === s.fugPos) { capture = [0, v, t]; break; }
        for (let x = 0; x < 3; x++) left[x] = s.detTk[3 * i + x] - (x === t ? 1 : 0);
        kids.push([T.dist[C.maskOf(left, 0) * T.nn + v * T.n + s.fugPos] * 1000 + v, v, t]);
      }
      let order;
      if (capture) order = [capture];
      else {
        kids.sort((a, b) => a[0] - b[0]);
        order = kids.slice(0, this.detBeam);
      }
      let best = Infinity;
      for (const [, v, t] of order) {
        const c = C.clone(s);
        C.moveDetective(T, c, v, t);
        const r = c.phase !== C.DET ? rounds - 1 : rounds;
        const x = this.value(T, c, r, alpha, beta, ply + 1, dg);
        if (x < best) best = x;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    /** [[turn, state after it]] for every option considered at the root. */
    rootOptions(T, s) {
      const opts = [];
      const acts = C.fugitiveActions(T, s);
      const revealNext = C.IS_REVEAL[s.round + 1] === 1;
      const hasBasic = new Set(acts.filter(([, t]) => t !== C.SECRET).map(([v]) => v));
      for (const [to, t] of acts) {
        if (t === C.SECRET && revealNext && hasBasic.has(to)) continue; // shown anyway
        const c = C.clone(s);
        C.moveFugitive(T, c, to, t);
        opts.push([[[to, t]], c]);
      }
      if (this.doubles && C.canUseDouble(s)) {
        const base = C.clone(s);
        C.useDouble(base);
        for (const [v1, ts1] of groupByDest(C.fugitiveActions(T, base))) {
          const t1 = richestOf(base.fugTk, ts1);
          const mid = C.clone(base);
          C.moveFugitive(T, mid, v1, t1);
          if (mid.phase === C.OVER) continue;
          for (const [v2, ts2] of groupByDest(C.fugitiveActions(T, mid))) {
            const tickets = [richestOf(mid.fugTk, ts2)];
            if (ts2.includes(C.SECRET) && !C.IS_REVEAL[mid.round + 1] && !tickets.includes(C.SECRET)) tickets.push(C.SECRET);
            for (const t2 of tickets) {
              const c = C.clone(mid);
              C.moveFugitive(T, c, v2, t2);
              opts.push([['double', [v1, t1], [v2, t2]], c]);
            }
          }
        }
      }
      return opts;
    }

    /** The fugitive's whole turn for full state s: ['double'?, [to, ticket], ...]. */
    chooseTurn(T, state) {
      if (state.phase !== C.FUG || state.dbl !== C.NO_DBL) throw new Error('chooseTurn expects the start of a fugitive turn');
      const t0 = Date.now();
      this.nodes = 0;
      const dg = new Uint8Array(T.n);
      const opts = this.rootOptions(T, state);
      const jitter = opts.map(() => this.rng() * 1e-3);
      let order = opts.map((_, j) => j);
      const results = [];   // per depth: [best value, best index, complete]
      const perDepth = [];  // per depth: Map(option index -> score)
      for (let depth = 1; depth <= this.depth; depth++) {
        if (depth > 1) order = order.slice(0, this.rootKeep);
        const scores = new Map();
        let alpha = -Infinity;
        for (const j of order) {
          const a = depth === 1 ? -Infinity : alpha;
          const v = this.value(T, opts[j][1], depth, a, Infinity, 1, dg) + jitter[j];
          scores.set(j, v);
          alpha = Math.max(alpha, v);
          if (this.timeLimit && depth > 1 && (Date.now() - t0) / 1000 > this.timeLimit) break;
        }
        const complete = scores.size === order.length;
        let best = -1, bv = -Infinity;
        for (const [j, v] of scores) if (v > bv) { best = j; bv = v; }
        results.push([bv, best, complete]);
        perDepth.push(scores);
        const ranked = [...scores.keys()].sort((x, y) => scores.get(y) - scores.get(x));
        order = ranked.concat(order.filter((j) => !scores.has(j)));
        if (!complete) break;
        if (this.timeLimit && (Date.now() - t0) / 1000 > this.timeLimit) break;
      }
      let pick = results[results.length - 1];
      for (let r = results.length - 1; r >= 0; r--) {
        if (results[r][0] > -WIN / 2 && results[r][2]) { pick = results[r]; break; }
      }
      const [value, idx] = pick;
      this.last = {
        value, depth: results.length, options: opts.length, nodes: this.nodes, time: (Date.now() - t0) / 1000,
        chosen: idx,
        rankings: perDepth.map((sc) => [...sc].map(([j, v]) => [opts[j][0], v]).sort((a, b) => b[1] - a[1])),
      };
      return opts[idx][0].slice();
    }
  }

  function groupByDest(actions) {
    const out = [];
    for (const [to, t] of actions) {
      if (out.length && out[out.length - 1][0] === to) out[out.length - 1][1].push(t);
      else out.push([to, [t]]);
    }
    return out;
  }

  /** policies.richest_ticket: most plentiful basic ticket among options, else secret. */
  function richestOf(tk, options) {
    let best = null;
    for (const t of options) if (t !== C.SECRET && (best === null || tk[t] > tk[best])) best = t;
    return best === null ? C.SECRET : best;
  }

  return { AlphaBetaFugitive, WIN, DEFAULT_WEIGHTS, evaluate, groupByDest, richestOf };
});
