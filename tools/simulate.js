/*
 * Win-rate simulation: plays many full games through the real rules engine with
 * heuristic players, to check map balance.
 *
 *   node tools/simulate.js [games] [--sy <dir>]
 *
 *   games      games per configuration (default 1000)
 *   --sy dir   also simulate on a reference map given as stations.txt + connections.txt
 *              (AlexElvers/scotland-yard-data format) for comparison.
 *
 * Players
 *   fugitive    knows where every detective is. Picks the move that maximises distance to
 *               the nearest detective, then number of safe exits; plays a double move when
 *               every single move leaves it one step from a detective; uses a secret ticket
 *               on the move after each reveal; otherwise spends its most plentiful ticket.
 *   detectives  use only public information (Engine.possibleLocations). Step onto a
 *               candidate station when one is in reach, otherwise close in on the candidate
 *               set, avoiding stacking on top of each other; spend their most plentiful
 *               ticket, and plan only over lines they still hold tickets for.
 *   random      both sides pick uniformly random legal moves (baseline).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../js/engine.js');
const { loadMaps } = require('./genmap.js');

// ---------- args ----------
const args = process.argv.slice(2);
const GAMES = Number(args.find((a) => /^\d+$/.test(a))) || 1000;
const syIdx = args.indexOf('--sy');
const SY_DIR = syIdx >= 0 ? args[syIdx + 1] : null;

// ---------- reference map loader ----------
function loadTextMap(dir) {
  const T = { taxi: 'cab', bus: 'tram', underground: 'metro', water: 'ferry' };
  const stations = fs
    .readFileSync(path.join(dir, 'stations.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => ({ id: Number(l.split(' ')[0]) }));
  const edges = fs
    .readFileSync(path.join(dir, 'connections.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const [a, b, t] = l.trim().split(/\s+/);
      return { a: Number(a), b: Number(b), type: T[t] };
    });
  return { name: 'Scotland Yard', stations, edges };
}
// Standard start cards for the reference map (not part of the dataset).
const SY_DET = [13, 26, 29, 34, 50, 53, 91, 94, 103, 112, 117, 123, 138, 141, 155, 174];
const SY_FUG = [35, 45, 51, 71, 78, 104, 106, 127, 132, 146, 166, 170, 172];

// ---------- rng ----------
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
function sample(arr, k, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// ---------- distances ----------
// dist[mask][u][v]: moves from u to v using only the ticket types in mask (bit0 cab, bit1 tram, bit2 metro).
function buildDistances(map, adj) {
  const ids = map.stations.map((s) => s.id);
  const types = ['cab', 'tram', 'metro'];
  const dist = {};
  for (let mask = 1; mask < 8; mask++) {
    const ts = types.filter((_, i) => mask & (1 << i));
    const table = {};
    for (const src of ids) {
      const d = { [src]: 0 };
      let frontier = [src];
      while (frontier.length) {
        const next = [];
        for (const u of frontier) for (const t of ts) for (const v of adj[u][t]) if (d[v] === undefined) { d[v] = d[u] + 1; next.push(v); }
        frontier = next;
      }
      table[src] = d;
    }
    dist[mask] = table;
  }
  return dist;
}
const INF = 99;
const maskOf = (tickets) => (tickets.cab > 0 ? 1 : 0) | (tickets.tram > 0 ? 2 : 0) | (tickets.metro > 0 ? 4 : 0);
const dd = (dist, mask, u, v) => (mask ? dist[mask][u][v] ?? INF : INF);

// ---------- players ----------
function richestTicket(tickets, options) {
  let best = null;
  for (const t of options) if (t !== 'secret' && (best === null || tickets[t] > tickets[best])) best = t;
  return best || 'secret';
}

function fugitiveTurn(g, ctx, rng) {
  const { adj, dist } = ctx;
  const dets = g.detectives;
  const danger = (v) => Math.min(...dets.map((d) => dd(dist, maskOf(d.tickets), d.pos, v)));
  const scoreMove = (m) => {
    const dg = danger(m.to);
    let exits = 0;
    for (const t of E.TRANSPORTS) for (const w of adj[m.to][t]) if (danger(w) >= 2) exits++;
    return 10 * Math.min(dg, 4) + exits + rng() * 0.5;
  };
  const best = (moves) => moves.reduce((a, b) => (scoreMove(b) > scoreMove(a) ? b : a));

  let moves = E.fugitiveMoves(g, adj);
  let m = best(moves);
  if (danger(m.to) <= 1 && E.canUseDouble(g)) E.useDouble(g);
  for (;;) {
    moves = E.fugitiveMoves(g, adj);
    m = best(moves);
    const nextRound = g.round + 1;
    const afterReveal = E.REVEAL_ROUNDS.includes(nextRound - 1);
    const t = afterReveal && m.tickets.includes('secret') ? 'secret' : richestTicket(g.fugitive.tickets, m.tickets);
    E.moveFugitive(g, adj, m.to, t);
    if (g.winner || g.double !== 'second') return;
  }
}

function detectiveTurn(g, ctx, rng, claimed) {
  const { adj, dist, map } = ctx;
  const d = g.detectives[g.current];
  const cands = E.possibleLocations(g, adj, map);
  const candSet = new Set(cands);
  const others = g.detectives.filter((_, j) => j !== g.current).map((x) => x.pos);
  const moves = E.detectiveMoves(g, adj, g.current);
  let best = null;
  let bestScore = Infinity;
  for (const m of moves) {
    const t = richestTicket(d.tickets, m.tickets);
    const left = { ...d.tickets, [t]: d.tickets[t] - 1 };
    const mask = maskOf(left);
    let score;
    if (candSet.has(m.to)) {
      score = -1000 + (claimed.has(m.to) ? 500 : 0);
    } else if (cands.length) {
      let mn = INF, sum = 0;
      for (const c of cands) { const x = dd(dist, mask, m.to, c); mn = Math.min(mn, x); sum += Math.min(x, 12); }
      score = 3 * mn + sum / cands.length;
    } else score = 0;
    for (const o of others) if (dd(dist, 7, m.to, o) <= 1) score += 0.75; // spread out
    score += rng() * 0.1;
    if (score < bestScore) { bestScore = score; best = { to: m.to, t }; }
  }
  claimed.add(best.to);
  E.moveDetective(g, adj, best.to, best.t);
}

function randomTurn(g, ctx, rng) {
  if (g.phase === 'fugitive') {
    if (E.canUseDouble(g) && rng() < 0.08) E.useDouble(g);
    const m = pick(E.fugitiveMoves(g, ctx.adj), rng);
    E.moveFugitive(g, ctx.adj, m.to, pick(m.tickets, rng));
  } else {
    const m = pick(E.detectiveMoves(g, ctx.adj, g.current), rng);
    E.moveDetective(g, ctx.adj, m.to, pick(m.tickets, rng));
  }
}

// ---------- game loop ----------
function playGame(ctx, nDet, rng, mode) {
  const map = ctx.map;
  const g = E.createGame(map, ctx.adj, {
    detectives: Array.from({ length: nDet }, (_, i) => ({ name: `D${i + 1}`, color: '#000' })),
    rng,
  });
  if (ctx.detStarts) {
    // separate start pools (reference map)
    const ds = sample(ctx.detStarts, nDet, rng);
    g.detectives.forEach((d, i) => (d.pos = d.start = ds[i]));
    g.fugitive.pos = g.fugitive.start = pick(ctx.fugStarts, rng);
  }
  let claimed = new Set();
  let steps = 0;
  while (!g.winner) {
    if (++steps > 2000) throw new Error('game did not terminate');
    if (mode === 'random') randomTurn(g, ctx, rng);
    else if (g.phase === 'fugitive') { fugitiveTurn(g, ctx, rng); claimed = new Set(); }
    else detectiveTurn(g, ctx, rng, claimed);
  }
  return { winner: g.winner, round: g.round, reason: g.reason };
}

function makeCtx(map, detStarts, fugStarts) {
  const adj = E.buildAdjacency(map);
  // possibleLocations seeds its candidates from map.starts, so with separate pools
  // that must be the fugitive's pool.
  const m = fugStarts ? { ...map, starts: fugStarts } : map;
  return { map: m, adj, dist: buildDistances(map, adj), detStarts, fugStarts };
}

// ---------- run ----------
const configs = loadMaps().map(({ data }) => ({ label: data.name, ctx: makeCtx(data) }));
if (SY_DIR) {
  const sy = loadTextMap(SY_DIR);
  configs.push({ label: 'Scotland Yard', ctx: makeCtx(sy, SY_DET, SY_FUG) });
}

const pct = (x, n) => ((100 * x) / n).toFixed(1).padStart(5);
const ci = (x, n) => (196 * Math.sqrt((x / n) * (1 - x / n) / n)).toFixed(1);
console.log(
  `${GAMES} games per row. Detective win % (±95% CI), avg round of capture, and fugitive wins split into\n` +
    `"survived" (all 24 moves) vs "dets stuck" (detectives out of usable tickets — they hold 22 for 24 rounds,\n` +
    `so this is usually also an end-of-game survival).\n`
);
for (const mode of ['heuristic', 'random']) {
  console.log(`== ${mode} players ==`);
  console.log('map'.padEnd(30), 'dets', ' det win', '        ', 'capture rd', 'fug wins: survived / dets stuck');
  for (const { label, ctx } of configs) {
    for (const nDet of [3, 4, 5]) {
      const rng = makeRng(1234 + nDet);
      let dw = 0, rounds = 0, survived = 0, stuck = 0;
      for (let i = 0; i < GAMES; i++) {
        const r = playGame(ctx, nDet, rng, mode);
        if (r.winner === 'detectives') { dw++; rounds += r.round; }
        else if (/stayed free/.test(r.reason)) survived++;
        else stuck++;
      }
      console.log(
        label.padEnd(30), String(nDet).padStart(4), pct(dw, GAMES) + '%', `±${ci(dw, GAMES)}`.padEnd(7),
        (dw ? (rounds / dw).toFixed(1) : '-').padStart(10), `   ${survived} / ${stuck}`
      );
    }
  }
  console.log();
}
