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

  class BoardView {
    constructor(svg, map) {
      this.svg = svg;
      this.onStationClick = null;
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      this.layers = {};
      for (const name of [
        'bg', 'blocks', 'parks', 'river', 'bridges', 'roads', 'lines', 'labels', 'ferry', 'preview',
        'candidates', 'route', 'highlight', 'stations', 'pieces',
      ]) {
        this.layers[name] = el('g', { class: `layer-${name}` }, svg);
      }
      for (const name of ['pieces', 'route', 'candidates', 'highlight', 'preview', 'labels', 'blocks', 'bridges', 'roads']) {
        this.layers[name].style.pointerEvents = 'none';
      }
      this.key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
      this.setMap(map);
      this.bindPanZoom();
      this.bindHover();
    }

    /** Shows a different map: clears every layer and redraws, keeping the event handlers. */
    setMap(map) {
      this.map = map;
      this.st = new Map(map.stations.map((s) => [s.id, s]));
      this.legalRoutes = new Map();
      for (const name in this.layers) this.clear(name);
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
      for (const [x, y, w, h, a] of D.buildings || []) {
        el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 2, class: 'building', transform: `translate(${x} ${y}) rotate(${a})` }, L.blocks);
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
      const GAP = 7.5;
      const groups = { cab: el('g', {}, L.lines), tram: el('g', {}, L.lines), metro: el('g', {}, L.lines) };
      for (const st of streets.values()) {
        // Offsets are measured relative to the tram line's direction of travel, so a tram
        // line keeps to the same side of its street all the way along.
        const [f, t] = st.dir || [st.a, st.b];
        const pts = this.streetPts(f, t);
        el('path', { d: this.offsetPath(pts, 0), class: 'road' }, L.roads);
        const lanes = !st.dir
          ? [['cab', 0]]
          : !st.metro
            ? [['cab', -GAP / 2], ['tram', GAP / 2]]
            : [['metro', -GAP], ['cab', 0], ['tram', GAP]];
        for (const [type, o] of lanes) el('path', { d: this.offsetPath(pts, o), class: `edge edge-${type}` }, groups[type]);
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
        if (t.has('ferry')) el('circle', { r: r + 6, class: 'st-ferry' }, g);
        el('circle', { r, class: 'st-core' }, g);
        const txt = el('text', { class: 'st-num' }, g);
        txt.textContent = s.id;
        this.stationNodes.set(s.id, g);
      }
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

    /** SVG path for a polyline shifted sideways by o (positive = left of travel). */
    offsetPath(pts, o) {
      const n = pts.length;
      const out = pts.map((p, i) => {
        if (!o) return p;
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(n - 1, i + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: p.x - ((b.y - a.y) / len) * o, y: p.y + ((b.x - a.x) / len) * o };
      });
      return 'M' + out.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L');
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

    setCandidates(ids) {
      const g = this.clear('candidates');
      for (const id of ids) {
        const s = this.st.get(id);
        el('circle', { cx: s.x, cy: s.y, r: 31, class: 'candidate' }, g);
      }
    }

    /** pieces: [{pos, color, badge, kind, active}] */
    setPieces(pieces) {
      const g = this.clear('pieces');
      for (const p of pieces) {
        const s = this.st.get(p.pos);
        const pg = el('g', { transform: `translate(${s.x} ${s.y})`, class: `piece ${p.kind}${p.active ? ' active' : ''}` }, g);
        if (p.active) el('circle', { r: 31, class: 'piece-active', style: `stroke:${p.color}` }, pg);
        el('circle', { r: 23, class: 'piece-disc', style: `fill:${p.color}` }, pg);
        const t = el('text', { class: 'piece-num' }, pg);
        t.textContent = p.pos;
        const bg = el('g', { transform: 'translate(20 -20)' }, pg);
        el('circle', { r: 10, class: 'piece-badge', style: `stroke:${p.color}` }, bg);
        const bt = el('text', { class: 'piece-badge-text', style: `fill:${p.color}` }, bg);
        bt.textContent = p.badge;
      }
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
      const v = this.vb;
      if (v.w >= this.map.width * 0.85) return;
      this.vb = this.clamp({ x: s.x - v.w / 2, y: s.y - v.h / 2, w: v.w, h: v.h });
      this.applyViewBox();
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
