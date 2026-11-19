/*
 * Bot-vs-bot games with the browser's computer players (js/ai/): alpha-beta fugitive vs
 * ISMCTS detectives, to check their strength against the Python arena (python3 -m ai.arena).
 *
 *   node tools/arena.js [--maps twin,harbour] [--dets 3,4,5] [--games 48] [--workers 12]
 *                       [--seed 0] [--json out.json]
 *
 * Start stations are dealt by game seed (seed + 1000·k + i), not the Python deal, so the
 * games differ from the Python arena's; compare win rates, not single games.
 */
'use strict';
const os = require('os');
const { fork } = require('child_process');
const fs = require('fs');

function playGame(key, k, seed) {
  const C = require('../js/ai/core.js');
  const AB = require('../js/ai/alphabeta.js');
  const IS = require('../js/ai/ismcts.js');
  const WEIGHTS = require('../js/ai/weights.js');
  const map = require(`../js/maps/${key}.js`);
  const T = C.tables(map);
  const rng = C.makeRng(seed);
  const pool = T.starts.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const s = C.newGame(T, k, pool[k], pool.slice(0, k));
  const fug = new AB.AlphaBetaFugitive({ seed: seed * 2 + 1 });
  const det = new IS.ISMCTSDetectives({ seed: seed * 2 + 2, valueWeights: WEIGHTS.value, moveWeights: WEIGHTS.move });
  let tf = 0, td = 0, nf = 0, nd = 0;
  while (s.phase !== C.OVER) {
    const t0 = Date.now();
    if (s.phase === C.FUG) { C.applyTurn(T, s, fug.chooseTurn(T, C.clone(s))); tf += Date.now() - t0; nf++; }
    else { const [to, t] = det.chooseMove(T, C.publicView(s)); C.moveDetective(T, s, to, t); td += Date.now() - t0; nd++; }
  }
  return { map: key, k, seed, winner: s.winner, round: s.round, tf: tf / nf, td: td / nd };
}

if (process.argv[2] === '--child') {
  process.on('message', (job) => {
    if (job === null) process.exit(0);
    process.send(playGame(job.map, job.k, job.seed));
  });
} else {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const maps = arg('maps', 'twin,harbour,quarter,market,hill').split(',');
  const dets = arg('dets', '3,4,5').split(',').map(Number);
  const games = Number(arg('games', 48));
  const workers = Number(arg('workers', Math.max(1, os.cpus().length - 2)));
  const seed = Number(arg('seed', 0));
  const out = arg('json', null);
  const jobs = [];
  for (const k of dets) for (const m of maps) for (let i = 0; i < games; i++) jobs.push({ map: m, k, seed: seed + 1000 * k + i });
  const results = [];
  const t0 = Date.now();
  let next = 0;
  const report = () => {
    console.log(`\n${results.length} games in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log('map        dets  games  detectives win      ms/fug turn  ms/det move');
    const row = (label, k, rs) => {
      const p = rs.filter((r) => r.winner === 2).length / rs.length;
      const ci = 196 * Math.sqrt(p * (1 - p) / rs.length);
      const avg = (f) => (rs.reduce((a, r) => a + r[f], 0) / rs.length).toFixed(0);
      console.log(`${label.padEnd(10)} ${String(k).padStart(4)}  ${String(rs.length).padStart(5)}  ${(100 * p).toFixed(1).padStart(6)}% ±${ci.toFixed(1).padEnd(5)}   ${avg('tf').padStart(10)}  ${avg('td').padStart(11)}`);
    };
    for (const k of dets) {
      for (const m of maps) row(m, k, results.filter((r) => r.k === k && r.map === m));
      row('all', k, results.filter((r) => r.k === k));
    }
    if (out) fs.writeFileSync(out, JSON.stringify(results));
  };
  let live = 0;
  for (let w = 0; w < Math.min(workers, jobs.length); w++) {
    const child = fork(__filename, ['--child']);
    live++;
    const feed = () => child.send(next < jobs.length ? jobs[next++] : null);
    child.on('message', (r) => {
      results.push(r);
      if (results.length % 50 === 0) console.log(`${results.length}/${jobs.length}`);
      feed();
    });
    child.on('exit', () => { if (--live === 0) report(); });
    feed();
  }
}
