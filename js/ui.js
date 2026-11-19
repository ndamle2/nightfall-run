/* Nightfall Run — game controller: turn flow, hot-seat privacy, panel UI, save/resume. */
(function () {
  'use strict';
  const E = window.Engine;
  // Every map registers itself in window.MAPS; the first one loaded is the default.
  const MAPS = window.MAPS || {};
  const MAP_KEYS = Object.keys(MAPS);
  let MAP = null;
  let MAP_KEY = null;
  let ADJ = null;
  const SAVE_KEY = 'nightfall-run:save:v1';
  const PREF_KEY = 'nightfall-run:prefs:v1';
  const RECORDS_KEY = 'nightfall-run:records:v1'; // human-vs-bot games kept in the browser
  const MAX_LOCAL_RECORDS = 300;

  // ---------- computer players ----------
  // The strong bots (alpha-beta fugitive, ISMCTS detectives: js/ai/, ports of the Python
  // bots in ai/) run in the browser, in a Web Worker when one can start, else on the page.
  // The basic bots in js/bots.js are the last resort if they fail.
  // Game records: served by `python3 -m ai.serve`, every game is saved to data/games/; with
  // a records address in js/config.js, finished games are also sent there (a Google Sheet,
  // see tools/sheets/); and the browser keeps its own copy for download.
  const CONFIG = window.NIGHTFALL_CONFIG || {};
  const PLAY_MODES = {
    hotseat: 'Pass and play: everyone at this computer',
    'human-fugitive': 'Play the fugitive against computer detectives',
    'human-detectives': 'Play the detectives against a computer fugitive',
  };
  let server = null; // null while unknown, then true / false
  const AI_BOTS = (window.AIPlayers && window.AIPlayers.BOTS) || { engine: 'browser-basic' };
  let botCtx = null; // js/bots.js context for the current map
  let botRun = 0; // bumped to cancel a bot turn in progress
  let turnReadyAt = Date.now(); // when the current move could first be made (thinking time)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Runs the strong bots: ai.call('move' | 'review', record) → Promise of the result. */
  const ai = (() => {
    let worker = null;
    let broken = !window.Worker || !window.AIPlayers;
    let seq = 0;
    const pending = new Map(); // id -> {resolve, reject, op, record}
    const mapsSent = new Set();
    const onPage = (op, record) => {
      if (!window.AIPlayers) throw new Error('the computer players did not load');
      const m = MAPS[record.map];
      return op === 'move' ? AIPlayers.botMove(m, record) : AIPlayers.review(m, record);
    };
    function fail() {
      // a worker that cannot start (e.g. a page opened from disk): run on the page instead
      broken = true;
      if (worker) worker.terminate();
      worker = null;
      const left = [...pending.values()];
      pending.clear();
      for (const p of left) setTimeout(() => { try { p.resolve(onPage(p.op, p.record)); } catch (e) { p.reject(e); } }, 0);
    }
    function start() {
      try {
        worker = new Worker('js/ai/worker.js');
      } catch (e) { fail(); return; }
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.result);
        else p.reject(new Error(e.data.error));
      };
      worker.onerror = (e) => { e.preventDefault(); fail(); };
    }
    function call(op, record) {
      if (!broken && !worker) start();
      if (broken) {
        // give the page a moment to draw first (the search blocks it while it runs)
        return sleep(40).then(() => onPage(op, record));
      }
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, op, record });
        const msg = { id, op, map: record.map, record };
        if (!mapsSent.has(record.map)) { msg.mapData = MAPS[record.map]; mapsSent.add(record.map); }
        worker.postMessage(msg);
      });
    }
    return { call, get onPage() { return broken; } };
  })();
  const BOT_STEP_MS = 450; // minimum time each bot move stays on screen
  // post-game review (ai/review.py via the server): {id, status, data}; shown on the board
  let review = { id: null, status: 'idle', data: null };
  let reviewOpen = false;

  // How often the detectives win, by city and number of detectives: computer vs computer
  // (ISMCTS detectives against the alpha-beta fugitive; 228 games per cell for 3-5 detectives,
  // so about ±5-6 points; 48 games for 2),
  // measured November 2026 on the current cities (README, "Balance"). Regenerate a city and
  // these need re-measuring.
  const CITY_BALANCE = {
    twin: { 2: 6, 3: 28, 4: 65, 5: 83 },
    harbour: { 2: 0, 3: 11, 4: 36, 5: 54 },
    quarter: { 2: 4, 3: 25, 4: 57, 5: 82 },
    market: { 2: 0, 3: 18, 4: 59, 5: 83 },
    hill: { 2: 0, 3: 24, 4: 55, 5: 79 },
  };
  const CITY_NOTE = { harbour: 'hardest for the detectives' };

  const DET_PRESETS = [
    { name: 'Blue', color: '#2f6fd0' },
    { name: 'Orange', color: '#e07a1f' },
    { name: 'Violet', color: '#8657c6' },
    { name: 'Brown', color: '#8a5a2e' }, // no line, ticket or station uses brown
    { name: 'Rose', color: '#cf4a8c' },
  ];
  const FUG_COLOR = '#2e2c2a';
  const FUG_HL = '#d99a12';
  const TICKETS = {
    cab: { label: 'Cab', color: 'var(--cab)' },
    tram: { label: 'Tram', color: 'var(--tram)' },
    metro: { label: 'Metro', color: 'var(--metro)' },
    secret: { label: 'Secret', color: 'var(--secret)' },
    double: { label: 'Double', color: 'var(--double)' },
  };

  const LINE_COLORS = { cab: '#e8ad35', tram: '#2f9c6b', metro: '#cf4a40', ferry: '#3f7dc8' };
  const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  let EDGES_BY_PAIR = new Map();
  /** For hover previews: which concrete lines could carry each legal move. */
  function legalRoutes(from, moves) {
    const out = new Map();
    for (const m of moves) {
      const types = new Set(m.tickets.includes('secret') ? E.TRANSPORTS : m.tickets);
      const list = (EDGES_BY_PAIR.get(pairKey(from, m.to)) || [])
        .filter((e) => types.has(e.type))
        .map((edge) => ({ edge, from, color: LINE_COLORS[edge.type] }));
      out.set(m.to, list);
    }
    return out;
  }

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let board = null;

  /** Switches the city shown on the board (and used for new games). */
  function useMap(key) {
    if (!MAPS[key]) key = MAP_KEYS[0];
    if (key === MAP_KEY) return;
    MAP_KEY = key;
    MAP = MAPS[key];
    ADJ = E.buildAdjacency(MAP);
    EDGES_BY_PAIR = new Map();
    for (const e of MAP.edges) {
      const k = pairKey(e.a, e.b);
      if (!EDGES_BY_PAIR.has(k)) EDGES_BY_PAIR.set(k, []);
      EDGES_BY_PAIR.get(k).push(e);
    }
    botCtx = null; // built on first use
    if (board) board.setMap(MAP);
    else board = new BoardView($('#board'), MAP);
    const sub = document.querySelector('.brand .sub');
    if (sub) sub.textContent = `A chase through the city of ${MAP.name}`;
  }

  // mode: 'setup' | 'handoff-fugitive' | 'fugitive' | 'handoff-detectives' | 'detectives' | 'over'
  let game = null;
  let mode = 'setup';
  let turnSnapshot = null; // game state at the start of the fugitive's turn (for undo)
  let undoStack = []; // detective moves this phase
  let prefs = loadPrefs();
  let gameMapKey = null; // the city the current game is played in
  useMap(prefs.mapKey);

  // ---------- persistence ----------
  function loadPrefs() {
    try {
      return { showPossible: false, ...(JSON.parse(localStorage.getItem(PREF_KEY)) || {}) };
    } catch (e) {
      return { showPossible: false };
    }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }
  function save() {
    if (!game) return;
    // Never persist a half-finished fugitive turn: store the start-of-turn snapshot instead.
    const data = mode === 'fugitive'
      ? { game: turnSnapshot, mode: 'handoff-fugitive', mapKey: gameMapKey, mapSeed: MAPS[gameMapKey].seed }
      : { game, mode, mapKey: gameMapKey, mapSeed: MAPS[gameMapKey].seed };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }
  function loadSave() {
    try {
      const d = JSON.parse(localStorage.getItem(SAVE_KEY));
      // a save from a map that has since been regenerated would put pieces on unrelated stations
      const m = d && MAPS[d.mapKey];
      return d && d.game && d.game.version === 1 && m && d.mapSeed === m.seed ? d : null;
    } catch (e) {
      return null;
    }
  }
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  }

  // ---------- game records (human vs bot) ----------
  const playMode = () => (game && game.meta && game.meta.mode) || 'hotseat';
  const humanIs = (side) => playMode() === `human-${side}`;
  const vsBot = () => playMode() !== 'hotseat';

  function newGameId() {
    const rnd = Math.random().toString(36).slice(2, 10);
    return `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${rnd}`;
  }

  /** Appends an action to the game's history (kept inside the state, so undo and saves
   * carry it). by: 'human' | 'server' | 'browser'; ms: thinking time. */
  function record(action, by, ms) {
    if (!game.history) game.history = [];
    const now = Date.now();
    game.history.push({ ...action, by, ms: ms != null ? ms : now - turnReadyAt });
    turnReadyAt = now;
  }

  function buildRecord() {
    return {
      schema: 1,
      app: 'nightfall-run',
      id: game.meta.id,
      mode: game.meta.mode,
      map: gameMapKey,
      mapSeed: MAPS[gameMapKey].seed,
      detectives: game.detectives.length,
      fugitiveStart: game.fugitive.start,
      detectiveStarts: game.detectives.map((d) => d.start),
      history: game.history || [],
      bots: AI_BOTS,
      player: (prefs.player || '').trim() || null,
      result: game.winner ? { winner: game.winner, reason: game.reason, round: game.round } : null,
      created: game.meta.created,
      updated: new Date().toISOString(),
    };
  }

  function localRecords() {
    try { return JSON.parse(localStorage.getItem(RECORDS_KEY)) || []; } catch (e) { return []; }
  }
  function storeLocalRecord(rec) {
    try {
      const list = localRecords().filter((r) => r.id !== rec.id);
      list.push(rec);
      localStorage.setItem(RECORDS_KEY, JSON.stringify(list.slice(-MAX_LOCAL_RECORDS)));
    } catch (e) { /* storage full or blocked: the game still works */ }
  }

  /** Saves the game's record (against the computer or pass and play): to the server when
   * there is one, else in the browser; a finished game also goes to the records address. */
  function saveRecord() {
    if (!game || !game.meta) return;
    const rec = buildRecord();
    if (server) {
      fetch('api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: rec }) })
        .then((r) => { if (!r.ok) throw new Error(); })
        .catch(() => storeLocalRecord(rec));
    } else storeLocalRecord(rec);
    if (rec.result) sendRecord(rec);
  }

  /** Sends a record to the records address in js/config.js (once per game and length).
   * beacon: use navigator.sendBeacon, which still works while the page is closing. */
  function sendRecord(rec, beacon = false) {
    const url = CONFIG.recordsUrl;
    if (!url || !rec.history.length) return;
    const tag = `${rec.id}:${rec.history.length}:${rec.result ? 1 : 0}`;
    if (game && game.meta && game.meta.sent === tag) return;
    if (game && game.meta && game.meta.id === rec.id) game.meta.sent = tag;
    const body = JSON.stringify(rec);
    try {
      // text/plain keeps it a "simple" request: Apps Script answers without CORS preflight
      if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      else fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body, keepalive: body.length < 60000 });
    } catch (e) { /* offline: the browser copy remains */ }
  }

  // A game left unfinished (tab closed mid-game) is sent as far as it got.
  window.addEventListener('pagehide', () => {
    if (game && game.meta && !game.winner && (game.history || []).length >= 6) sendRecord(buildRecord(), true);
  });

  function downloadRecords() {
    const blob = new Blob([JSON.stringify(localRecords(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nightfall-run-games-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Finds out whether the page is served by ai.serve; if so, hands it any records the
   * browser kept while it ran without the server. */
  async function detectServer() {
    // ai.serve only ever runs on your own machine: elsewhere (a static host) don't probe
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (!/^https?:$/.test(location.protocol) || !(local || CONFIG.probeServer)) { server = false; return; }
    try {
      const r = await fetch('api/ping', { cache: 'no-store' });
      const d = await r.json();
      server = !!d.ok;
    } catch (e) {
      server = false;
    }
    if (server) {
      const pending = localRecords();
      const left = [];
      for (const rec of pending) {
        try {
          const r = await fetch('api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: rec }) });
          if (!r.ok) left.push(rec);
        } catch (e) { left.push(rec); }
      }
      try {
        if (left.length) localStorage.setItem(RECORDS_KEY, JSON.stringify(left));
        else localStorage.removeItem(RECORDS_KEY);
      } catch (e) { /* ignore */ }
    }
  }

  /** Asks the server to review the finished game (once per game). */
  function requestReview() {
    if (!game || !game.meta || review.id === game.meta.id) return;
    const id = game.meta.id;
    review = { id, status: 'loading', data: null };
    ai.call('review', buildRecord())
      .then((d) => { if (review.id === id) review = { id, status: 'ready', data: d }; })
      .catch((e) => { if (review.id === id) review = { id, status: 'error', data: e.message }; })
      .finally(() => { if (review.id === id) renderReview(); });
  }

  const VERDICT = {
    best: ['Good', 'good'], ok: ['OK', 'ok'], weak: ['Weak', 'weak'], blunder: ['Mistake', 'bad'],
    lost: ['Lost', 'lost'], unusual: ['Unusual', 'ok'],
  };
  const fmtTurn = (t) => (t.double ? '2× ' : '') + t.moves.map((m) => `${TICKETS[m.ticket].label} ${m.to}`).join(', ');

  function renderReview() {
    const el = $('#review');
    if (!el) return;
    const show = mode === 'over' && reviewOpen && game && game.meta && review.id === game.meta.id;
    el.classList.toggle('hidden', !show);
    if (!show) return;
    let body = '';
    if (review.status === 'loading') body = '<p class="hint">Reviewing your game…</p>';
    else if (review.status === 'error') body = `<p class="hint">The review failed: ${esc(review.data)}</p>`;
    else if (review.status === 'ready') {
      const d = review.data;
      if (d.side === 'both') {
        body += `<h3>For ${esc(game.fugitive.name)}</h3>` + reviewPart(d.fugitive, false) +
          '<h3>For the detectives</h3>' + reviewPart(d.detectives, false);
      } else body += reviewPart(d, true);
    }
    el.innerHTML = `<h2>Game review</h2>${body}`;
    el.querySelectorAll('tr[data-at]').forEach((tr) =>
      tr.addEventListener('click', () => board.centerOn(Number(tr.dataset.at))));
  }

  /** One side's lessons and table. you: the reader played this side alone against the computer. */
  function reviewPart(d, you) {
    let body = '<ul class="lessons">' + d.lessons.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>';
    const me = you ? 'You' : d.side === 'fugitive' ? 'Fugitive' : 'Detectives';
    {
      if (d.side === 'fugitive') {
        body += `<details open><summary>Move by move <span class="fineprint">(click a row to show the station)</span></summary>
          <table class="review-table"><tr><th>Move</th><th>${me}</th><th>Bot</th><th></th><th title="moves to the nearest detective">Near</th><th title="stations you could reach before any detective">Room</th><th title="stations the detectives had to consider">Cands</th></tr>` +
          d.turns.map((t) => {
            const [label, cls] = VERDICT[t.verdict] || ['', ''];
            const mv = t.last > t.move ? `${t.move}–${t.last}` : `${t.move}`;
            return `<tr data-at="${t.at}" title="${esc(t.why)}"><td>${mv}${t.reveal ? ' 👁' : ''}</td><td>${esc(fmtTurn(t.you))}</td>
              <td>${t.same ? '=' : esc(fmtTurn(t.bot))}</td><td><span class="verdict ${cls}">${label}</span></td>
              <td>${t.nearest ?? '–'}</td><td>${t.room ?? '–'}</td><td>${t.candidates ?? '–'}</td></tr>`;
          }).join('') + '</table></details>';
      } else {
        body += `<details open><summary>Round by round <span class="fineprint">(click a row to show where the fugitive was)</span></summary>
          <table class="review-table"><tr><th>After</th><th>Fugitive</th><th>${you ? 'Your moves' : 'Detectives'}</th><th>Bot</th></tr>` +
          d.rounds.map((r) => `<tr data-at="${r.fugitive_at}"><td>${r.move}</td><td>${r.fugitive_at} <span class="fineprint">(${r.candidates} possible)</span></td>
            <td>${r.moves.map((m) => `<span class="${m.missed_catch ? 'verdict bad' : m.caught ? 'verdict good' : ''}">${m.detective}: ${m.to}</span>`).join(' ')}</td>
            <td>${r.moves.map((m) => (m.same ? '=' : m.bot.to)).join(' ')}</td></tr>`).join('') + '</table></details>';
      }
    }
    return body;
  }

  /** The bot's next actions: the fugitive's whole turn, or the current detective's move. */
  let strongBots = true; // false after the strong bots fail: the basic ones finish the game
  async function botActions() {
    const t0 = Date.now();
    if (strongBots) {
      try {
        const acts = await ai.call('move', buildRecord());
        return acts.map((a) => ({ ...a, by: 'browser-ai', ms: Date.now() - t0 }));
      } catch (e) {
        strongBots = false;
        toast(`The computer players hit a problem (${e.message}); simpler bots take over.`, 6000);
      }
    }
    if (!botCtx) botCtx = Bots.context(MAP, ADJ);
    const acts = game.phase === 'fugitive'
      ? Bots.fugitiveTurn(game, botCtx).map((a) => ({ side: 'F', ...a }))
      : [{ side: 'D', i: game.current, ...Bots.detectiveMove(game, botCtx) }];
    return acts.map((a) => ({ ...a, by: 'browser-basic', ms: Date.now() - t0 }));
  }

  /** Plays one bot action on the game through the engine (which checks it is legal). */
  function applyBotAction(a) {
    const { by, ms, ...act } = a;
    if (act.type === 'double') E.useDouble(game);
    else if (act.side === 'F') E.moveFugitive(game, ADJ, act.to, act.ticket);
    else {
      if (act.i !== game.current) throw new Error('bot moved out of turn');
      E.moveDetective(game, ADJ, act.to, act.ticket);
    }
    record(act, by, ms);
  }

  async function runBotTurn() {
    const run = ++botRun;
    const g = game;
    const alive = () => run === botRun && game === g && !game.winner;
    const side = game.phase === 'fugitive' ? 'fugitive' : 'detectives';
    while (alive() && (side === 'fugitive' ? game.phase === 'fugitive' : game.phase === 'detectives')) {
      const t0 = Date.now();
      let acts;
      try {
        acts = await botActions();
      } catch (e) {
        toast(`The computer ${side} could not move: ${e.message}`, 6000);
        return;
      }
      if (!alive()) return;
      for (const a of acts) {
        try {
          applyBotAction(a);
        } catch (e) {
          // an answer the page's engine rejects: use the basic bots from here
          strongBots = false;
          toast('The computer players made an illegal move; simpler bots take over.', 6000);
          break;
        }
      }
      const wait = BOT_STEP_MS - (Date.now() - t0);
      if (side === 'detectives') {
        render();
        if (wait > 0) await sleep(wait);
      }
    }
    if (run !== botRun || game !== g) return; // cancelled (new game, resume, …)
    turnReadyAt = Date.now();
    saveRecord();
    if (game.winner) return enterMode('over');
    if (side === 'fugitive') {
      enterMode('detectives');
      announceFugitiveTurn();
    } else beginFugitiveTurn();
  }

  // ---------- modal helpers ----------
  function openModal(html, { opaque = false } = {}) {
    $('#modal').innerHTML = html;
    $('#overlay').classList.toggle('opaque', opaque);
    $('#overlay').classList.remove('hidden');
  }
  function closeModal() {
    $('#overlay').classList.add('hidden');
  }

  let toastTimer = null;
  function toast(text, ms = 3500) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------- setup ----------
  function showSetup() {
    botRun++;
    mode = 'setup';
    closePicker();
    // every new game starts in a random city (the list still lets you pick)
    useMap(MAP_KEYS[Math.floor(Math.random() * MAP_KEYS.length)]);
    if (game) { board.setPieces([]); board.setHighlights([], '#000'); board.setCandidates([]); board.setRoute(null, null); }
    const saved = loadSave();
    const resumable = saved && saved.game.phase !== 'over';
    openModal(`
      <h2>Nightfall Run</h2>
      <p>One player is the <b>Fugitive</b>, moving in secret through <span id="city-name">${esc(MAP.name)}</span>. Everyone else plays the
      <b>Detectives</b>, working together to land on the fugitive's station within 24 moves.</p>
      <div class="form-grid">
        <label for="map-pick">City</label>
        <select id="map-pick">
          ${MAP_KEYS.map((k) => `<option value="${k}" ${k === MAP_KEY ? 'selected' : ''}>${esc(MAPS[k].name)}</option>`).join('')}
        </select>
        <span></span><span class="fineprint"><span id="city-blurb">${esc(MAP.blurb || '')}</span>
          <a href="#" id="balance-link" class="balance-link">How hard is each city?</a></span>
        <span></span><div id="balance-pop" class="balance-pop hidden"></div>
        <label for="play-mode">Players</label>
        <select id="play-mode">
          ${Object.entries(PLAY_MODES).map(([k, label]) => `<option value="${k}" ${k === (prefs.playMode || 'hotseat') ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <span></span><span class="fineprint" id="bot-note"></span>
        <label for="player-name">Your name</label>
        <input type="text" id="player-name" value="${esc(prefs.player || '')}" maxlength="30" placeholder="optional">
        <label for="f-name">Fugitive</label>
        <input type="text" id="f-name" value="The Fugitive" maxlength="20">
        <label for="n-det">Detectives</label>
        <select id="n-det">
          ${[2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      <div id="det-names" class="form-grid"></div>
      <p class="fineprint">Fewer people than pieces? One person can control several detectives.
      The fugitive gets one secret ticket per detective. More detectives make the chase tighter.</p>
      <div class="row">
        <button class="btn big" id="btn-start">Start game</button>
        ${resumable ? `<button class="btn ghost big" id="btn-resume">Resume saved game in ${esc(MAPS[saved.mapKey].name)} (move ${saved.game.round}/24)</button>` : ''}
        ${game ? '<button class="btn ghost big" id="btn-cancel">Cancel</button>' : ''}
      </div>
      <p class="fineprint" id="records-note"></p>`);
    const renderBotNote = () => {
      const pm = $('#play-mode').value;
      const note = $('#bot-note');
      const sent = CONFIG.recordsUrl
        ? ' Finished games (the moves, the city, and your name if you give one) are sent to the game’s maker to help improve the bots.'
        : server ? ' This game is recorded to data/games/.' : '';
      if (pm === 'hotseat') note.textContent = sent.trim();
      else note.textContent = `The computer plays at full strength, in your browser.${sent}`;
      const n = localRecords().length;
      $('#records-note').innerHTML = !server && n
        ? `${n} game${n > 1 ? 's' : ''} against the computer recorded in this browser. <a href="#" id="dl-records">Download the records</a>`
        : '';
      const dl = $('#dl-records');
      if (dl) dl.addEventListener('click', (e) => { e.preventDefault(); downloadRecords(); });
    };
    $('#play-mode').addEventListener('change', () => {
      prefs.playMode = $('#play-mode').value;
      savePrefs();
      renderBotNote();
    });
    renderBotNote();
    if (server === null) serverReady.then(() => { if (mode === 'setup' && $('#bot-note')) renderBotNote(); });
    const renderNames = () => {
      const n = Number($('#n-det').value);
      $('#det-names').innerHTML = DET_PRESETS.slice(0, n)
        .map((d, i) => `<label><span class="dot shield" style="background:${d.color}"></span></label>
          <input type="text" id="d-name-${i}" value="Detective ${d.name}" maxlength="20">`)
        .join('');
    };
    $('#n-det').addEventListener('change', renderNames);
    renderNames();
    const renderBalance = () => {
      const n = Number($('#n-det').value);
      const counts = [2, 3, 4, 5];
      $('#balance-pop').innerHTML = `
        <div class="bp-title">How often the detectives win</div>
        <table class="bp-table"><tr><th>City</th>${counts.map((c) => `<th class="${c === n ? 'sel' : ''}">${c} det.</th>`).join('')}</tr>
        ${MAP_KEYS.filter((k) => CITY_BALANCE[k]).map((k) => `<tr data-city="${k}" class="${k === MAP_KEY ? 'sel' : ''}">
          <td>${esc(MAPS[k].name)}${CITY_NOTE[k] ? `<div class="bp-note">${CITY_NOTE[k]}</div>` : ''}</td>
          ${counts.map((c) => `<td class="${c === n ? 'sel' : ''}">${CITY_BALANCE[k][c]}%</td>`).join('')}</tr>`).join('')}
        </table>
        <p class="fineprint">The computer playing both sides at full strength. Against a person the fugitive usually does worse,
        so as the fugitive try fewer detectives. Click a city to choose it.</p>`;
      $('#balance-pop').querySelectorAll('tr[data-city]').forEach((tr) => tr.addEventListener('click', () => {
        $('#map-pick').value = tr.dataset.city;
        $('#map-pick').dispatchEvent(new Event('change'));
      }));
    };
    $('#balance-link').addEventListener('click', (e) => {
      e.preventDefault();
      const pop = $('#balance-pop');
      pop.classList.toggle('hidden');
      if (!pop.classList.contains('hidden')) renderBalance();
    });
    $('#n-det').addEventListener('change', () => { if (!$('#balance-pop').classList.contains('hidden')) renderBalance(); });
    $('#map-pick').addEventListener('change', () => {
      // preview the city on the board behind the dialog
      useMap($('#map-pick').value);
      prefs.mapKey = MAP_KEY;
      savePrefs();
      $('#city-name').textContent = MAP.name;
      $('#city-blurb').textContent = MAP.blurb || '';
      if (!$('#balance-pop').classList.contains('hidden')) renderBalance();
      if (game) { board.setPieces([]); board.setHighlights([], '#000'); board.setCandidates([]); board.setRoute(null, null); }
    });
    $('#btn-start').addEventListener('click', () => {
      const n = Number($('#n-det').value);
      const detectives = DET_PRESETS.slice(0, n).map((d, i) => ({
        name: ($(`#d-name-${i}`).value || `Detective ${d.name}`).trim(),
        color: d.color,
      }));
      prefs.player = $('#player-name').value.trim();
      savePrefs();
      startGame({ fugitiveName: ($('#f-name').value || 'The Fugitive').trim(), detectives }, $('#play-mode').value);
    });
    if (resumable) $('#btn-resume').addEventListener('click', () => resume(saved));
    if (game) {
      $('#btn-cancel').addEventListener('click', () => {
        closeModal();
        useMap(gameMapKey); // back to the city of the game in progress
        mode = lastModeBeforeSetup || mode;
        enterMode(mode);
      });
    }
  }
  let lastModeBeforeSetup = null;

  function startGame(cfg, pm = 'hotseat') {
    botRun++;
    reviewOpen = false;
    gameMapKey = MAP_KEY;
    game = E.createGame(MAP, ADJ, cfg);
    game.meta = { id: newGameId(), mode: pm, created: new Date().toISOString() };
    game.history = [];
    undoStack = [];
    turnSnapshot = null;
    board.fit();
    if (game.phase === 'over') return enterMode('over');
    beginFugitiveTurn();
  }

  function resume(saved) {
    botRun++;
    reviewOpen = false;
    useMap(saved.mapKey);
    gameMapKey = MAP_KEY;
    game = saved.game;
    undoStack = [];
    let m = saved.mode === 'fugitive' ? 'handoff-fugitive' : saved.mode;
    if (vsBot() && game.phase !== 'over') {
      // no curtains against the computer: go straight to whoever is to move
      if (game.phase === 'fugitive') m = humanIs('fugitive') ? 'fugitive-turn' : 'bot-fugitive';
      else m = humanIs('detectives') ? 'detectives' : 'bot-detectives';
    }
    if (m === 'fugitive-turn') return beginFugitiveTurn();
    enterMode(m);
  }

  /** The start of the fugitive's turn: a curtain in pass-and-play, the bot, or straight to the human. */
  function beginFugitiveTurn() {
    if (game.winner) return enterMode('over');
    if (playMode() === 'hotseat') return enterMode('handoff-fugitive');
    if (humanIs('detectives')) return enterMode('bot-fugitive');
    turnSnapshot = E.clone(game);
    turnReadyAt = Date.now();
    enterMode('fugitive');
  }

  /** After the fugitive's turn: tell the detectives which tickets it used (and any reveal). */
  function announceFugitiveTurn() {
    const lastEntry = game.log[game.log.length - 1];
    if (!lastEntry) return;
    const moves = game.log.slice(lastEntry.double ? -2 : -1);
    const desc = moves.map((e) => TICKETS[e.ticket].label).join(' then ');
    const reveal = moves.filter((e) => e.reveal).pop();
    if (reveal) {
      toast(`The fugitive moved (${desc}) and was spotted at station ${reveal.pos}!`, 6000);
      board.centerOn(reveal.pos);
    } else toast(`The fugitive moved: ${desc}${moves.length > 1 ? ' (double move)' : ''}.`, 4500);
  }

  // ---------- mode transitions ----------
  function enterMode(m) {
    mode = m;
    closePicker();
    if (m === 'handoff-fugitive') {
      render();
      const r = game.round + 1;
      openModal(`
        <div class="big-icon">🕶️</div>
        <div class="center">
          <h2>Move ${r} — the Fugitive</h2>
          <p><b>Detectives, look away from the screen.</b><br>
          Hand the computer to <b>${esc(game.fugitive.name)}</b>.</p>
          ${E.REVEAL_ROUNDS.includes(r) ? '<p>⚠️ This move is a <b>reveal</b>: where you land will be shown to everyone.</p>' : ''}
          <div class="row" style="justify-content:center">
            <button class="btn big" id="btn-go">I'm the fugitive. Show my position</button>
          </div>
        </div>`, { opaque: true });
      $('#btn-go').addEventListener('click', () => {
        turnSnapshot = E.clone(game);
        turnReadyAt = Date.now();
        closeModal();
        enterMode('fugitive');
      });
      return;
    }
    if (m === 'bot-fugitive' || m === 'bot-detectives') {
      closeModal();
      render();
      runBotTurn();
      return;
    }
    if (m === 'fugitive') {
      closeModal();
      render();
      board.centerOn(game.fugitive.pos);
      return;
    }
    if (m === 'handoff-detectives') {
      render();
      const lastEntry = game.log[game.log.length - 1];
      const moves = game.log.slice(lastEntry && lastEntry.double ? -2 : -1);
      const desc = moves.map((e) => `<b>${TICKETS[e.ticket].label}</b>`).join(' then ');
      const reveal = moves.filter((e) => e.reveal).pop();
      openModal(`
        <div class="big-icon">🔒</div>
        <div class="center">
          <h2>The fugitive has moved</h2>
          <p>Hand the computer back to the detectives.</p>
          <p>Ticket${moves.length > 1 ? 's' : ''} used: ${desc}${moves.length > 1 ? ' (double move)' : ''}.</p>
          <div class="row" style="justify-content:center">
            <button class="btn big" id="btn-go">Start the detectives' turn</button>
          </div>
        </div>`, { opaque: true });
      $('#btn-go').addEventListener('click', () => {
        closeModal();
        enterMode('detectives');
        if (reveal) {
          toast(`The fugitive was spotted at station ${reveal.pos}!`, 5000);
          board.centerOn(reveal.pos);
        }
      });
      return;
    }
    if (m === 'detectives') {
      closeModal();
      undoStack = [];
      turnReadyAt = Date.now();
      render();
      return;
    }
    if (m === 'over') {
      botRun++;
      saveRecord();
      requestReview();
      render();
      showGameOver();
      return;
    }
  }

  function showGameOver() {
    const fw = game.winner === 'fugitive';
    openModal(`
      <div class="big-icon">${fw ? '🌙' : '🔦'}</div>
      <div class="center">
        <h2>${fw ? `${esc(game.fugitive.name)} escapes!` : 'The detectives win!'}</h2>
        <p>${esc(game.reason)}</p>
        <p class="fineprint">The fugitive's full route is now drawn on the map.</p>
        <div class="row" style="justify-content:center">
          <button class="btn big" id="btn-again">New game</button>
          <button class="btn ghost big" id="btn-view">${game.meta ? 'View the board and review' : 'View the board'}</button>
        </div>
      </div>`);
    $('#btn-again').addEventListener('click', () => { clearSave(); game = null; showSetup(); });
    $('#btn-view').addEventListener('click', () => {
      closeModal();
      reviewOpen = true;
      renderReview();
    });
  }

  // ---------- board interaction ----------
  function onStationClick(id, cx, cy) {
    if (!game || game.winner) return;
    if (mode === 'fugitive' && game.phase === 'fugitive') {
      const mv = E.fugitiveMoves(game, ADJ).find((m) => m.to === id);
      if (!mv) return;
      chooseTicket(mv, game.fugitive.tickets, cx, cy, (t) => {
        E.moveFugitive(game, ADJ, id, t);
        record({ side: 'F', to: id, ticket: t }, 'human');
        render();
      });
    } else if (mode === 'detectives' && game.phase === 'detectives') {
      const d = game.detectives[game.current];
      const mv = E.detectiveMoves(game, ADJ, game.current).find((m) => m.to === id);
      if (!mv) return;
      chooseTicket(mv, d.tickets, cx, cy, (t) => {
        undoStack.push(E.clone(game));
        const i = game.current;
        E.moveDetective(game, ADJ, id, t);
        record({ side: 'D', i, to: id, ticket: t }, 'human');
        if (game.winner) return enterMode('over');
        render();
      });
    }
  }

  function chooseTicket(move, tickets, cx, cy, cb) {
    if (move.tickets.length === 1) return cb(move.tickets[0]);
    const p = $('#picker');
    p.innerHTML = `<div class="title">Travel to ${move.to} using…</div>` +
      move.tickets.map((t) => `<button data-t="${t}"><span class="sw" style="--c:${TICKETS[t].color}"></span>
        ${TICKETS[t].label}<span class="cnt">${tickets[t]} left</span></button>`).join('');
    p.classList.remove('hidden');
    const r = p.getBoundingClientRect();
    p.style.left = Math.min(cx + 12, window.innerWidth - r.width - 8) + 'px';
    p.style.top = Math.min(cy + 12, window.innerHeight - r.height - 8) + 'px';
    p.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closePicker();
        cb(b.dataset.t);
      })
    );
  }
  function closePicker() {
    $('#picker').classList.add('hidden');
  }
  document.addEventListener('pointerdown', (e) => {
    if (!$('#picker').contains(e.target)) closePicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
  });

  // ---------- rendering ----------
  function render() {
    if (!game) {
      board.setPieces([]);
      board.setHighlights([], '#000');
      board.setCandidates([]);
      board.setRoute(null, null);
      $('#turn').innerHTML = '<div class="hint">Set up a game to begin.</div>';
      $('#players').innerHTML = '';
      $('#log').innerHTML = '';
      $('#notices').innerHTML = '';
      renderReview();
      return;
    }
    // the human fugitive always sees itself; a computer fugitive is shown only at the end
    const showFugitive = mode === 'fugitive' || mode === 'over' || (humanIs('fugitive') && mode !== 'setup');
    const pieces = game.detectives.map((d, i) => ({
      pos: d.pos,
      color: d.color,
      badge: String(i + 1),
      kind: 'detective',
      active: (mode === 'detectives' || mode === 'bot-detectives') && game.phase === 'detectives' && game.current === i,
    }));
    if (showFugitive) {
      pieces.push({ pos: game.fugitive.pos, color: FUG_COLOR, badge: 'F', kind: 'fugitive', active: mode === 'fugitive' });
    }
    board.setPieces(pieces);

    let moves = [];
    let from = null;
    let hlColor = '#000';
    if (mode === 'fugitive' && game.phase === 'fugitive' && !game.winner) {
      moves = E.fugitiveMoves(game, ADJ);
      from = game.fugitive.pos;
      hlColor = FUG_HL;
    } else if (mode === 'detectives' && game.phase === 'detectives') {
      moves = E.detectiveMoves(game, ADJ, game.current);
      from = game.detectives[game.current].pos;
      hlColor = game.detectives[game.current].color;
    }
    board.setHighlights(moves.map((m) => m.to), hlColor);
    board.setLegalRoutes(from ? legalRoutes(from, moves) : null);

    board.setCandidates(
      prefs.showPossible && ['detectives', 'handoff-fugitive', 'bot-fugitive', 'bot-detectives'].includes(mode) && game.phase !== 'over'
        ? E.possibleLocations(game, ADJ, MAP)
        : []
    );

    const last = E.lastReveal(game);
    if (mode === 'over') {
      board.setRoute(null, [game.fugitive.start, ...game.log.map((e) => e.pos)]);
    } else if (humanIs('fugitive')) {
      board.setRoute(null, [game.fugitive.start, ...game.log.map((e) => e.pos)]); // your own route so far
    } else {
      board.setRoute(last && mode !== 'fugitive' ? { pos: last.pos, round: last.round } : null, null);
    }

    renderTurn();
    renderPlayers();
    renderLog();
    renderNotices();
    renderReview();
    save();
  }

  function renderTurn() {
    const el = $('#turn');
    const roundLabel = `Move ${Math.min(game.round + (game.phase === 'fugitive' ? 1 : 0), 24)} of 24`;
    let who = '';
    let hint = '';
    let actions = '';

    if (mode === 'over') {
      who = game.winner === 'fugitive' ? `🌙 ${esc(game.fugitive.name)} escaped` : '🔦 Detectives win';
      hint = esc(game.reason);
      actions = '<button class="btn" id="a-new">New game</button><button class="btn ghost" id="a-result">Show result</button>' +
        (game.meta ? '<button class="btn ghost" id="a-review">Review</button>' : '');
    } else if (mode === 'fugitive') {
      who = `<span class="dot" style="background:${FUG_COLOR}"></span>${esc(game.fugitive.name)}`;
      const done = game.phase !== 'fugitive';
      if (game.winner) {
        hint = 'You are trapped. Undo to try a different route, or confirm to end the game.';
      } else if (done) {
        hint = vsBot()
          ? `You're now at <b>${game.fugitive.pos}</b>. Confirm to end your turn.`
          : `You're now at <b>${game.fugitive.pos}</b>. Confirm to hide the board and pass to the detectives.`;
      } else if (game.double === 'second') {
        hint = `Double move, step 2 of 2. You're at <b>${game.fugitive.pos}</b>. Pick your next station.`;
      } else if (game.double === 'first') {
        hint = `Double move, step 1 of 2. You're at <b>${game.fugitive.pos}</b>. Pick your first station.`;
      } else {
        hint = `You're at <b>${game.fugitive.pos}</b>. Click a highlighted station to move there.`;
      }
      const changed = turnSnapshot && JSON.stringify(turnSnapshot) !== JSON.stringify(game);
      actions =
        (E.canUseDouble(game) ? `<button class="btn double" id="a-double">Play double move (${game.fugitive.tickets.double})</button>` : '') +
        `<button class="btn ghost" id="a-undo" ${changed ? '' : 'disabled'}>Undo</button>` +
        `<button class="btn" id="a-confirm" ${done || game.winner ? '' : 'disabled'}>${vsBot() ? 'Confirm' : 'Confirm &amp; hide'}</button>`;
    } else if (mode === 'detectives') {
      if (game.phase === 'detectives') {
        const d = game.detectives[game.current];
        who = `<span class="dot shield" style="background:${d.color}"></span>${esc(d.name)}`;
        hint = `At station <b>${d.pos}</b>. Click a highlighted station to move. Drag to pan, scroll to zoom.`;
      } else {
        who = 'Detectives done';
        hint = vsBot() ? 'Every detective has moved. End the turn to let the fugitive move.' : 'Every detective has moved. Pass the computer to the fugitive.';
      }
      actions =
        `<button class="btn ghost" id="a-undo" ${undoStack.length ? '' : 'disabled'}>Undo last move</button>` +
        (game.phase === 'fugitive' ? `<button class="btn" id="a-pass">${vsBot() ? 'End the detectives’ turn' : 'Pass to the fugitive'}</button>` : '');
    } else if (mode === 'bot-fugitive') {
      who = `<span class="dot" style="background:${FUG_COLOR}"></span>${esc(game.fugitive.name)} (computer)`;
      hint = 'The fugitive is making its move…';
    } else if (mode === 'bot-detectives') {
      const d = game.phase === 'detectives' ? game.detectives[game.current] : null;
      who = d ? `<span class="dot shield" style="background:${d.color}"></span>${esc(d.name)} (computer)` : 'Computer detectives';
      hint = 'The detectives are thinking…';
    } else {
      who = 'Waiting…';
      hint = 'Follow the on-screen instructions.';
    }

    el.innerHTML = `<div class="round">${roundLabel}</div><div class="who">${who}</div>
      <div class="hint">${hint}</div><div class="actions">${actions}</div>`;

    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    on('a-double', () => { E.useDouble(game); record({ side: 'F', type: 'double' }, 'human'); render(); });
    on('a-undo', () => {
      if (mode === 'fugitive') game = E.clone(turnSnapshot);
      else if (undoStack.length) game = undoStack.pop();
      render();
    });
    on('a-confirm', () => {
      if (game.winner) return enterMode('over');
      if (vsBot()) { saveRecord(); return enterMode('bot-detectives'); }
      enterMode('handoff-detectives');
    });
    on('a-pass', () => {
      if (vsBot()) { saveRecord(); return enterMode('bot-fugitive'); }
      enterMode('handoff-fugitive');
    });
    on('a-new', () => { clearSave(); game = null; showSetup(); });
    on('a-result', showGameOver);
    on('a-review', () => { reviewOpen = true; requestReview(); renderReview(); });
  }

  function ticketChips(t, keys) {
    return keys.map((k) => `<span class="tk ${t[k] ? '' : 'empty'}" style="--c:${TICKETS[k].color}" title="${TICKETS[k].label}">${TICKETS[k].label} ${t[k]}</span>`).join('');
  }

  function renderPlayers() {
    const last = E.lastReveal(game);
    const fWhere = mode === 'fugitive' || mode === 'over' || humanIs('fugitive')
      ? `At ${game.fugitive.pos}`
      : last ? `Last seen at ${last.pos} (move ${last.round})` : 'Not yet seen';
    let html = `<div class="player ${mode === 'fugitive' || mode === 'bot-fugitive' ? 'current' : ''}" style="--pc:${FUG_COLOR}">
      <span class="dot" style="background:${FUG_COLOR}"></span>
      <div><div class="name">${esc(game.fugitive.name)}</div><div class="where">${fWhere}</div></div>
      <div class="tickets">${ticketChips(game.fugitive.tickets, ['cab', 'tram', 'metro', 'secret', 'double'])}</div>
    </div>`;
    game.detectives.forEach((d, i) => {
      const cur = (mode === 'detectives' || mode === 'bot-detectives') && game.phase === 'detectives' && game.current === i;
      html += `<div class="player ${cur ? 'current' : ''}" style="--pc:${d.color}">
        <span class="dot shield" style="background:${d.color}">${i + 1}</span>
        <div><div class="name">${esc(d.name)}</div><div class="where">At ${d.pos}</div></div>
        <div class="tickets">${ticketChips(d.tickets, ['cab', 'tram', 'metro'])}</div>
      </div>`;
    });
    $('#players').innerHTML = html;
  }

  function renderLog() {
    const showAll = mode === 'fugitive' || mode === 'over' || humanIs('fugitive');
    let html = '';
    for (let r = 1; r <= E.MAX_ROUNDS; r++) {
      const e = game.log[r - 1];
      const reveal = E.REVEAL_ROUNDS.includes(r);
      const next = !e && r === game.round + 1 && game.phase !== 'over';
      let inner = `<span class="n">${r}</span>`;
      if (e) {
        if (e.double) inner += '<span class="dbl">2×</span>';
        inner += `<span class="tchip" style="--c:${TICKETS[e.ticket].color}" title="${TICKETS[e.ticket].label}"></span>`;
        inner += `<span class="pos">${e.reveal || showAll ? e.pos : TICKETS[e.ticket].label}</span>`;
      }
      html += `<div class="slot ${reveal ? 'reveal' : ''} ${next ? 'next' : ''}" title="${reveal ? 'Reveal move' : ''}">${inner}</div>`;
    }
    $('#log').innerHTML = html;
  }

  function renderNotices() {
    const recent = game.events.filter((ev) => ev.round >= game.round - 1).slice(-3);
    $('#notices').innerHTML = recent.map((ev) => `<div class="notice">${esc(ev.text)}</div>`).join('');
  }

  // ---------- rules ----------
  function showRules() {
    openModal(`
      <h2>How to play</h2>
      <p>The Fugitive hides somewhere in ${MAP.name}. The Detectives work together to land on the
      fugitive's station before the fugitive's 24th move is over.</p>
      <h3>Turns</h3>
      <ul>
        <li>The fugitive moves first, in secret, while the detectives look away. Then each detective moves in order.</li>
        <li>Every move travels along one line from your station to a neighbouring station and costs one ticket of that line's colour.</li>
        <li>Cab lines (yellow) link every station to its neighbours. Tram lines (green) stop only at green and red stations, and Metro lines (red) only at red stations. Both run alongside the streets and pass through other stations without stopping, so one tram or metro ticket can carry you several stations at once.</li>
        <li>Hover over a highlighted station to see exactly which line gets you there.</li>
      </ul>
      <h3>The fugitive</h3>
      <ul>
        <li>Each move fills a slot in the travel log, which everyone can see. The log shows the ticket used, but not the station.</li>
        <li>On moves <b>3, 8, 13, 18 and 24</b> the fugitive's station is revealed to everyone.</li>
        <li><b>Secret tickets</b> (one per detective) work on any line, including the river ferry, and hide which transport was used.</li>
        <li><b>Double moves</b> (two per game) let the fugitive move twice in a row. Each step fills its own log slot, and the reveal rule still applies to each one.</li>
        <li>Every ticket a detective spends is handed to the fugitive.</li>
        <li>The fugitive can never move onto a detective's station.</li>
      </ul>
      <h3>The detectives</h3>
      <ul>
        <li>Each detective starts with 10 Cab, 8 Tram and 4 Metro tickets and never gets more.</li>
        <li>Two detectives can't share a station.</li>
        <li>A detective with no legal move sits out.</li>
      </ul>
      <h3>Winning</h3>
      <ul>
        <li><b>Detectives</b> win the moment one of them lands on the fugitive's station, or if the fugitive has no legal move.</li>
        <li><b>The fugitive</b> wins by surviving through the detectives' turn after move 24, or if no detective can move any more.</li>
      </ul>
      <p class="fineprint">Tip: tick “Shade every station the fugitive could be at” to see where the fugitive could be,
      based only on what's public.</p>
      <div class="row"><button class="btn" id="btn-close">Got it</button></div>`);
    $('#btn-close').addEventListener('click', () => {
      closeModal();
      if (mode === 'over') return;
      if (mode === 'handoff-fugitive' || mode === 'handoff-detectives') enterMode(mode);
    });
  }

  // ---------- wiring ----------
  board.onStationClick = onStationClick;
  document.querySelectorAll('.zoom-controls button').forEach((b) =>
    b.addEventListener('click', () => {
      const z = b.dataset.zoom;
      if (z === 'in') board.zoomCenter(0.75);
      else if (z === 'out') board.zoomCenter(1.33);
      else board.fit();
    })
  );
  $('#btn-rules').addEventListener('click', () => {
    if (mode === 'setup') return;
    showRules();
  });
  $('#btn-new').addEventListener('click', () => {
    if (game && game.phase !== 'over' && !confirm('Abandon the current game and start a new one?')) return;
    lastModeBeforeSetup = mode;
    showSetup();
  });
  const opt = $('#opt-possible');
  opt.checked = prefs.showPossible;
  opt.addEventListener('change', () => {
    prefs.showPossible = opt.checked;
    savePrefs();
    if (game) render();
  });

  const serverReady = detectServer();
  render();
  showSetup();
})();
