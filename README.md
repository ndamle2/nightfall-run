# Nightfall Run

A pass-and-play hidden-movement chase for 3–6 people on one computer. One player is the
Fugitive, moving in secret through the city of Brackwell. Everyone else plays the Detectives,
who work together to catch the fugitive within 24 moves.

## Play

Open `index.html` in a browser and pick a city on the setup screen. Double-clicking it works, and there's nothing to install.
The game saves itself in the browser, so you can close the tab and resume later.

- **Fugitive's turn:** a full-screen "look away" curtain appears. The fugitive clicks through,
  sees their own position, makes the move (or a double move), then presses **Confirm & hide**.
- **Detectives' turn:** each detective clicks a highlighted station in order. When a link
  can be taken with more than one ticket type, a picker asks which ticket to use.
  **Undo last move** works until you pass the computer back to the fugitive.
- Drag to pan, scroll to zoom, and use ⤢ to fit the whole map.
- **Optional helper:** "Shade every station the fugitive could be at" marks every station
  consistent with the public travel log.

Click **Rules** in the side panel for the full rules.

## Project layout

| Path | What it is |
| --- | --- |
| `js/engine.js` | Rules engine (pure logic, runs in the browser and in Node) |
| `js/maps/*.js` | The five generated cities (Brackwell, Harrowgate, Oldmere, Saltmarsh, Highcombe): stations, cab/tram/metro/ferry links, start stations, street shapes and decor. Each registers itself in `window.MAPS`; the first one loaded in `index.html` is the default. Rebuild them all with `node tools/genmap.js`. |
| `js/render.js` | SVG board renderer with pan and zoom |
| `js/ui.js` | Turn flow, hot-seat privacy screens, side panel, save/resume |
| `tools/genmap.js` | Map generator (`node tools/genmap.js [seed] [setting=value ...]`); settings and their defaults are in `DEFAULTS` at the top |
| `tools/decor.js` | Visual-only city detail, run by the generator: shaped streets (arcs, S-bends, kinks, doglegs that never cross or touch other stations), street-front buildings, park trees, paths and ponds, bridges, squares at metro hubs, and district/river/park names |
| `tools/layouts.js` | Five hand-designed city layouts (river, parks, districts) with their tuned seeds and settings; build one with `node tools/genmap.js layout=<key>` (default `twin`; `layout=none` for the free generator) |
| `tools/mapstats.js` | Graph statistics for the map (`node tools/mapstats.js [--sy <dir>]`), optionally side by side with a reference board |
| `tools/mapsearch.js` | Searches seeds and generator settings for the map closest to a reference board's statistics (`node tools/mapsearch.js --sy <dir> [trials]`) |
| `tools/simulate.js` | Bot-vs-bot win-rate simulation on every map (`node tools/simulate.js [games] [--sy <dir>]`) |
| `tests/engine.test.js` | Rules tests plus 300 random full games (`node tests/engine.test.js`) |
| `tools/trace_games.js` | Records random JS games move by move, for the Python port's parity test |
| `ai/` | Python bots and engines; see [Bots](#bots-python) |

## Bots (Python)

`ai/` is a Python port of the rules engine plus computer players, for training and
benchmarking bots outside the browser. It needs Python 3.10+ and numpy (`pip install numpy`).
Run everything from the project root.

| Path | What it is |
| --- | --- |
| `ai/engine.py` | One game at a time, for tree search. Same rules as `js/engine.js`; reads the maps straight from `js/maps/*.js`. Stations are indices `0..N-1` (`GameMap.ids` / `.index` convert). |
| `ai/vec_engine.py` | Batched engine: many games as numpy arrays, stepped together. Used for rollouts, and the base for an RL environment. |
| `ai/policies.py` | The heuristic and random players from `tools/simulate.js`, in single-game and batched form |
| `ai/alphabeta.py` | Alpha-beta fugitive (paranoid search, detectives one ply each) |
| `ai/ismcts.py` | ISMCTS detectives (samples where the fugitive could be, shares one tree across samples). Samples come from a location estimate that follows the public log move by move, assuming the fugitive tends to move away from detectives (`belief: 'model'`, strength `belief_beta: 2`; `'uniform'` treats every candidate alike). Moves are picked by PUCT with a prior from the heuristic detectives; leaves are scored by a 2-round playout plus the value model (`rollout_rounds`: `None` = play to the end, `0` = value model only). Inside the tree the fugitive is an adaptive opponent by default (`fugitive_model: 'bandit'`), or the fixed heuristic (`'heuristic'`). |
| `ai/value.py` | Learned position value (logistic regression on hand-made features), fitted to bot games: `python3 -m ai.value fit`. Writes `ai/value_weights.json`, which ISMCTS loads. |
| `ai/arena.py` | Bot-vs-bot matches on all cores: `python3 -m ai.arena -f alphabeta -d ismcts --maps twin --dets 4 --games 100`. `--oracle` is a diagnostic that shows the detectives the fugitive's true station. |
| `ai/annotate.py` | Plays one game and prints every decision with numbers (distances, candidate count, safe exits, search scores, the value model's P(detectives win), and where the heuristic or an all-seeing detective would have moved differently): `python3 -m ai.annotate --map twin --seed 0` |
| `ai/simulate.py` | Batched heuristic simulation, the counterpart of `tools/simulate.js` (`python3 -m ai.simulate 2000`) |
| `ai/tests/` | `python3 -m unittest discover ai/tests`: parity with the JS engine (replays 500 recorded games, needs Node), batched vs single engine, bot behaviour |

Bots share one interface: a fugitive bot has `choose_turn(state)` returning
`[('double')?, (to, ticket), ...]` and sees the full state; a detective bot has
`choose_move(state.public_view())` returning `(to, ticket)` and never sees the fugitive.
Bot settings are keyword arguments, passed to the arena as JSON (`--fopts '{"depth": 2}'`,
`--dopts '{"iterations": 1000}'`).

The alpha-beta fugitive's evaluation counts "room to run": stations it can reach within 3
moves before any detective can (`weights.room`, default 3; `policies.room_to_run`). Without
it the fugitive would walk into dead ends where every exit was safe for one more move. It
also never spends a secret ticket on a reveal round when a basic ticket would do.

Detective win rate, 4 detectives, Brackwell + Oldmere, 240 games per cell (±5–6 points at
95%), same start positions in every cell:

| fugitive \ detectives | ISMCTS, uniform estimate | ISMCTS, current defaults |
| --- | --- | --- |
| alpha-beta without room to run | 32.9% | 44.6% |
| alpha-beta, current defaults | 21.2% | 32.5%* |

\* also with the room value model below; it made no difference elsewhere.

Earlier results (before room to run and the reveal-round rule): against heuristic detectives
the heuristic fugitive was caught 21.2% of the time and alpha-beta 11.7%; the old ISMCTS (UCB,
full playouts) caught them 48.8% and 15.0%. The heuristic prior and value-model leaves took
ISMCTS from 15.0% to 37.9% against alpha-beta. With 5 detectives against the heuristic
detectives, room to run cut alpha-beta's capture rate from 20.0% to 13.7% (600 games).

Per move on an M4 Pro, with 12 games running at once: alpha-beta about 30–55 ms per turn,
ISMCTS about 0.5 s per move. What made the difference for ISMCTS, found with `--oracle` runs
(detectives shown the true station, against alpha-beta): the old search won 40% even knowing
where the fugitive was, worse than the heuristic's 55%, because ~80 noisy full playouts per
move could not separate good moves from bad. The heuristic prior took it to 80% and
value-model leaves to 88–90%. The location estimate puts on average 0.30 probability on the
true station against alpha-beta, vs 0.13 for uniform.

What else was tried, 4 detectives against alpha-beta, same 240 start positions (baseline
28.3%, about ±6 points):

| Change | Detectives win |
| --- | --- |
| detectives shown the true station (`--oracle`) | 64.6% |
| ISMCTS `iterations: 3072` (2×, 1.0 s per move) | 34.6% |
| alpha-beta `depth: 3` (0.55 s per turn) | 21.7% |
| alpha-beta `room_depth: 4` | 25.0% |
| alpha-beta room weight 1.5 / 5 / 8 | 30.0% / 32.9% / 36.7% |
| ISMCTS `belief_beta: 3` | 25.0% |
| ISMCTS `search_belief: 'prior'` / `'both'` (estimate also in the prior / playouts) | 27.9% / 27.9% |
| ISMCTS `team: 2, cover: 6` (team-coverage terms in prior and playouts) | 26.3% (5 detectives: 49.6% vs 48.7%) |

Hidden information is the largest gap (28% → 65% when shown the station); more search
still helps both sides. `search_belief` and `team`/`cover` (also on the heuristic
detectives, where a sweep of 8 settings changed nothing) stay off by default.

Balance with the current defaults, alpha-beta fugitive, all 5 maps, 240 games per count:

| Detectives | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| heuristic detectives win | 1.3% | 0.4% | 0.4% | 8.3% | 15.4% |
| ISMCTS detectives win | 3.8% | 0.8% | 11.7% | 30.0% | 53.3% |

Other value-model files: `ai/value_weights_gen1.json` (fitted on ISMCTS games) and
`ai/value_weights_room.json` (adds the room-to-run features; slightly better fit, held-out log
loss 0.279 → 0.273). Neither changed the arena results, so the default stays
`ai/value_weights.json`. Pass `--dopts '{"value_path": "ai/value_weights_room.json"}'` to use one.

If you change the rules in `js/engine.js`, make the same change in `ai/engine.py` and
`ai/vec_engine.py`; the tests will catch any drift.

## Map balance

The default map is Brackwell, the hand-made `twin` layout in `tools/layouts.js` (two old
towns facing each other across the river), tuned by `tools/mapsearch.js` to match the classic
Scotland Yard board's graph statistics: average distance, travel times by line, degree
mix, how fast the fugitive's possible locations grow between reveals, start spacing, and
no single station whose loss would cut off part of the map. The reference board uses the
`stations.txt`/`connections.txt` format from AlexElvers/scotland-yard-data; pass its folder
with `--sy`.

Stations can also bunch into districts (`density`, `districts`) instead of being spread
evenly, never closer than `minGap` (76 px) so pieces and highlights don't overlap. The
layouts in `tools/layouts.js` (harbour, twin, quarter, market, hill) each meet the
standard in `tools/mapsearch.js`; run `node tools/mapsearch.js --sy <dir> --layout <key>`
to retune one after editing it.
