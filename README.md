# WinGo Engine V2 (Independent Clone)

Runs the prediction engine and the Telegram broadcaster as a plain Node service, 24/7,
with a small web control panel. It is the browser version's logic moved to the server —
the strategy itself is unchanged.

No dependencies: everything uses Node's built-ins, so `npm install` has nothing to do
and deploys stay quick.

## Layout

| File | What lives there |
|---|---|
| `src/index.js` | boot + the round loop (poll feed → settle last round → publish next signal) |
| `src/config.js` | every constant and the default config |
| `src/store.js` | the single state object, saved to a JSON file |
| `src/history.js` | lottery feed + the rolling round history |
| `src/engine.js` | the four-stage prediction engine (pure logic, no I/O) |
| `src/posts.js` | builds the message: header, past results, target box, footer |
| `src/telegram.js` | Telegram client, broadcasting, the subscriber bot, DM cleanup |
| `src/server.js` | the control-panel API |
| `public/` | the control panel page |

The strategy rules live only in `engine.js`, so tuning them later means touching one file.

## Run it locally

```bash
cd wingo-engine
npm start                     # then open http://localhost:3000
```

The panel password is **`012m24`** unless you set `PANEL_PASSWORD` in the environment,
which is the better idea — see below.

## Environment

| Variable | Meaning |
|---|---|
| `PANEL_PASSWORD` | protects the control panel. Defaults to `012m24` — set your own, the panel can read your bot token. |
| `FEED_PROXY` | optional relay for the feed, ending in `?url=` |
| `FEED_URL` | optional — point at a completely different source |
| `WINGO_HOST` | optional — pin a single mirror host, e.g. `ar-lottery03` |
| `WINGO_GAME` | `WinGo_30S` (default), `WinGo_1M`, `WinGo_3M`, `WinGo_5M` |
| `PORT` | panel port (Render sets it for you) |
| `DATA_DIR` | folder holding `state.json` — on Render set this to the disk mount |
| `POLL_MS` | how often the feed is polled, default 2000 |

## When the feed answers 403

The feed is served from several mirror hosts that all return the same rounds:

```
ar-lottery02  ar-lottery03  ar-lottery04  ar-lottery05  ar-lottery01
```

`ar-lottery01` sits behind **Cloudflare Bot Management** and answers **HTTP 403** to many
data-centre IPs — Render's among them — before it even looks at the request. The others
serve the same data and do not. The engine therefore walks the list in that order,
remembers whichever host answered, and tries it first from then on, so a blocked host
never stops the bot. The panel's Data feed card shows which mirror is in use.

That is the whole fix, and it needs no configuration. Two optional overrides exist if a
day comes when they all refuse:

- `WINGO_HOST` — use one host only, e.g. `ar-lottery03`
- `FEED_PROXY` — a relay ending in `?url=` (`deploy/cloudflare-worker.js` is a ready-made
  free one) so requests leave from the relay's IP
- `FEED_URL` — point at a completely different source

`WINGO_GAME` picks the game: `WinGo_30S` (default), `WinGo_1M`, `WinGo_3M`, `WinGo_5M`.

## Deploy on Render

`render.yaml` is included, so **New → Blueprint** and point it at this repo. It creates a
**Web Service** with a 1 GB disk mounted at `/var/data`:

- A web service gives the engine an always-on process **and** a public URL, so the control
  panel is reachable from anywhere. `healthCheckPath: /healthz` keeps Render happy.
- A **free** web service sleeps after 15 minutes with no traffic, which would stop the
  engine — so the blueprint uses a paid instance type. Background workers never sleep
  either, but they have no public URL; if you do not need the panel, change `type: web`
  to `type: worker` and drop `healthCheckPath`.
- Set `PANEL_PASSWORD` in the dashboard (it is marked `sync: false`).
- The disk keeps `state.json` across restarts. Without it the saved channels,
  subscribers and rolling history are wiped on every deploy.

## Push to GitHub

```bash
cd wingo-engine
git init
git add .
git commit -m "WinGo engine: Node service + control panel"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `data/` and `.env`, so the bot token is not published.
Never paste a real token into a tracked file, and never commit an exported config JSON
(it contains the token).

## Things worth knowing

- **The engine has START / STOP buttons** on the panel. It boots already running, so
  normally you never touch them. STOP pauses the feed polling and every post; START
  resumes it. The setting survives a restart.
- **The Log card explains quiet spells.** If nothing is landing in the session log, look
  there first — it says things like `nothing published — no bot token` or
  `feed failed: timed out after 10s`. The Data feed card also has **TEST FEED NOW**, which
  makes one live call and reports the rounds, latency and any error.
- **A missed round can no longer wedge the engine.** If the process sleeps or the feed
  jumps past the round a signal was made for, that signal is logged as `⏭️ MISSED` and
  cleared, so the next round publishes normally.
- **Bot token** lives in `data/state.json` on the server, not in this repo.
- **Post images** use Telegram `file_id`s, which only work for the bot that received the
  photo. If the token changes, re-send the pictures to the new bot and paste the new ids.
- **Photos cap the caption at 1024 characters**, so long PAST RESULTS lists are trimmed
  to the newest lines that fit. With images off the full list goes out.
- **STOP wipes the subscriber's DM** using `deleteMessages` (100 ids per call). Telegram
  refuses to delete messages older than 48 hours, and the welcome message is sent before
  the user subscribes, so that one stays on purpose.
- **The countdown is measured** from the moment a new period is first seen, so it cannot
  drift with the server's timezone.
- Predictions have no statistical edge — the draw is random. This service relays a fixed
  rule faithfully; it does not make the rule predictive.
