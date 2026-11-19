/*
 * Nightfall Run — site settings.
 *
 * recordsUrl: where finished games are sent (a Google Apps Script web app that appends them
 * to a private Google Sheet; set it up with tools/sheets/README.md). Empty: games are only
 * kept in the browser (and saved to data/games/ when served by `python3 -m ai.serve`).
 */
window.NIGHTFALL_CONFIG = {
  recordsUrl: '',
};
