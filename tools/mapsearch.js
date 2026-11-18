/*
 * Searches generator seeds + settings for the map whose graph statistics best match a
 * reference board (Scotland Yard), using tools/mapstats.js.
 *
 *   node tools/mapsearch.js --sy <dir> [trials] [--layout key] [--write file.js] [--out results.json]
 *
 *   --layout key   keep a hand-made layout from tools/layouts.js fixed (river, parks, districts)
 *                  and search only seeds and the remaining settings
 *   --write file   write the best map (passing the standard, if any does) to file.js
 *
 * Phase 1 samples random settings and seeds; phase 2 perturbs the best few. Prints the top
 * candidates with their stats and the command that regenerates each. Nothing in js/ is written.
 */
'use strict';
const fs = require('fs');
const { generate, writeMap, DEFAULTS } = require('./genmap.js');
const LAYOUTS = require('./layouts.js');
const { computeStats, loadTextMap } = require('./mapstats.js');

const args = process.argv.slice(2);
const syDir = args[args.indexOf('--sy') + 1];
if (!args.includes('--sy') || !syDir) {
  console.error('usage: node tools/mapsearch.js --sy <scotland-yard-data dir> [trials] [--out file]');
  process.exit(1);
}
const TRIALS = Number(args.find((a) => /^\d+$/.test(a))) || 1500;
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const OUT = opt('--out');
const WRITE = opt('--write');
const LAYOUT = opt('--layout');
if (LAYOUT && !LAYOUTS[LAYOUT]) { console.error(`unknown layout ${LAYOUT}`); process.exit(1); }
const target = computeStats(loadTextMap(syDir));

// stat -> [weight, tolerance]. Error per stat is weight * ((value - target) / tolerance)^2.
const WEIGHTS = {
  avgDist: [3, 0.1],
  diameter: [1, 1],
  radius: [0.5, 1],
  avgDistCab: [2, 0.4],
  avgDistCabTram: [2, 0.3],
  avgDegree: [1, 0.1],
  deg2: [2, 0.02],
  deg3: [1, 0.03],
  deg4: [1, 0.03],
  deg56: [1, 0.03],
  deg7p: [1, 0.03],
  clustering: [2, 0.03],
  maxBetweenness: [1, 0.03],
  reach2: [1, 1],
  reach3: [1, 3],
  reach4: [1, 5],
  candCab3: [1, 1],
  candCab5: [2, 3],
  candTram: [0.5, 0.2],
  candCabTram: [1, 0.3],
  candSecret2: [1, 1],
  tramStops: [0.5, 3],
  tramLinks: [1, 5],
  metroStops: [0.5, 1],
  metroLinks: [0.5, 2],
  avgDistToMetro: [0.5, 0.1],
  startGap: [2, 0.2],
  startGap2: [1, 0.07],
  startCover2: [0.5, 0.03],
};
// The standard a map must meet to count as "Scotland Yard-like": stat -> [min, max].
// Bands are offsets from the reference value; clustering is capped rather than matched,
// because evenly spaced street networks can't get down to the reference value (see README).
const t = target;
const STANDARD = {
  cutVertices: [0, 0],
  avgDegree: [t.avgDegree - 0.15, t.avgDegree + 0.15],
  deg2: [0.04, 0.12],
  diameter: [t.diameter - 1, t.diameter + 1],
  avgDist: [t.avgDist - 0.15, t.avgDist + 0.15],
  avgDistCab: [t.avgDistCab - 0.7, t.avgDistCab + 0.7],
  avgDistCabTram: [t.avgDistCabTram - 0.5, t.avgDistCabTram + 0.5],
  maxBetweenness: [0, 0.28],
  clustering: [0, 0.3],
  reach3: [t.reach3 - 4, t.reach3 + 4],
  candCab3: [t.candCab3 - 1.5, t.candCab3 + 1.5],
  candCab5: [t.candCab5 - 4, t.candCab5 + 4],
  candCabTram: [t.candCabTram - 0.4, t.candCabTram + 0.4],
  candSecret2: [t.candSecret2 - 1.5, t.candSecret2 + 1.5],
  tramLinks: [t.tramLinks - 10, t.tramLinks + 10],
  metroStops: [12, 16],
  startGap: [t.startGap - 0.25, t.startGap + 0.25],
  startGap2: [0.25, 1],
};
const misses = (st) => Object.entries(STANDARD).filter(([k, [lo, hi]]) => !(st[k] >= lo - 1e-9 && st[k] <= hi + 1e-9)).map(([k]) => k);

function score(st) {
  let s = 100 * st.cutVertices; // hard requirement: no trap pockets
  const parts = {};
  for (const [k, [w, tol]] of Object.entries(WEIGHTS)) {
    parts[k] = w * ((st[k] - target[k]) / tol) ** 2;
    s += parts[k];
  }
  return { total: s, parts };
}

