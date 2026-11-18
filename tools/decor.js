/*
 * City detail for a generated map (used by tools/genmap.js). Purely visual — it never changes
 * which stations connect, so game balance is untouched.
 *
 *   - cab streets get a shape (arc, S-bend, kink or dogleg) instead of a straight line, chosen so
 *     streets never cross, keep clear of other stations, the river and the parks, and leave each
 *     station at distinct angles. Bridges and the park cut-through stay straight.
 *   - decor: building footprints aligned to the nearest street (denser in busy districts),
 *     trees, footpaths and a pond in the parks, bridge decks, squares at metro hubs, and
 *     district / river names.
 */
'use strict';

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const dist = (a, b) => Math.sqrt(d2(a, b));
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}
function distSeg(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}
const distPoly = (p, pts) => {
  let m = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) m = Math.min(m, distSeg(p, pts[i], pts[i + 1]));
  return m;
};
function bbox(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
const boxHit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Shapes the cab streets of `data` (adds `curve` to each cab edge) and adds `data.decor`.
 * ctx: { seed, width, height, riverY(x), riverHalf, parks, densityAt(p), straight:Set<'a-b'>,
 *        labels:[{text, x, y, size}] (fractions), riverName, parkName }
 */
function addCityDetail(data, ctx) {
  const rand = mulberry32(((ctx.seed * 2654435761) ^ 0x5bd1e995) >>> 0);
  const uni = (a, b) => a + rand() * (b - a);
  const S = new Map(data.stations.map((s) => [s.id, s]));
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const parks = ctx.parks;
  const inPark = (p, pad) => parks.some((pk) => p.x > pk.x - pad && p.x < pk.x + pk.w + pad && p.y > pk.y - pad && p.y < pk.y + pk.h + pad);
  const riverGap = (p) => (ctx.riverOff ? ctx.riverOff(p) : Math.abs(p.y - ctx.riverY(p.x))) - ctx.riverHalf;
  const ferryLines = data.edges.filter((e) => e.type === 'ferry').map((e) => e.line.map(([x, y]) => ({ x, y })));

  // ---------- 1. Street shapes ----------
  const cabs = data.edges.filter((e) => e.type === 'cab');
  const geo = new Map(cabs.map((e) => [e, [S.get(e.a), S.get(e.b)].map((p) => ({ x: p.x, y: p.y }))]));
  const boxes = new Map(cabs.map((e) => [e, bbox(geo.get(e), 20)]));
  const atStation = new Map(data.stations.map((s) => [s.id, []]));
  for (const e of cabs) { atStation.get(e.a).push(e); atStation.get(e.b).push(e); }

  function shape(A, B, kind, amt) {
    const len = dist(A, B);
    const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
    const nx = -uy, ny = ux;
    const off = len * amt;
    const at = (t, o) => ({ x: A.x + (B.x - A.x) * t + nx * o, y: A.y + (B.y - A.y) * t + ny * o });
    if (kind === 'kink') return [A, at(uni(0.35, 0.65), off), B];
    if (kind === 'dogleg') { const t = uni(0.25, 0.4); return [A, at(t, off), at(1 - t, off), B]; }
    const out = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // arc: quadratic bow; scurve: cubic with opposite bows
      const o = kind === 'arc' ? off * 4 * t * (1 - t) : off * 6 * Math.sqrt(3) * t * (1 - t) * (0.5 - t) * 2;
      out.push(i === 0 ? A : i === n ? B : at(t, o));
    }
    return out;
  }
  const departAngle = (pts, fromStart) => {
    const [p, q] = fromStart ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
    return Math.atan2(q.y - p.y, q.x - p.x);
  };
  const angDiff = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };

  function valid(e, pts) {
    const box = bbox(pts, 20);
    // stays out of the river and parks, clear of ferry lines
    for (let i = 0; i + 1 < pts.length; i++) {
      for (let k = 1; k <= 4; k++) {
        const p = { x: pts[i].x + ((pts[i + 1].x - pts[i].x) * k) / 4, y: pts[i].y + ((pts[i + 1].y - pts[i].y) * k) / 4 };
        if (riverGap(p) < 10 || inPark(p, 6)) return false;
      }
      for (const fl of ferryLines) for (let j = 0; j + 1 < fl.length; j++) if (segIntersect(pts[i], pts[i + 1], fl[j], fl[j + 1])) return false;
    }
    // other stations keep their distance
    for (const s of data.stations) {
      if (s.id === e.a || s.id === e.b) continue;
      if (s.x < box.x0 - 40 || s.x > box.x1 + 40 || s.y < box.y0 - 40 || s.y > box.y1 + 40) continue;
      if (distPoly(s, pts) < 34) return false;
    }
    // no crossings, no running alongside another street
    for (const f of cabs) {
      if (f === e || !boxHit(box, boxes.get(f))) continue;
      const q = geo.get(f);
      for (let i = 0; i + 1 < pts.length; i++) for (let j = 0; j + 1 < q.length; j++) if (segIntersect(pts[i], pts[i + 1], q[j], q[j + 1])) return false;
      const shared = f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b;
      if (!shared) {
        for (const p of pts) if (distPoly(p, q) < 22) return false;
        for (const p of q) if (distPoly(p, pts) < 22) return false;
      }
    }
    // leave each end station at an angle clearly different from its other streets
    for (const [sid, fromStart] of [[e.a, true], [e.b, false]]) {
      const ang = departAngle(pts, fromStart);
      for (const f of atStation.get(sid)) {
        if (f === e) continue;
        const q = geo.get(f);
        if (angDiff(ang, departAngle(q, f.a === sid)) < 0.45) return false;
      }
    }
    return true;
  }

  const order = cabs.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  for (const e of order) {
    if (ctx.straight.has(key(e.a, e.b))) continue;
    const A = geo.get(e)[0], B = geo.get(e)[1];
    const len = dist(A, B);
    const roll = rand();
    const kind = roll < 0.14 ? null : roll < 0.48 ? 'arc' : roll < 0.62 ? 'scurve' : roll < 0.84 ? 'kink' : 'dogleg';
    if (!kind) continue;
    const base = (kind === 'arc' || kind === 'kink' ? uni(0.08, 0.2) : uni(0.06, 0.12)) * (rand() < 0.5 ? -1 : 1) * (len < 90 ? 0.6 : 1);
    for (const s of [1, 0.65, 0.4]) {
      const pts = shape(A, B, kind, base * s);
      if (valid(e, pts)) { geo.set(e, pts); boxes.set(e, bbox(pts, 20)); break; }
    }
  }
  for (const e of cabs) e.curve = geo.get(e).map((p) => [r1(p.x), r1(p.y)]);

  // ---------- 2. Decor ----------
  const decor = { buildings: [], trees: [], paths: [], ponds: [], bridges: [], plazas: [], labels: [], riverName: ctx.riverName || null };

  // street segments in a bucket grid, for nearest-street lookups
  const CELL = 90;
  const buckets = new Map();
  const bkey = (cx, cy) => `${cx},${cy}`;
  for (const pts of geo.values()) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const b = bbox([pts[i], pts[i + 1]]);
      for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
        for (let cy = Math.floor(b.y0 / CELL); cy <= Math.floor(b.y1 / CELL); cy++) {
          const k = bkey(cx, cy);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push([pts[i], pts[i + 1]]);
        }
      }
    }
  }
  function nearestStreet(p, range = 2) {
    let best = Infinity, ang = 0;
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
    for (let x = cx - range; x <= cx + range; x++) for (let y = cy - range; y <= cy + range; y++) {
      for (const [a, b] of buckets.get(bkey(x, y)) || []) {
        const d = distSeg(p, a, b);
        if (d < best) { best = d; ang = Math.atan2(b.y - a.y, b.x - a.x); }
      }
    }
    return { d: best, ang };
  }
  const nearStation = (p, r) => data.stations.some((s) => d2(s, p) < r * r);

  // buildings
  const placed = new Map(); // bucket -> [{x, y, r}]
  const PB = 60;
  const free = (p, r) => {
    const cx = Math.floor(p.x / PB), cy = Math.floor(p.y / PB);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const q of placed.get(bkey(x, y)) || []) if (d2(p, q) < (r + q.r + 3) ** 2) return false;
    }
    return true;
  };
  const okSpot = (p) => !(inPark(p, 16) || riverGap(p) < 24 || nearStation(p, 31) || ferryLines.some((fl) => distPoly(p, fl) < 24));
  const put = (p, w, h, angRad) => {
    const r = 0.5 * Math.hypot(w, h);
    const k = bkey(Math.floor(p.x / PB), Math.floor(p.y / PB));
    if (!placed.has(k)) placed.set(k, []);
    placed.get(k).push({ ...p, r });
    let a = Math.round((angRad * 180) / Math.PI) % 180;
    if (a < 0) a += 180;
    decor.buildings.push([r1(p.x), r1(p.y), r1(w), r1(h), a]);
  };
  const busy = (p) => Math.max(0.5, Math.min(0.97, 1.3 - 0.45 * ctx.densityAt(p))); // higher in districts

  // a) frontage: rows of buildings facing each street, on both sides
  for (const pts of geo.values()) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const A = pts[i], B = pts[i + 1];
      const len = dist(A, B);
      if (len < 1) continue;
      const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
      const ang = Math.atan2(uy, ux);
      for (const side of [-1, 1]) {
        let t = uni(4, 14);
        while (t < len - 6) {
          const w = uni(14, 26), h = uni(12, 20);
          const off = 13 + h / 2 + uni(1, 4);
          const c = { x: A.x + ux * (t + w / 2) - uy * off * side, y: A.y + uy * (t + w / 2) + ux * off * side };
          t += w + uni(3, 9);
          if (!okSpot(c) || rand() > busy(c)) continue;
          const near = nearestStreet(c);
          if (near.d < off - 1.5) continue; // too close to another street
          const r = 0.5 * Math.hypot(w, h);
          if (!free(c, r * 0.8)) continue;
          put(c, w, h, ang);
        }
      }
    }
  }
  // b) infill: smaller buildings behind the frontage, sparser out of the districts
  const STEP = 30;
  for (let gx = 20; gx < ctx.width - 20; gx += STEP) {
    for (let gy = 20; gy < ctx.height - 20; gy += STEP) {
      const p = { x: gx + uni(-9, 9), y: gy + uni(-9, 9) };
      if (!okSpot(p)) continue;
      const { d, ang } = nearestStreet(p);
      if (d < 30) continue;
      let prob = busy(p) * 0.55;
      if (d > 130) prob *= 0.3;
      if (rand() > prob) continue;
      let w = uni(12, 24), h = uni(10, 17);
      const r = 0.5 * Math.hypot(w, h);
      if (d - 13 < r || !free(p, r)) continue;
      put(p, w, h, ang);
    }
  }

  // parks: footpath, pond (big park), trees
  for (const pk of parks) {
    const crossing = cabs.filter((e) => ctx.straight.has(key(e.a, e.b))).map((e) => geo.get(e))
      .filter((pts) => pts.some((p, i) => i + 1 < pts.length && distSeg({ x: pk.x + pk.w / 2, y: pk.y + pk.h / 2 }, p, pts[i + 1]) < Math.max(pk.w, pk.h)));
    const path = [];
    const y0 = pk.y + pk.h * uni(0.3, 0.7), y1 = pk.y + pk.h * uni(0.3, 0.7);
    const bow = pk.h * uni(-0.25, 0.25);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      path.push([r1(pk.x + 14 + (pk.w - 28) * t), r1(y0 + (y1 - y0) * t + bow * 4 * t * (1 - t))]);
    }
    decor.paths.push(path);
    const pathPts = path.map(([x, y]) => ({ x, y }));
    let pond = null;
    if (pk.big) {
      for (let t = 0; t < 400 && !pond; t++) {
        const c = { x: pk.x + uni(0.12, 0.88) * pk.w, y: pk.y + uni(0.3, 0.7) * pk.h };
        const shrink = 1 - t / 600; // try smaller ponds as attempts run out
        const rx = uni(45, 70) * shrink, ry = uni(24, 34) * shrink;
        const clear = crossing.every((pts) => distPoly(c, pts) > rx + 24) && distPoly(c, pathPts) > ry + 12;
        if (clear && c.x - rx > pk.x + 18 && c.x + rx < pk.x + pk.w - 18 && c.y - ry > pk.y + 18 && c.y + ry < pk.y + pk.h - 18) pond = { ...c, rx, ry };
      }
      if (pond) decor.ponds.push([r1(pond.x), r1(pond.y), r1(pond.rx), r1(pond.ry)]);
      if (ctx.parkName) {
        // along the top of the park, on the side away from the cut-through street
        const halfW = ctx.parkName.length * 6.5 + 10;
        let bx = pk.x + pk.w / 2, bs = -1;
        for (let x = pk.x + halfW + 16; x <= pk.x + pk.w - halfW - 16; x += 10) {
          const sc = Math.min(...crossing.map((pts) => Math.min(...[-1, 0, 1].map((k) => distPoly({ x: x + k * halfW, y: pk.y + 30 }, pts)))), 999);
          if (sc > bs) { bs = sc; bx = x; }
        }
        decor.parkName = { text: ctx.parkName, x: Math.round(bx), y: Math.round(pk.y + 30), halfW };
      }
    }
    for (let t = 0; t < pk.w * pk.h / 180; t++) {
      const p = { x: pk.x + uni(16, pk.w - 16), y: pk.y + uni(16, pk.h - 16) };
      const r = uni(8, 15);
      if (crossing.some((pts) => distPoly(p, pts) < r + 14)) continue;
      if (distPoly(p, pathPts) < r + 7) continue;
      const nm = pk.big && decor.parkName;
      if (nm && Math.abs(p.y - nm.y) < r + 12 && Math.abs(p.x - nm.x) < nm.halfW + r) continue;
      if (pond && ((p.x - pond.x) / (pond.rx + r + 6)) ** 2 + ((p.y - pond.y) / (pond.ry + r + 6)) ** 2 < 1) continue;
      if (decor.trees.some(([x, y, rr]) => (x - p.x) ** 2 + (y - p.y) ** 2 < (rr + r) ** 2 * 0.8)) continue;
      decor.trees.push([r1(p.x), r1(p.y), r1(r)]);
    }
  }

  // bridge decks where a street crosses the river
  for (const e of cabs) {
    const pts = geo.get(e);
    const A = pts[0], B = pts[pts.length - 1];
    if (Math.sign(A.y - ctx.riverY(A.x)) === Math.sign(B.y - ctx.riverY(B.x))) continue;
    let first = null, last = null;
    for (let i = 0; i <= 60; i++) {
      const p = { x: A.x + ((B.x - A.x) * i) / 60, y: A.y + ((B.y - A.y) * i) / 60 };
      if (riverGap(p) < 14) { if (!first) first = p; last = p; }
    }
    if (first) decor.bridges.push([r1(first.x), r1(first.y), r1(last.x), r1(last.y)]);
  }

  // river name: the longest stretch of water clear of bridges and ferry piers
  if (decor.riverName) {
    const span = decor.riverName.length * 22;
    const blockers = [...decor.bridges.flatMap(([x1, , x2]) => [x1, x2]), ...ferryLines.flatMap((fl) => [fl[0].x, fl[fl.length - 1].x])];
    let best = 120, bs = -1;
    for (let x = 60; x + span < ctx.width - 60; x += 10) {
      const sc = Math.min(...blockers.map((b) => (b < x ? x - b : b > x + span ? b - x - span : -1)));
      if (sc > bs) { bs = sc; best = x; }
    }
    decor.riverLabelX = best;
  }

  // paved squares around metro hubs
  const metroIds = new Set(data.edges.filter((e) => e.type === 'metro').flatMap((e) => [e.a, e.b]));
  for (const id of metroIds) decor.plazas.push([S.get(id).x, S.get(id).y]);

  // names: nudge each label to the clearest nearby spot
  for (const lb of ctx.labels || []) {
    const size = lb.size || 30;
    const halfW = (lb.text.length * size * 0.62 + lb.text.length * 6) / 2;
    const tx = lb.x * ctx.width, ty = lb.y * ctx.height;
    let best = null;
    for (let dx = -240; dx <= 240; dx += 20) for (let dy = -160; dy <= 160; dy += 20) {
      const c = { x: tx + dx, y: ty + dy };
      if (c.x - halfW < 30 || c.x + halfW > ctx.width - 30 || c.y < 40 || c.y > ctx.height - 30) continue;
      let clear = Infinity;
      for (let k = -2; k <= 2; k++) {
        const p = { x: c.x + (halfW * k) / 2, y: c.y };
        for (const s of data.stations) clear = Math.min(clear, Math.abs(s.x - p.x) < 60 ? Math.hypot(s.x - p.x, s.y - p.y) : Infinity);
        if (riverGap(p) < 16 || inPark(p, 26)) clear = 0;
      }
      const sc = Math.min(clear, 90) - 0.08 * Math.hypot(dx, dy);
      if (!best || sc > best.sc) best = { ...c, sc };
    }
    if (best) decor.labels.push({ text: lb.text, x: Math.round(best.x), y: Math.round(best.y), size });
  }

  data.decor = decor;
  return data;
}

module.exports = { addCityDetail };
