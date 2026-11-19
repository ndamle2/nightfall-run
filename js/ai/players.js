/*
 * Nightfall Run — the strong computer players behind one call each, as ai/serve.py offers
 * them (and with the same answers): botMove(map, record) for the next bot actions,
 * review(map, record) for the post-game review. Runs inside js/ai/worker.js, or on the
 * page itself when a worker cannot start (pages opened straight from disk).
 */
(function (root, factory) {
  const req = typeof require === 'function' ? require : null;
  const api = factory(
    root.AICore || req('./core.js'), root.AIAlphaBeta || req('./alphabeta.js'),
    root.AIISMCTS || req('./ismcts.js'), root.AIReview || req('./review.js'),
    root.AIWeights || req('./weights.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIPlayers = api;
})(typeof self !== 'undefined' ? self : this, function (C, AB, IS, RV, WEIGHTS) {
  'use strict';

  const BOTS = { fugitive: 'alphabeta depth 3', detectives: 'ismcts 3072 mix reuse=game terr=0.3', engine: 'browser' };
  const MAX_BOTS = 16;
  const bots = new Map(); // `${game id}:${side}` -> bot (ISMCTS keeps its estimate and tree per game)

  function bot(id, side, opts) {
    const key = `${id}:${side}`;
    let b = bots.get(key);
    if (!b) {
      b = side === 'F'
        ? new AB.AlphaBetaFugitive(opts.fugitive || {})
        : new IS.ISMCTSDetectives({ valueWeights: WEIGHTS.value, moveWeights: WEIGHTS.move, ...(opts.detectives || {}) });
      bots.set(key, b);
      while (bots.size > MAX_BOTS) bots.delete(bots.keys().next().value);
    } else {
      bots.delete(key);
      bots.set(key, b); // most recently used last
    }
    return b;
  }

  /** The bot's next actions for the position the record reaches: the fugitive's whole
   * turn, or the current detective's move, as record actions {side, to, ticket, i?, type?}. */
  function botMove(map, record, opts = {}) {
    const T = C.tables(map);
    const s = C.replay(T, record);
    if (s.phase === C.OVER) throw new Error('the game is over');
    if (s.phase === C.FUG) {
      if (s.dbl !== C.NO_DBL) throw new Error('the record stops halfway through a double move');
      const turn = bot(record.id, 'F', opts).chooseTurn(T, s);
      return turn.map((a) => (a === 'double' ? { side: 'F', type: 'double' }
        : { side: 'F', to: T.ids[a[0]], ticket: C.TICKET_NAMES[a[1]] }));
    }
    const [to, t] = bot(record.id, 'D', opts).chooseMove(T, C.publicView(s));
    return [{ side: 'D', i: s.current, to: T.ids[to], ticket: C.TICKET_NAMES[t] }];
  }

  function review(map, record) {
    return RV.review(C.tables(map), record);
  }

  return { botMove, review, BOTS };
});
