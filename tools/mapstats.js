/*
 * Graph statistics for a map, used to compare generated maps with a reference board.
 *
 *   node tools/mapstats.js [--sy <dir>]
 *
 * Prints stats for every map in js/maps, side by side with a reference map given as
 * stations.txt + connections.txt (AlexElvers/scotland-yard-data format) if --sy is passed.
 * "Moves" are single tickets; detectives cannot use the ferry.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Standard start cards for the Scotland Yard reference board (not part of that dataset).
const SY_DET = [13, 26, 29, 34, 50, 53, 91, 94, 103, 112, 117, 123, 138, 141, 155, 174];
const SY_FUG = [35, 45, 51, 71, 78, 104, 106, 127, 132, 146, 166, 170, 172];

function loadTextMap(dir) {
  const T = { taxi: 'cab', bus: 'tram', underground: 'metro', water: 'ferry' };
  const lines = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
  const stations = lines('stations.txt').map((l) => ({ id: Number(l.split(' ')[0]) }));
  const edges = lines('connections.txt').map((l) => {
    const [a, b, t] = l.trim().split(/\s+/);
    return { a: Number(a), b: Number(b), type: T[t] };
  });
  return { name: 'Scotland Yard', stations, edges, detStarts: SY_DET, fugStarts: SY_FUG };
}

function bfsAll(ids, nbrs) {
  const D = new Map();
  for (const s of ids) {
    const d = new Map([[s, 0]]);
    let fr = [s];
    while (fr.length) {
      const nx = [];
      for (const u of fr) for (const v of nbrs(u)) if (!d.has(v)) { d.set(v, d.get(u) + 1); nx.push(v); }
      fr = nx;
    }
    D.set(s, d);
  }
  return D;
}

function cutVertices(ids, adj) {
  const disc = new Map(), low = new Map(), cut = new Set();
  let t = 0;
  for (const root of ids) {
    if (disc.has(root)) continue;
    const stack = [[root, -1, 0]];
    disc.set(root, t); low.set(root, t); t++;
    let kids = 0;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, p] = top;
      const nb = [...adj.get(u)];
      if (top[2] < nb.length) {
        const v = nb[top[2]++];
        if (!disc.has(v)) { disc.set(v, t); low.set(v, t); t++; if (u === root) kids++; stack.push([v, u, 0]); }
        else if (v !== p) low.set(u, Math.min(low.get(u), disc.get(v)));
      } else {
        stack.pop();
        if (p >= 0) {
          low.set(p, Math.min(low.get(p), low.get(u)));
          if (p !== root && low.get(u) >= disc.get(p)) cut.add(p);
        }
      }
    }
    if (kids > 1) cut.add(root);
  }
  return [...cut].sort((a, b) => a - b);
}

function betweennessMax(ids, adj) {
  // Brandes, unweighted, normalised like networkx (undirected): / ((n-1)(n-2)/2) and halved
  const C = new Map(ids.map((i) => [i, 0]));
  for (const s of ids) {
    const S = [], P = new Map(ids.map((i) => [i, []])), sig = new Map(ids.map((i) => [i, 0])), d = new Map();
    sig.set(s, 1); d.set(s, 0);
    const Q = [s];
    for (let qi = 0; qi < Q.length; qi++) {
      const v = Q[qi]; S.push(v);
      for (const w of adj.get(v)) {
        if (!d.has(w)) { d.set(w, d.get(v) + 1); Q.push(w); }
        if (d.get(w) === d.get(v) + 1) { sig.set(w, sig.get(w) + sig.get(v)); P.get(w).push(v); }
      }
    }
    const del = new Map(ids.map((i) => [i, 0]));
    while (S.length) {
      const w = S.pop();
      for (const v of P.get(w)) del.set(v, del.get(v) + (sig.get(v) / sig.get(w)) * (1 + del.get(w)));
      if (w !== s) C.set(w, C.get(w) + del.get(w));
    }
  }
  const n = ids.length;
  const norm = 1 / ((n - 1) * (n - 2));
  return Math.max(...[...C.values()].map((c) => c * norm));
}

function mulberry(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stats for a map in MAP_DATA format ({stations, edges, starts} or detStarts/fugStarts).
 */
