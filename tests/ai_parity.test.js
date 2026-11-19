/*
 * The JavaScript computer players (js/ai/) against the Python ones (ai/): the same
 * positions must give the same answers. Positions and Python answers come from
 * tests/fixtures/ai_parity.json (python3 tools/ai_parity_fixture.py).
 *
 *   node tests/ai_parity.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../js/ai/core.js');
const AB = require('../js/ai/alphabeta.js');
const IS = require('../js/ai/ismcts.js');
const WEIGHTS = require('../js/ai/weights.js');
const { loadMaps } = require('../tools/genmap.js');

const MAPS = Object.fromEntries(loadMaps().map((m) => [m.key, m.data]));
const games = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ai_parity.json'), 'utf8'));

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

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const W = C.valueWeights(WEIGHTS.value);

test('weights.js matches the Python weight files', () => {
  for (const [name, file] of [['value', 'value_weights.json'], ['move', 'move_weights.json']]) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai', file), 'utf8'));
    assert.deepStrictEqual(WEIGHTS[name].features, d.features, `${name} features (rerun tools/export_ai_weights.py)`);
    assert.deepStrictEqual(WEIGHTS[name].weights, d.weights, `${name} weights (rerun tools/export_ai_weights.py)`);
  }
});

const counts = { value: 0, playout: 0, ranked: 0, ab: 0, abTurn: 0, belief: 0, scores: 0 };
for (const { record, checks } of games) {
  test(`${record.id}: same rules, values, models and searches as Python (${checks.length} positions)`, () => {
    const T = C.tables(MAPS[record.map]);
    const id = (v) => T.ids[v];
    const watcher = new IS.ISMCTSDetectives({ iterations: 8, seed: 0, valueWeights: WEIGHTS.value, moveWeights: WEIGHTS.move });
    const ab = new AB.AlphaBetaFugitive({ seed: 1 });
    const end = C.replay(T, record);
    assert.strictEqual(end.round, record.result.round);
    assert.strictEqual(end.winner, record.result.winner === 'detectives' ? C.DET_WIN : C.FUG_WIN);
    for (const c of checks) {
      const s = C.replay(T, record, c.upto);
      const at = `${record.id} @${c.upto}`;
      assert.deepStrictEqual(Array.from(C.danger(T, s, new Uint8Array(T.n))), c.danger, `${at} danger`);
      near(C.value(T, s, W), c.value, 1e-9, `${at} value`); counts.value++;
      // playouts with noise 0 are deterministic
      near(C.playoutValue(T, s, 2, W, () => 0, C.makeScratch(T), 0, 0), c.playout, 1e-9, `${at} playout`); counts.playout++;
      if (s.phase === C.FUG) {
        assert.deepStrictEqual(C.fugitiveActions(T, s).map(([v, t]) => [id(v), t]), c.actions, `${at} fugitive actions`);
        const ranked = C.rankedTurns(T, s).map((turn) => turn.map((a) => (a === 'double' ? a : [id(a[0]), C.TICKET_NAMES[a[1]]])));
        assert.deepStrictEqual(ranked, c.ranked, `${at} ranked turns`); counts.ranked++;
        const turn = ab.chooseTurn(T, C.clone(s));
        const js = (t) => JSON.stringify(t.map((a) => (a === 'double' ? a : [id(a[0]), C.TICKET_NAMES[a[1]]])));
        const mine = new Map(ab.last.rankings[0].map(([t, v]) => [js(t), v]));
        assert.strictEqual(mine.size, c.ab_depth1.length, `${at} alpha-beta options`);
        for (const [t, v] of c.ab_depth1) {
          const k = JSON.stringify(t);
          assert.ok(mine.has(k), `${at} option ${k} missing`);
          near(mine.get(k), v, 2.1e-3, `${at} depth-1 score of ${k}`); // both include a random tie-break < 1e-3
        }
        // deeper searches look at the root_keep best depth-1 options; exact ties there are
        // broken by the random jitter, so now and then the two keep different options
        counts.ab++;
        if (Math.abs(ab.last.value - c.ab_value) > 2.1e-3) counts.abValueDiff = (counts.abValueDiff || 0) + 1;
        if (js(turn) === JSON.stringify(c.ab_turn)) counts.abTurn++;
      } else {
        assert.deepStrictEqual(C.detectiveActions(T, s).map(([v, t]) => [id(v), t]), c.det_actions, `${at} detective actions`);
        const { tos, tks, scores } = C.detScores(T, s, 0.3, 3);
        assert.deepStrictEqual(tos.map((v, j) => [id(v), tks[j]]), c.det_scores.map(([v, t]) => [v, t]), `${at} prior moves`);
        scores.forEach((x, j) => near(x, c.det_scores[j][2], 1e-9, `${at} prior score`)); counts.scores++;
        const mass = watcher.beliefMass(T, C.publicView(s));
        for (let v = 0; v < T.n; v++) near(mass[v], c.belief[id(v)] || 0, 2e-5, `${at} belief at ${id(v)}`);
        watcher.lastPosterior.forEach((p, k) => near(p, c.posterior[k], 2e-4, `${at} model posterior`));
        counts.belief++;
      }
    }
  });
}

test('alpha-beta finds the same best value as Python almost always', () => {
  assert.ok((counts.abValueDiff || 0) <= 0.03 * counts.ab, `${counts.abValueDiff} of ${counts.ab} differ`);
});

test('ISMCTS plays legal moves and keeps its tree across a game', () => {
  const { record } = games[0];
  const T = C.tables(MAPS[record.map]);
  const bot = new IS.ISMCTSDetectives({ iterations: 256, seed: 3, valueWeights: WEIGHTS.value, moveWeights: WEIGHTS.move });
  let reusedOnce = false;
  for (let upto = 0; upto < record.history.length; upto++) {
    if (record.history[upto].side !== 'D') continue;
    const s = C.replay(T, record, upto);
    const [to, t] = bot.chooseMove(T, C.publicView(s));
    assert.ok(C.detectiveActions(T, s).some(([v, x]) => v === to && x === t), 'legal');
    if (bot.last.reused > 0) reusedOnce = true;
  }
  assert.ok(reusedOnce, 'reused a subtree at least once');
});

console.log(`\n${passed} passed; compared ${JSON.stringify(counts)}`);
