/*
 * Nightfall Run — rules engine.
 * Pure game logic: no DOM access. Works in the browser (window.Engine) and in Node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_ROUNDS = 24;
  const REVEAL_ROUNDS = [3, 8, 13, 18, 24];
  const TRANSPORTS = ['cab', 'tram', 'metro', 'ferry'];
  const BASIC_TICKETS = ['cab', 'tram', 'metro'];
  const DETECTIVE_TICKETS = { cab: 10, tram: 8, metro: 4 };
  const FUGITIVE_TICKETS = { cab: 4, tram: 3, metro: 3 };
  const DOUBLE_CARDS = 2;

  function buildAdjacency(map) {
    const adj = {};
    for (const s of map.stations) adj[s.id] = { cab: [], tram: [], metro: [], ferry: [] };
    for (const e of map.edges) {
      adj[e.a][e.type].push(e.b);
      adj[e.b][e.type].push(e.a);
    }
    return adj;
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const clone = (state) => JSON.parse(JSON.stringify(state));

  function createGame(map, adj, opts) {
    const rng = opts.rng || Math.random;
    const n = opts.detectives.length;
    if (n < 1 || n > 5) throw new Error('A game needs 1–5 detectives.');
    if (map.starts.length < n + 1) throw new Error('Not enough start stations.');
    const pool = shuffle(map.starts.slice(), rng);
    const state = {
      version: 1,
      phase: 'fugitive', // 'fugitive' | 'detectives' | 'over'
      round: 0, // number of fugitive moves made so far (= filled log slots)
      fugitive: {
        name: opts.fugitiveName || 'The Fugitive',
        pos: pool[n],
        start: pool[n],
        tickets: { ...FUGITIVE_TICKETS, secret: n, double: DOUBLE_CARDS },
      },
      detectives: opts.detectives.map((d, i) => ({
        name: d.name,
        color: d.color,
        pos: pool[i],
        start: pool[i],
        tickets: { ...DETECTIVE_TICKETS },
      })),
      current: -1, // index of detective to move (during the detectives phase)
      double: null, // null | 'first' | 'second'
      log: [], // { round, ticket, pos, reveal, double }
      events: [], // public notices
      winner: null, // 'fugitive' | 'detectives'
      reason: '',
    };
    if (fugitiveMoves(state, adj).length === 0) {
      finish(state, 'detectives', 'The fugitive started with no way out.');
    }
    return state;
  }

  // ---------- Move generation ----------

  function collect(res, to, ticket) {
    if (!res.has(to)) res.set(to, []);
    const list = res.get(to);
    if (!list.includes(ticket)) list.push(ticket);
  }

  const toList = (res) =>
    [...res].map(([to, tickets]) => ({ to, tickets })).sort((a, b) => a.to - b.to);

  /** Legal fugitive moves: [{to, tickets:[...]}]. Cannot land on a detective. */
  function fugitiveMoves(state, adj) {
    const f = state.fugitive;
    const blocked = new Set(state.detectives.map((d) => d.pos));
    const res = new Map();
    for (const t of BASIC_TICKETS) {
      if (f.tickets[t] <= 0) continue;
      for (const nb of adj[f.pos][t]) if (!blocked.has(nb)) collect(res, nb, t);
    }
    if (f.tickets.secret > 0) {
      for (const t of TRANSPORTS) {
        for (const nb of adj[f.pos][t]) if (!blocked.has(nb)) collect(res, nb, 'secret');
      }
    }
    return toList(res);
  }

  /** Legal moves for detective i. Cannot land on another detective; may land on the fugitive. */
  function detectiveMoves(state, adj, i) {
    const d = state.detectives[i];
    const blocked = new Set(state.detectives.filter((_, j) => j !== i).map((x) => x.pos));
    const res = new Map();
    for (const t of BASIC_TICKETS) {
      if (d.tickets[t] <= 0) continue;
      for (const nb of adj[d.pos][t]) if (!blocked.has(nb)) collect(res, nb, t);
    }
    return toList(res);
  }

  // ---------- Fugitive actions ----------

  function canUseDouble(state) {
    return (
      state.phase === 'fugitive' &&
      !state.winner &&
      state.double === null &&
      state.fugitive.tickets.double > 0 &&
      state.round <= MAX_ROUNDS - 2
    );
  }

  function useDouble(state) {
    if (!canUseDouble(state)) throw new Error('A double move cannot be played now.');
    state.fugitive.tickets.double--;
    state.double = 'first';
    state.events.push({ round: state.round + 1, text: 'The fugitive played a double move.' });
    return state;
  }

  function moveFugitive(state, adj, to, ticket) {
    if (state.phase !== 'fugitive' || state.winner) throw new Error('It is not the fugitive’s turn.');
    const opt = fugitiveMoves(state, adj).find((m) => m.to === to);
    if (!opt || !opt.tickets.includes(ticket)) throw new Error('Illegal fugitive move.');
    const f = state.fugitive;
    f.tickets[ticket]--;
    f.pos = to;
    state.round++;
    state.log.push({
      round: state.round,
      ticket,
      pos: to,
      reveal: REVEAL_ROUNDS.includes(state.round),
      double: state.double !== null,
    });
    if (state.double === 'first') {
      state.double = 'second';
      if (fugitiveMoves(state, adj).length === 0) {
        finish(state, 'detectives', 'The fugitive was cornered halfway through a double move.');
      }
      return state;
    }
    state.double = null;
    beginDetectivePhase(state, adj);
    return state;
  }

  // ---------- Detective actions ----------

  function beginDetectivePhase(state, adj) {
    state.phase = 'detectives';
    const anyCanMove = state.detectives.some((_, i) => detectiveMoves(state, adj, i).length > 0);
    if (!anyCanMove) {
      finish(state, 'fugitive', 'None of the detectives can move any more.');
      return;
    }
    state.current = -1;
    advanceDetective(state, adj);
  }

  function advanceDetective(state, adj) {
    for (let i = state.current + 1; i < state.detectives.length; i++) {
      if (detectiveMoves(state, adj, i).length > 0) {
        state.current = i;
        return;
      }
      state.events.push({
        round: state.round,
        text: `${state.detectives[i].name} has no legal move and sits this turn out.`,
      });
    }
    endDetectivePhase(state, adj);
  }

  function endDetectivePhase(state, adj) {
    state.current = -1;
    if (state.round >= MAX_ROUNDS) {
      finish(state, 'fugitive', `The fugitive stayed free for all ${MAX_ROUNDS} moves.`);
      return;
    }
    state.phase = 'fugitive';
    if (fugitiveMoves(state, adj).length === 0) {
      finish(state, 'detectives', 'The fugitive is surrounded with nowhere left to go.');
    }
  }

  function moveDetective(state, adj, to, ticket) {
    if (state.phase !== 'detectives' || state.winner) throw new Error('It is not the detectives’ turn.');
    const i = state.current;
    const opt = detectiveMoves(state, adj, i).find((m) => m.to === to);
    if (!opt || !opt.tickets.includes(ticket)) throw new Error('Illegal detective move.');
    const d = state.detectives[i];
    d.tickets[ticket]--;
    state.fugitive.tickets[ticket]++; // spent detective tickets go to the fugitive
    d.pos = to;
    if (to === state.fugitive.pos) {
      finish(state, 'detectives', `${d.name} caught the fugitive at station ${to}!`);
      return state;
    }
    advanceDetective(state, adj);
    return state;
  }

  function finish(state, winner, reason) {
    state.phase = 'over';
    state.winner = winner;
    state.reason = reason;
    state.current = -1;
    state.double = null;
  }

  // ---------- Public-information helpers ----------

  function lastReveal(state) {
    for (let i = state.log.length - 1; i >= 0; i--) if (state.log[i].reveal) return state.log[i];
    return null;
  }

  /** Stations the fugitive could be at, using only public information. */
  function possibleLocations(state, adj, map) {
    const detStarts = new Set(state.detectives.map((d) => d.start));
    let set = new Set(map.starts.filter((s) => !detStarts.has(s)));
    for (const entry of state.log) {
      if (entry.reveal) {
        set = new Set([entry.pos]);
        continue;
      }
      const types = entry.ticket === 'secret' ? TRANSPORTS : [entry.ticket];
      const next = new Set();
      for (const s of set) for (const t of types) for (const nb of adj[s][t]) next.add(nb);
      set = next;
    }
    for (const d of state.detectives) set.delete(d.pos);
    return [...set].sort((a, b) => a - b);
  }

  return {
    MAX_ROUNDS,
    REVEAL_ROUNDS,
    TRANSPORTS,
    DETECTIVE_TICKETS,
    FUGITIVE_TICKETS,
    buildAdjacency,
    createGame,
    clone,
    fugitiveMoves,
    detectiveMoves,
    canUseDouble,
    useDouble,
    moveFugitive,
    moveDetective,
    lastReveal,
    possibleLocations,
  };
});
