/*
 * Nightfall Run — computer players that run in the browser.
 *
 * These are the heuristic players from tools/simulate.js. They are the fallback when the
 * page is opened straight from disk; served by `python3 -m ai.serve`, the page asks the
 * much stronger Python bots instead (alpha-beta fugitive, ISMCTS detectives).
 *
 *   fugitive    sees every detective. Moves to maximise distance to the nearest detective,
 *               then safe exits; doubles when every move ends next to a detective; uses a
 *               secret ticket right after a reveal; otherwise its most plentiful ticket.
 *   detectives  use only public information (Engine.possibleLocations). Step onto a
 *               candidate station when one is in reach, otherwise close in on the candidate
 *               set without bunching up.
 */
(function (root, factory) {
  const api = factory(root.Engine || (typeof require === 'function' ? require('./engine.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Bots = api;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const INF = 99;
  const TYPES = ['cab', 'tram', 'metro'];
  const maskOf = (t) => (t.cab > 0 ? 1 : 0) | (t.tram > 0 ? 2 : 0) | (t.metro > 0 ? 4 : 0);

  /** dist[mask][u][v]: fewest moves u→v using only the ticket types in mask. */
  function buildDistances(map, adj) {
    const ids = map.stations.map((s) => s.id);
    const dist = {};
    for (let mask = 1; mask < 8; mask++) {
      const ts = TYPES.filter((_, i) => mask & (1 << i));
      const table = {};
      for (const src of ids) {
        const d = { [src]: 0 };
        let frontier = [src];
        while (frontier.length) {
          const next = [];
          for (const u of frontier) for (const t of ts) for (const v of adj[u][t]) {
            if (d[v] === undefined) { d[v] = d[u] + 1; next.push(v); }
          }
          frontier = next;
        }
        table[src] = d;
      }
      dist[mask] = table;
    }
    return dist;
  }

  function context(map, adj) {
    return { map, adj, dist: buildDistances(map, adj) };
  }

  const dd = (ctx, mask, u, v) => (mask ? ctx.dist[mask][u][v] ?? INF : INF);

  function richestTicket(tickets, options) {
    let best = null;
    for (const t of options) if (t !== 'secret' && (best === null || tickets[t] > tickets[best])) best = t;
    return best || 'secret';
  }

  /** The fugitive's whole turn as actions: [{type:'double'}?, {to, ticket}, ...]. */
  function fugitiveTurn(game, ctx, rng = Math.random) {
    const g = E.clone(game);
    const { adj } = ctx;
    const danger = (v) => Math.min(...g.detectives.map((d) => dd(ctx, maskOf(d.tickets), d.pos, v)));
    const scoreMove = (m) => {
      let exits = 0;
      for (const t of E.TRANSPORTS) for (const w of adj[m.to][t]) if (danger(w) >= 2) exits++;
      return 10 * Math.min(danger(m.to), 4) + exits + rng() * 0.5;
    };
    const best = (moves) => {
      let top = null, topScore = -Infinity;
      for (const m of moves) { const s = scoreMove(m); if (s > topScore) { top = m; topScore = s; } }
      return top;
    };
    const out = [];
    let m = best(E.fugitiveMoves(g, adj));
    if (danger(m.to) <= 1 && E.canUseDouble(g)) {
      E.useDouble(g);
      out.push({ type: 'double' });
    }
    for (;;) {
      const moves = E.fugitiveMoves(g, adj);
      if (!moves.length) break;
      m = best(moves);
      const afterReveal = E.REVEAL_ROUNDS.includes(g.round);
      const t = afterReveal && m.tickets.includes('secret') ? 'secret' : richestTicket(g.fugitive.tickets, m.tickets);
      E.moveFugitive(g, adj, m.to, t);
      out.push({ to: m.to, ticket: t });
      if (g.winner || g.double !== 'second') break;
    }
    return out;
  }

  /** The current detective's move {to, ticket}, from public information only. */
  function detectiveMove(game, ctx, rng = Math.random) {
    const g = game;
    const { adj, map } = ctx;
    const d = g.detectives[g.current];
    const cands = E.possibleLocations(g, adj, map);
    const candSet = new Set(cands);
    const others = g.detectives.filter((_, j) => j !== g.current).map((x) => x.pos);
    let best = null;
    let bestScore = Infinity;
    for (const m of E.detectiveMoves(g, adj, g.current)) {
      const t = richestTicket(d.tickets, m.tickets);
      const mask = maskOf({ ...d.tickets, [t]: d.tickets[t] - 1 });
      let score;
      if (candSet.has(m.to)) score = -1000;
      else if (cands.length) {
        let mn = INF, sum = 0;
        for (const c of cands) { const x = dd(ctx, mask, m.to, c); mn = Math.min(mn, x); sum += Math.min(x, 12); }
        score = 3 * mn + sum / cands.length;
      } else score = 0;
      for (const o of others) if (dd(ctx, 7, m.to, o) <= 1) score += 0.75; // spread out
      score += rng() * 0.1;
      if (score < bestScore) { bestScore = score; best = { to: m.to, ticket: t }; }
    }
    return best;
  }

  return { context, fugitiveTurn, detectiveMove };
});
