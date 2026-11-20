/* Nightfall Run — SVG board renderer with pan & zoom. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // a police-badge shield about the size of a piece disc (r 23), centred on the station
  const SHIELD_PTS = [[0, -27], [8, -21], [15, -20], [23, -20], [23, 0], [18, 17], [0, 27], [-18, 17], [-23, 0], [-23, -20], [-15, -20], [-8, -21], [0, -27]];
  /** The shield outline scaled by k (1 = about a piece disc, r 23). */
  const shield = (k) => {
    const p = SHIELD_PTS.map(([x, y]) => `${(x * k).toFixed(1)} ${(y * k).toFixed(1)}`);
    return `M${p[0]} C${p[1]} ${p[2]} ${p[3]} C${p[4]} ${p[5]} ${p[6]} C${p[7]} ${p[8]} ${p[9]} C${p[10]} ${p[11]} ${p[12]} Z`;
  };
  const SHIELD = shield(1.12);       // covers the station underneath, number and all
  const SHIELD_HALO = shield(1.7);

  // ---------- night lighting ----------
  // The sky over the 24 moves: [progress, west, middle, east (r, g, b, alpha), darkness
  // outside the detectives' torchlight]. Dusk glows in the west, dawn in the east.
  const SKY = [
    [0, [255, 128, 72, 0.34], [160, 80, 130, 0.16], [70, 60, 150, 0.14], 0.36],
    [0.2, [170, 80, 120, 0.14], [60, 40, 110, 0.1], [30, 30, 90, 0.1], 0.45],
    [0.5, [0, 0, 12, 0.24], [0, 0, 12, 0.26], [0, 0, 12, 0.24], 0.56],
    [0.8, [10, 10, 40, 0.16], [30, 30, 90, 0.12], [100, 80, 160, 0.14], 0.47],
    [1, [110, 100, 170, 0.12], [200, 130, 140, 0.14], [255, 168, 104, 0.34], 0.3],
  ];
  const SUNRISE = [[255, 200, 160, 0.2], [255, 184, 130, 0.26], [255, 196, 128, 0.46], 0];
  const POOL_R = 270; // radius of a detective's torchlight
  // how fast pieces travel, in map units per millisecond
  const SPEED = { cab: 0.42, tram: 0.8, metro: 1.3, ferry: 0.38 };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  /** A small deterministic hash in [0, 1), so the lit windows stay put between redraws. */
  const hash = (a, b) => {
    let h = Math.imul((a * 73856093) ^ (b * 19349663), 2654435761) >>> 0;
    h ^= h >>> 15;
    return (Math.imul(h, 2246822519) >>> 0) / 4294967296;
  };

  class BoardView {
    constructor(svg, map) {
      this.svg = svg;
      this.onStationClick = null;
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      this.layers = {};
      for (const name of [
        'bg', 'blocks', 'parks', 'river', 'bridges', 'roads', 'sky', 'glow', 'lines', 'labels', 'ferry', 'dark',
        'preview', 'candidates', 'route', 'trails', 'highlight', 'stations', 'crossings', 'pieces', 'fx',
      ]) {
        this.layers[name] = el('g', { class: `layer-${name}` }, svg);
      }
      for (const name of ['pieces', 'crossings', 'route', 'candidates', 'highlight', 'preview', 'labels', 'blocks', 'bridges',
        'roads', 'sky', 'glow', 'dark', 'trails', 'fx']) {
        this.layers[name].style.pointerEvents = 'none';
      }
      this.defs = el('defs', {});
      svg.insertBefore(this.defs, svg.firstChild);
      this.buildDefs();
      this.effects = true;
      this.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.sky = { p: 0, sunrise: false };
      this.pieceState = new Map(); // piece key -> {pos} as last drawn
      this.pieceNodes = new Map(); // piece key -> its <g>
      this.poolNodes = new Map();  // detective key -> its torchlight circle in the mask
      this.anims = new Map();      // piece key -> a move in progress
      this.trails = new Map();     // piece key -> trail paths still fading
      this.tweens = new Set();     // other frame-by-frame effects: fn(now) -> keep going?
      this.animEnd = 0;
      this.raf = null;
      this.fxSeq = 0;
      this.key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
      this.setMap(map);
      this.bindPanZoom();
      this.bindHover();
    }

    /** Gradients and the torchlight mask, shared by every map. */
    buildDefs() {
      const d = this.defs;
      const grad = (tag, id, attrs, stops) => {
        const g = el(tag, { id, ...attrs }, d);
        for (const [o, c, a] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g);
        return g;
      };
      this.skyStops = [...grad('linearGradient', 'sky-grad', { x1: 0, y1: 0, x2: 1, y2: 0 },
        [[0, '#000', 0], [0.5, '#000', 0], [1, '#000', 0]]).children];
      grad('radialGradient', 'pool-grad', {}, [[0, '#000', 1], [0.45, '#000', 0.92], [1, '#000', 0]]);
      grad('radialGradient', 'torch-grad', {}, [[0, '#ffe2a0', 0.2], [0.5, '#ffd98a', 0.08], [1, '#ffd98a', 0]]);
      grad('radialGradient', 'fog-grad', {}, [[0, '#d4e0f7', 0.5], [0.55, '#b9c9ea', 0.26], [1, '#b9c9ea', 0]]);
      grad('radialGradient', 'spot-grad', {}, [[0, '#fff6dc', 0.7], [0.45, '#ffe7a8', 0.32], [1, '#ffe7a8', 0]]);
      grad('radialGradient', 'sun-grad', {}, [[0, '#ffd39a', 0.55], [0.5, '#ffb784', 0.22], [1, '#ffb784', 0]]);
      this.torchMask = el('mask', { id: 'torch-mask', maskUnits: 'userSpaceOnUse' }, d);
      this.torchMaskRect = el('rect', { fill: '#fff' }, this.torchMask);
      this.poolG = el('g', {}, this.torchMask);
    }

    /** Shows a different map: clears every layer and redraws, keeping the event handlers. */
    setMap(map) {
      this.map = map;
      this.st = new Map(map.stations.map((s) => [s.id, s]));
      this.legalRoutes = new Map();
      this.clearFx();
      for (const name in this.layers) this.clear(name);
      this.pieceState.clear();
      this.pieceNodes.clear();
      this.anims.clear();
      this.trails.clear();
      this.poolNodes.clear();
      while (this.poolG.firstChild) this.poolG.removeChild(this.poolG.firstChild);
      const big = { x: -400, y: -400, width: map.width + 800, height: map.height + 800 };
      for (const n of [this.torchMask, this.torchMaskRect]) for (const k in big) n.setAttribute(k, big[k]);
      this.edgeByType = new Map();
      for (const e of map.edges) this.edgeByType.set(`${e.type}:${this.key(e.a, e.b)}`, e);
      // street shapes (generated maps bend their streets; older maps are straight)
      const key = this.key;
      this.curves = new Map();
      for (const e of map.edges) {
        if (e.type !== 'cab') continue;
        const pts = (e.curve || [[this.st.get(e.a).x, this.st.get(e.a).y], [this.st.get(e.b).x, this.st.get(e.b).y]]).map(([x, y]) => ({ x, y }));
        this.curves.set(key(e.a, e.b), { from: e.a, pts });
      }
      this.links = new Map(); // tram/metro link endpoints -> edge, for drawing routes
      for (const e of map.edges) if (e.type === 'tram' || e.type === 'metro') this.links.set(key(e.a, e.b), e);
      this.drawStatic();
      this.fit();
    }

    drawStatic() {
      const m = this.map;
      const L = this.layers;
      el('rect', { x: -400, y: -400, width: m.width + 800, height: m.height + 800, class: 'map-outside' }, L.bg);
      el('rect', { x: 0, y: 0, width: m.width, height: m.height, rx: 24, class: 'map-bg' }, L.bg);

      const D = m.decor || {};
      for (const [x, y] of D.plazas || []) el('circle', { cx: x, cy: y, r: 50, class: 'plaza' }, L.blocks);
      // buildings, about a third of them with a few lit windows
      for (const [x, y, w, h, a] of D.buildings || []) {
        const transform = `translate(${x} ${y}) rotate(${a})`;
        const r = hash(Math.round(x), Math.round(y));
        if (r > 0.36 || w < 12 || h < 10) {
          el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 2, class: 'building', transform }, L.blocks);
          continue;
        }
        const bg = el('g', { transform }, L.blocks);
        el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 2, class: 'building' }, bg);
        const cols = Math.max(1, Math.floor((w - 5) / 7)), rows = Math.max(1, Math.floor((h - 5) / 7));
        const n = 1 + Math.floor(hash(Math.round(y), Math.round(x)) * 3);
        for (let i = 0; i < n; i++) {
          const k = hash(Math.round(x) + i * 7, Math.round(y) - i * 13);
          const cx = -w / 2 + 3 + (Math.floor(k * cols) % cols) * 7;
          const cy = -h / 2 + 3 + (Math.floor(k * 977) % rows) * 7;
          el('rect', { x: cx, y: cy, width: 4.2, height: 4.2, rx: 0.8, class: k < 0.3 ? 'window dim' : 'window' }, bg);
        }
      }

      for (const p of m.parks) {
        el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 36, class: 'park' }, L.parks);
        el('rect', { x: p.x + 10, y: p.y + 10, width: p.w - 20, height: p.h - 20, rx: 28, class: 'park-inner' }, L.parks);
      }
      for (const path of D.paths || []) el('path', { d: 'M' + path.map(([x, y]) => `${x} ${y}`).join('L'), class: 'park-path' }, L.parks);
      for (const [x, y, rx, ry] of D.ponds || []) el('ellipse', { cx: x, cy: y, rx, ry, class: 'pond' }, L.parks);
      for (const [x, y, r] of D.trees || []) {
        el('circle', { cx: x, cy: y + 2, r, class: 'tree-shade' }, L.parks);
        el('circle', { cx: x, cy: y, r, class: 'tree' }, L.parks);
      }

      const hw = m.river.halfWidth;
      const pts = m.river.points;
      // banks are offset at right angles to the river, so steep bends keep their width
      const bank = (side) => pts.map(([x, y], i) => {
        const [ax, ay] = pts[Math.max(0, i - 1)];
        const [bx, by] = pts[Math.min(pts.length - 1, i + 1)];
        const len = Math.hypot(bx - ax, by - ay) || 1;
        return `${(x + ((by - ay) / len) * hw * side).toFixed(1)},${(y - ((bx - ax) / len) * hw * side).toFixed(1)}`;
      });
      const upper = bank(1);
      const lower = bank(-1).reverse();
      const clip = el('clipPath', { id: 'map-clip' }, L.river);
      el('rect', { x: 0, y: 0, width: m.width, height: m.height, rx: 24 }, clip);
      const rg = el('g', { 'clip-path': 'url(#map-clip)' }, L.river);
      el('polygon', { points: upper.concat(lower).join(' '), class: 'river' }, rg);
      if (D.riverName) {
        el('path', { id: 'river-centre', d: 'M' + pts.map(([x, y]) => `${x} ${y + 24}`).join('L'), fill: 'none' }, rg);
        const rt = el('text', { class: 'river-name' }, rg);
        // start the name at decor.riverLabelX, measured along the river's centre line
        let off = 0;
        for (let i = 0; i + 1 < pts.length && pts[i + 1][0] <= (D.riverLabelX ?? m.width * 0.22); i++) off += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        const tp = el('textPath', { href: '#river-centre', startOffset: off.toFixed(0) }, rt);
        tp.textContent = D.riverName;
      }
      for (const [x1, y1, x2, y2] of D.bridges || []) {
        el('line', { x1, y1, x2, y2, class: 'bridge-edge' }, L.bridges);
        el('line', { x1, y1, x2, y2, class: 'bridge' }, L.bridges);
      }
      if (D.parkName) {
        const pt = el('text', { x: D.parkName.x, y: D.parkName.y, class: 'park-name' }, L.parks);
        pt.textContent = D.parkName.text;
      }
      for (const lb of D.labels || []) {
        const t = el('text', { x: lb.x, y: lb.y, class: 'district-name', 'font-size': lb.size }, L.labels);
        t.textContent = lb.text;
      }

      // the sky's tint over the ground, and the darkness outside the detectives' torchlight
      const all = { x: -400, y: -400, width: m.width + 800, height: m.height + 800 };
      el('rect', { ...all, fill: 'url(#sky-grad)' }, L.sky);
      this.darkRect = el('rect', { ...all, class: 'darkness', mask: 'url(#torch-mask)' }, L.dark);
      this.applySky();

      // Every tram/metro link runs along cab streets. Work out, street by street,
      // which services share it, then draw each street as a bundle of parallel lines.
      const key = this.key;
      const streets = new Map();
      for (const e of m.edges) if (e.type === 'cab') streets.set(key(e.a, e.b), { a: e.a, b: e.b, dir: null, metro: false });
      for (const e of m.edges) {
        if (e.type !== 'tram' && e.type !== 'metro') continue;
        for (let i = 0; i + 1 < e.path.length; i++) {
          const st = streets.get(key(e.path[i], e.path[i + 1]));
          if (!st) continue;
          if (e.type === 'tram') st.dir = [e.path[i], e.path[i + 1]];
          else st.metro = true;
        }
      }
      this.orientStreets(streets);
      const GAP = 7.5;
      this.streetLanes = streets;
      this.GAP = GAP;
      this.crossings = this.findCrossings();
      const XR = 40; // lanes stop this far from a crossing; drawCrossings joins them up
      const groups = { cab: el('g', {}, L.lines), tram: el('g', {}, L.lines), metro: el('g', {}, L.lines) };
      for (const st of streets.values()) {
        // Offsets are measured relative to the street's reference direction (orientStreets),
        // chosen so each tram and metro line keeps to the same side all the way along.
        const [f, t] = st.ref;
        const pts = this.streetPts(f, t);
        el('path', { d: this.offsetPath(pts, 0), class: 'road' }, L.roads);
        const lanes = !st.dir
          ? [['cab', 0]]
          : !st.metro
            ? [['cab', -GAP / 2], ['tram', GAP / 2]]
            : [['metro', -GAP], ['cab', 0], ['tram', GAP]];
        for (const [type, o] of lanes) {
          let lp = this.offsetPts(pts, o);
          if (type !== 'cab') {
            for (const end of [f, t]) {
              if (!this.crossings[type].has(end)) continue;
              const c = this.st.get(end);
              lp = lp.filter((p) => Math.hypot(p.x - c.x, p.y - c.y) >= XR);
              const r = this.clipNear(this.offsetPts(pts, o), c, XR - 0.01, XR + 0.01, end === t);
              if (r.length) lp = end === t ? [...lp, r[r.length - 1]] : [r[0], ...lp];
            }
          }
          const d = 'M' + lp.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L');
          el('path', { d, class: `edge edge-${type}` }, groups[type]);
          // tram and metro lines glow like signal lamps; cab streets stay street-level
          if (type !== 'cab') el('path', { d, class: `edge-glow edge-glow-${type}` }, L.glow);
        }
      }
      for (const e of m.edges) {
        if (e.type === 'ferry') el('path', { d: 'M' + e.line.map(([x, y]) => `${x} ${y}`).join('L'), class: 'edge edge-ferry' }, L.ferry);
      }

      // A station is coloured by the best service that stops there.
      const types = new Map(m.stations.map((s) => [s.id, new Set()]));
      for (const e of m.edges) {
        types.get(e.a).add(e.type);
        types.get(e.b).add(e.type);
      }
      this.stationTypes = types;
      this.stationNodes = new Map();
      for (const s of m.stations) {
        const t = types.get(s.id);
        const tier = t.has('metro') ? 'metro' : t.has('tram') ? 'tram' : 'cab';
        const r = tier === 'metro' ? 21 : tier === 'tram' ? 19 : 17;
        const g = el('g', { class: `station tier-${tier}`, transform: `translate(${s.x} ${s.y})`, 'data-id': s.id }, L.stations);
        el('circle', { r: 32, class: 'st-hit' }, g);
        el('circle', { r: r + 9, class: 'st-glow' }, g);
        if (t.has('ferry')) el('circle', { r: r + 6, class: 'st-ferry' }, g);
        el('circle', { r, class: 'st-core' }, g);
        const txt = el('text', { class: 'st-num' }, g);
        txt.textContent = s.id;
        this.stationNodes.set(s.id, g);
      }
      this.drawCrossings(groups);
    }

    /**
     * Gives every street a reference direction st.ref = [from, to]; lanes are offset
     * relative to it (tram to the left, metro to the right). A line keeps to the same
     * side of its streets only if, at each station it passes, it runs with the reference
     * on both streets or against it on both. That is a parity constraint between the two
     * streets, solved with a union-find that tracks parity: first every pass-through
     * station inside a link (always solvable on these maps), then, where possible, links
     * of the same kind that carry straight on through a stop.
     */
    orientStreets(streets) {
      const key = this.key;
      const parent = new Map(), par = new Map(); // street -> parent, flip relative to parent
      const find = (s) => {
        if (!parent.has(s)) { parent.set(s, s); par.set(s, 0); }
        let r = s, p = 0;
        while (parent.get(r) !== r) { p ^= par.get(r); r = parent.get(r); }
        return [r, p];
      };
      // a line goes p -> x -> n: flips of streets (p,x) and (x,n), measured from their
      // low-to-high direction, must differ exactly when the line's direction does
      const join = (p, x, n) => {
        const s1 = key(p, x), s2 = key(x, n);
        if (!streets.has(s1) || !streets.has(s2)) return;
        const c = (p < x) !== (x < n) ? 1 : 0;
        const [r1, p1] = find(s1), [r2, p2] = find(s2);
        if (r1 !== r2) { parent.set(r2, r1); par.set(r2, p1 ^ p2 ^ c); }
      };
      const ends = new Map(); // 'type:stop' -> neighbours of the stop along its links
      for (const e of this.map.edges) {
        if (e.type !== 'tram' && e.type !== 'metro') continue;
        const P = e.path;
        for (let i = 1; i + 1 < P.length; i++) join(P[i - 1], P[i], P[i + 1]);
        for (const [x, nb] of [[P[0], P[1]], [P[P.length - 1], P[P.length - 2]]]) {
          const k = `${e.type}:${x}`;
          if (!ends.has(k)) ends.set(k, { x, nbs: [] });
          ends.get(k).nbs.push(nb);
        }
      }
      // through a stop: pair up links that leave it in near-opposite directions, straightest first
      for (const { x, nbs } of ends.values()) {
        const c = this.st.get(x);
        const ang = (n) => Math.atan2(this.st.get(n).y - c.y, this.st.get(n).x - c.x);
        const pairs = [];
        for (let i = 0; i < nbs.length; i++) {
          for (let j = i + 1; j < nbs.length; j++) {
            let d = Math.abs(ang(nbs[i]) - ang(nbs[j]));
            d = Math.min(d, 2 * Math.PI - d);
            if (d > 2.3) pairs.push([d, nbs[i], nbs[j]]);
          }
        }
        pairs.sort((u, v) => v[0] - u[0]);
        const used = new Set();
        for (const [, p, n] of pairs) {
          if (used.has(p) || used.has(n)) continue;
          used.add(p); used.add(n);
          join(p, x, n);
        }
      }
      for (const [k, st] of streets) {
        const lo = Math.min(st.a, st.b), hi = Math.max(st.a, st.b);
        st.ref = find(k)[1] ? [hi, lo] : [lo, hi];
      }
    }

    /** Lane points of a tram/metro line along the street from a to b (same offsets as the
     * street bundles drawn above). */
    lanePts(type, a, b) {
      const st = this.streetLanes.get(this.key(a, b));
      const [f, t] = st ? st.ref : [a, b];
      const o = type === 'metro' ? -this.GAP : st && st.metro ? this.GAP : this.GAP / 2;
      const pts = this.offsetPts(this.streetPts(f, t), o);
      return f === a ? pts : pts.reverse();
    }

    /**
     * Where two lines of the same kind both pass through a station without stopping, the
     * street bundles alone meet in the middle and you cannot tell which way each line goes.
     * Draw each line through such a station as one continuous curve on top of it, the later
     * one bridging over the earlier (a road-coloured casing), with the station number on top.
     */
    /** {tram, metro}: Map station -> [[prev, next], ...] for stations that two or more lines
     * of that kind pass through without stopping. */
    findCrossings() {
      const res = {};
      for (const type of ['tram', 'metro']) {
        const through = new Map();
        const stops = new Set();
        for (const e of this.map.edges) {
          if (e.type !== type) continue;
          stops.add(e.a); stops.add(e.b);
          for (let i = 1; i + 1 < e.path.length; i++) {
            const x = e.path[i];
            if (!through.has(x)) through.set(x, []);
            through.get(x).push([e.path[i - 1], e.path[i + 1]]);
          }
        }
        res[type] = new Map([...through].filter(([x, ls]) => ls.length > 1 && !stops.has(x)));
      }
      return res;
    }

    drawCrossings(groups) {
      const g = this.clear('crossings');
      const R = 40; // matches XR in setMap: the lanes stop here
      for (const type of ['tram', 'metro']) {
        for (const [x, lines] of this.crossings[type]) {
          const c = this.st.get(x);
          const xg = el('g', { class: `crossing crossing-${type}` }, g);
          lines.forEach(([u, v], li) => {
            const inn = this.clipNear(this.lanePts(type, u, x), c, R - 0.5, 1.5 * R, true);
            const out = this.clipNear(this.lanePts(type, x, v), c, R - 0.5, 1.5 * R, false);
            const p = inn[inn.length - 1];
            const q = out[0];
            const di = this.unit(inn[inn.length - 2], p);
            const dq = this.unit(q, out[1]);
            const k = 0.9 * R;
            const f = (pt) => `${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
            let mid;
            if (li === 0) {
              // through the middle, under the station disc
              mid = `C${f({ x: p.x + di.x * k, y: p.y + di.y * k })} ${f({ x: q.x - dq.x * k, y: q.y - dq.y * k })} ${f(q)}`;
            } else {
              // around the station disc, on the side away from the first line
              const AR = 27;
              const ang = (pt) => Math.atan2(pt.y - c.y, pt.x - c.x);
              const a1 = ang(p), a2 = ang(q);
              const first = lines[0];
              const side = this.sideAway(c, a1, a2, [ang(this.st.get(first[0])), ang(this.st.get(first[1]))]);
              const s1 = { x: c.x + AR * Math.cos(a1), y: c.y + AR * Math.sin(a1) };
              const s2 = { x: c.x + AR * Math.cos(a2), y: c.y + AR * Math.sin(a2) };
              const sweep = side > 0 ? 1 : 0;
              let span = (a2 - a1) * (sweep ? 1 : -1);
              span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
              mid = `L${f(s1)}A${AR} ${AR} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${f(s2)}L${f(q)}`;
            }
            const d = 'M' + inn.map(f).join('L') + mid + 'L' + out.slice(1).map(f).join('L');
            if (li === 0) {
              // the first line runs under the station, like the other lines do
              el('path', { d, class: `edge edge-${type}` }, groups[type]);
            } else {
              // the others bridge over it: a road-coloured casing, then the line
              el('path', { d, class: 'crossing-casing' }, xg);
              el('path', { d, class: `edge edge-${type} crossing-line` }, xg);
            }
          });
          const t = el('text', { x: c.x, y: c.y, class: 'crossing-num' }, xg);
          t.textContent = x;
        }
      }
    }

    /** The part of a polyline between distances r0 and r1 from point c; `ending` means the
     * line runs towards c (keep its far part first). */
    clipNear(pts, c, r0, r1, ending) {
      const seq = ending ? pts.slice().reverse() : pts;   // now starting at c, running away
      const dist = (p) => Math.hypot(p.x - c.x, p.y - c.y);
      const out = [];
      for (let i = 0; i + 1 < seq.length; i++) {
        const a = seq[i], b = seq[i + 1];
        const da = dist(a), db = dist(b);
        for (const r of [r0, r1]) {
          if ((da - r) * (db - r) < 0) {
            const f = (r - da) / (db - da);
            out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, r });
          }
        }
        if (db > r0 && db < r1) out.push({ ...b, r: db });
        if (db >= r1) break;
      }
      const res = out.sort((p, q) => p.r - q.r);
      if (res.length < 2) res.push({ x: seq[seq.length - 1].x, y: seq[seq.length - 1].y });
      return ending ? res.reverse() : res;
    }

    /** Which way to go round a station from angle a1 to a2 (+1 clockwise in screen
     * coordinates, -1 the other way) so the arc keeps clear of the arms at angles `avoid`. */
    sideAway(c, a1, a2, avoid) {
      const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const cw = norm(a2 - a1);            // arc length going with increasing angle
      const inArc = (x, dir) => (dir > 0 ? norm(x - a1) < cw : norm(a1 - x) < 2 * Math.PI - cw);
      const hits = (dir) => avoid.filter((x) => inArc(x, dir)).length;
      const h1 = hits(1), h2 = hits(-1);
      if (h1 !== h2) return h1 < h2 ? 1 : -1;
      return cw <= Math.PI ? 1 : -1;      // otherwise the shorter way round
    }

    unit(a, b) {
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    }

    /** Points along the street from station a to station b (straight if there is none). */
    streetPts(a, b) {
      const c = this.curves.get(this.key(a, b));
      if (!c) return [this.st.get(a), this.st.get(b)];
      return c.from === a ? c.pts : c.pts.slice().reverse();
    }

    /** Points along a sequence of stations, following streets between neighbours. */
    pathPts(ids) {
      const out = [this.st.get(ids[0])];
      for (let i = 0; i + 1 < ids.length; i++) out.push(...this.streetPts(ids[i], ids[i + 1]).slice(1));
      return out;
    }

    /** Points for one move from a to b: along the street, or along the tram/metro line. */
    linkPts(a, b) {
      if (this.curves.has(this.key(a, b))) return this.streetPts(a, b);
      const e = this.links.get(this.key(a, b));
      if (e) return this.pathPts(e.path[0] === a ? e.path : e.path.slice().reverse());
      return [this.st.get(a), this.st.get(b)];
    }

    /** A polyline shifted sideways by o (positive = left of travel). */
    offsetPts(pts, o) {
      const n = pts.length;
      return pts.map((p, i) => {
        if (!o) return { x: p.x, y: p.y };
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(n - 1, i + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: p.x - ((b.y - a.y) / len) * o, y: p.y + ((b.x - a.x) / len) * o };
      });
    }

    /** SVG path for a polyline shifted sideways by o (positive = left of travel). */
    offsetPath(pts, o) {
      return 'M' + this.offsetPts(pts, o).map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L');
    }

    /** Points along an edge, for drawing a route preview. */
    edgePoints(e, from) {
      if (e.type === 'ferry') {
        let pts = e.line.map(([x, y]) => ({ x, y }));
        const first = this.st.get(from);
        if (pts.length && (pts[0].x !== first.x || pts[0].y !== first.y)) pts = pts.slice().reverse();
        return pts;
      }
      const ids = e.path || [e.a, e.b];
      return this.pathPts(ids[0] === from ? ids : ids.slice().reverse());
    }

    /** routes: Map<stationId, [{edge, from, color}]> shown when hovering a legal destination. */
    setLegalRoutes(routes) {
      this.legalRoutes = routes || new Map();
      this.clear('preview');
    }

    showPreview(id) {
      const g = this.clear('preview');
      const list = this.legalRoutes.get(id);
      if (!list) return;
      for (const { edge, from, color } of list) {
        const pts = this.edgePoints(edge, from);
        el('polyline', { points: pts.map((p) => `${p.x},${p.y}`).join(' '), class: 'preview-line', style: `stroke:${color}` }, g);
      }
    }

    bindHover() {
      let current = null;
      this.svg.addEventListener('pointerover', (e) => {
        const st = e.target.closest && e.target.closest('.station');
        const id = st ? Number(st.getAttribute('data-id')) : null;
        if (id === current) return;
        current = id;
        if (id && this.legalRoutes.has(id)) this.showPreview(id);
        else this.clear('preview');
      });
      this.svg.addEventListener('pointerleave', () => {
        current = null;
        this.clear('preview');
      });
    }

    // ---------- dynamic layers ----------
    clear(layer) {
      const g = this.layers[layer];
      while (g.firstChild) g.removeChild(g.firstChild);
      return g;
    }

    setHighlights(ids, color) {
      const g = this.clear('highlight');
      for (const id of ids) {
        const s = this.st.get(id);
        const h = el('g', { transform: `translate(${s.x} ${s.y})` }, g);
        el('circle', { r: 36, class: 'hl', style: `stroke:${color};fill:${color}` }, h);
      }
      for (const [id, node] of this.stationNodes) node.classList.toggle('legal', ids.includes(id));
    }

    /** Stations the fugitive could be at, drawn as a cold fog that drifts. */
    setCandidates(ids) {
      const g = this.clear('candidates');
      for (const id of ids) {
        const s = this.st.get(id);
        el('circle', { cx: s.x, cy: s.y, r: 64, class: 'candidate', fill: 'url(#fog-grad)', style: `--d:${(hash(id, 5) * 6).toFixed(2)}` }, g);
      }
    }

    /**
     * pieces: [{key, pos, color, badge, kind, active, via}]. via = {from, ticket}: the move
     * that brought the piece here; when the piece was last drawn at `from`, it travels
     * there along the route instead of jumping. Detectives carry torchlight.
     */
    setPieces(pieces) {
      const g = this.clear('pieces');
      this.pieceNodes.clear();
      const keep = new Set();
      for (const p of pieces) {
        const key = p.key || `${p.kind}:${p.badge}`;
        keep.add(key);
        const prev = this.pieceState.get(key);
        let anim = this.anims.get(key);
        if (anim && anim.to !== p.pos) { this.fadeTrail(anim); this.anims.delete(key); anim = null; }
        if (!anim && p.via && prev && prev.pos === p.via.from && p.via.from !== p.pos && !this.reduced) {
          this.startMove(key, p.via.from, p.pos, p.via.ticket);
        }
        this.pieceState.set(key, { pos: p.pos });
        const s = this.st.get(p.pos);
        const pg = el('g', { transform: `translate(${s.x} ${s.y})`, class: `piece ${p.kind}${p.active ? ' active' : ''}` }, g);
        this.pieceNodes.set(key, pg);
        // detectives are badge-shaped so they never read as a station (stations are round);
        // the fugitive stays a disc
        if (p.kind === 'detective') {
          // a pulsing shield-shaped halo marks every detective; the number matches the panel
          el('path', { d: SHIELD_HALO, class: 'det-halo', style: `stroke:${p.color};fill:${p.color}` }, pg);
          if (p.active) el('circle', { r: 40, class: 'piece-active', style: `stroke:${p.color}` }, pg);
          el('path', { d: SHIELD, class: 'piece-disc', style: `fill:${p.color}` }, pg);
          const n = el('text', { class: 'det-num', y: -1 }, pg);
          n.textContent = p.badge;
          continue;
        } else {
          if (p.active) el('circle', { r: 31, class: 'piece-active', style: `stroke:${p.color}` }, pg);
          el('circle', { r: 23, class: 'piece-disc', style: `fill:${p.color}` }, pg);
        }
        const t = el('text', { class: 'piece-num' }, pg);
        t.textContent = p.pos;
        const bg = el('g', { transform: 'translate(20 -20)' }, pg);
        el('circle', { r: 10, class: 'piece-badge', style: `stroke:${p.color}` }, bg);
        const bt = el('text', { class: 'piece-badge-text', style: `fill:${p.color}` }, bg);
        bt.textContent = p.badge;
      }
      // a piece taken off the board (the fugitive hidden again) loses its move and trail at
      // once, so nothing is left behind for the other side to see
      for (const k of [...this.pieceState.keys()]) {
        if (keep.has(k)) continue;
        this.pieceState.delete(k);
        this.anims.delete(k);
        for (const t of this.trails.get(k) || []) t.remove();
        this.trails.delete(k);
      }
      // torchlight: one pool per detective, cut out of the darkness
      // (a hole in the darkness's mask, and a faint warm glow on the streets beneath)
      for (const [k, c] of this.poolNodes) if (!keep.has(k)) { c.forEach((n) => n.remove()); this.poolNodes.delete(k); }
      for (const p of pieces) {
        if (p.kind !== 'detective') continue;
        const key = p.key || `${p.kind}:${p.badge}`;
        let c = this.poolNodes.get(key);
        if (!c) {
          c = [el('circle', { r: POOL_R, fill: 'url(#pool-grad)' }, this.poolG),
            el('circle', { r: POOL_R * 0.9, fill: 'url(#torch-grad)', class: 'torch' }, this.layers.sky)];
          this.poolNodes.set(key, c);
        }
        const s = this.st.get(p.pos);
        c.forEach((n) => { n.setAttribute('cx', s.x); n.setAttribute('cy', s.y); });
      }
      this.tick(performance.now());
    }

    // ---------- movement ----------
    /** The route a move from a to b takes on the given ticket: {type, pts}. A secret
     * ticket takes the ferry where there is one, else the fastest line between them. */
    movePts(a, b, ticket) {
      const k = this.key(a, b);
      const order = ticket === 'secret' ? ['ferry', 'metro', 'tram', 'cab'] : [ticket];
      for (const type of order) {
        const e = this.edgeByType.get(`${type}:${k}`);
        if (e) return { type, pts: this.edgePoints(e, a) };
      }
      return { type: 'cab', pts: this.linkPts(a, b) };
    }

    startMove(key, from, to, ticket) {
      const { type, pts } = this.movePts(from, to, ticket);
      const cum = [0];
      for (let i = 0; i + 1 < pts.length; i++) cum.push(cum[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
      const total = cum[cum.length - 1] || 1;
      const dur = Math.min(1150, Math.max(380, total / (SPEED[type] || 0.6)));
      const trail = el('path', { class: `trail trail-${ticket === 'secret' ? 'secret' : type}` }, this.layers.trails);
      if (!this.trails.has(key)) this.trails.set(key, []);
      this.trails.get(key).push(trail);
      const anim = { to, pts, cum, total, dur, t0: performance.now(), trail, key };
      this.anims.set(key, anim);
      this.animEnd = Math.max(this.animEnd, anim.t0 + dur);
      this.loop();
    }

    /** The point a fraction f of the way along a move, and the route up to it. */
    along(a, f) {
      const d = a.total * f;
      let i = 0;
      while (i + 2 < a.cum.length && a.cum[i + 1] < d) i++;
      const seg = a.cum[i + 1] - a.cum[i] || 1;
      const t = Math.min(1, Math.max(0, (d - a.cum[i]) / seg));
      const p = { x: a.pts[i].x + (a.pts[i + 1].x - a.pts[i].x) * t, y: a.pts[i].y + (a.pts[i + 1].y - a.pts[i].y) * t };
      return { p, done: a.pts.slice(0, i + 1).concat([p]) };
    }

    loop() {
      if (!this.raf) this.raf = requestAnimationFrame((now) => { this.raf = null; this.tick(now); });
    }

    tick(now) {
      let more = false;
      for (const [key, a] of this.anims) {
        const t = Math.min(1, (now - a.t0) / a.dur);
        const { p, done } = this.along(a, easeInOut(t));
        const node = this.pieceNodes.get(key);
        if (node) node.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
        for (const n of this.poolNodes.get(key) || []) { n.setAttribute('cx', p.x.toFixed(1)); n.setAttribute('cy', p.y.toFixed(1)); }
        a.trail.setAttribute('d', 'M' + done.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join('L'));
        if (t < 1) { more = true; continue; }
        this.anims.delete(key);
        this.fadeTrail(a);
      }
      for (const fn of this.tweens) if (fn(now)) more = true; else this.tweens.delete(fn);
      if (more) this.loop();
    }

    /** A finished (or interrupted) move's trail lingers a moment, then fades away. */
    fadeTrail(a) {
      const tr = a.trail;
      setTimeout(() => tr.classList.add('fading'), 250);
      setTimeout(() => {
        tr.remove();
        const list = this.trails.get(a.key);
        if (list) this.trails.set(a.key, list.filter((x) => x !== tr));
      }, 3000);
    }

    /** Milliseconds until the moves on screen have finished. */
    busyMs() {
      return Math.max(0, this.animEnd - performance.now());
    }

    tween(fn) {
      this.tweens.add(fn);
      this.loop();
    }

    // ---------- sky and lighting ----------
    /** p: how far through the night (0 dusk .. 1 dawn). Kept at sunrise once sunrise() ran. */
    setSky(p) {
      this.sky.p = p;
      this.applySky();
    }

    applySky() {
      let cols, dark;
      if (this.sky.sunrise) {
        cols = SUNRISE.slice(0, 3);
        dark = SUNRISE[3];
      } else {
        const p = Math.min(1, Math.max(0, this.sky.p));
        let i = 0;
        while (i + 2 < SKY.length && SKY[i + 1][0] < p) i++;
        const [a, b] = [SKY[i], SKY[i + 1]];
        const f = (p - a[0]) / (b[0] - a[0] || 1);
        const mix = (u, v) => u.map((x, j) => x + (v[j] - x) * f);
        cols = [1, 2, 3].map((j) => mix(a[j], b[j]));
        dark = a[4] + (b[4] - a[4]) * f;
      }
      cols.forEach(([r, g, b, al], j) => {
        this.skyStops[j].style.stopColor = `rgb(${r | 0},${g | 0},${b | 0})`;
        this.skyStops[j].style.stopOpacity = this.effects ? al.toFixed(3) : 0;
      });
      if (this.darkRect) this.darkRect.style.opacity = this.effects ? dark.toFixed(3) : 0;
    }

    /** Turns the night lighting (sky, darkness, searchlights) on or off. */
    setEffects(on) {
      this.effects = !!on;
      this.layers.dark.style.display = on ? '' : 'none';
      this.layers.sky.classList.toggle('lights-off', !on);
      if (!on) this.clear('fx');
      this.applySky();
    }

    clearFx() {
      this.tweens.clear();
      if (this.layers.fx) this.clear('fx');
      if (this.layers.sky) this.layers.sky.querySelectorAll('.fx-sun').forEach((n) => n.remove());
      this.sky.sunrise = false;
      if (this.skyStops) this.applySky();
    }

    get fxOn() {
      return this.effects && !this.reduced;
    }

    /** A reveal: the view pans to the station and a searchlight sweeps onto it. */
    revealAt(pos) {
      this.centerOn(pos);
      if (!this.fxOn) return;
      const s = this.st.get(pos);
      const g = el('g', { class: 'fx-reveal' }, this.layers.fx);
      const ax = s.x < this.map.width / 2 ? s.x + 700 : s.x - 700; // the lamp stands off to one side
      const ay = s.y - 950;
      const len = Math.hypot(s.x - ax, s.y - ay) + 160;
      const aim = Math.atan2(s.y - ay, s.x - ax);
      const from = aim + (ax > s.x ? 0.5 : -0.5);
      const gid = `beam-${++this.fxSeq}`;
      const lg = el('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: ax, y1: ay, x2: s.x, y2: s.y }, g);
      for (const [o, a] of [[0, 0], [0.6, 0.08], [1, 0.3]]) el('stop', { offset: o, 'stop-color': '#fff3cf', 'stop-opacity': a }, lg);
      const beam = el('path', { fill: `url(#${gid})` }, g);
      el('circle', { cx: s.x, cy: s.y, r: 110, fill: 'url(#spot-grad)', class: 'fx-spot' }, g);
      el('circle', { cx: s.x, cy: s.y, r: 40, class: 'fx-ring' }, g);
      const half = 0.075;
      const t0 = performance.now();
      this.tween((now) => {
        const t = now - t0;
        const ang = from + (aim - from) * easeOut(Math.min(1, t / 1100));
        const p = (a) => `${(ax + len * Math.cos(a)).toFixed(1)} ${(ay + len * Math.sin(a)).toFixed(1)}`;
        beam.setAttribute('d', `M${ax} ${ay}L${p(ang - half)}A${len.toFixed(1)} ${len.toFixed(1)} 0 0 1 ${p(ang + half)}Z`);
        g.style.opacity = t < 2600 ? 1 : Math.max(0, 1 - (t - 2600) / 900);
        if (t < 3500) return true;
        g.remove();
        return false;
      });
    }

    /** The detectives win: darkness closes in on the station, ringed by their colours. */
    capture(pos, colors) {
      if (!this.fxOn) return;
      const s = this.st.get(pos);
      const m = this.map;
      const all = { x: -400, y: -400, width: m.width + 800, height: m.height + 800 };
      const g = el('g', { class: 'fx-capture' }, this.layers.fx);
      const mid = `capture-${++this.fxSeq}`;
      const mask = el('mask', { id: mid, maskUnits: 'userSpaceOnUse', ...all }, g);
      el('rect', { ...all, fill: '#fff' }, mask);
      const hole = el('circle', { cx: s.x, cy: s.y, r: 1600, fill: 'url(#pool-grad)' }, mask);
      const shade = el('rect', { ...all, class: 'fx-shade', mask: `url(#${mid})` }, g);
      colors.forEach((c, i) => el('circle', { cx: s.x, cy: s.y, r: 70 + i * 13, class: 'fx-close', style: `stroke:${c};animation-delay:${(i * 0.12).toFixed(2)}s,${(1.9 + i * 0.12).toFixed(2)}s` }, g));
      const t0 = performance.now();
      this.tween((now) => {
        const f = easeInOut(Math.min(1, (now - t0) / 1700));
        hole.setAttribute('r', (1600 - f * 1340).toFixed(0));
        shade.style.opacity = (f * 0.55).toFixed(3);
        return f < 1;
      });
    }

    /** The fugitive escapes: the sun comes up in the east and the darkness lifts. */
    sunrise() {
      this.sky.sunrise = true;
      this.applySky();
      if (!this.fxOn) return;
      const m = this.map;
      el('circle', { cx: m.width + 150, cy: m.height * 0.4, r: 1800, fill: 'url(#sun-grad)', class: 'fx-sun' }, this.layers.sky);
    }

    /** ghost: {pos, round} | null;  route: [stationIds] | null */
    setRoute(ghost, route) {
      const g = this.clear('route');
      if (route && route.length > 1) {
        const legs = route.slice(1).map((id, i) => this.linkPts(route[i], id));
        const all = [legs[0][0], ...legs.flatMap((l) => l.slice(1))];
        el('path', { d: 'M' + all.map((p) => `${p.x} ${p.y}`).join('L'), class: 'route-line' }, g);
        route.forEach((id, i) => {
          if (i === 0) return;
          const { x: mx, y: my } = this.midpoint(legs[i - 1]);
          el('circle', { cx: mx, cy: my, r: 11, class: 'route-step' }, g);
          const t = el('text', { x: mx, y: my, class: 'route-step-text' }, g);
          t.textContent = i;
        });
      }
      if (ghost) {
        const s = this.st.get(ghost.pos);
        const gg = el('g', { transform: `translate(${s.x} ${s.y})` }, g);
        el('circle', { r: 38, class: 'ghost' }, gg);
        el('rect', { x: -40, y: -68, width: 80, height: 24, rx: 12, class: 'ghost-tag' }, gg);
        const t = el('text', { y: -56, class: 'ghost-text' }, gg);
        t.textContent = `seen · ${ghost.round}`;
      }
    }

    /** Point halfway along a polyline. */
    midpoint(pts) {
      const seg = [];
      let total = 0;
      for (let i = 0; i + 1 < pts.length; i++) { const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); seg.push(l); total += l; }
      let left = total / 2;
      for (let i = 0; i < seg.length; i++) {
        if (left <= seg[i]) { const t = seg[i] ? left / seg[i] : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }; }
        left -= seg[i];
      }
      return pts[pts.length - 1];
    }

    // ---------- view ----------
    applyViewBox() {
      const v = this.vb;
      this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    }

    fit() {
      this.panToken = null;
      this.vb = { x: -20, y: -20, w: this.map.width + 40, h: this.map.height + 40 };
      this.applyViewBox();
    }

    clientToSvg(cx, cy) {
      const pt = this.svg.createSVGPoint();
      pt.x = cx;
      pt.y = cy;
      return pt.matrixTransform(this.svg.getScreenCTM().inverse());
    }

    zoomAt(p, f) {
      this.panToken = null;
      const v = this.vb;
      const nw = Math.min(Math.max(v.w * f, 350), this.map.width * 1.6);
      const k = nw / v.w;
      this.vb = { x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k, w: v.w * k, h: v.h * k };
      this.applyViewBox();
    }

    zoomCenter(f) {
      const v = this.vb;
      this.zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, f);
    }

    /** Pan so a station is visible — only matters when zoomed in. */
    centerOn(id) {
      const s = this.st.get(id);
      const v = { ...this.vb };
      if (v.w >= this.map.width * 0.85) return;
      const to = this.clamp({ x: s.x - v.w / 2, y: s.y - v.h / 2, w: v.w, h: v.h });
      if (this.reduced) { this.vb = to; this.applyViewBox(); return; }
      const t0 = performance.now();
      const token = (this.panToken = {});
      this.tween((now) => {
        if (this.panToken !== token) return false; // the player panned or zoomed meanwhile
        const f = easeInOut(Math.min(1, (now - t0) / 650));
        this.vb = { x: v.x + (to.x - v.x) * f, y: v.y + (to.y - v.y) * f, w: v.w, h: v.h };
        this.applyViewBox();
        return f < 1;
      });
    }

    clamp(v) {
      const m = this.map;
      const pad = 200;
      const x = Math.min(Math.max(v.x, -pad), Math.max(-pad, m.width + pad - v.w));
      const y = Math.min(Math.max(v.y, -pad), Math.max(-pad, m.height + pad - v.h));
      return { ...v, x, y };
    }

    bindPanZoom() {
      const svg = this.svg;
      let drag = null;
      svg.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          this.zoomAt(this.clientToSvg(e.clientX, e.clientY), Math.exp(e.deltaY * 0.0015));
        },
        { passive: false }
      );
      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, vb: { ...this.vb }, moved: false };
      });
      window.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        drag.moved = true;
        this.panToken = null;
        svg.classList.add('panning');
        const rect = svg.getBoundingClientRect();
        const ratio = Math.max(drag.vb.w / rect.width, drag.vb.h / rect.height);
        this.vb = this.clamp({ ...drag.vb, x: drag.vb.x - dx * ratio, y: drag.vb.y - dy * ratio });
        this.applyViewBox();
      });
      window.addEventListener('pointerup', (e) => {
        if (!drag) return;
        const wasDrag = drag.moved;
        drag = null;
        svg.classList.remove('panning');
        if (wasDrag) return;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const st = target && target.closest && target.closest('.station');
        if (st && svg.contains(st) && this.onStationClick) {
          this.onStationClick(Number(st.getAttribute('data-id')), e.clientX, e.clientY);
        }
      });
    }
  }

  root.BoardView = BoardView;
})(window);
