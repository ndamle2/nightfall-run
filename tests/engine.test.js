/* Rules-engine tests.  Run: node tests/engine.test.js */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const { loadMaps } = require('../tools/genmap.js');
const MAPS = loadMaps();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    console.error('  ✗', name);
    console.error(err);
    process.exitCode = 1;
  }
}

// A tiny hand-made map:
//   1 -cab- 2 -cab- 3 -cab- 4 -cab- 5 -cab- 6
//   1 =tram= 3 =tram= 5,   2 ~metro~ 6,   4 ~ferry~ 6,  plus cab 6-7, 7-8
const tiny = {
  stations: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, x: id * 10, y: 0 })),
  edges: [
    ...[[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]].map(([a, b]) => ({ a, b, type: 'cab' })),
    { a: 1, b: 3, type: 'tram' },
    { a: 3, b: 5, type: 'tram' },
    { a: 2, b: 6, type: 'metro' },
    { a: 4, b: 6, type: 'ferry' },
  ],
  starts: [1, 4, 8],
};
const tinyAdj = E.buildAdjacency(tiny);

function tinyGame(fpos, dets) {
  const g = E.createGame(tiny, tinyAdj, {
    fugitiveName: 'F',
    detectives: dets.map((p, i) => ({ name: `D${i + 1}`, color: '#000' })),
    rng: () => 0.5,
  });
  g.fugitive.pos = g.fugitive.start = fpos;
  dets.forEach((p, i) => (g.detectives[i].pos = g.detectives[i].start = p));
  return g;
}
const tos = (moves) => moves.map((m) => m.to);

console.log('Rules engine');

test('starting tickets follow the rules', () => {
  const g = tinyGame(4, [1, 8]);
  assert.deepStrictEqual(g.detectives[0].tickets, { cab: 10, tram: 8, metro: 4 });
  assert.deepStrictEqual(g.fugitive.tickets, { cab: 4, tram: 3, metro: 3, secret: 2, double: 2 });
});

test('fugitive cannot move onto a detective; ferry needs a secret ticket', () => {
  const g = tinyGame(4, [3, 8]);
  const m = E.fugitiveMoves(g, tinyAdj);
  assert.deepStrictEqual(tos(m), [5, 6]);
  assert.deepStrictEqual(m.find((x) => x.to === 6).tickets, ['secret']);
  assert.deepStrictEqual(m.find((x) => x.to === 5).tickets, ['cab', 'secret']);
});

test('detectives cannot share a station but may land on the fugitive', () => {
  const g = tinyGame(4, [3, 5]);
  E.moveFugitive(g, tinyAdj, 6, 'secret'); // via ferry; 3 and 5 are blocked anyway
  assert.strictEqual(g.phase, 'detectives');
  assert.strictEqual(g.current, 0);
  const m = tos(E.detectiveMoves(g, tinyAdj, 0)); // D1 at 3: cab 2,4  tram 1,5(blocked)
  assert.deepStrictEqual(m, [1, 2, 4]);
  const m2 = tos(E.detectiveMoves(g, tinyAdj, 1)); // D2 at 5: cab 4,6  tram 3(blocked)
  assert.deepStrictEqual(m2, [4, 6]);
});

test('detective tickets are handed to the fugitive', () => {
  const g = tinyGame(1, [4, 8]);
  E.moveFugitive(g, tinyAdj, 2, 'cab');
  const before = g.fugitive.tickets.tram;
  E.moveDetective(g, tinyAdj, 5, 'cab');
  assert.strictEqual(g.detectives[0].tickets.cab, 9);
  assert.strictEqual(g.fugitive.tickets.cab, 4); // 4 - 1 used + 1 received
  E.moveDetective(g, tinyAdj, 7, 'cab');
  assert.strictEqual(g.fugitive.tickets.cab, 5);
  assert.strictEqual(g.fugitive.tickets.tram, before);
});

