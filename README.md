# Nightfall Run

A hidden-movement chase, pass-and-play for 3–6 people on one computer or solo against the
computer. One player is the Fugitive, moving in secret through the city of Brackwell. Everyone
else plays the Detectives, who work together to catch the fugitive within 24 moves.

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

### Playing against the computer

On the setup screen, **Players** offers pass-and-play, playing the fugitive against computer
detectives, or playing the detectives against a computer fugitive. Against the computer
there are no look-away curtains: the computer's moves play out on the board, and you are told
which tickets a computer fugitive used.

The computer players are the full-strength bots (the alpha-beta fugitive and the ISMCTS
detectives, see [Bots](#bots-python)) running in the browser itself: `js/ai/` is a
JavaScript port of the Python bots in `ai/`. They make the same choices, checked position by
position by `tests/ai_parity.test.js`, and take about 0.1 s per detective move. Over 900
games on the five cities (`node tools/arena.js`, 60 per city and count) the JavaScript
detectives won 22.3% / 55.3% / 76.0% with 3 / 4 / 5 detectives, against 21.2% / 54.4% /
76.0% for the Python bots (±5 points). They run in
a Web Worker so the page stays responsive. Opened straight from disk (double-clicking
`index.html`), browsers refuse to start the worker, so the bots run on the page instead
(the same bots; the page just pauses while one thinks). If they ever fail, the simpler
heuristic bots in `js/bots.js` finish the game, and the page says so.

`python3 -m ai.serve` in the game folder serves the page too. It finds a free port (the
first from 8000 up), prints the address and opens it; `--port N` insists on one port,
`--no-browser` skips opening the page. It also saves every game to `data/games/` (below),
and still answers bot moves and reviews over HTTP (`/api/move`, `/api/review`) with the
Python bots, for tools and tests.

**Game review.** When a game ends, **View the board and review** (or **Review** in the side
panel) shows a review: a few plain-language lessons, then a move-by-move table comparing
each move with what the bots would have played (click a row to show the station). As the
fugitive: how close the detectives were, room to run, how many stations they had to
consider, which move let them force a capture, wasted secrets, doubles spent too early,
how predictable you were. As the detectives: where the fugitive really was, how often you
matched the bot detectives, and any move that could have caught it but didn't. Pass and
play gets both. The review runs in the browser (`js/ai/review.js`, a port of `ai/review.py`
with the same fields and wording; `python3 -m ai.review <record>` prints one from Python).

**Game records.** Every game is recorded move by move (pass-and-play games too, as mode
`hotseat`), with how long each move took and the optional player name from the setup screen.
Served by `ai.serve`, each game goes to `data/games/<id>.json` (`--data <dir>` for
elsewhere). Otherwise the browser keeps them, with a **Download the records** link on the
setup screen, and hands them to the server the next time the page is served by it. With a
records address in `js/config.js`, finished games are also sent there: a private Google
Sheet, see below.
`python3 -m ai.human_games [files or folders]` checks and summarises them, and
`ai/human_games.py` turns them into training data (`as_training_games`: the fugitive turns of
games where a person played the fugitive, against the computer or pass and play, in the
format the location model is fitted on).

### Putting it online for friends

The game is a static site, so GitHub Pages (or any static host) can serve it as is, bots
included:

1. In the repository on GitHub: **Settings → Pages → Build and deployment → Deploy from a
   branch**, branch `main`, folder `/ (root)`. The site appears at
   `https://<user>.github.io/<repo>/` within a minute or two. On a free account the
   repository has to be public for Pages. Nothing links to the site, so only people you send
   the address to will find it, but it isn't locked.
2. To collect your friends' games, set up the Google Sheet in
   [`tools/sheets/README.md`](tools/sheets/README.md) and put its address in `js/config.js`.
   The sheet stays private to your Google account. The page can only add games to it, and
   `python3 -m ai.import_records <sheet.csv>` brings them into `data/games/` after checking
   each one against the rules.

`data/` is in `.gitignore`, so your own records stay off GitHub.

## Project layout

| Path | What it is |
| --- | --- |
| `js/engine.js` | Rules engine (pure logic, runs in the browser and in Node) |
| `js/maps/*.js` | The five generated cities (Brackwell, Harrowgate, Oldmere, Saltmarsh, Highcombe): stations, cab/tram/metro/ferry links, start stations, street shapes and decor. Each registers itself in `window.MAPS`; every new game starts in a random one (the setup screen lets you pick another). Rebuild them all with `node tools/genmap.js`. |
| `js/render.js` | SVG board renderer with pan and zoom |
| `js/ui.js` | Turn flow, hot-seat privacy screens, games against the computer, game records, side panel, save/resume |
| `js/ai/` | The full-strength computer players in JavaScript, ports of the Python bots: `core.js` (board tables, rules by station index, heuristic players, value and location models), `alphabeta.js`, `ismcts.js`, `review.js` (post-game review), `players.js` (one call per bot move or review), `worker.js` (runs them in a Web Worker), `weights.js` (the fitted models, generated by `python3 tools/export_ai_weights.py`) |
| `js/config.js` | Site settings: `recordsUrl`, where finished games are sent (see [Putting it online](#putting-it-online-for-friends)) |
| `js/bots.js` | Simple heuristic players (those of `tools/simulate.js`), the last resort if the full-strength bots fail |
| `tools/genmap.js` | Map generator (`node tools/genmap.js [seed] [setting=value ...]`); settings and their defaults are in `DEFAULTS` at the top |
| `tools/decor.js` | Visual-only city detail, run by the generator: shaped streets (arcs, S-bends, kinks, doglegs that never cross or touch other stations), street-front buildings, park trees, paths and ponds, bridges, squares at metro hubs, and district/river/park names |
| `tools/layouts.js` | Five hand-designed city layouts (river, parks, districts) with their tuned seeds and settings; build one with `node tools/genmap.js layout=<key>` (default `twin`; `layout=none` for the free generator) |
| `tools/mapstats.js` | Graph statistics for the map (`node tools/mapstats.js [--sy <dir>]`), optionally side by side with a reference board |
| `tools/mapsearch.js` | Searches seeds and generator settings for the map closest to a reference board's statistics (`node tools/mapsearch.js --sy <dir> [trials]`) |
| `tools/simulate.js` | Bot-vs-bot win-rate simulation on every map (`node tools/simulate.js [games] [--sy <dir>]`) |
| `tests/engine.test.js` | Rules tests plus 300 random full games (`node tests/engine.test.js`) |
| `tests/bots.test.js` | The in-page bots play 120 games against each other on every map, recorded as the page records them (`node tests/bots.test.js`) |
| `tests/ai_parity.test.js` | The JavaScript bots against the Python ones on about 1,000 positions: rules, values, playouts, prior scores, fugitive model, location estimates, alpha-beta scores (`node tests/ai_parity.test.js`; positions from `python3 tools/ai_parity_fixture.py`) |
| `tools/arena.js` | Bot-vs-bot win rates for the JavaScript bots, like `python3 -m ai.arena` (`node tools/arena.js --dets 3,4,5 --games 48`) |
| `tools/sheets/` | Google Apps Script (`Code.gs`) and setup steps for collecting games in a private Google Sheet; `python3 -m ai.import_records <csv>` imports them |
| `data/games/` | Recorded games (created by `ai.serve` and `ai.import_records`; not in git) |
| `tools/trace_games.js` | Records random JS games move by move, for the Python port's parity test |
| `ai/` | Python bots and engines; see [Bots](#bots-python) |

## Bots (Python)

The bot results below were measured on the previous versions of the five cities (before
the November 2026 rebuild that removed line crossings, see [Map balance](#map-balance)).
The new cities have the same layouts and closely matching graph statistics, so the
comparisons between bot settings should carry over, but the exact percentages will differ.

`ai/` is a Python port of the rules engine plus computer players, for training and
benchmarking bots outside the browser. It needs Python 3.10+ and numpy (`pip install numpy`).
Run everything from the project root.

Optional, for speed: numba (`python3 -m pip install numba`). With it, the search hot paths
run compiled (`ai/fast.py`, `ai/fast_tree.py`): alpha-beta about 10× faster, ISMCTS about 3×.
Without it everything works the same, only slower. numba ships prebuilt packages for
Apple Silicon Python; an Intel (x86_64) Python on an M-series Mac, such as an old miniconda
install, cannot install it (pip tries to build it from source and fails). Check with
`python3 -c "from ai import fast; print(fast.AVAILABLE)"`.

| Path | What it is |
| --- | --- |
| `ai/engine.py` | One game at a time, for tree search. Same rules as `js/engine.js`; reads the maps straight from `js/maps/*.js`. Stations are indices `0..N-1` (`GameMap.ids` / `.index` convert). |
| `ai/vec_engine.py` | Batched engine: many games as numpy arrays, stepped together. Used for rollouts, and the base for an RL environment. |
| `ai/policies.py` | The heuristic and random players from `tools/simulate.js`, in single-game and batched form |
| `ai/alphabeta.py` | Alpha-beta fugitive (paranoid search, detectives one ply each), 3 rounds deep by default |
| `ai/ismcts.py` | ISMCTS detectives, 3,072 iterations per move by default (samples where the fugitive could be, shares one tree across samples). Samples come from a location estimate that follows the public log move by move (`belief: 'mix'`, see [Where is the fugitive?](#where-is-the-fugitive)). Moves are picked by PUCT with a prior from the heuristic detectives; leaves are scored by a 2-round playout plus the value model (`rollout_rounds`: `None` = play to the end, `0` = value model only). Inside the tree the fugitive is an adaptive opponent by default (`fugitive_model: 'bandit'`), or the fixed heuristic (`'heuristic'`). The detectives cooperate: they keep one shared search tree from move to move (`reuse: 'game'`) and score moves by how little room they leave the fugitive as a team (`prior_terr: 0.3`). Use one bot per game. |
| `ai/value.py` | Learned position value (logistic regression on hand-made features), fitted to bot games: `python3 -m ai.value fit`. Writes `ai/value_weights.json`, which ISMCTS loads. |
| `ai/arena.py` | Bot-vs-bot matches on all cores: `python3 -m ai.arena -f alphabeta -d ismcts --maps twin --dets 4 --games 100`. `--oracle` is a diagnostic that shows the detectives the fugitive's true station. |
| `ai/annotate.py` | Plays one game and prints every decision with numbers (distances, candidate count, safe exits, search scores, the value model's P(detectives win), and where the heuristic or an all-seeing detective would have moved differently): `python3 -m ai.annotate --map twin --seed 0` |
| `ai/fast.py`, `ai/fast_tree.py` | Compiled versions (numba) of the rules, the heuristic playouts, the value features, the alpha-beta tree search, and the ISMCTS prior and fugitive-turn ranking. Same results as the Python code (the tests check it); used automatically when numba is installed (`fast: false` turns it off). |
| `ai/serve.py` | Serves the game with the Python bots behind it and saves game records: `python3 -m ai.serve` (see [Playing against the computer](#playing-against-the-computer)). The page sends the whole game so far; the server replays it through `ai/engine.py`, so the detective bot only ever sees the public view. |
| `ai/human_games.py` | Loads, replays and summarises recorded games, and converts them to training data |
| `ai/review.py` | The post-game review the page shows (`POST /api/review`) |
| `ai/simulate.py` | Batched heuristic simulation, the counterpart of `tools/simulate.js` (`python3 -m ai.simulate 2000`) |
| `ai/tests/` | `python3 -m unittest discover ai/tests`: parity with the JS engine (replays 500 recorded games, needs Node), batched vs single engine, compiled vs Python code (skipped without numba), bot behaviour, the bot server and the game records (records built by the page's own code, replayed in Python) |

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

Speed on an M4 Pro, one game at a time (4 detectives), with numba / plain Python:
alpha-beta depth 3 26 / 254 ms per turn (depth 2: 3 / 25 ms); ISMCTS 3,072 iterations about
0.2 s per move (1,536 iterations: 92 / 290 ms). With 12 games running at once, as in the
arena, expect roughly 1.5–2× those.
The compiled alpha-beta visits exactly the same tree (same moves, node counts and scores);
the compiled playouts match the batched engine exactly without noise and draw their noise
from numba's random stream. What made the difference for ISMCTS, found with `--oracle` runs
(detectives shown the true station, against alpha-beta): the old search won 40% even knowing
where the fugitive was, worse than the heuristic's 55%, because ~80 noisy full playouts per
move could not separate good moves from bad. The heuristic prior took it to 80% and
value-model leaves to 88–90%. The location estimate puts on average 0.30 probability on the
true station against alpha-beta, vs 0.13 for uniform.

What else was tried, 4 detectives against alpha-beta, same 240 start positions (baseline
28.3%, about ±6 points; the old defaults, alpha-beta depth 2 against ISMCTS 1,536 iterations):

| Change | Detectives win |
| --- | --- |
| detectives shown the true station (`--oracle`) | 64.6% |
| ISMCTS `iterations: 3072` (now the default) | 34.6% |
| alpha-beta `depth: 3` (now the default) | 21.7% |
| alpha-beta `depth: 3` against ISMCTS 3,072 (the new defaults) | 26.3% |
| (compiled code: depth 2 vs 1,536 / depth 3 vs 1,536 / depth 2 vs 3,072) | 24.6% / 23.7% / 32.1% |
| alpha-beta `depth: 4` against ISMCTS 3,072 | 31.7% (worse for the fugitive than depth 3, at 14× the time) |
| alpha-beta `room_depth: 4` | 25.0% |
| alpha-beta room weight 1.5 / 5 / 8 | 30.0% / 32.9% / 36.7% |
| ISMCTS `belief_beta: 3` | 25.0% |
| ISMCTS `search_belief: 'prior'` / `'both'` (estimate also in the prior / playouts) | 27.9% / 27.9% |
| ISMCTS `team: 2, cover: 6` (team-coverage terms in prior and playouts) | 26.3% (5 detectives: 49.6% vs 48.7%) |

Detectives working together, ISMCTS 3,072 against alpha-beta depth 3 (the baseline above,
26.3%; same 240 start positions):

| Change | 4 detectives | 5 detectives | Room left | ms/move |
| --- | --- | --- | --- | --- |
| none (independent searches) | 26.3% | 52.1% | 24.1 | 338 |
| `reuse: 'round'` (shared plan within a round) | 28.3% | | 23.0 | 399 |
| `reuse: 'round', reuse_budget: 'total'` (same, equal compute) | 26.7% | | 23.5 | 150 |
| `reuse: 'game'` (shared plan kept across the fugitive's turn) | 35.0% | 58.3% | 22.5 | 397 |
| `prior_terr: 0.3` (territory objective in the prior) | 31.3% | 47.1% | 21.7 | 353 |
| `prior_terr: 0.3, playout_terr: 0.3` (also in playouts) | 31.3% | | 22.1 | 483 |
| **`reuse: 'game', prior_terr: 0.3` (the defaults, with `belief: 'model'`)** | **37.9%** | **62.5%** | 20.4 | 464 |

Room left: the fugitive's room to run after each detective round, averaged. Two ways of
cooperating: a shared plan (`reuse`: each detective continues the previous decision's
search tree instead of starting over, so the team follows one plan) and a team objective
(`prior_terr`: a move scores by how many stations the fugitive could still reach first
within 3 moves, given where the other detectives stand; `policies.team_territory`). On the
heuristic detectives the territory objective (`terr: 0.1`) raised the win rate from 5.3% to
8.3% over 3–5 detectives (5 detectives: 9.5% → 15.0%), where the older team/cover terms
changed nothing.

Hidden information is the largest gap (28% → 65% when shown the station); more search
still helps both sides. `search_belief` and `team`/`cover` (also on the heuristic
detectives, where a sweep of 8 settings changed nothing) stay off by default.

### Where is the fugitive?

The detectives sample the fugitive's station from a location estimate that follows the public
log move by move. It needs a model of how the fugitive picks its moves:

- `belief: 'model'`: it runs from detectives, picking among the stations its ticket reaches
  with odds exp(2 · distance to the nearest detective, capped at 4).
- `belief: 'fitted'`: a model fitted to 17,155 recorded alpha-beta moves
  (`ai/move_weights.json`, features in `policies.move_features`). It gives odds to each
  (ticket, destination) pair, so the ticket used is evidence too (a secret ticket is unlikely
  from a station with good taxi exits), and it knows the fugitive's habits: room to run, exits,
  saving secret tickets for late in the game and never wasting one on a reveal.
- `belief: 'mix'` (default): both models filter side by side, each weighted by how well it
  has predicted what the detectives have seen this game (tickets used, reveals, empty
  stations), so the bot works out which kind of fugitive it is facing. More models (one
  fitted to people's games from `data/games/`, say) slot in the same way.

Average probability on the true station, on held-out games:

| Fugitive | uniform | `'model'` | `'fitted'` | `'mix'` |
| --- | --- | --- | --- | --- |
| alpha-beta | 0.13 | 0.27 | 0.33 | 0.33 |
| heuristic | | 0.39 | 0.35 | 0.38 |

Against alpha-beta (Brackwell + Oldmere, 240 games per cell, same start positions):

| Detectives | `'model'` | `'fitted'` | `'mix'` |
| --- | --- | --- | --- |
| 4 | 37.9% | 41.3% | **43.8%** |
| 5 | 62.5% | 69.2% | **72.1%** |

Balance, alpha-beta fugitive (depth 3) against the detectives, all 5 maps. The older rows are
240 games per count (48 per map) on the old cities. The last row is the current bots on the
current (rebuilt) cities: 1,140 games per count for 3–5 detectives (228 per map, about ±2.5–3
points overall), 240 for 1–2:

| Detectives | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| heuristic detectives win (old cities) | 1.3% | 0.4% | 0.4% | 8.3% | 15.4% |
| ISMCTS, old defaults (1,536 iterations, independent, vs depth 2; old cities) | 3.8% | 0.8% | 11.7% | 30.0% | 53.3% |
| ISMCTS, shared plan + territory, `belief: 'model'` (old cities) | 0.0% | 1.2% | 14.6% | 41.7% | 67.5% |
| **ISMCTS, current defaults (`belief: 'mix'`), new cities** | **0.4%** | **2.1%** | **21.2%** | **54.4%** | **76.0%** |

By city (current bots), detective win %:

| City | 3 | 4 | 5 |
| --- | --- | --- | --- |
| Brackwell | 28.1% | 64.9% | 82.5% |
| Harrowgate | 11.0% | 36.0% | 54.4% |
| Oldmere | 25.4% | 56.6% | 81.6% |
| Saltmarsh | 17.5% | 59.2% | 82.9% |
| Highcombe | 24.1% | 55.3% | 78.5% |

(228 games per cell, ±4–6.5 points.) Against the strongest fugitive, 4 detectives is close to
even and 5 strongly favours the detectives; 1–2 detectives cannot win. Harrowgate is clearly
the hardest city for the detectives (about 20–28 points below the others at 4–5 detectives);
the other four are within noise of each other at 4–5.

Other value-model files: `ai/value_weights_gen1.json` (fitted on ISMCTS games) and
`ai/value_weights_room.json` (adds the room-to-run features; slightly better fit, held-out log
loss 0.279 → 0.273). Neither changed the arena results, so the default stays
`ai/value_weights.json`. Pass `--dopts '{"value_path": "ai/value_weights_room.json"}'` to use one.

If you change the rules in `js/engine.js`, make the same change in `ai/engine.py` and
`ai/vec_engine.py`; the tests will catch any drift.

## Map balance

Each city is a hand-made layout in `tools/layouts.js` (river, parks, districts; Brackwell's
two old towns face each other across the river), its seed and settings tuned by
`tools/mapsearch.js` to match the classic Scotland Yard board's graph statistics: average distance, travel times by line, degree
mix, how fast the fugitive's possible locations grow between reveals, start spacing, and
no single station whose loss would cut off part of the map. The reference board uses the
`stations.txt`/`connections.txt` format from AlexElvers/scotland-yard-data; pass its folder
with `--sy`.

Stations can also bunch into districts (`density`, `districts`) instead of being spread
evenly, never closer than `minGap` (76 px) so pieces and highlights don't overlap. The
layouts in `tools/layouts.js` (harbour, twin, quarter, market, hill) each meet the
standard in `tools/mapsearch.js` or come within a hair of it; run
`node tools/mapsearch.js --sy <dir> --layout <key> --no-cross` to retune one after editing it.

**No line crossings.** Two tram lines (or two metro lines) never pass through the same
station without stopping there (`tramShareStops: false`, `metroShareStops: false`), so the
map never has to show four lanes of one colour meeting at a station with no way to tell
which continues where. `mapsearch.js --no-cross` enforces this, and `mapstats.js` reports
`crossings`. (If a map built with sharing allowed has crossings, `js/render.js` draws one
line around the station with a bridge over the other.) The cities were rebuilt this way in
November 2026; games saved or recorded on the old cities can't be resumed or replayed on the new ones:

| City | score (lower = closer to Scotland Yard) | misses | heuristic detectives win, 3 / 4 / 5 detectives |
| --- | --- | --- | --- |
| Brackwell | 30.0 (was 34.2) | maxBetweenness, by a hair | 13.1% / 25.7% / 36.9% |
| Harrowgate | 66.8 (was 45.5): more street triangles (clustering 0.29) and more 4-street stations | none | 10.9% / 21.3% / 33.4% |
| Oldmere | 36.1 (was 42.6) | maxBetweenness, tram links 88 vs 89 | 12.6% / 23.3% / 35.2% |
| Saltmarsh | 41.1 (was 37.3) | average degree slightly high, maxBetweenness | 10.1% / 20.5% / 32.6% |
| Highcombe | 30.3 (was 32.8) | none | 15.2% / 24.1% / 33.0% |
