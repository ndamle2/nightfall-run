/*
 * Nightfall Run — shared pieces of the strong computer players (JavaScript port of ai/).
 *
 * Stations are addressed by index 0..N-1 here (Tables.ids / Tables.index convert to and
 * from the station ids the page uses), tickets by number: 0 cab, 1 tram, 2 metro, 3 secret
 * (3 is also "any line", ferries included, when a secret ticket is played), 4 double.
 *
 * What is here, and the Python it follows move for move (tests/ai_parity.test.js checks it
 * against positions computed by the Python code):
 *   tables(map)            ai/engine.py GameMap + ai/fast.py Tables
 *   newGame, move*, ...    ai/engine.py rules (the same rules as js/engine.js)
 *   heuristic players      ai/fast.py _fugitive_turn / _detective_move (leaf playouts)
 *   detScores              ai/fast_tree.py det_scores (the ISMCTS prior)
 *   rankedTurns            ai/fast_tree.py ranked_turns (the ISMCTS fugitive model)
 *   value                  ai/value.py ValueModel (P(detectives win) of a position)
 *   moveOdds, beliefUpdate ai/policies.py move_odds / belief_update_joint (where is the
 *                          fugitive likely to be?)
 *
 * Works in the browser (self.AICore, also inside a Web Worker) and in Node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AICore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_ROUNDS = 24;
  const REVEALS = [3, 8, 13, 18, 24];
  const IS_REVEAL = new Uint8Array(MAX_ROUNDS + 2);
  for (const r of REVEALS) IS_REVEAL[r] = 1;
  const NEXT_REVEAL = [];
  for (let x = 0; x <= MAX_ROUNDS + 1; x++) {
    const r = REVEALS.find((y) => y > x);
    NEXT_REVEAL.push(r === undefined ? MAX_ROUNDS + 1 : r);
  }
  const TRANSPORTS = ['cab', 'tram', 'metro', 'ferry'];
  const TICKET_NAMES = ['cab', 'tram', 'metro', 'secret', 'double'];
  const TICKET = { cab: 0, tram: 1, metro: 2, secret: 3, double: 4 };
  const SECRET = 3, DOUBLE = 4;
  const DETECTIVE_TICKETS = [10, 8, 4];
  const FUGITIVE_TICKETS = [4, 3, 3];
  const DOUBLE_CARDS = 2;
  const INF = 99;
  const FUG = 0, DET = 1, OVER = 2;
  const NO_WINNER = 0, FUG_WIN = 1, DET_WIN = 2;
  const NO_DBL = 0, DBL_FIRST = 1, DBL_SECOND = 2;
  const DANGER_CAP = 4;

  // ---------- random numbers ----------

  /** Seeded uniform [0, 1) generator (mulberry32). No seed: a random one. */
  function makeRng(seed) {
    let a = (seed === undefined || seed === null ? Math.floor(Math.random() * 2 ** 32) : seed) >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- board tables ----------

  const tableCache = new Map();

  /** Per-map arrays, built once per map (cached by key and seed). */
  function tables(map) {
    const ck = `${map.key}:${map.seed}`;
    let T = tableCache.get(ck);
    if (T) return T;
    const ids = map.stations.map((s) => s.id).sort((a, b) => a - b);
    const index = {};
    ids.forEach((id, i) => { index[id] = i; });
    const n = ids.length;
    const nn = n * n;
    const prop = new Uint8Array(4 * nn);   // prop[t][u][v]; t 3 = any line (secret ticket)
    const edge = new Float64Array(nn);     // links between u and v, all lines
    const adj4 = new Uint8Array(4 * nn);   // by transport, ferry at 3
    for (const e of map.edges) {
      const t = TRANSPORTS.indexOf(e.type);
      const a = index[e.a], b = index[e.b];
      adj4[t * nn + a * n + b] = adj4[t * nn + b * n + a] = 1;
    }
    const nbr = [[], [], [], []];
    const nbrAny = [], nbrBasic = [];
    for (let u = 0; u < n; u++) {
      const any = [], basic = [];
      for (let t = 0; t < 4; t++) {
        const list = [];
        for (let v = 0; v < n; v++) if (adj4[t * nn + u * n + v]) list.push(v);
        nbr[t].push(list);
      }
      for (let v = 0; v < n; v++) {
        let a = 0, b = 0, cnt = 0;
        for (let t = 0; t < 4; t++) {
          const x = adj4[t * nn + u * n + v];
          if (x) { a = 1; cnt++; if (t < 3) b = 1; }
        }
        for (let t = 0; t < 3; t++) prop[t * nn + u * n + v] = adj4[t * nn + u * n + v];
        prop[3 * nn + u * n + v] = a;
        edge[u * n + v] = cnt;
        if (a) any.push(v);
        if (b) basic.push(v);
      }
      nbrAny.push(any);
      nbrBasic.push(basic);
    }
    // dist[mask][u][v]: fewest moves using only ticket types in mask (bit0 cab, bit1 tram,
    // bit2 metro); unreachable, or mask 0, is INF
    const dist = new Uint8Array(8 * nn).fill(INF);
    for (let mask = 1; mask < 8; mask++) {
      const ts = [0, 1, 2].filter((t) => mask & (1 << t));
      for (let src = 0; src < n; src++) {
        const row = mask * nn + src * n;
        dist[row + src] = 0;
        let frontier = [src];
        let step = 0;
        while (frontier.length) {
          step++;
          const next = [];
          for (const u of frontier) for (const t of ts) for (const v of nbr[t][u]) {
            if (dist[row + v] === INF) { dist[row + v] = step; next.push(v); }
          }
          frontier = next;
        }
      }
    }
    // The heuristic counts a destination's safe exits over every line, ferries included
    // (ai/fast.py _base_at walks nbr_any, weighting by edge count).
    T = {
      key: map.key, seed: map.seed, n, nn, ids, index, prop, edge, nbr, nbrAny, nbrBasic, dist,
      starts: map.starts.map((s) => index[s]),
    };
    tableCache.set(ck, T);
    return T;
  }

  const maskOf = (tk, o) => (tk[o] > 0 ? 1 : 0) | (tk[o + 1] > 0 ? 2 : 0) | (tk[o + 2] > 0 ? 4 : 0);

  // ---------- game state ----------
  // { k, detPos Int32Array(k), detTk Int32Array(3k), detStart [k], fugPos, fugStart,
  //   fugTk Int32Array(5), phase, round, current, dbl, log [[ticket, pos, reveal, double]],
  //   winner, cand Uint8Array(N) }  — cand: the public candidate set before removing the
  //   stations detectives stand on (as ai/engine.py).

  function newGame(T, k, fugStart, detStarts) {
    const s = {
      k,
      detPos: Int32Array.from(detStarts),
      detTk: new Int32Array(3 * k),
      detStart: detStarts.slice(),
      fugPos: fugStart,
      fugStart,
      fugTk: Int32Array.from([...FUGITIVE_TICKETS, k, DOUBLE_CARDS]),
      phase: FUG, round: 0, current: -1, dbl: NO_DBL, log: [], winner: NO_WINNER,
      cand: new Uint8Array(T.n),
    };
    for (let i = 0; i < k; i++) s.detTk.set(DETECTIVE_TICKETS, 3 * i);
    for (const v of T.starts) s.cand[v] = 1;
    for (const p of detStarts) s.cand[p] = 0;
    if (!fugCanMove(T, s)) finish(s, DET_WIN);
    return s;
  }

  function clone(s) {
    return {
      k: s.k, detPos: s.detPos.slice(), detTk: s.detTk.slice(), detStart: s.detStart,
      fugPos: s.fugPos, fugStart: s.fugStart, fugTk: s.fugTk.slice(), phase: s.phase,
      round: s.round, current: s.current, dbl: s.dbl, log: s.log.slice(), winner: s.winner,
      cand: s.cand, // never mutated in place
    };
  }

  /** A copy with everything the detectives cannot see blanked out (-1). */
  function publicView(s) {
    const p = clone(s);
    p.fugPos = -1;
    p.fugStart = -1;
    p.log = s.log.map(([t, q, rev, dbl]) => [t, rev ? q : -1, rev, dbl]);
    return p;
  }

  function occupied(s, v) {
    const dp = s.detPos;
    for (let j = 0; j < dp.length; j++) if (dp[j] === v) return true;
    return false;
  }

  /** Legal ticket bits (0..3) for the fugitive moving to v (0 if v is not reachable). */
  function fugReach(T, s, v) {
    if (occupied(s, v)) return 0;
    const base = s.fugPos * T.n + v;
    let m = 0;
    for (let t = 0; t < 4; t++) if (s.fugTk[t] > 0 && T.prop[t * T.nn + base]) m |= 1 << t;
    return m;
  }

  function fugCanMove(T, s) {
    if (s.fugPos < 0) return true; // a public view: the station is unknown
    for (const v of T.nbrAny[s.fugPos]) if (fugReach(T, s, v)) return true;
    return false;
  }

  function detCanMove(T, s, j) {
    const p = s.detPos[j];
    for (const v of T.nbrBasic[p]) {
      if (occupied(s, v)) continue;
      for (let t = 0; t < 3; t++) if (s.detTk[3 * j + t] > 0 && T.prop[t * T.nn + p * T.n + v]) return true;
    }
    return false;
  }

  /** Legal fugitive moves [[to, ticket]], by station then ticket (secret last). */
  function fugitiveActions(T, s) {
    const out = [];
    for (const v of T.nbrAny[s.fugPos]) {
      const m = fugReach(T, s, v);
      for (let t = 0; t < 4; t++) if (m & (1 << t)) out.push([v, t]);
    }
    return out;
  }

  /** Legal moves [[to, ticket]] for detective i (default: the one to move). */
  function detectiveActions(T, s, i = s.current) {
    const out = [];
    const p = s.detPos[i];
    for (const v of T.nbrBasic[p]) {
      let blocked = false;
      for (let j = 0; j < s.k; j++) if (j !== i && s.detPos[j] === v) blocked = true;
      if (blocked) continue;
      for (let t = 0; t < 3; t++) if (s.detTk[3 * i + t] > 0 && T.prop[t * T.nn + p * T.n + v]) out.push([v, t]);
    }
    return out;
  }

  function finish(s, winner) {
    s.phase = OVER;
    s.winner = winner;
    s.current = -1;
    s.dbl = NO_DBL;
  }

  function canUseDouble(s) {
    return s.phase === FUG && s.winner === NO_WINNER && s.dbl === NO_DBL && s.fugTk[DOUBLE] > 0 &&
      s.round <= MAX_ROUNDS - 2;
  }

  function useDouble(s) {
    s.fugTk[DOUBLE]--;
    s.dbl = DBL_FIRST;
  }

  function moveFugitive(T, s, to, t) {
    s.fugTk[t]--;
    s.fugPos = to;
    s.round++;
    const reveal = IS_REVEAL[s.round] === 1;
    s.log.push([t, to, reveal, s.dbl !== NO_DBL]);
    const n = T.n;
    const c = new Uint8Array(n);
    if (reveal) c[to] = 1;
    else {
      const off = t * T.nn;
      const old = s.cand;
      for (let u = 0; u < n; u++) {
        if (!old[u]) continue;
        const nb = T.nbrAny[u];
        for (let a = 0; a < nb.length; a++) if (T.prop[off + u * n + nb[a]]) c[nb[a]] = 1;
      }
    }
    s.cand = c;
    if (s.dbl === DBL_FIRST) {
      s.dbl = DBL_SECOND;
      if (!fugCanMove(T, s)) finish(s, DET_WIN);
      return;
    }
    s.dbl = NO_DBL;
    s.phase = DET;
    let any = false;
    for (let j = 0; j < s.k; j++) if (detCanMove(T, s, j)) { any = true; break; }
    if (!any) { finish(s, FUG_WIN); return; }
    s.current = -1;
    advance(T, s);
  }

  function advance(T, s) {
    for (let j = s.current + 1; j < s.k; j++) {
      if (detCanMove(T, s, j)) { s.current = j; return; }
    }
    s.current = -1;
    if (s.round >= MAX_ROUNDS) { finish(s, FUG_WIN); return; }
    s.phase = FUG;
    if (!fugCanMove(T, s)) finish(s, DET_WIN);
  }

  function moveDetective(T, s, to, t) {
    const i = s.current;
    s.detTk[3 * i + t]--;
    s.fugTk[t]++; // spent detective tickets go to the fugitive
    s.detPos[i] = to;
    if (to === s.fugPos) { finish(s, DET_WIN); return; }
    advance(T, s);
  }

  /** A fugitive turn: ['double'?, [to, ticket], [to, ticket]?]. */
  function applyTurn(T, s, turn) {
    for (const a of turn) {
      if (a === 'double') useDouble(s);
      else moveFugitive(T, s, a[0], a[1]);
    }
  }

  function possibleMask(s) {
    const c = s.cand.slice();
    for (let j = 0; j < s.k; j++) c[s.detPos[j]] = 0;
    return c;
  }

  function possibleLocations(s) {
    const c = possibleMask(s);
    const out = [];
    for (let v = 0; v < c.length; v++) if (c[v]) out.push(v);
    return out;
  }

  /** Fewest moves for the nearest detective to reach each station, into out (Uint8Array N). */
  function danger(T, s, out) {
    out.fill(INF);
    const n = T.n;
    for (let j = 0; j < s.k; j++) {
      const off = maskOf(s.detTk, 3 * j) * T.nn + s.detPos[j] * n;
      for (let v = 0; v < n; v++) if (T.dist[off + v] < out[v]) out[v] = T.dist[off + v];
    }
    return out;
  }

  /** Richest basic ticket among the bits in lt (first wins ties), else secret. */
  function richest(tk, o, lt) {
    let t = 3, best = -1;
    for (let x = 0; x < 3; x++) if ((lt >> x) & 1 && tk[o + x] > best) { t = x; best = tk[o + x]; }
    return t;
  }

  /** Stations the fugitive reaches within `depth` moves strictly before any detective. */
  function roomToRun(T, s, dg, depth = 3) {
    const mask = s.fugTk[SECRET] > 0 ? 7 : maskOf(s.fugTk, 0);
    if (!mask) return 0;
    const off = mask * T.nn + s.fugPos * T.n;
    let room = 0;
    for (let v = 0; v < T.n; v++) if (T.dist[off + v] <= depth && T.dist[off + v] < dg[v]) room++;
    return room;
  }

  // ---------- record actions (station ids, ticket names) ----------

  /** The state a game record reaches after its first `upto` actions (all by default).
   * Throws if the record does not fit the map or an action is illegal. */
  function replay(T, rec, upto) {
    if (rec.mapSeed != null && T.seed != null && rec.mapSeed !== T.seed) {
      throw new Error('the map has been regenerated since this game was played');
    }
    const ix = (id) => {
      if (!(id in T.index)) throw new Error(`unknown station ${id}`);
      return T.index[id];
    };
    const s = newGame(T, Number(rec.detectives), ix(rec.fugitiveStart), rec.detectiveStarts.map(ix));
    const hist = upto === undefined ? rec.history : rec.history.slice(0, upto);
    for (const a of hist) applyAction(T, s, a);
    return s;
  }

  function applyAction(T, s, a) {
    if (s.phase === OVER) throw new Error('action after the end of the game');
    if (a.side === 'F') {
      if (s.phase !== FUG) throw new Error('fugitive move out of turn');
      if (a.type === 'double') {
        if (!canUseDouble(s)) throw new Error('a double move cannot be played now');
        useDouble(s);
        return;
      }
      const to = T.index[a.to], t = TICKET[a.ticket];
      if (!fugitiveActions(T, s).some(([v, x]) => v === to && x === t)) throw new Error('illegal fugitive move');
      moveFugitive(T, s, to, t);
    } else {
      if (s.phase !== DET || (a.i != null && a.i !== s.current)) throw new Error('detective move out of turn');
      const to = T.index[a.to], t = TICKET[a.ticket];
      if (!detectiveActions(T, s).some(([v, x]) => v === to && x === t)) throw new Error('illegal detective move');
      moveDetective(T, s, to, t);
    }
  }

  // ---------- heuristic players (leaf playouts; ai/fast.py) ----------

  function fugBest(T, s, base, noise, rng) {
    let best = -1, bestSc = -Infinity;
    for (const v of T.nbrAny[s.fugPos]) {
      if (fugReach(T, s, v)) {
        let sc = base[v];
        if (noise) sc += rng() * noise;
        if (sc > bestSc) { best = v; bestSc = sc; }
      }
    }
    return best;
  }

  function fugTicket(T, s, to) {
    const lt = fugReach(T, s, to);
    if (IS_REVEAL[s.round] && (lt >> 3) & 1) return 3;
    return richest(s.fugTk, 0, lt);
  }

  /** 10 · min(danger, 4) + links to stations at least 2 moves from every detective. */
  function baseScores(T, dg, out) {
    const n = T.n;
    for (let v = 0; v < n; v++) {
      let x = 0;
      const nb = T.nbrAny[v];
      for (let a = 0; a < nb.length; a++) if (dg[nb[a]] >= 2) x += T.edge[v * n + nb[a]];
      out[v] = 10 * Math.min(dg[v], DANGER_CAP) + x;
    }
    return out;
  }

  /** Plays the heuristic fugitive's whole turn on s (in place). */
  function heuristicFugitiveTurn(T, s, noise, rng, scratch) {
    const dg = danger(T, s, scratch.dg);
    const base = baseScores(T, dg, scratch.base);
    let to = fugBest(T, s, base, noise, rng);
    if (dg[to] <= 1 && s.phase === FUG && s.dbl === NO_DBL && s.fugTk[4] > 0 && s.round <= MAX_ROUNDS - 2) {
      s.fugTk[4]--;
      s.dbl = DBL_FIRST;
    }
    to = fugBest(T, s, base, noise, rng);
    moveFugitive(T, s, to, fugTicket(T, s, to));
    if (s.phase === FUG && s.dbl === DBL_SECOND) {
      to = fugBest(T, s, base, noise, rng);
      moveFugitive(T, s, to, fugTicket(T, s, to));
    }
  }

  /** Union territory setup (policies.team_territory): od = other detectives' distance to
   * each station, F = fugitive distance from the nearest candidate. */
  function terrSetup(T, s, i, cands, nc, od, F) {
    const n = T.n;
    od.fill(INF);
    F.fill(INF);
    for (let j = 0; j < s.k; j++) {
      if (j === i) continue;
      const off = maskOf(s.detTk, 3 * j) * T.nn + s.detPos[j] * n;
      for (let v = 0; v < n; v++) if (T.dist[off + v] < od[v]) od[v] = T.dist[off + v];
    }
    for (let c = 0; c < nc; c++) {
      const off = 7 * T.nn + cands[c] * n;
      for (let v = 0; v < n; v++) if (T.dist[off + v] < F[v]) F[v] = T.dist[off + v];
    }
  }

  function terrCount(T, od, F, mask, v, h) {
    const off = mask * T.nn + v * T.n;
    let cnt = 0;
    for (let u = 0; u < T.n; u++) {
      const r = T.dist[off + u];
      const d = r < od[u] ? r : od[u];
      if (F[u] < d && F[u] <= h) cnt++;
    }
    return cnt;
  }

  /** Heuristic detective scores for the detective to move (lower is better), as
   * HeuristicDetectives.scores with the union territory term `terr`: {tos, tks, scores}. */
  function detScores(T, s, terr = 0, h = 3, scratch) {
    const i = s.current;
    const p = s.detPos[i];
    const n = T.n;
    const cands = scratch ? scratch.cands : new Int32Array(n);
    let nc = 0;
    for (let v = 0; v < n; v++) if (s.cand[v] && !occupied(s, v)) cands[nc++] = v;
    let od, F;
    if (terr && nc) {
      od = scratch ? scratch.od : new Int32Array(n);
      F = scratch ? scratch.F : new Int32Array(n);
      terrSetup(T, s, i, cands, nc, od, F);
    }
    const tos = [], tks = [], scores = [];
    const left = [0, 0, 0];
    for (const v of T.nbrBasic[p]) {
      let blocked = false;
      for (let j = 0; j < s.k; j++) if (j !== i && s.detPos[j] === v) blocked = true;
      if (blocked) continue;
      let t = -1, most = -1;
      for (let x = 0; x < 3; x++) {
        const c = s.detTk[3 * i + x];
        if (c > 0 && T.prop[x * T.nn + p * n + v] && c > most) { t = x; most = c; }
      }
      if (t < 0) continue;
      let sc;
      if (nc) {
        for (let x = 0; x < 3; x++) left[x] = s.detTk[3 * i + x] - (x === t ? 1 : 0);
        const mk = maskOf(left, 0);
        const off = mk * T.nn + v * n;
        let mn = INF, sm = 0;
        for (let c = 0; c < nc; c++) {
          const d = T.dist[off + cands[c]];
          if (d < mn) mn = d;
          sm += d < 12 ? d : 12;
        }
        sc = 3 * mn + sm / nc;
        if (terr) sc += terr * terrCount(T, od, F, mk, v, h);
      } else sc = 0;
      if (s.cand[v]) sc = -1000;
      let near = 0;
      for (let j = 0; j < s.k; j++) if (j !== i && T.dist[7 * T.nn + v * n + s.detPos[j]] <= 1) near++;
      tos.push(v);
      tks.push(t);
      scores.push(sc + 0.75 * near);
    }
    return { tos, tks, scores };
  }

  /** Plays the heuristic detective's move on s (in place), as ai/fast.py _detective_move. */
  function heuristicDetectiveMove(T, s, noise, rng, scratch) {
    const i = s.current;
    const p = s.detPos[i];
    const n = T.n;
    const cands = scratch.cands;
    let nc = 0;
    for (let v = 0; v < n; v++) if (s.cand[v] && !occupied(s, v)) cands[nc++] = v;
    let bestV = -1, bestT = -1, bestSc = Infinity;
    const left = scratch.left;
    for (const v of T.nbrBasic[p]) {
      if (occupied(s, v)) continue;
      let t = -1, most = -1;
      for (let x = 0; x < 3; x++) {
        const c = s.detTk[3 * i + x];
        if (c > 0 && T.prop[x * T.nn + p * n + v] && c > most) { t = x; most = c; }
      }
      if (t < 0) continue;
      let sc;
      if (s.cand[v]) sc = -1000;
      else if (nc) {
        for (let x = 0; x < 3; x++) left[x] = s.detTk[3 * i + x] - (x === t ? 1 : 0);
        const off = maskOf(left, 0) * T.nn + v * n;
        let mn = INF, sm = 0;
        for (let c = 0; c < nc; c++) {
          const d = T.dist[off + cands[c]];
          if (d < mn) mn = d;
          sm += d < 12 ? d : 12;
        }
        sc = 3 * mn + sm / nc;
      } else sc = 0;
      let near = 0;
      for (let j = 0; j < s.k; j++) if (j !== i && T.dist[7 * T.nn + v * n + s.detPos[j]] <= 1) near++;
      sc += 0.75 * near;
      if (noise) sc += rng() * noise;
      if (sc < bestSc) { bestV = v; bestT = t; bestSc = sc; }
    }
    moveDetective(T, s, bestV, bestT);
  }

  function makeScratch(T) {
    const n = T.n;
    return {
      dg: new Uint8Array(n), base: new Float64Array(n), cands: new Int32Array(n),
      od: new Int32Array(n), F: new Int32Array(n), left: [0, 0, 0],
    };
  }

  // ---------- value model (ai/value.py) ----------

  const VALUE_FEATURES = [
    'bias', 'd1_is1', 'd1_is2', 'd1_is3', 'd1_is4', 'd2', 'dmean', 'near2',
    'log_cand', 'cand_is1', 'rounds_left', 'to_reveal', 'safe_exits', 'moves',
    'doubles', 'secrets', 'det_tickets', 'det_phase', 'capture_threat', 'k',
    'room', 'room_small',
  ];

  /** Weights over all 22 features from a weights file {features, weights}. */
  function valueWeights(file) {
    const W = new Float64Array(VALUE_FEATURES.length);
    file.features.forEach((name, j) => {
      const c = VALUE_FEATURES.indexOf(name);
      if (c < 0) throw new Error(`unknown value feature ${name}`);
      W[c] = file.weights[j];
    });
    return W;
  }

  function valueFeatures(T, s, dg) {
    const k = s.k, n = T.n, f = s.fugPos;
    danger(T, s, dg);
    const d = [];
    for (let j = 0; j < k; j++) {
      const x = T.dist[maskOf(s.detTk, 3 * j) * T.nn + s.detPos[j] * n + f];
      d.push(x < 10 ? x : 10);
    }
    d.sort((a, b) => a - b);
    const d1 = d[0], d2 = k > 1 ? d[1] : 10;
    let dests = 0, safe = 0;
    for (const v of T.nbrAny[f]) {
      if (fugReach(T, s, v)) { dests++; if (dg[v] >= 2) safe++; }
    }
    let nc = 0;
    for (let v = 0; v < n; v++) if (s.cand[v]) nc++;
    for (let j = 0; j < k; j++) if (s.cand[s.detPos[j]]) nc--;
    if (nc < 1) nc = 1;
    const detPhase = s.phase === DET;
    let threat = false;
    if (detPhase) {
      for (let j = Math.max(s.current, 0); j < k; j++) {
        if (T.dist[maskOf(s.detTk, 3 * j) * T.nn + s.detPos[j] * n + f] === 1) threat = true;
      }
    }
    const rnd = s.round;
    const room = roomToRun(T, s, dg, 3);
    let sumD = 0, near2 = 0, tick = 0;
    for (let j = 0; j < k; j++) {
      sumD += d[j];
      if (d[j] <= 2) near2++;
      tick += s.detTk[3 * j] + s.detTk[3 * j + 1] + s.detTk[3 * j + 2];
    }
    return [
      1, d1 === 1 ? 1 : 0, d1 === 2 ? 1 : 0, d1 === 3 ? 1 : 0, d1 === 4 ? 1 : 0, d2 / 10, sumD / (10 * k),
      near2 / 5, Math.log2(nc) / 7, nc === 1 ? 1 : 0, (MAX_ROUNDS - rnd) / 24, (NEXT_REVEAL[rnd] - rnd) / 5,
      Math.min(safe, 8) / 8, Math.min(dests, 12) / 12, s.fugTk[4] / 2, Math.min(s.fugTk[3], 5) / 5,
      tick / (22 * k), detPhase ? 1 : 0, threat ? 1 : 0, k / 5, Math.min(room, 30) / 30, room <= 4 ? 1 : 0,
    ];
  }

  /** P(detectives win) of state s (fugitive's station known). */
  function value(T, s, W, dg) {
    if (s.phase === OVER) return s.winner === DET_WIN ? 1 : 0;
    const f = valueFeatures(T, s, dg || new Uint8Array(T.n));
    let z = 0;
    for (let x = 0; x < f.length; x++) z += W[x] * f[x];
    return 1 / (1 + Math.exp(-z));
  }

  /** Plays s (a copy) `rounds` rounds with the noisy heuristic players, then scores it
   * with the value model (ai/fast.py playout_values: fugitive noise 0.5, detectives 0.1). */
  function playoutValue(T, s0, rounds, W, rng, scratch, fnoise = 0.5, dnoise = 0.1) {
    const s = clone(s0);
    const until = s.round + rounds;
    while (s.phase !== OVER) {
      if (s.phase === FUG) {
        if (s.round >= until) break;
        heuristicFugitiveTurn(T, s, fnoise, rng, scratch);
      } else heuristicDetectiveMove(T, s, dnoise, rng, scratch);
    }
    if (s.phase === OVER) return s.winner === DET_WIN ? 1 : 0;
    return value(T, s, W, scratch.dg);
  }

  // ---------- the fugitive model inside ISMCTS (ai/fast_tree.py ranked_turns) ----------

  const SECRET_PENALTY = 2, DOUBLE_PENALTY = 15, DOUBLE_FIRSTS = 3, DOUBLE_SECONDS = 2;

  function tkChoice(ftk, lt, rnd) {
    if (IS_REVEAL[rnd] && (lt >> 3) & 1) return 3;
    return richest(ftk, 0, lt);
  }

  /** Whole fugitive turns for s, best first by the heuristic's scoring. */
  function rankedTurns(T, s, scratch) {
    const n = T.n;
    const dg = danger(T, s, scratch ? scratch.dg : new Uint8Array(n));
    const base = new Float64Array(n).fill(NaN);
    const baseAt = (v) => {
      if (Number.isNaN(base[v])) {
        let x = 0;
        const nb = T.nbrAny[v];
        for (let a = 0; a < nb.length; a++) if (dg[nb[a]] >= 2) x += T.edge[v * n + nb[a]];
        base[v] = 10 * Math.min(dg[v], 4) + x;
      }
      return base[v];
    };
    const dests = (fpos, ftk) => {
      const vs = [], lts = [];
      for (const v of T.nbrAny[fpos]) {
        if (occupied(s, v)) continue;
        let m = 0;
        for (let t = 0; t < 4; t++) if (ftk[t] > 0 && T.prop[t * T.nn + fpos * n + v]) m |= 1 << t;
        if (m) { vs.push(v); lts.push(m); }
      }
      return [vs, lts];
    };
    const entries = []; // [score, turn]
    const ftk = s.fugTk, rnd = s.round;
    const [vs, lts] = dests(s.fugPos, ftk);
    for (let a = 0; a < vs.length; a++) {
      const v = vs[a], lt = lts[a];
      const b = baseAt(v);
      const t = tkChoice(ftk, lt, rnd);
      entries.push([b, [[v, t]]]);
      if ((lt >> 3) & 1 && t !== 3) entries.push([b - SECRET_PENALTY, [[v, 3]]]);
    }
    if (vs.length && canUseDouble(s)) {
      let cornered = true;
      for (const v of vs) if (dg[v] > 1) cornered = false;
      const bonus = cornered ? DOUBLE_PENALTY + 1 : -DOUBLE_PENALTY;
      const ftk1 = ftk.slice();
      ftk1[4]--;
      const firsts = vs.map((v, a) => a).sort((x, y) => baseAt(vs[y]) - baseAt(vs[x]) || x - y).slice(0, DOUBLE_FIRSTS);
      for (const fi of firsts) {
        const v1 = vs[fi];
        const t1 = tkChoice(ftk1, lts[fi], rnd);
        const ftk2 = ftk1.slice();
        ftk2[t1]--;
        const [vs2, lts2] = dests(v1, ftk2);
        if (!vs2.length) continue;
        const seconds = vs2.map((v, a) => a).sort((x, y) => baseAt(vs2[y]) - baseAt(vs2[x]) || x - y).slice(0, DOUBLE_SECONDS);
        for (const q of seconds) {
          entries.push([baseAt(vs2[q]) + bonus, ['double', [v1, t1], [vs2[q], tkChoice(ftk2, lts2[q], rnd + 1)]]]);
        }
      }
    }
    const order = entries.map((e, j) => j).sort((x, y) => entries[y][0] - entries[x][0] || x - y);
    return order.map((j) => entries[j][1]);
  }

  // ---------- where is the fugitive? (ai/policies.py move model + filter) ----------

  const MOVE_FEATS = ['dg', 'dg1', 'room', 'safe', 'bus', 'metro', 'secret', 'sec_after_rev',
    'sec_on_rev', 'sec_hides', 'dgq', 'tk_rich', 'dg2', 'dg3', 'room0', 'room_lt5',
    'logroom', 'deg', 'late', 'sec_late'];

  /** Per-map constants of the move features. */
  function moveTables(T) {
    if (T._move) return T._move;
    const n = T.n;
    const deg = new Float64Array(n), basicAny = new Uint8Array(n);
    for (let d = 0; d < n; d++) {
      deg[d] = T.nbrAny[d].length;
      for (let u = 0; u < n; u++) {
        for (let t = 0; t < 3; t++) if (T.prop[t * T.nn + u * n + d]) basicAny[d] = 1;
      }
    }
    T._move = { deg, basicAny };
    return T._move;
  }

  /** (4·N) relative odds exp(w · features) of the fugitive moving with ticket t to station
   * d (index t·N + d), facing detectives detPos / detTk, holding fugTk, in round rnd
   * (before the move); zero for tickets not held and on detectives. */
  function moveOdds(T, detPos, detTk, fugTk, rnd, w) {
    const n = T.n;
    const { deg, basicAny } = moveTables(T);
    const dgr = new Float64Array(n).fill(INF);
    for (let j = 0; j < detPos.length; j++) {
      const off = maskOf(detTk, 3 * j) * T.nn + detPos[j] * n;
      for (let v = 0; v < n; v++) if (T.dist[off + v] < dgr[v]) dgr[v] = T.dist[off + v];
    }
    const mask = fugTk[SECRET] > 0 ? 7 : maskOf(fugTk, 0);
    const room = new Float64Array(n);
    if (mask) {
      for (let d = 0; d < n; d++) {
        const off = mask * T.nn + d * n;
        let c = 0;
        for (let v = 0; v < n; v++) if (T.dist[off + v] <= 3 && T.dist[off + v] < dgr[v]) c++;
        room[d] = c;
      }
    }
    const afterRev = IS_REVEAL[rnd], onRev = IS_REVEAL[rnd + 1], late = rnd / MAX_ROUNDS;
    const bmax = Math.max(fugTk[0], fugTk[1], fugTk[2]);
    const rich = [fugTk[0] === bmax ? 1 : 0, fugTk[1] === bmax ? 1 : 0, fugTk[2] === bmax ? 1 : 0, 0];
    const g = new Float64Array(4 * n);
    for (let d = 0; d < n; d++) {
      let safe = 0;
      for (const v of T.nbrAny[d]) if (dgr[v] >= 2) safe++;
      const dz = dgr[d];
      const dg = Math.min(dz, DANGER_CAP);
      const r = room[d];
      const common = w[0] * dg + w[1] * (dz <= 1) + w[2] * r / 10 + w[3] * safe / 5 + w[10] * dg * dg / 4 +
        w[12] * (dz === 2) + w[13] * (dz === 3) + w[14] * (r === 0) + w[15] * (r < 5) + w[16] * Math.log1p(r) +
        w[17] * deg[d] / 5 + w[18] * late;
      for (let t = 0; t < 4; t++) {
        let z = common + w[11] * rich[t];
        if (t === 1) z += w[4];
        if (t === 2) z += w[5];
        if (t === 3) z += w[6] + w[7] * afterRev + w[8] * onRev + w[9] * (basicAny[d] ? 0 : 1) + w[19] * late;
        g[t * n + d] = fugTk[t] > 0 ? Math.exp(z) : 0;
      }
    }
    for (let j = 0; j < detPos.length; j++) for (let t = 0; t < 4; t++) g[t * n + detPos[j]] = 0;
    return g;
  }

  /** belief_update_joint: moves a location estimate `mass` (N) along log entries
   * [[ticket, pos, reveal, double]], oddsFn(j) giving the (4·N) odds before entry j.
   * Returns [mass, log evidence]. */
  function beliefUpdate(T, mass, entries, oddsFn) {
    const n = T.n;
    let logev = 0;
    for (let j = 0; j < entries.length; j++) {
      const [t, p, rev] = entries[j];
      const odds = oddsFn(j);
      const alive = new Float64Array(n);
      let z = 0;
      for (let v = 0; v < n; v++) {
        const ok = odds[v] > 0 || odds[n + v] > 0 || odds[2 * n + v] > 0 || odds[3 * n + v] > 0;
        alive[v] = ok ? mass[v] : 0;
        z += alive[v];
      }
      if (z <= 0) {
        z = 0;
        for (let v = 0; v < n; v++) { alive[v] = mass[v]; z += mass[v]; }
      }
      logev += Math.log(Math.max(z, 1e-300));
      const fresh = new Float64Array(n);
      for (let u = 0; u < n; u++) {
        if (!(alive[u] > 0)) continue;
        let Z = 0;
        for (let x = 0; x < 3; x++) for (const d of T.nbr[x][u]) Z += odds[x * n + d];
        for (const d of T.nbrAny[u]) Z += odds[3 * n + d];
        if (!(Z > 0)) continue;
        const src = alive[u] / z / Z;
        const nb = t === 3 ? T.nbrAny[u] : T.nbr[t][u];
        for (const d of nb) fresh[d] += src;
      }
      let tot = 0;
      for (let d = 0; d < n; d++) { fresh[d] *= odds[t * n + d]; tot += fresh[d]; }
      if (rev) {
        logev += Math.log(Math.max(fresh[p], 1e-300));
        mass = new Float64Array(n);
        mass[p] = 1;
        continue;
      }
      logev += Math.log(Math.max(tot, 1e-300));
      if (tot <= 0) { // the model ruled out every route: fall back to plain propagation
        fresh.fill(0);
        for (let u = 0; u < n; u++) {
          if (!(mass[u] > 0)) continue;
          const nb = t === 3 ? T.nbrAny[u] : T.nbr[t][u];
          for (const d of nb) fresh[d] += 1;
        }
        tot = 0;
        for (let d = 0; d < n; d++) { if (!(odds[t * n + d] > 0)) fresh[d] = 0; tot += fresh[d]; }
      }
      if (tot > 0) for (let d = 0; d < n; d++) fresh[d] /= tot;
      mass = fresh;
    }
    return [mass, logev];
  }

  /** mass limited to the candidate set and normalized; uniform there if it has none. */
  function restrict(mass, cand) {
    const out = new Float64Array(mass.length);
    let tot = 0;
    for (let v = 0; v < mass.length; v++) { out[v] = cand[v] ? mass[v] : 0; tot += out[v]; }
    if (!(tot > 0)) {
      tot = 0;
      for (let v = 0; v < mass.length; v++) { out[v] = cand[v] ? 1 : 0; tot += out[v]; }
    }
    for (let v = 0; v < mass.length; v++) out[v] /= tot;
    return out;
  }

  return {
    MAX_ROUNDS, REVEALS, IS_REVEAL, TICKET_NAMES, TICKET, SECRET, DOUBLE, INF,
    FUG, DET, OVER, NO_WINNER, FUG_WIN, DET_WIN, NO_DBL, DBL_FIRST, DBL_SECOND, DANGER_CAP,
    VALUE_FEATURES, MOVE_FEATS,
    makeRng, tables, maskOf, newGame, clone, publicView, occupied, fugReach, fugitiveActions,
    detectiveActions, canUseDouble, useDouble, moveFugitive, moveDetective, applyTurn,
    possibleMask, possibleLocations, danger, richest, roomToRun, replay, applyAction,
    heuristicFugitiveTurn, heuristicDetectiveMove, detScores, makeScratch, valueWeights,
    valueFeatures, value, playoutValue, rankedTurns, moveOdds, beliefUpdate, restrict,
  };
});
