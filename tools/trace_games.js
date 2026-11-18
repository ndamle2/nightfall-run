/*
 * Records random games played through the JS rules engine, for the Python port's parity
 * test (ai/tests/test_engine_parity.py). Every decision point stores the full state, the
 * legal moves and the action taken.
 *
 *   node tools/trace_games.js [gamesPerConfig] [out.json]
 */
'use strict';
const fs = require('fs');
const E = require('../js/engine.js');
const { loadMaps } = require('./genmap.js');

const GAMES = Number(process.argv[2]) || 20;
const OUT = process.argv[3] || null;

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

function snapshot(g, adj, map) {
  return {
    phase: g.phase,
    round: g.round,
    current: g.current,
    double: g.double,
    winner: g.winner,
    reason: g.reason,
    fpos: g.fugitive.pos,
    ftk: { ...g.fugitive.tickets },
    dpos: g.detectives.map((d) => d.pos),
    dtk: g.detectives.map((d) => ({ ...d.tickets })),
    cands: E.possibleLocations(g, adj, map),
  };
}

const traces = [];
for (const { key, data: map } of loadMaps()) {
  const adj = E.buildAdjacency(map);
  for (const nDet of [1, 3, 4, 5]) {
    const rng = makeRng(777 + nDet * 31 + key.length);
    for (let gi = 0; gi < GAMES; gi++) {
      const g = E.createGame(map, adj, {
        detectives: Array.from({ length: nDet }, (_, i) => ({ name: `D${i + 1}`, color: '#000' })),
        rng,
      });
      // Mix of play styles so that captures, survivals, stuck detectives and doubles all occur:
      // the fugitive sometimes chases danger, detectives sometimes head for the fugitive.
      const greedy = gi % 3;
      const trace = {
        map: key, nDet,
        fugStart: g.fugitive.start,
        detStarts: g.detectives.map((d) => d.start),
        initial: snapshot(g, adj, map),
        steps: [],
      };
      while (!g.winner) {
        const legal = g.phase === 'fugitive' ? E.fugitiveMoves(g, adj) : E.detectiveMoves(g, adj, g.current);
        const canDouble = E.canUseDouble(g);
        let action;
        if (g.phase === 'fugitive') {
          if (canDouble && rng() < 0.15) action = ['double'];
          else {
            const m = pick(legal, rng);
            action = ['f', m.to, pick(m.tickets, rng)];
          }
        } else {
          let m = pick(legal, rng);
          if (greedy && rng() < 0.5) {
            // step toward the fugitive when adjacent, to produce captures
            const hit = legal.find((x) => x.to === g.fugitive.pos);
            if (hit) m = hit;
          }
          action = ['d', m.to, pick(m.tickets, rng)];
        }
        trace.steps.push({ legal, canDouble, action });
        if (action[0] === 'double') E.useDouble(g);
        else if (action[0] === 'f') E.moveFugitive(g, adj, action[1], action[2]);
        else E.moveDetective(g, adj, action[1], action[2]);
        trace.steps[trace.steps.length - 1].after = snapshot(g, adj, map);
      }
      traces.push(trace);
    }
  }
}

const json = JSON.stringify(traces);
if (OUT) fs.writeFileSync(OUT, json);
else process.stdout.write(json);
