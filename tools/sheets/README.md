# Collecting games in a Google Sheet

The site (GitHub Pages or any static host) sends every finished game to a small Google
Apps Script attached to a sheet. The sheet stays private: only your Google account can open
it. The script can add rows but not read them, so its address is safe to have in the page.
The worst anyone who finds it can do is send junk rows, which the importer rejects.

## Set up (about 5 minutes, once)

1. Create a new Google Sheet, for example "Nightfall Run games". Don't share it with anyone.
2. In the sheet, open **Extensions → Apps Script**. Delete what's in the editor, paste in
   the contents of [`Code.gs`](Code.gs), and click **Save**.
3. Click **Deploy → New deployment**. Click the gear next to "Select type" and pick
   **Web app**, then set:
   - Description: `records`
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy**. Google asks you to authorise the script; it needs to edit this one
   sheet. On the "Google hasn't verified this app" screen, choose **Advanced → Go to …**:
   it's your own script.
4. Copy the **Web app URL** (it ends in `/exec`) into `js/config.js`:

   ```js
   window.NIGHTFALL_CONFIG = {
     recordsUrl: 'https://script.google.com/macros/s/…/exec',
   };
   ```
5. Commit and push. A `games` tab appears in the sheet with the first game that comes in.

"Anyone" means anyone can *send* a game to the script. It doesn't give access to the
sheet, which only accepts rows through the script.

If you edit `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New
version**. That keeps the same URL; a brand-new deployment gets a new one.

## Bring the games home

In the sheet: **File → Download → Comma-separated values (.csv)**. Then:

```sh
python3 -m ai.import_records ~/Downloads/"Nightfall Run games - games.csv"
python3 -m ai.human_games              # summary of everything in data/games/
python3 -m ai.review data/games/<id>.json
```

The importer replays every game against the rules on the current maps and skips anything
that isn't a legal game. It keeps the longest copy when a game was sent twice (a game
abandoned mid-way is sent as far as it got when the tab closes). Re-importing the same
file changes nothing.

## What a row contains

When it arrived, the game id, the optional player name, the mode, the city, the number of
detectives, the result, and the full record: start stations, every move with its ticket and
thinking time, and which bots played. The setup screen tells players their finished games
are sent to you.

## Turning it off

Empty `recordsUrl` in `js/config.js`, or in Apps Script use **Deploy → Manage deployments
→ Archive**. Old pages that still point at the archived URL just fail quietly.
