/*
 * Nightfall Run — receives finished games from the site and appends them to this sheet.
 * Set up: tools/sheets/README.md. Paste this into the sheet's Extensions > Apps Script.
 *
 * Write-only on purpose: there is no way to read the sheet through this script. Anyone who
 * finds its address can add rows (the page's source shows it), so rows are checked for
 * shape and size here, and every game is replayed against the rules on import
 * (python3 -m ai.import_records), which drops anything that is not a legal game.
 */
const SHEET_NAME = 'games';
const HEADERS = ['received', 'id', 'player', 'mode', 'city', 'detectives', 'winner', 'moves', 'record'];
const MAX_CHARS = 45000; // a cell holds 50,000 characters; a full game is about 10,000
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents;
    if (!body || body.length > MAX_CHARS) return reply('rejected: size');
    const r = JSON.parse(body);
    if (r.app !== 'nightfall-run' || !ID_RE.test(String(r.id || '')) || !Array.isArray(r.history) ||
        r.history.length > 400) return reply('rejected: not a game record');
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      sheet().appendRow([
        new Date(), r.id, text(r.player, 30), text(r.mode, 20), text(r.map, 20), Number(r.detectives) || '',
        r.result ? text(r.result.winner, 12) : '(unfinished)', r.result ? Number(r.result.round) || '' : r.history.length,
        body,
      ]);
    } finally {
      lock.releaseLock();
    }
    return reply('ok');
  } catch (err) {
    return reply('error');
  }
}

function doGet() {
  return reply('Nightfall Run game records: this address only accepts games.');
}

function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** A short plain-text cell: never starts like a formula. */
function text(x, n) {
  const s = String(x == null ? '' : x).slice(0, n);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function reply(t) {
  return ContentService.createTextOutput(t);
}
