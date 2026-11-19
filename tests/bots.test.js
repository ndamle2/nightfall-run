/* In-browser bots (js/bots.js).  Run: node tests/bots.test.js [--dump records.json]
 *
 * Plays the heuristic bots against each other on every map through the real engine, and
 * builds the same game records js/ui.js builds. With --dump, writes the records so the
 * Python side can replay them (ai/tests/test_serve.py does).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const E = require('../js/engine.js');
const Bots = require('../js/bots.js');
const { loadMaps } = require('../tools/genmap.js');
const MAPS = loadMaps();

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** One bot-vs-bot game; returns a game record in the page's format. */
function playRecorded(key, map, n, seed) {
  const adj = E.buildAdjacency(map);
  const ctx = Bots.context(map, adj);
  const rng = makeRng(seed);
  const g = E.createGame(map, adj, {
    detectives: Array.from({ length: n }, (_, i) => ({ name: `D${i + 1}`, color: '#000' })),
    rng,
  });
  const history = [];
  let steps = 0;
  while (!g.winner) {
    assert(++steps < 500, 'game did not end');
    if (g.phase === 'fugitive') {
      const acts = Bots.fugitiveTurn(g, ctx, rng);
      assert(acts.length >= 1);
      for (const a of acts) {
        if (a.type === 'double') E.useDouble(g);
        else E.moveFugitive(g, adj, a.to, a.ticket); // throws if illegal
        history.push({ side: 'F', ...a, by: 'browser', ms: 0 });
      }
      assert(g.winner || g.phase === 'detectives', 'fugitive turn left unfinished');
    } else {
      // the detective bot gets the game with the fugitive's position hidden
      const pub = E.clone(g);
      pub.fugitive.pos = -1;
      pub.fugitive.start = -1;
      const i = g.current;
      const m = Bots.detectiveMove(pub, ctx, rng);
      E.moveDetective(g, adj, m.to, m.ticket);
      history.push({ side: 'D', i, ...m, by: 'browser', ms: 0 });
    }
  }
  return {
    schema: 1, app: 'nightfall-run', id: `test-${key}-${n}-${seed}`,
    mode: seed % 2 ? 'human-fugitive' : 'human-detectives',
    map: key, mapSeed: map.seed, detectives: n,
    fugitiveStart: g.fugitive.start, detectiveStarts: g.detectives.map((d) => d.start),
    history, bots: { engine: 'browser' },
    result: { winner: g.winner, reason: g.reason, round: g.round },
  };
}

const records = [];
const wins = {};
for (const { key, data: map } of MAPS) {
  for (const n of [2, 3, 4, 5]) {
    for (let seed = 1; seed <= 6; seed++) {
      const r = playRecorded(key, map, n, 1000 * n + seed);
      records.push(r);
      wins[n] = (wins[n] || 0) + (r.result.winner === 'detectives');
    }
  }
}
console.log(`  ✓ ${records.length} bot-vs-bot games on ${MAPS.length} maps, all moves legal`);
console.log('    detective wins by count:', JSON.stringify(wins));

const dump = process.argv.indexOf('--dump');
if (dump >= 0) fs.writeFileSync(process.argv[dump + 1], JSON.stringify(records));
