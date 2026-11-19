#!/usr/bin/env node
/*
 * Generates the city maps for Nightfall Run into js/maps/<layout>.js.
 *   node tools/genmap.js                          rebuild every layout in tools/layouts.js
 *   node tools/genmap.js layout=<key> [seed] [setting=value ...]   rebuild one (overrides are for experiments)
 *   node tools/genmap.js layout=none [seed] [...] --out <file>     the free (non-hand-made) generator
 *
 * Structure (transit-map style):
 *   - Cab streets connect neighbouring stations (planar graph).
 *   - Every tram link runs along cab streets, passing through cab-only stations without stopping.
 *   - Every metro link runs along tram links, passing through tram stops without stopping.
 *   - Each street carries at most one tram line and one metro line, so lines draw as clean parallel bundles.
 *   - Parks are open areas no line enters, except one street that cuts across the big park.
 *   - A few river piers are joined by a ferry that only secret tickets can use.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { addCityDetail } = require('./decor.js');

// Tunable settings. The default map is the hand-made `twin` layout (Brackwell) from
// tools/layouts.js, whose own tuned settings override these. With layout=none the settings
// below apply; they were tuned by tools/mapsearch.js for an evenly spread map (Wexmoor, seed 48795).
const DEFAULTS = {
  seed: 48795,
  streetBeta: 1, // street layout: 1 = Gabriel graph (many triangles) ... 2 = relative neighbourhood graph (none)
  density: 0, // >0: stations cluster in districts and thin out between them (try 0.4-1.2)
  minGap: 76, // with density > 0: closest two stations may be (px); pieces and highlights need ~72
  districtCount: 4, // random districts when density > 0 and no hand-placed list
  // Hand-made layouts can also pass: river {y, waves}, parks [{x, y, w, h, big}], districts [{x, y, s, w}]
  fillTarget: 0, // >0: after the skeleton, add triangle-free streets up to this many per station
  cabTarget: 3.56, // average cab streets per station after pruning
  maxDeg2: 22, // most stations allowed to end with only two streets
  pruneLengthBias: 0.32, // how strongly pruning prefers removing long streets (0 = ignore length)
  triWeight: 3.1, // >0 prefers pruning streets that sit in many triangles (fewer tight loops)
  biconnected: true, // never prune a street if it leaves a station whose loss would split the map
  tramMinStops: 55,
  tramHops: 7, // longest tram link, in streets
  tramMinHops: 1, // shortest tram link, in streets (2-street links close a triangle with the street)
  tramStretch: 1.58, // tram link may be at most this much longer than the straight line
  tramTarget: 3.68, // aimed-for links per tram stop
  tramDegCap: 5,
  tramShareStops: true, // allow two tram lines to pass through the same cab-only station
  metroTarget: 3.3,
  metroShareStops: true, // allow two metro lines to pass through the same station (false: no crossings to draw)
  layout: 'twin', // key in tools/layouts.js (hand-made river, parks, districts), or null / 'none'
  bridges: 6, // most streets allowed to cross the river (one per equal-width strip of the map)
  startSpread: 228, // starting minimum spacing (px) between start stations; lower packs them closer
};
const N = 199;
const W = 2400;
const H = 1700;
const MARGIN = 70;
const RIVER_HALF = 34;
const RIVER_CLEAR = 76;
const PARK_PAD = 50;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(1);
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function fail(msg) {
  throw new Error(msg);
}

const DEFAULT_RIVER = { y: 0.71, waves: [[85, 410, 0.5], [32, 165, 2.0]] };
// river centre line: y fraction of the map height, an optional tilt (px of y per px of x,
// measured from the middle of the map) plus sine waves [amplitude px, wavelength/2π px, phase]
const makeRiver = (spec) => (x) =>
  H * spec.y + (spec.tilt || 0) * (x - W / 2) + spec.waves.reduce((s, [a, l, ph]) => s + a * Math.sin(x / l + ph), 0);
let riverY = makeRiver(DEFAULT_RIVER);
// Distance from p to the river's centre line. Gentle rivers measure it straight up/down (the
// original behaviour); `windy` rivers measure it at right angles, so steep bends keep their width.
let riverOff = (p) => Math.abs(p.y - riverY(p.x));
function makeRiverOff(spec) {
  if (!spec.windy) return (p) => Math.abs(p.y - riverY(p.x));
  const pts = [];
  for (let x = -200; x <= W + 200; x += 6) pts.push({ x, y: riverY(x) });
  return (p) => {
    let m = Infinity;
    const i0 = Math.max(0, Math.floor((p.x - 200 + 200) / 6) - 60);
    const i1 = Math.min(pts.length - 1, Math.floor((p.x + 200 + 200) / 6) + 60);
    for (let i = i0; i < i1; i++) {
      const a = pts[i], b = pts[i + 1];
      const vx = b.x - a.x, vy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy)));
      m = Math.min(m, Math.hypot(p.x - a.x - t * vx, p.y - a.y - t * vy));
    }
    return m;
  };
}
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const dist = (a, b) => Math.sqrt(d2(a, b));

function generate(opts = {}) {
const LAYOUTS = require('./layouts.js');
const layoutKey = 'layout' in opts ? opts.layout : DEFAULTS.layout;
if (layoutKey && layoutKey !== 'none' && !LAYOUTS[layoutKey]) throw new Error(`unknown layout ${layoutKey}`);
const L = layoutKey && layoutKey !== 'none' ? LAYOUTS[layoutKey] : {};
// precedence: defaults < the layout's tuned settings < the layout itself < explicit options
const O = { ...DEFAULTS, ...(L.tuned || {}), ...L, ...opts };
const SEED = O.seed;
rand = mulberry32(SEED);
riverY = makeRiver(O.river || DEFAULT_RIVER);
riverOff = makeRiverOff(O.river || DEFAULT_RIVER);
// ---------- 0. Parks ----------
const parks = [];
const inRect = (p, r, pad) => p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad;
function rectOk(r) {
  if (r.x < MARGIN + 60 || r.y < MARGIN + 60 || r.x + r.w > W - MARGIN - 60 || r.y + r.h > H - MARGIN - 60) return false;
  for (let x = r.x - 40; x <= r.x + r.w + 40; x += 20) {
    const ry = riverY(x);
    if (ry > r.y - RIVER_CLEAR - 120 && ry < r.y + r.h + RIVER_CLEAR + 120) return false;
  }
  const gap = 300;
  return parks.every((q) => !(r.x < q.x + q.w + gap && q.x < r.x + r.w + gap && r.y < q.y + q.h + gap && q.y < r.y + r.h + gap));
}
// hand-placed parks: [{x, y, w, h, big}] with x, y as fractions of the map size
if (O.parks) for (const pk of O.parks) parks.push({ x: pk.x * W, y: pk.y * H, w: pk.w, h: pk.h, big: !!pk.big });
if (O.parks) {
  // hand-placed parks must stay clear of the river
  for (const pk of parks) {
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      for (const p of [{ x: pk.x + pk.w * t, y: pk.y }, { x: pk.x + pk.w * t, y: pk.y + pk.h }, { x: pk.x, y: pk.y + pk.h * t }, { x: pk.x + pk.w, y: pk.y + pk.h * t }]) {
        if (riverOff(p) < RIVER_HALF + 40 || (p.y > riverY(p.x)) !== (pk.y + pk.h / 2 > riverY(pk.x + pk.w / 2))) fail('a park overlaps the river');
      }
    }
  }
}
else for (const s of [{ w: 620, h: 210, big: true }, { w: 250, h: 200 }, { w: 230, h: 170 }]) {
  for (let t = 0; t < 2000; t++) {
    const r = s.big
      ? { x: W * 0.3 + rand() * W * 0.14, y: H * 0.17 + rand() * H * 0.14, w: s.w, h: s.h }
      : { x: MARGIN + rand() * (W - 2 * MARGIN - s.w), y: MARGIN + rand() * (H - 2 * MARGIN - s.h), w: s.w, h: s.h };
    if (rectOk(r)) {
      parks.push({ ...r, big: !!s.big });
      break;
    }
  }
}

// ---------- 1. Station positions: Poisson-disc sampling (Bridson) ----------
// Optional density field: stations pack closer inside "districts" and spread out elsewhere.
// mult(p) scales the spacing at p: exp(density * (0.5 - g)), g in [0, 1] = district strength.
let districts = [];
if (O.density > 0) {
  districts = O.districts
    ? O.districts.map((d) => ({ x: d.x * W, y: d.y * H, s: d.s, w: d.w ?? 1 }))
    : Array.from({ length: O.districtCount }, () => ({
        x: MARGIN + rand() * (W - 2 * MARGIN),
        y: MARGIN + rand() * (H - 2 * MARGIN),
        s: 150 + rand() * 250,
        w: 0.6 + rand() * 0.6,
      }));
}
const mult = (p) => {
  if (!(O.density > 0)) return 1;
  let g = 0;
  for (const d of districts) g += d.w * Math.exp(-d2(p, d) / (2 * d.s * d.s));
  return Math.exp(O.density * (0.5 - Math.min(1, g)));
};
const M_MIN = O.density > 0 ? Math.exp(-0.5 * O.density) : 1;
const M_MAX = O.density > 0 ? Math.exp(0.5 * O.density) : 1;

function poisson(r) {
  const k = 30;
  const cell = (r * M_MIN) / Math.SQRT2;
  const reach = Math.ceil((r * M_MAX) / cell);
  const gw = Math.ceil(W / cell);
  const gh = Math.ceil(H / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts = [];
  const active = [];
  const ok = (p) => {
    if (p.x < MARGIN || p.x > W - MARGIN || p.y < MARGIN || p.y > H - MARGIN) return false;
    if (riverOff(p) < RIVER_CLEAR) return false;
    if (parks.some((pk) => inRect(p, pk, PARK_PAD))) return false;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    const rp = r * mult(p);
    for (let y = Math.max(0, cy - reach); y <= Math.min(gh - 1, cy + reach); y++) {
      for (let x = Math.max(0, cx - reach); x <= Math.min(gw - 1, cx + reach); x++) {
        const j = grid[y * gw + x];
        if (j < 0) continue;
        const rr = O.density > 0 ? Math.max(O.minGap, (rp + r * mult(pts[j])) / 2) : r;
        if (d2(pts[j], p) < rr * rr) return false;
      }
    }
    return true;
  };
  const add = (p) => {
    pts.push(p);
    active.push(pts.length - 1);
    grid[Math.floor(p.y / cell) * gw + Math.floor(p.x / cell)] = pts.length - 1;
  };
  for (let t = 0; t < 200 && pts.length < 2; t++) {
    const s = { x: MARGIN + rand() * (W - 2 * MARGIN), y: pts.length === 0 ? H * 0.1 + rand() * H * 0.3 : riverY(W / 2) + RIVER_CLEAR + 40 + rand() * 120 };
    if (ok(s)) add(s);
  }
  while (active.length) {
    const ai = Math.floor(rand() * active.length);
    const base = pts[active[ai]];
    let found = false;
    for (let t = 0; t < k; t++) {
      const ang = rand() * Math.PI * 2;
      const rr = Math.max(O.minGap, r * mult(base)) * (1 + rand());
      const p = { x: base.x + Math.cos(ang) * rr, y: base.y + Math.sin(ang) * rr };
      if (ok(p)) {
        add(p);
        found = true;
        break;
      }
    }
    if (!found) active.splice(ai, 1);
  }
  return pts;
}

let P = null;
let spacing = 0;
for (let r = 150; r > 60; r -= 1.5) {
  P = poisson(r);
  spacing = r;
  if (P.length >= N) break;
}
while (P.length > N) {
  let worst = -1;
  let wd = Infinity;
  P.forEach((p, i) => {
    let m = Infinity;
    P.forEach((q, j) => {
      if (i !== j) m = Math.min(m, d2(p, q));
    });
    if (O.density > 0) m /= mult(p) ** 2;
    if (m < wd) {
      wd = m;
      worst = i;
    }
  });
  P.splice(worst, 1);
}
const ALL = P.map((_, i) => i);

// ---------- Geometry / graph helpers ----------
const ekey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const elen = (e) => dist(P[e[0]], P[e[1]]);

function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}

function connected(nodes, edges) {
  return components(nodes, edges).count === 1;
}
function components(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) {
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const comp = new Map();
  let count = 0;
  for (const n of nodes) {
    if (comp.has(n)) continue;
    const stack = [n];
    comp.set(n, count);
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj.get(u)) if (!comp.has(v)) { comp.set(v, count); stack.push(v); }
    }
    count++;
  }
  return { comp, count };
}
function degreeMap(nodes, edges) {
  const deg = new Map(nodes.map((n) => [n, 0]));
  for (const [a, b] of edges) {
    deg.set(a, deg.get(a) + 1);
    deg.set(b, deg.get(b) + 1);
  }
  return deg;
}

function gabriel(ids) {
  const E = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = P[ids[i]];
      const b = P[ids[j]];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r2 = d2(a, b) / 4;
      let ok = true;
      for (const k of ids) {
        if (k === ids[i] || k === ids[j]) continue;
        if (d2(P[k], m) < r2) { ok = false; break; }
      }
      if (ok) E.push([ids[i], ids[j]]);
    }
  }
  return E;
}

// Lune-based beta-skeleton: keep a-b unless another station lies in the lune of the two
// circles of radius beta*|ab|/2 centred on the segment. beta = 1 is the Gabriel graph;
// beta = 2 is the relative neighbourhood graph, which has no triangles.
function betaSkeleton(ids, beta) {
  if (beta === 1) return gabriel(ids);
  const E = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = P[ids[i]];
      const b = P[ids[j]];
      const c1 = { x: a.x + ((b.x - a.x) * beta) / 2, y: a.y + ((b.y - a.y) * beta) / 2 };
      const c2 = { x: b.x + ((a.x - b.x) * beta) / 2, y: b.y + ((a.y - b.y) * beta) / 2 };
      const r2 = (beta * beta * d2(a, b)) / 4;
      let ok = true;
      for (const k of ids) {
        if (k === ids[i] || k === ids[j]) continue;
        if (d2(P[k], c1) < r2 && d2(P[k], c2) < r2) { ok = false; break; }
      }
      if (ok) E.push([ids[i], ids[j]]);
    }
  }
  return E;
}

function sampleSeg(a, b, n = 30) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
  return out;
}
function riverRelation(a, b) {
  const s0 = Math.sign(a.y - riverY(a.x));
  let touch = false;
  for (const p of sampleSeg(a, b)) {
    const ry = riverY(p.x);
    if (Math.sign(p.y - ry) !== s0) return 'cross';
    if ((O.river && O.river.windy ? riverOff(p) : Math.abs(p.y - ry)) < RIVER_HALF + 8) touch = true;
  }
  return touch ? 'touch' : 'none';
}
const crossesPark = (a, b) => parks.some((pk) => sampleSeg(a, b).some((p) => inRect(p, pk, 6)));

// ---------- 2. Cab streets ----------
let cab = betaSkeleton(ALL, O.streetBeta);
if (O.fillTarget > 0) {
  // Add back the shortest Gabriel streets that don't close a triangle, until the average
  // reaches fillTarget streets per station. Gives block-like faces instead of triangles.
  const nb = new Map(ALL.map((i) => [i, new Set()]));
  for (const [a, b] of cab) { nb.get(a).add(b); nb.get(b).add(a); }
  const extra = gabriel(ALL).filter(([a, b]) => !nb.get(a).has(b)).sort((e, f) => elen(e) - elen(f));
  for (const [a, b] of extra) {
    if ((2 * cab.length) / N >= O.fillTarget) break;
    if ([...nb.get(a)].some((x) => nb.get(b).has(x))) continue;
    cab.push([a, b]);
    nb.get(a).add(b);
    nb.get(b).add(a);
  }
}
cab = cab.filter((e) => !crossesPark(P[e[0]], P[e[1]]));
{
  // keep up to O.bridges bridges spread along the river; drop anything else that touches the water
  const crossing = [];
  const rest = [];
  for (const e of cab) {
    const rel = riverRelation(P[e[0]], P[e[1]]);
    if (rel === 'cross') crossing.push(e);
    else if (rel === 'none') rest.push(e);
  }
  const bridges = [];
  const n = O.bridges;
  for (let b = 0; b < n; b++) {
    const inB = crossing.filter((e) => {
      const mx = (P[e[0]].x + P[e[1]].x) / 2;
      return mx >= (b * W) / n && mx < ((b + 1) * W) / n;
    });
    inB.sort((e, f) => elen(e) - elen(f));
    if (inB.length) bridges.push(inB[0]);
  }
  cab = rest.concat(bridges);
  var protectedCab = new Set(bridges);
}

// One street cuts straight across the big park.
{
  const pk = parks.find((p) => p.big);
  if (pk) {
    const north = ALL.filter((i) => P[i].y < pk.y && P[i].x > pk.x + pk.w * 0.25 && P[i].x < pk.x + pk.w * 0.75);
    const south = ALL.filter((i) => P[i].y > pk.y + pk.h && P[i].x > pk.x + pk.w * 0.25 && P[i].x < pk.x + pk.w * 0.75);
    const cands = [];
    for (const a of north) for (const b of south) cands.push([a, b, elen([a, b]) + 2.5 * Math.abs(P[a].x - P[b].x)]);
    cands.sort((x, y) => x[2] - y[2]);
    for (const [a, b] of cands) {
      if (cab.some(([c, d]) => c !== a && c !== b && d !== a && d !== b && segIntersect(P[a], P[b], P[c], P[d]))) continue;
      const other = ALL.some((k) => k !== a && k !== b && sampleSeg(P[a], P[b]).some((p) => dist(p, P[k]) < 40));
      if (other) continue;
      const e = [a, b];
      cab.push(e);
      protectedCab.add(e);
      pk.crossing = true;
      break;
    }
  }
}

// Repair: every station needs at least two streets.
function canAddStreet(a, b) {
  if (cab.some(([c, d]) => ekey(c, d) === ekey(a, b))) return false;
  if (crossesPark(P[a], P[b]) || riverRelation(P[a], P[b]) !== 'none') return false;
  if (ALL.some((k) => k !== a && k !== b && sampleSeg(P[a], P[b]).some((p) => dist(p, P[k]) < 30))) return false;
  return !cab.some(([c, d]) => c !== a && c !== b && d !== a && d !== b && segIntersect(P[a], P[b], P[c], P[d]));
}
for (let pass = 0; pass < 3; pass++) {
  const deg = degreeMap(ALL, cab);
  for (const i of ALL) {
    if (deg.get(i) >= 2) continue;
    const near = ALL.filter((j) => j !== i).sort((x, y) => d2(P[i], P[x]) - d2(P[i], P[y]));
    for (const j of near.slice(0, 8)) {
      if (canAddStreet(i, j)) {
        cab.push([i, j]);
        deg.set(i, deg.get(i) + 1);
        deg.set(j, deg.get(j) + 1);
        break;
      }
    }
  }
}
if (!connected(ALL, cab)) fail('cab network disconnected');

// Number of cut stations (articulation points): stations whose removal splits the graph.
function cutVertexCount(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) { adj.get(a).push(b); adj.get(b).push(a); }
  const disc = new Map();
  const low = new Map();
  const cut = new Set();
  let t = 0;
  for (const root of nodes) {
    if (disc.has(root)) continue;
    // iterative DFS: [node, parent, neighbour index]
    const stack = [[root, -1, 0]];
    disc.set(root, t); low.set(root, t); t++;
    let rootKids = 0;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, parent] = top;
      const nbrs = adj.get(u);
      if (top[2] < nbrs.length) {
        const v = nbrs[top[2]++];
        if (!disc.has(v)) {
          disc.set(v, t); low.set(v, t); t++;
          if (u === root) rootKids++;
          stack.push([v, u, 0]);
        } else if (v !== parent) low.set(u, Math.min(low.get(u), disc.get(v)));
      } else {
        stack.pop();
        if (parent >= 0) {
          low.set(parent, Math.min(low.get(parent), low.get(u)));
          if (parent !== root && low.get(u) >= disc.get(parent)) cut.add(parent);
        }
      }
    }
    if (rootKids > 1) cut.add(root);
  }
  return cut.size;
}

function prune(nodes, E, { target, minDeg, keep, maxLen, maxDeg2, triWeight, biconnected, lengthBias }) {
  let edges = E.slice();
  const deg = degreeMap(nodes, edges);
  // triangles each street belongs to (computed once, on the unpruned streets)
  const nb = new Map(nodes.map((n) => [n, new Set()]));
  for (const [a, b] of edges) { nb.get(a).add(b); nb.get(b).add(a); }
  const tri = (e) => [...nb.get(e[0])].filter((x) => nb.get(e[1]).has(x)).length;
  const score = new Map(edges.map((e) => [e, elen(e) ** lengthBias * (1 + 0.6 * rand()) * (1 + triWeight * tri(e))]));
  const order = edges.slice().sort((e, f) => score.get(f) - score.get(e));
  const targetCount = Math.round((nodes.length * target) / 2);
  let deg2 = [...deg.values()].filter((d) => d === 2).length;
  let cuts = biconnected ? cutVertexCount(nodes, edges) : 0;
  for (const e of order) {
    if (edges.length <= targetCount && elen(e) <= maxLen) continue;
    if (keep.has(e)) continue;
    const [a, b] = e;
    if (deg.get(a) <= minDeg || deg.get(b) <= minDeg) continue;
    const newDeg2 = (deg.get(a) === 3) + (deg.get(b) === 3);
    if (newDeg2 && deg2 + newDeg2 > maxDeg2) continue;
    const rest = edges.filter((x) => x !== e);
    if (!connected(nodes, rest)) continue;
    if (biconnected) {
      const c = cutVertexCount(nodes, rest);
      if (c > cuts) continue;
      cuts = c;
    }
    edges = rest;
    deg.set(a, deg.get(a) - 1);
    deg.set(b, deg.get(b) - 1);
    deg2 += newDeg2;
  }
  return edges;
}
cab = prune(ALL, cab, {
  target: O.cabTarget,
  minDeg: 2,
  keep: protectedCab,
  maxLen: spacing * 2.3 * M_MAX,
  maxDeg2: O.maxDeg2,
  triWeight: O.triWeight,
  biconnected: O.biconnected,
  lengthBias: O.pruneLengthBias,
});
const cabDeg = degreeMap(ALL, cab);

const cabAdj = new Map(ALL.map((n) => [n, []]));
for (const [a, b] of cab) {
  const k = ekey(a, b);
  const l = elen([a, b]);
  cabAdj.get(a).push({ to: b, len: l, eid: k });
  cabAdj.get(b).push({ to: a, len: l, eid: k });
}

// ---------- 3/4. Routed layers (tram over cab, metro over tram) ----------
function routeCandidates(L, baseAdj, maxHops, stretch, minHops = 1) {
  const Ls = new Set(L);
  const out = [];
  for (const s of L) {
    const best = new Map([[s, 0]]);
    const prev = new Map();
    const done = new Set();
    const pq = [[0, s]];
    while (pq.length) {
      pq.sort((x, y) => x[0] - y[0]);
      const [d, u] = pq.shift();
      if (done.has(u)) continue;
      done.add(u);
      if (u !== s && Ls.has(u)) continue; // other layer stops are endpoints only
      for (const { to, len, eid } of baseAdj.get(u)) {
        const nd = d + len;
        if (nd < (best.has(to) ? best.get(to) : Infinity)) {
          best.set(to, nd);
          prev.set(to, { u, eid });
          pq.push([nd, to]);
        }
      }
    }
    for (const t of L) {
      if (t <= s || !done.has(t)) continue;
      const nodes = [t];
      const eids = [];
      let c = t;
      while (c !== s) {
        const p = prev.get(c);
        eids.push(p.eid);
        c = p.u;
        nodes.push(c);
      }
      nodes.reverse();
      eids.reverse();
      const len = best.get(t);
      if (eids.length > maxHops || eids.length < minHops || len > stretch * dist(P[s], P[t])) continue;
      out.push({ a: s, b: t, nodes, eids, len });
    }
  }
  return out.sort((x, y) => x.len - y.len);
}

function selectRoutes(L, cands, { degCap, targetAvg, relaxInner = false }) {
  const usedE = new Set();
  const usedN = new Set();
  const deg = new Map(L.map((n) => [n, 0]));
  const chosen = [];
  const inner = (c) => c.nodes.slice(1, -1);
  // Lines never share a street; by default they also never pass through the same in-between station.
  const fits = (c, relaxed = false) =>
    !chosen.includes(c) && c.eids.every((e) => !usedE.has(e)) && (relaxed || inner(c).every((n) => !usedN.has(n)));
  const take = (c) => {
    chosen.push(c);
    c.eids.forEach((e) => usedE.add(e));
    inner(c).forEach((n) => usedN.add(n));
    deg.set(c.a, deg.get(c.a) + 1);
    deg.set(c.b, deg.get(c.b) + 1);
  };
  const target = Math.round((L.length * targetAvg) / 2);
  for (const c of cands) {
    if (chosen.length >= target) break;
    if (deg.get(c.a) >= degCap || deg.get(c.b) >= degCap) continue;
    if (fits(c)) take(c);
  }
  for (;;) {
    const { comp, count } = components(L, chosen.map((c) => [c.a, c.b]));
    if (count === 1) break;
    const c =
      cands.find((x) => comp.get(x.a) !== comp.get(x.b) && fits(x)) ||
      (relaxInner && cands.find((x) => comp.get(x.a) !== comp.get(x.b) && fits(x, true)));
    if (!c) return null;
    take(c);
  }
  for (const n of L) {
    if (deg.get(n) >= 2) continue;
    const c = cands.find((x) => (x.a === n || x.b === n) && fits(x) && deg.get(x.a === n ? x.b : x.a) < degCap + 1);
    if (c) take(c);
  }
  if (relaxInner) {
    for (const c of cands) {
      if (chosen.length >= target) break;
      if (deg.get(c.a) >= degCap || deg.get(c.b) >= degCap) continue;
      if (fits(c, true)) take(c);
    }
  }
  return chosen;
}

function spreadSubset(cands, minD, weight) {
  const order = shuffle(cands.slice());
  const w = new Map(order.map((i) => [i, weight(i) + rand() * 2]));
  order.sort((a, b) => w.get(b) - w.get(a));
  const out = [];
  for (const i of order) if (out.every((j) => dist(P[i], P[j]) >= minD)) out.push(i);
  return out;
}

let tramStops = null;
let tram = null;
for (let attempt = 0; attempt < 60 && !tram; attempt++) {
  const d = 195 - (attempt % 12) * 5;
  tramStops = spreadSubset(ALL.filter((i) => cabDeg.get(i) >= 3), d, (i) => cabDeg.get(i));
  if (tramStops.length < O.tramMinStops) continue;
  tram = selectRoutes(tramStops, routeCandidates(tramStops, cabAdj, O.tramHops, O.tramStretch, O.tramMinHops), {
    degCap: O.tramDegCap,
    targetAvg: O.tramTarget,
    relaxInner: O.tramShareStops,
  });
}
if (!tram) fail('could not build a connected tram network');

const tramAdj = new Map(tramStops.map((n) => [n, []]));
tram.forEach((r, i) => {
  tramAdj.get(r.a).push({ to: r.b, len: r.len, eid: i });
  tramAdj.get(r.b).push({ to: r.a, len: r.len, eid: i });
});

let metroHubs = null;
let metro = null;
for (let attempt = 0; attempt < 60 && !metro; attempt++) {
  const d = 540 - (attempt % 10) * 15;
  metroHubs = spreadSubset(tramStops, d, (i) => tramAdj.get(i).length);
  if (metroHubs.length < 12 || metroHubs.length > 16) continue;
  const m = selectRoutes(metroHubs, routeCandidates(metroHubs, tramAdj, 7, 1.8), { degCap: 4, targetAvg: O.metroTarget, relaxInner: O.metroShareStops !== false });
  if (m && m.length >= metroHubs.length + 3) metro = m;
}
if (!metro) fail('could not build a connected metro network');

// Expand a metro route (sequence of tram stops) into the full station path along tram routes.
function expandMetro(route) {
  const out = [route.nodes[0]];
  route.eids.forEach((tid, k) => {
    const tr = tram[tid];
    const from = route.nodes[k];
    const seq = tr.nodes[0] === from ? tr.nodes : tr.nodes.slice().reverse();
    out.push(...seq.slice(1));
  });
  return out;
}

// ---------- 5. Ferry piers ----------
const nearRiver = ALL.filter((i) => riverOff(P[i]) < 150);
const ferryStops = [];
for (const f of [0.1, 0.37, 0.63, 0.9]) {
  const tx = f * W;
  let best = -1;
  let bs = Infinity;
  for (const i of nearRiver) {
    if (ferryStops.includes(i)) continue;
    const s = Math.abs(P[i].x - tx) + 1.5 * riverOff(P[i]);
    if (s < bs) { bs = s; best = i; }
  }
  if (best < 0) fail('no ferry pier candidate');
  ferryStops.push(best);
}
ferryStops.sort((a, b) => P[a].x - P[b].x);

// ---------- 6. Number stations row by row ----------
const order = ALL.slice().sort((a, b) => {
  const ra = Math.floor(P[a].y / 120);
  const rb = Math.floor(P[b].y / 120);
  return ra - rb || P[a].x - P[b].x;
});
const idOf = new Map(order.map((idx, k) => [idx, k + 1]));
const ids = (arr) => arr.map((i) => idOf.get(i));
const round1 = (v) => Math.round(v * 10) / 10;

const edgesOut = [];
for (const [a, b] of cab) edgesOut.push({ a: idOf.get(a), b: idOf.get(b), type: 'cab' });
for (const r of tram) edgesOut.push({ a: idOf.get(r.a), b: idOf.get(r.b), type: 'tram', path: ids(r.nodes) });
for (const r of metro) edgesOut.push({ a: idOf.get(r.a), b: idOf.get(r.b), type: 'metro', path: ids(expandMetro(r)) });
for (let k = 0; k + 1 < ferryStops.length; k++) {
  const A = P[ferryStops[k]];
  const B = P[ferryStops[k + 1]];
  const pts = [{ x: A.x, y: A.y }, { x: A.x, y: riverY(A.x) }];
  for (let x = Math.ceil(A.x / 30) * 30; x < B.x; x += 30) pts.push({ x, y: riverY(x) });
  pts.push({ x: B.x, y: riverY(B.x) }, { x: B.x, y: B.y });
  edgesOut.push({
    a: idOf.get(ferryStops[k]),
    b: idOf.get(ferryStops[k + 1]),
    type: 'ferry',
    line: pts.map((p) => [round1(p.x), round1(p.y)]),
  });
}

// ---------- 7. Start stations ----------
const metroSet = new Set(metroHubs);
const ferrySet = new Set(ferryStops);
const startCands = ALL.filter((i) => cabDeg.get(i) >= 3 && !metroSet.has(i) && !ferrySet.has(i));
let starts = null;
for (let d = O.startSpread; d > 150; d -= 10) {
  starts = spreadSubset(startCands, d, () => 0);
  if (starts.length >= 18) break;
}
if (starts.length < 18) fail('not enough start stations');
starts = starts.slice(0, 18).map((i) => idOf.get(i)).sort((a, b) => a - b);

// ---------- Output ----------
const river = [];
for (let x = -60; x <= W + 60; x += 20) river.push([x, round1(riverY(x))]);

const stations = order.map((idx) => ({ id: idOf.get(idx), x: Math.round(P[idx].x), y: Math.round(P[idx].y) }));
const data = {
  key: layoutKey && layoutKey !== 'none' ? layoutKey : 'custom',
  name: O.name || 'Wexmoor',
  blurb: O.blurb || '',
  seed: SEED,
  width: W,
  height: H,
  river: { halfWidth: RIVER_HALF, points: river },
  parks: parks.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h })),
  stations,
  edges: edgesOut,
  starts,
};

// Street shapes and city decor: visual only, with their own random stream, so the graph
// above is identical with or without them.
if (O.detail !== false) {
  const straight = new Set([...protectedCab].map(([a, b]) => ekey(idOf.get(a), idOf.get(b))));
  addCityDetail(data, {
    seed: SEED,
    width: W,
    height: H,
    riverY,
    riverOff,
    riverHalf: RIVER_HALF,
    parks: parks.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h, big: !!p.big })),
    densityAt: mult,
    straight,
    labels: O.labels || [],
    riverName: O.riverName || null,
    parkName: O.parkName || null,
  });
}

const count = (t) => edgesOut.filter((e) => e.type === t).length;
const hops = (t) => {
  const es = edgesOut.filter((e) => e.type === t);
  return (es.reduce((s, e) => s + e.path.length - 1, 0) / es.length).toFixed(1);
};
const summary = [
  `seed ${SEED}: ${stations.length} stations (spacing ${spacing.toFixed(1)}), parks ${parks.length}${parks.some((p) => p.crossing) ? ' (big park crossed once)' : ''}`,
  `  cab   edges ${count('cab')}  avg deg ${((2 * count('cab')) / N).toFixed(2)}`,
  `  tram  stops ${tramStops.length}  links ${count('tram')}  avg streets/link ${hops('tram')}`,
  `  metro hubs  ${metroHubs.length}  links ${count('metro')}  avg streets/link ${hops('metro')}`,
  `  ferry piers ${ferryStops.length}`,
  `  starts ${starts.join(', ')}`,
].join('\n');
return { data, summary };
}

const MAPS_DIR = path.join(__dirname, '..', 'js', 'maps');

/** Writes a map as a script that registers itself in window.MAPS (browser) or exports it (Node). */
function writeMap(data, file = path.join(MAPS_DIR, `${data.key}.js`)) {
  const header = `/* Generated by tools/genmap.js — ${data.name}, a city map for Nightfall Run. Do not edit by hand. */\n`;
  const body =
    `(function (root) {\n  const MAP_DATA = ${JSON.stringify(data)};\n` +
    `  if (typeof module === 'object' && module.exports) module.exports = MAP_DATA;\n` +
    `  else (root.MAPS = root.MAPS || {})[MAP_DATA.key] = MAP_DATA;\n})(typeof self !== 'undefined' ? self : this);\n`;
  fs.writeFileSync(file, header + body);
}