test('capture ends the game for the detectives', () => {
  const g = tinyGame(1, [4, 8]);
  E.moveFugitive(g, tinyAdj, 2, 'cab');
  E.moveDetective(g, tinyAdj, 3, 'cab');
  E.moveDetective(g, tinyAdj, 7, 'cab');
  E.moveFugitive(g, tinyAdj, 6, 'metro');
  E.moveDetective(g, tinyAdj, 4, 'cab');
  E.moveDetective(g, tinyAdj, 6, 'cab');
  assert.strictEqual(g.winner, 'detectives');
  assert.strictEqual(g.phase, 'over');
});

test('reveal flags are set on moves 3, 8, 13, 18, 24', () => {
  const g = tinyGame(1, [7]);
  let ping = true;
  while (!g.winner && g.round < 24) {
    if (g.phase === 'fugitive') {
      E.moveFugitive(g, tinyAdj, ping ? 2 : 1, 'secret' in g.fugitive.tickets && g.fugitive.tickets.cab > 0 ? 'cab' : 'secret');
      ping = !ping;
    } else {
      const d = g.detectives[0];
      E.moveDetective(g, tinyAdj, d.pos === 7 ? 8 : 7, 'cab');
    }
  }
  const reveals = g.log.filter((e) => e.reveal).map((e) => e.round);
  assert.deepStrictEqual(reveals, [3, 8, 13, 18].filter((r) => r <= g.round).concat(g.round === 24 ? [24] : []));
});

test('double move: two log slots, one detective turn, not allowed in last two moves', () => {
  const g = tinyGame(1, [8]);
  assert.ok(E.canUseDouble(g));
  E.useDouble(g);
  assert.strictEqual(g.fugitive.tickets.double, 1);
  E.moveFugitive(g, tinyAdj, 2, 'cab');
  assert.strictEqual(g.phase, 'fugitive');
  assert.strictEqual(g.double, 'second');
  assert.ok(!E.canUseDouble(g));
  E.moveFugitive(g, tinyAdj, 3, 'cab');
  assert.strictEqual(g.phase, 'detectives');
  assert.strictEqual(g.round, 2);
  assert.ok(g.log.every((e) => e.double));
  // double move across reveal round 3 marks the 3rd slot as reveal
  E.moveDetective(g, tinyAdj, 7, 'cab');
  E.useDouble(g);
  E.moveFugitive(g, tinyAdj, 4, 'cab');
  assert.strictEqual(g.log[2].reveal, true);
  // round limit
  const h = tinyGame(1, [8]);
  h.round = 23;
  assert.ok(!E.canUseDouble(h));
  h.round = 22;
  assert.ok(E.canUseDouble(h));
});

test('detective with no tickets for any line sits out', () => {
  const g = tinyGame(1, [4, 8]);
  g.detectives[0].tickets = { cab: 0, tram: 0, metro: 0 };
  E.moveFugitive(g, tinyAdj, 2, 'cab');
  assert.strictEqual(g.current, 1);
  assert.ok(g.events.some((e) => /D1 has no legal move/.test(e.text)));
});

test('fugitive wins when no detective can move', () => {
  const g = tinyGame(1, [4, 8]);
  g.detectives.forEach((d) => (d.tickets = { cab: 0, tram: 0, metro: 0 }));
  E.moveFugitive(g, tinyAdj, 2, 'cab');
  assert.strictEqual(g.winner, 'fugitive');
});

test('detectives win when the fugitive is boxed in', () => {
  const g = tinyGame(1, [5, 8]);
  E.moveFugitive(g, tinyAdj, 2, 'cab');
  E.moveDetective(g, tinyAdj, 3, 'tram');
  // fugitive at 2: neighbours 1, 3 (blocked), 6 by metro. Put D2 on 6.
  E.moveDetective(g, tinyAdj, 7, 'cab');
  assert.strictEqual(g.phase, 'fugitive');
  g.fugitive.tickets.cab = 0; // force: only metro to 6, and secret
  g.fugitive.tickets.secret = 0;
  g.detectives[1].pos = 6;
  assert.deepStrictEqual(tos(E.fugitiveMoves(g, tinyAdj)), []);
});

