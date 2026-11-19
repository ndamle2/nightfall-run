/*
 * Nightfall Run — Web Worker running the computer players off the page's main thread.
 * Messages in: {id, op: 'move' | 'review', map: key, mapData?, record} (the page sends each
 * map's data with its first request for it). Out: {id, ok, result | error, ms}.
 */
/* global importScripts, AIPlayers */
importScripts('core.js', 'weights.js', 'alphabeta.js', 'ismcts.js', 'review.js', 'players.js');

const maps = {};

self.onmessage = (e) => {
  const { id, op, map, mapData, record } = e.data;
  const t0 = Date.now();
  try {
    if (mapData) maps[map] = mapData;
    const m = maps[map];
    if (!m) throw new Error(`unknown map ${map}`);
    const result = op === 'move' ? AIPlayers.botMove(m, record) : AIPlayers.review(m, record);
    self.postMessage({ id, ok: true, result, ms: Date.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