let seed = 12345;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const uni = (a, b) => a + rng() * (b - a);
const int = (a, b) => Math.floor(uni(a, b + 1));
const RANGES = {
  density: () => (rng() < 0.15 ? 0 : +uni(0.3, 1.4).toFixed(2)),
  districtCount: () => int(2, 7),
  streetBeta: () => (rng() < 0.25 ? 1 : +uni(1, 1.8).toFixed(2)),
  fillTarget: () => (rng() < 0.5 ? 0 : +uni(3.2, 4).toFixed(2)),
  cabTarget: () => +uni(3.2, 3.7).toFixed(2),
  maxDeg2: () => int(8, 40),
  pruneLengthBias: () => +uni(0, 1.2).toFixed(2),
  triWeight: () => +uni(0, 4).toFixed(2),
  biconnected: () => true,
  tramMinStops: () => int(55, 64),
  tramHops: () => int(4, 7),
  tramMinHops: () => int(1, 3),
  tramStretch: () => +uni(1.4, 2.2).toFixed(2),
  tramTarget: () => +uni(2.8, 4).toFixed(2),
  tramDegCap: () => int(4, 6),
  tramShareStops: () => rng() < 0.5,
  metroTarget: () => +uni(2.8, 3.6).toFixed(2),
  startSpread: () => int(120, 380),
  bridges: () => int(5, 9),
};
// a hand-made layout fixes its own placement settings
const FIXED = LAYOUT ? ['river', 'parks', 'districts', 'density', 'districtCount'] : [];
const randomOpts = () => {
  const o = { seed: int(1, 100000) };
  for (const [k, f] of Object.entries(RANGES)) if (!FIXED.includes(k)) o[k] = f();
  o.layout = LAYOUT || null; // without --layout, search the free (non-hand-made) generator
  return o;
};
const perturb = (o) => {
  const p = { ...o };
  const keys = Object.keys(RANGES).filter((k) => !FIXED.includes(k));
  for (let i = 0; i < 3; i++) {
    const k = keys[int(0, keys.length - 1)];
    p[k] = RANGES[k]();
  }
  if (rng() < 0.5) p.seed = int(1, 100000);
  return p;
};

function evaluate(opts) {
  try {
    const { data } = generate({ ...opts, detail: false }); // decor is visual only; skip it while scoring
    const st = computeStats(data);
    return { opts, st, data, miss: misses(st), ...score(st) };
  } catch (e) {
    failReasons[e.message] = (failReasons[e.message] || 0) + 1;
    return null;
  }
}

const failReasons = {};
const results = [];
let fails = 0;
const t0 = Date.now();
const log = (i, n, phase) => {
  if (i % 100 === 0) {
    const best = results.length ? Math.min(...results.map((r) => r.total)).toFixed(1) : '-';
    console.error(`${phase} ${i}/${n}  best ${best}  failed ${fails}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
};
const baseline = evaluate({ ...DEFAULTS });
const better = (a, b) => (b.miss.length === 0 ? 1 : 0) - (a.miss.length === 0 ? 1 : 0) || a.total - b.total;
for (let i = 0; i < TRIALS; i++) {
  const r = evaluate(randomOpts());
  r ? results.push(r) : fails++;
  log(i + 1, TRIALS, 'random');
}
const REFINE = Math.round(TRIALS / 2);
for (let i = 0; i < REFINE; i++) {
  results.sort(better);
  const parent = results[int(0, Math.min(7, results.length - 1))];
  const r = evaluate(perturb(parent.opts));
  r ? results.push(r) : fails++;
  log(i + 1, REFINE, 'refine');
}
results.sort(better);
// different settings can produce the same map; keep one of each
const seen = new Set();
const unique = results.filter((r) => { const k = JSON.stringify(r.st); if (seen.has(k)) return false; seen.add(k); return true; });

const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v));
console.log(`\n${results.length} maps scored, ${fails} settings failed to generate. Lower score = closer to Scotland Yard.`);
console.log('failures:', failReasons);
console.log(`current defaults (seed ${DEFAULTS.seed}): score ${baseline.total.toFixed(1)}\n`);
const top = unique.slice(0, 5);
console.log('stat'.padEnd(16) + 'target'.padStart(9) + 'current'.padStart(9) + top.map((_, i) => `#${i + 1}`.padStart(9)).join(''));
console.log('misses'.padEnd(16) + '0'.padStart(9) + String(baseline.miss.length).padStart(9) + top.map((r) => String(r.miss.length).padStart(9)).join(''));
console.log('score'.padEnd(16) + '0'.padStart(9) + baseline.total.toFixed(1).padStart(9) + top.map((r) => r.total.toFixed(1).padStart(9)).join(''));
for (const k of Object.keys(target)) {
  console.log(k.padEnd(16) + fmt(target[k]).padStart(9) + fmt(baseline.st[k]).padStart(9) + top.map((r) => fmt(r.st[k]).padStart(9)).join(''));
}
console.log();
console.log(`maps meeting the standard: ${unique.filter((r) => !r.miss.length).length} of ${unique.length}`);
top.forEach((r, i) => r.miss.length && console.log(`#${i + 1} misses: ${r.miss.join(', ')}`));
top.forEach((r, i) => console.log(`#${i + 1}: node tools/genmap.js ${Object.entries(r.opts).map(([k, v]) => (k === 'seed' ? v : `${k}=${v}`)).join(' ')}`));
if (WRITE) {
  writeMap(generate(unique[0].opts).data, WRITE);
  console.log(`wrote #1 to ${WRITE}${unique[0].miss.length ? ' (does NOT meet the standard)' : ''}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(unique.slice(0, 50).map(({ opts, st, total, parts }) => ({ opts, total, st, parts })), null, 1));