function computeStats(map) {
  const ids = map.stations.map((s) => s.id);
  const N = ids.length;
  const by = { cab: new Map(), tram: new Map(), metro: new Map(), ferry: new Map() };
  for (const t in by) for (const i of ids) by[t].set(i, new Set());
  for (const e of map.edges) { by[e.type].get(e.a).add(e.b); by[e.type].get(e.b).add(e.a); }
  const union = (types) => new Map(ids.map((i) => [i, new Set(types.flatMap((t) => [...by[t].get(i)]))]));
  const all = union(['cab', 'tram', 'metro', 'ferry']);
  const det = union(['cab', 'tram', 'metro']);
  const st = {};
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const pairsMean = (D) => { let s = 0, c = 0; for (const u of ids) for (const v of ids) if (u < v) { s += D.get(u).get(v) ?? 1e9; c++; } return s / c; };
  const diam = (D) => Math.max(...ids.map((u) => Math.max(...D.get(u).values())));

  const deg = ids.map((i) => all.get(i).size);
  st.avgDegree = mean(deg);
  st.avgTicketOptions = (2 * map.edges.length) / N;
  st.maxDegree = Math.max(...deg);
  st.deg2 = deg.filter((d) => d === 2).length / N;
  st.deg3 = deg.filter((d) => d === 3).length / N;
  st.deg4 = deg.filter((d) => d === 4).length / N;
  st.deg56 = deg.filter((d) => d === 5 || d === 6).length / N;
  st.deg7p = deg.filter((d) => d >= 7).length / N;
  const layer = (t) => {
    const nodes = ids.filter((i) => by[t].get(i).size);
    return { stops: nodes.length, links: map.edges.filter((e) => e.type === t).length, deg: nodes.length ? mean(nodes.map((i) => by[t].get(i).size)) : 0 };
  };
  const cab = layer('cab'), tram = layer('tram'), metro = layer('metro');
  st.cabDegree = cab.deg;
  st.tramStops = tram.stops; st.tramLinks = tram.links; st.tramDegree = tram.deg;
  st.metroStops = metro.stops; st.metroLinks = metro.links; st.metroDegree = metro.deg;

  const DA = bfsAll(ids, (u) => all.get(u));
  const ecc = ids.map((u) => Math.max(...DA.get(u).values()));
  st.diameter = Math.max(...ecc);
  st.radius = Math.min(...ecc);
  st.avgDist = pairsMean(DA);
  st.avgDistNoFerry = pairsMean(bfsAll(ids, (u) => det.get(u)));
  const DC = bfsAll(ids, (u) => by.cab.get(u));
  st.cabDiameter = diam(DC);
  st.avgDistCab = pairsMean(DC);
  const cabTram = union(['cab', 'tram']);
  st.avgDistCabTram = pairsMean(bfsAll(ids, (u) => cabTram.get(u)));

  st.cutVertices = cutVertices(ids, all).length;
  let cl = 0, tri = 0;
  for (const i of ids) {
    const nb = [...all.get(i)];
    let links = 0;
    for (let a = 0; a < nb.length; a++) for (let b = a + 1; b < nb.length; b++) if (all.get(nb[a]).has(nb[b])) links++;
    tri += links;
    if (nb.length > 1) cl += links / ((nb.length * (nb.length - 1)) / 2);
  }
  st.clustering = cl / N;
  st.triangles = tri / 3;
  st.maxBetweenness = betweennessMax(ids, all);

  for (const k of [2, 3, 4]) st[`reach${k}`] = mean(ids.map((u) => [...DA.get(u).values()].filter((d) => d > 0 && d <= k).length));

  // Fugitive's possible stations after a reveal, given the public ticket log (ignores detectives).
  const step = (S, t) => {
    const out = new Set();
    for (const s of S) for (const v of t === 'secret' ? all.get(s) : by[t].get(s)) out.add(v);
    return out;
  };
  const cand = (seq) => {
    const sizes = [];
    for (const i of ids) {
      let S = new Set([i]);
      for (const t of seq) S = step(S, t);
      if (S.size) sizes.push(S.size);
    }
    return mean(sizes);
  };
  st.candCab3 = cand(['cab', 'cab', 'cab']);
  st.candCab5 = cand(['cab', 'cab', 'cab', 'cab', 'cab']);
  st.candTram = cand(['tram']);
  st.candCabTram = cand(['cab', 'tram']);
  st.candSecret2 = cand(['secret', 'secret']);

  const metroSet = ids.filter((i) => by.metro.get(i).size);
  st.avgDistToMetro = mean(ids.map((u) => Math.min(...metroSet.map((m) => DA.get(u).get(m)))));

  // Start deals: 5 detectives + fugitive.
  const detPool = map.detStarts || map.starts;
  const fugPool = map.fugStarts || map.starts;
  const rng = mulberry(1);
  const gaps = [], cover = [];
  for (let n = 0; n < 4000; n++) {
    const pool = detPool.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const ds = pool.slice(0, 5);
    const fp = fugPool.filter((s) => !ds.includes(s));
    const x = fp[Math.floor(rng() * fp.length)];
    gaps.push(Math.min(...ds.map((d) => DA.get(x).get(d))));
    const seen = new Set();
    for (const d of ds) for (const [v, k] of DA.get(d)) if (k <= 2) seen.add(v);
    cover.push(seen.size / N);
  }
  st.startGap = mean(gaps);
  st.startGap2 = gaps.filter((g) => g <= 2).length / gaps.length;
  st.startCover2 = mean(cover);
  return st;
}

module.exports = { computeStats, loadTextMap, SY_DET, SY_FUG };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--sy');
  const cols = require('./genmap.js').loadMaps().map(({ data }) => [data.name, computeStats(data)]);
  if (i >= 0) cols.push(['Scotland Yard', computeStats(loadTextMap(args[i + 1]))]);
  const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(3));
  console.log('stat'.padEnd(18) + cols.map(([n]) => n.padStart(15)).join(''));
  for (const k of Object.keys(cols[0][1])) console.log(k.padEnd(18) + cols.map(([, s]) => fmt(s[k]).padStart(15)).join(''));
}
