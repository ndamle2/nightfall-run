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

  const DET_PRESETS = [
    { name: 'Blue', color: '#2f6fd0' },
    { name: 'Orange', color: '#e07a1f' },
    { name: 'Violet', color: '#8657c6' },
    { name: 'Teal', color: '#12958a' },
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
    mode = 'setup';
    closePicker();
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
        <span></span><span class="fineprint" id="city-blurb">${esc(MAP.blurb || '')}</span>
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
      </div>`);
    const renderNames = () => {
      const n = Number($('#n-det').value);
      $('#det-names').innerHTML = DET_PRESETS.slice(0, n)
        .map((d, i) => `<label><span class="dot" style="background:${d.color}"></span></label>
          <input type="text" id="d-name-${i}" value="Detective ${d.name}" maxlength="20">`)
        .join('');
    };
    $('#n-det').addEventListener('change', renderNames);
    renderNames();
    $('#map-pick').addEventListener('change', () => {
      // preview the city on the board behind the dialog
      useMap($('#map-pick').value);
      prefs.mapKey = MAP_KEY;
      savePrefs();
      $('#city-name').textContent = MAP.name;
      $('#city-blurb').textContent = MAP.blurb || '';
      if (game) { board.setPieces([]); board.setHighlights([], '#000'); board.setCandidates([]); board.setRoute(null, null); }
    });
    $('#btn-start').addEventListener('click', () => {
      const n = Number($('#n-det').value);
      const detectives = DET_PRESETS.slice(0, n).map((d, i) => ({
        name: ($(`#d-name-${i}`).value || `Detective ${d.name}`).trim(),
        color: d.color,
      }));
      startGame({ fugitiveName: ($('#f-name').value || 'The Fugitive').trim(), detectives });
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

  function startGame(cfg) {
    gameMapKey = MAP_KEY;
    game = E.createGame(MAP, ADJ, cfg);
    undoStack = [];
    turnSnapshot = null;
    board.fit();
    if (game.phase === 'over') return enterMode('over');
    enterMode('handoff-fugitive');
  }

  function resume(saved) {
    useMap(saved.mapKey);
    gameMapKey = MAP_KEY;
    game = saved.game;
    undoStack = [];
    enterMode(saved.mode === 'fugitive' ? 'handoff-fugitive' : saved.mode);
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
        closeModal();
        enterMode('fugitive');
      });
      return;
    }
    if (m === 'fugitive') {
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
      undoStack = [];
      render();
      return;
    }
    if (m === 'over') {
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
          <button class="btn ghost big" id="btn-view">View the board</button>
        </div>
      </div>`);
    $('#btn-again').addEventListener('click', () => { clearSave(); game = null; showSetup(); });
    $('#btn-view').addEventListener('click', closeModal);
  }

  // ---------- board interaction ----------
  function onStationClick(id, cx, cy) {
    if (!game || game.winner) return;
    if (mode === 'fugitive' && game.phase === 'fugitive') {
      const mv = E.fugitiveMoves(game, ADJ).find((m) => m.to === id);
      if (!mv) return;
      chooseTicket(mv, game.fugitive.tickets, cx, cy, (t) => {
        E.moveFugitive(game, ADJ, id, t);
        render();
      });
    } else if (mode === 'detectives' && game.phase === 'detectives') {
      const d = game.detectives[game.current];
      const mv = E.detectiveMoves(game, ADJ, game.current).find((m) => m.to === id);
      if (!mv) return;
      chooseTicket(mv, d.tickets, cx, cy, (t) => {
        undoStack.push(E.clone(game));
        E.moveDetective(game, ADJ, id, t);
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
      return;
    }
    const showFugitive = mode === 'fugitive' || mode === 'over';
    const pieces = game.detectives.map((d, i) => ({
      pos: d.pos,
      color: d.color,
      badge: String(i + 1),
      kind: 'detective',
      active: mode === 'detectives' && game.phase === 'detectives' && game.current === i,
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
      prefs.showPossible && (mode === 'detectives' || mode === 'handoff-fugitive') && game.phase !== 'over'
        ? E.possibleLocations(game, ADJ, MAP)
        : []
    );

    const last = E.lastReveal(game);
    if (mode === 'over') {
      board.setRoute(null, [game.fugitive.start, ...game.log.map((e) => e.pos)]);
    } else {
      board.setRoute(last && mode !== 'fugitive' ? { pos: last.pos, round: last.round } : null, null);
    }

    renderTurn();
    renderPlayers();
    renderLog();
    renderNotices();
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
      actions = '<button class="btn" id="a-new">New game</button><button class="btn ghost" id="a-result">Show result</button>';
    } else if (mode === 'fugitive') {
      who = `<span class="dot" style="background:${FUG_COLOR}"></span>${esc(game.fugitive.name)}`;
      const done = game.phase !== 'fugitive';
      if (game.winner) {
        hint = 'You are trapped. Undo to try a different route, or confirm to end the game.';
      } else if (done) {
        hint = `You're now at <b>${game.fugitive.pos}</b>. Confirm to hide the board and pass to the detectives.`;
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
        `<button class="btn" id="a-confirm" ${done || game.winner ? '' : 'disabled'}>Confirm &amp; hide</button>`;
    } else if (mode === 'detectives') {
      if (game.phase === 'detectives') {
        const d = game.detectives[game.current];
        who = `<span class="dot" style="background:${d.color}"></span>${esc(d.name)}`;
        hint = `At station <b>${d.pos}</b>. Click a highlighted station to move. Drag to pan, scroll to zoom.`;
      } else {
        who = 'Detectives done';
        hint = 'Every detective has moved. Pass the computer to the fugitive.';
      }
      actions =
        `<button class="btn ghost" id="a-undo" ${undoStack.length ? '' : 'disabled'}>Undo last move</button>` +
        (game.phase === 'fugitive' ? '<button class="btn" id="a-pass">Pass to the fugitive</button>' : '');
    } else {
      who = 'Waiting…';
      hint = 'Follow the on-screen instructions.';
    }

    el.innerHTML = `<div class="round">${roundLabel}</div><div class="who">${who}</div>
      <div class="hint">${hint}</div><div class="actions">${actions}</div>`;

    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    on('a-double', () => { E.useDouble(game); render(); });
    on('a-undo', () => {
      if (mode === 'fugitive') game = E.clone(turnSnapshot);
      else if (undoStack.length) game = undoStack.pop();
      render();
    });
    on('a-confirm', () => enterMode(game.winner ? 'over' : 'handoff-detectives'));
    on('a-pass', () => enterMode('handoff-fugitive'));
    on('a-new', () => { clearSave(); game = null; showSetup(); });
    on('a-result', showGameOver);
  }

  function ticketChips(t, keys) {
    return keys.map((k) => `<span class="tk ${t[k] ? '' : 'empty'}" style="--c:${TICKETS[k].color}" title="${TICKETS[k].label}">${TICKETS[k].label} ${t[k]}</span>`).join('');
  }

  function renderPlayers() {
    const last = E.lastReveal(game);
    const fWhere = mode === 'fugitive' || mode === 'over'
      ? `At ${game.fugitive.pos}`
      : last ? `Last seen at ${last.pos} (move ${last.round})` : 'Not yet seen';
    let html = `<div class="player ${mode === 'fugitive' ? 'current' : ''}" style="--pc:${FUG_COLOR}">
      <span class="dot" style="background:${FUG_COLOR}"></span>
      <div><div class="name">${esc(game.fugitive.name)}</div><div class="where">${fWhere}</div></div>
      <div class="tickets">${ticketChips(game.fugitive.tickets, ['cab', 'tram', 'metro', 'secret', 'double'])}</div>
    </div>`;
    game.detectives.forEach((d, i) => {
      const cur = mode === 'detectives' && game.phase === 'detectives' && game.current === i;
      html += `<div class="player ${cur ? 'current' : ''}" style="--pc:${d.color}">
        <span class="dot" style="background:${d.color}"></span>
        <div><div class="name">${esc(d.name)}</div><div class="where">At ${d.pos}</div></div>
        <div class="tickets">${ticketChips(d.tickets, ['cab', 'tram', 'metro'])}</div>
      </div>`;
    });
    $('#players').innerHTML = html;
  }

  function renderLog() {
    const showAll = mode === 'fugitive' || mode === 'over';
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

  render();
  showSetup();
})();