test('fugitive wins after surviving 24 moves', () => {
  const g = tinyGame(1, [7]);
  g.fugitive.tickets.cab = 99;
  for (let i = 0; i < 24; i++) {
    E.moveFugitive(g, tinyAdj, g.fugitive.pos === 1 ? 2 : 1, 'cab');
    if (g.winner) break;
    g.detectives[0].tickets.cab = 99;
    E.moveDetective(g, tinyAdj, g.detectives[0].pos === 7 ? 8 : 7, 'cab');
  }
  assert.strictEqual(g.winner, 'fugitive');
  assert.strictEqual(g.round, 24);
});

test('illegal moves are rejected', () => {
  const g = tinyGame(1, [8]);
  assert.throws(() => E.moveFugitive(g, tinyAdj, 5, 'cab'));
  assert.throws(() => E.moveFugitive(g, tinyAdj, 2, 'tram'));
  assert.throws(() => E.moveDetective(g, tinyAdj, 7, 'cab'));
});

test('possible locations use only public information', () => {
  const g = tinyGame(1, [8]);
  g.detectives[0].start = 8;
  // candidates before any move: starts minus detective starts
  assert.deepStrictEqual(E.possibleLocations(g, tinyAdj, tiny), [1, 4]);
  E.moveFugitive(g, tinyAdj, 3, 'tram');
  // from 1 by tram -> 3 ; from 4 by tram -> nothing
  assert.deepStrictEqual(E.possibleLocations(g, tinyAdj, tiny), [3]);
});

test('every map in js/maps is listed in index.html', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(MAPS.length >= 1);
  for (const { key } of MAPS) assert.ok(html.includes(`js/maps/${key}.js`), `index.html does not load js/maps/${key}.js`);
});

