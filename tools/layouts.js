/*
 * Hand-designed city layouts for tools/genmap.js. Each fixes the river course, the parks and
 * where stations bunch up; the seed and remaining generator settings come from a search
 * (tools/mapsearch.js --layout <key>) that tunes them to the Scotland Yard standard.
 *
 * Coordinates are fractions of the 2400 x 1700 map. River: centre y (fraction) plus sine waves
 * [amplitude px, wavelength/2π px, phase]. Parks: {x, y, w, h} (w, h in px); one may be `big`,
 * which gets a single street cut across it. Districts: {x, y, s (spread px), w (strength)}.
 * riverName, parkName (the big park) and labels (district names, nudged to a clear spot) are decor.
 */
'use strict';

module.exports = {
  // A port city: the river swings low, the old harbour quarter hugs the north bank.
  harbour: {
    name: 'Harrowgate',
    blurb: 'A port city: the river swings low and the old harbour quarter hugs its north bank.',
    riverName: 'The Harrow',
    parkName: 'Harrow Common',
    labels: [{ text: 'Harbour Quarter', x: 0.42, y: 0.55 }, { text: 'West Docks', x: 0.16, y: 0.6 }, { text: 'Saltgate', x: 0.72, y: 0.88 }],
    // seed + settings tuned by: node tools/mapsearch.js --sy <dir> --layout harbour
    tuned: { seed: 94588, streetBeta: 1.4, fillTarget: 3.94, cabTarget: 3.6, maxDeg2: 9, pruneLengthBias: 0.74, triWeight: 1.81, biconnected: true, tramMinStops: 63, tramHops: 6, tramMinHops: 1, tramStretch: 1.65, tramTarget: 3.38, tramDegCap: 5, tramShareStops: false, metroTarget: 3.21, startSpread: 165, bridges: 8, metroShareStops: false },
    river: { y: 0.76, waves: [[110, 380, 0.9], [28, 150, 2.4]] },
    parks: [
      { x: 0.33, y: 0.16, w: 600, h: 200, big: true },
      { x: 0.79, y: 0.12, w: 240, h: 190 },
      { x: 0.07, y: 0.36, w: 220, h: 180 },
    ],
    districts: [
      { x: 0.42, y: 0.58, s: 260, w: 1.1 },
      { x: 0.16, y: 0.62, s: 180, w: 0.8 },
      { x: 0.72, y: 0.86, s: 200, w: 0.7 },
    ],
    density: 0.9,
  },

  // Two old towns that grew into each other across a winding river.
  twin: {
    name: 'Brackwell',
    blurb: 'Two old towns facing each other across a long, winding river.',
    riverName: 'River Brack',
    parkName: 'Brackwell Common',
    labels: [{ text: 'Northbrack', x: 0.33, y: 0.3 }, { text: 'Ellery', x: 0.66, y: 0.68 }, { text: 'Fenhallow', x: 0.85, y: 0.2 }],
    // seed + settings tuned by: node tools/mapsearch.js --sy <dir> --layout twin
    tuned: { seed: 8311, streetBeta: 1.23, fillTarget: 3.39, cabTarget: 3.52, maxDeg2: 20, pruneLengthBias: 0.12, triWeight: 2.43, biconnected: true, tramMinStops: 57, tramHops: 7, tramMinHops: 1, tramStretch: 1.96, tramTarget: 3.61, tramDegCap: 5, tramShareStops: false, metroTarget: 2.89, startSpread: 177, bridges: 7, metroShareStops: false },
    // a long diagonal S-bend, like the Thames on the classic board: in low on the left,
    // out high on the right
    river: { y: 0.6, tilt: -0.3, windy: true, waves: [[150, 300, 0.4], [55, 130, 1.2], [22, 70, 0.5]] },
    parks: [
      { x: 0.1, y: 0.1, w: 560, h: 200, big: true },
      { x: 0.72, y: 0.74, w: 260, h: 200 },
      { x: 0.42, y: 0.8, w: 220, h: 160 },
    ],
    districts: [
      { x: 0.33, y: 0.32, s: 230, w: 1.0 },
      { x: 0.66, y: 0.66, s: 230, w: 1.0 },
      { x: 0.85, y: 0.22, s: 160, w: 0.6 },
    ],
    density: 0.8,
  },

  // River along the north edge; one dense old quarter in the middle, quieter rings around it.
  quarter: {
    name: 'Oldmere',
    blurb: 'A dense old quarter at the heart, with the river along the north edge.',
    riverName: 'The Mere',
    parkName: 'Abbey Fields',
    labels: [{ text: 'Old Quarter', x: 0.5, y: 0.45 }, { text: 'Millbrook', x: 0.2, y: 0.86 }, { text: 'Eastfold', x: 0.82, y: 0.86 }],
    // seed + settings tuned by: node tools/mapsearch.js --sy <dir> --layout quarter
    tuned: { seed: 14304, streetBeta: 1.12, fillTarget: 3.55, cabTarget: 3.56, maxDeg2: 17, pruneLengthBias: 0.53, triWeight: 2.8, biconnected: true, tramMinStops: 55, tramHops: 7, tramMinHops: 1, tramStretch: 1.65, tramTarget: 3.68, tramDegCap: 4, tramShareStops: false, metroTarget: 3.08, startSpread: 166, bridges: 7, metroShareStops: false },
    river: { y: 0.24, waves: [[70, 440, 2.0], [30, 140, 0.4]] },
    parks: [
      { x: 0.36, y: 0.7, w: 620, h: 200, big: true },
      { x: 0.08, y: 0.52, w: 240, h: 200 },
      { x: 0.8, y: 0.5, w: 230, h: 180 },
    ],
    districts: [
      { x: 0.5, y: 0.47, s: 300, w: 1.2 },
      { x: 0.2, y: 0.82, s: 170, w: 0.6 },
      { x: 0.82, y: 0.84, s: 170, w: 0.6 },
    ],
    density: 1.0,
  },

  // A long riverside market strip: three neighbourhoods strung along a winding river.
  market: {
    name: 'Saltmarsh',
    blurb: 'Three market neighbourhoods strung along a winding river.',
    riverName: 'River Salt',
    parkName: 'Marsh Park',
    labels: [{ text: 'Westmarket', x: 0.18, y: 0.45 }, { text: 'Saltmarsh Cross', x: 0.5, y: 0.4 }, { text: 'Eastmarket', x: 0.82, y: 0.46 }],
    // seed + settings tuned by: node tools/mapsearch.js --sy <dir> --layout market
    tuned: { seed: 3545, streetBeta: 1.04, fillTarget: 3.38, cabTarget: 3.62, maxDeg2: 21, pruneLengthBias: 0.31, triWeight: 2.43, biconnected: true, tramMinStops: 60, tramHops: 5, tramMinHops: 1, tramStretch: 1.65, tramTarget: 3.17, tramDegCap: 6, tramShareStops: false, metroTarget: 2.88, startSpread: 220, bridges: 8, metroShareStops: false },
    river: { y: 0.62, waves: [[95, 300, 1.1], [45, 120, 0.3]] },
    parks: [
      { x: 0.35, y: 0.08, w: 620, h: 210, big: true },
      { x: 0.06, y: 0.12, w: 240, h: 190 },
      { x: 0.83, y: 0.14, w: 220, h: 180 },
    ],
    districts: [
      { x: 0.18, y: 0.5, s: 190, w: 0.9 },
      { x: 0.5, y: 0.48, s: 210, w: 1.0 },
      { x: 0.82, y: 0.52, s: 190, w: 0.9 },
    ],
    density: 0.9,
  },

  // A hill town: dense centre up top, scattered suburbs, river near the southern edge.
  hill: {
    name: 'Highcombe',
    blurb: 'A crowded hilltop centre with scattered suburbs and a river to the south.',
    riverName: 'Combe Water',
    parkName: 'Highcombe Park',
    labels: [{ text: 'Highcombe Hill', x: 0.5, y: 0.18 }, { text: 'Lowfield', x: 0.3, y: 0.72 }, { text: 'Ashcombe', x: 0.72, y: 0.66 }],
    // seed + settings tuned by: node tools/mapsearch.js --sy <dir> --layout hill
    tuned: { seed: 79759, streetBeta: 1, fillTarget: 0, cabTarget: 3.49, maxDeg2: 15, pruneLengthBias: 0.12, triWeight: 2.08, biconnected: true, tramMinStops: 56, tramHops: 6, tramMinHops: 1, tramStretch: 2.12, tramTarget: 3.38, tramDegCap: 4, tramShareStops: false, metroTarget: 3.47, startSpread: 210, bridges: 9, metroShareStops: false },
    river: { y: 0.8, waves: [[55, 460, 0.0], [20, 180, 1.7]] },
    parks: [
      { x: 0.4, y: 0.45, w: 560, h: 190, big: true },
      { x: 0.1, y: 0.12, w: 230, h: 180 },
      { x: 0.8, y: 0.35, w: 230, h: 200 },
      { x: 0.12, y: 0.55, w: 200, h: 160 },
    ],
    districts: [
      { x: 0.5, y: 0.22, s: 280, w: 1.2 },
      { x: 0.2, y: 0.4, s: 150, w: 0.6 },
      { x: 0.72, y: 0.66, s: 160, w: 0.7 },
      { x: 0.3, y: 0.7, s: 150, w: 0.6 },
    ],
    density: 0.7,
  },
};