/** Every shipped map, default first: [{key, data}] read from js/maps. */
function loadMaps() {
  const LAYOUTS = require('./layouts.js');
  const keys = [DEFAULTS.layout, ...Object.keys(LAYOUTS).filter((k) => k !== DEFAULTS.layout)];
  return keys.filter((k) => fs.existsSync(path.join(MAPS_DIR, `${k}.js`))).map((k) => ({ key: k, data: require(path.join(MAPS_DIR, `${k}.js`)) }));
}

module.exports = { generate, writeMap, loadMaps, DEFAULTS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const opts = {};
  for (const a of args) {
    if (/^\d+$/.test(a)) opts.seed = Number(a);
    else if (a.includes('=')) {
      const [k, v] = a.split('=');
      if (!(k in DEFAULTS) && k !== 'layout') { console.error(`unknown setting ${k}`); process.exit(1); }
      opts[k] = v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v);
    }
  }
  try {
    if (!Object.keys(opts).length && !out) {
      // rebuild every hand-made layout with its tuned settings
      fs.mkdirSync(MAPS_DIR, { recursive: true });
      for (const key of Object.keys(require('./layouts.js'))) {
        const { data, summary } = generate({ layout: key });
        writeMap(data);
        console.log(`${key} (${data.name}) -> js/maps/${key}.js\n${summary}\n`);
      }
    } else {
      const { data, summary } = generate(opts);
      if (data.key === 'custom' && !out) throw new Error('layout=none needs --out <file>');
      writeMap(data, out || undefined);
      console.log(`${out || `js/maps/${data.key}.js`}\n${summary}`);
    }
  } catch (err) {
    console.error('Map generation failed:', err.message, '(try another seed)');
    process.exit(1);
  }
}