for (const { key, data: MAP } of MAPS) {
  console.log(`Map: ${MAP.name} (${key})`);
  const ADJ = E.buildAdjacency(MAP);

  test('map has 199 stations, connected, nested networks', () => {
    assert.strictEqual(MAP.stations.length, 199);
    const ids = MAP.stations.map((s) => s.id);
    const seen = new Set([ids[0]]);
    const stack = [ids[0]];
    while (stack.length) {
      const u = stack.pop();
      for (const v of ADJ[u].cab) if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
    assert.strictEqual(seen.size, 199, 'cab network should connect every station');
    for (const id of ids) {
      assert.ok(ADJ[id].cab.length >= 2, `station ${id} needs at least two cab links`);
      if (ADJ[id].metro.length) assert.ok(ADJ[id].tram.length, `metro hub ${id} should also be a tram stop`);
    }
  });

  test('tram/metro links follow streets and never skip a stop of their own kind', () => {
    const k = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const streets = new Set(MAP.edges.filter((e) => e.type === 'cab').map((e) => k(e.a, e.b)));
    const stops = { tram: new Set(), metro: new Set() };
    for (const e of MAP.edges) if (stops[e.type]) { stops[e.type].add(e.a); stops[e.type].add(e.b); }
    const used = { tram: new Set(), metro: new Set() };
    for (const e of MAP.edges) {
      if (!stops[e.type]) continue;
      const p = e.path;
      assert.ok((p[0] === e.a && p[p.length - 1] === e.b) || (p[0] === e.b && p[p.length - 1] === e.a));
      for (let i = 0; i + 1 < p.length; i++) {
        const sk = k(p[i], p[i + 1]);
        assert.ok(streets.has(sk), `${e.type} ${e.a}-${e.b} leaves the streets at ${sk}`);
        assert.ok(!used[e.type].has(sk), `two ${e.type} lines share street ${sk}`);
        used[e.type].add(sk);
      }
      for (const mid of p.slice(1, -1)) assert.ok(!stops[e.type].has(mid), `${e.type} ${e.a}-${e.b} passes stop ${mid}`);
    }
    for (const s of stops.metro) assert.ok(stops.tram.has(s), `metro hub ${s} is not a tram stop`);
  });

  test('street shapes join their stations, never cross, and keep clear of other stations', () => {
    const st = new Map(MAP.stations.map((s) => [s.id, s]));
    const cabs = MAP.edges.filter((e) => e.type === 'cab');
    const cross = (p1, p2, p3, p4) => {
      const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
      if (Math.abs(d) < 1e-9) return false;
      const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
      const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    };
    const segDist = ([px, py], [ax, ay], [bx, by]) => {
      const vx = bx - ax, vy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    };
    for (const e of cabs) {
      if (!e.curve) continue;
      const [f, l] = [e.curve[0], e.curve[e.curve.length - 1]];
      assert.ok(Math.hypot(f[0] - st.get(e.a).x, f[1] - st.get(e.a).y) < 0.5, `street ${e.a}-${e.b} does not start at ${e.a}`);
      assert.ok(Math.hypot(l[0] - st.get(e.b).x, l[1] - st.get(e.b).y) < 0.5, `street ${e.a}-${e.b} does not end at ${e.b}`);
      for (const s of MAP.stations) {
        if (s.id === e.a || s.id === e.b) continue;
        for (let i = 0; i + 1 < e.curve.length; i++) {
          assert.ok(segDist([s.x, s.y], e.curve[i], e.curve[i + 1]) >= 25, `street ${e.a}-${e.b} runs over station ${s.id}`);
        }
      }
    }
    for (let i = 0; i < cabs.length; i++) {
      for (let j = i + 1; j < cabs.length; j++) {
        const p = cabs[i].curve, q = cabs[j].curve;
        if (!p || !q) continue;
        for (let a = 0; a + 1 < p.length; a++) for (let b = 0; b + 1 < q.length; b++) {
          assert.ok(!cross(p[a], p[a + 1], q[b], q[b + 1]), `streets ${cabs[i].a}-${cabs[i].b} and ${cabs[j].a}-${cabs[j].b} cross`);
        }
      }
    }
  });

  test('random full games never break an invariant', () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tally = { fugitive: 0, detectives: 0 };
    for (let n = 0; n < 300; n++) {
      const g = E.createGame(MAP, ADJ, {
        detectives: [1, 2, 3, 4, 5].slice(0, 2 + (n % 4)).map((i) => ({ name: `D${i}`, color: '#000' })),
        rng,
      });
      let steps = 0;
      while (!g.winner) {
        if (++steps > 1000) throw new Error('game did not terminate');
        if (g.phase === 'fugitive') {
          if (E.canUseDouble(g) && rng() < 0.08) E.useDouble(g);
          const ms = E.fugitiveMoves(g, ADJ);
          const m = ms[Math.floor(rng() * ms.length)];
          E.moveFugitive(g, ADJ, m.to, m.tickets[Math.floor(rng() * m.tickets.length)]);
        } else {
          const ms = E.detectiveMoves(g, ADJ, g.current);
          const m = ms[Math.floor(rng() * ms.length)];
          E.moveDetective(g, ADJ, m.to, m.tickets[Math.floor(rng() * m.tickets.length)]);
        }
        const pos = g.detectives.map((d) => d.pos);
        assert.strictEqual(new Set(pos).size, pos.length, 'detectives share a station');
        if (!g.winner) assert.ok(!pos.includes(g.fugitive.pos), 'fugitive on a detective');
        assert.ok(g.log.length <= 24);
        for (const d of g.detectives) for (const t of ['cab', 'tram', 'metro']) assert.ok(d.tickets[t] >= 0);
        for (const t of ['cab', 'tram', 'metro', 'secret', 'double']) assert.ok(g.fugitive.tickets[t] >= 0);
      }
      tally[g.winner]++;
    }
    console.log(`      (random play: fugitive ${tally.fugitive}, detectives ${tally.detectives})`);
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
