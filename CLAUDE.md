# Lift — CLAUDE.md

Personal progressive-overload workout tracker. Single user (Andrew), no accounts —
auth is Cloudflare Access in front of the tunnel, so the app itself has no login.

Live at **https://workout.guess-ai.app** (Cloudflare tunnel `hot-seat` → `localhost:3003`).
Repo: `github.com/andgly95/workout` (private).

## Stack

Same shape as `~/the-square`, minus socket.io (single user — plain REST is enough):

- **Runtime:** Node.js v22, no build step — `node server.js` is production
- **Server:** Express, thin `server.js` + CommonJS modules in `lib/`
- **Store:** single JSON file (`data/store.json`) via `store.js` — no database
- **Frontend:** vanilla JS ES modules in `public/js/` + plain HTML/CSS
- **Deployment:** systemd service `workout` on the Pi, port 3003
- **Tests:** `npm test` — rules suite + API smoke + headless-chromium client check

## The program (the whole point)

3 sets · 90 s rest · 8–12 reps. 1–3 sessions a week, same machines every time.

Starting weights: leg press 140, chest press 80, low row 80, vertical traction
(lat pulldown) 60, overhead press 25, leg curl 60 (optional, off by default).

Progression ladder, per exercise — `lib/progression.js` is the ONLY place these
rules live (the client never re-implements them; the summary screen renders what
the server returned, and shows a pending state when offline):

| Result | Next workout |
|---|---|
| all 3 sets ≥ **12** | weight **+5 lb**, target back to **8** |
| all 3 sets ≥ target (8 or 10) | target **+2** |
| any set **< 8** | **offer** a 5 lb drop — never automatic ("may be dropped") |
| otherwise | hold — repeat the same weight and target |

So a lift climbs 8 → 10 → 12 → +5 lb → 8. `nextState()` is pure; every row above
has a test in `test/test.js`.

## File map

```
server.js              — express setup + listen (~12 lines)
store.js               — JSON read/write, debounced atomic save, SIGTERM flush
deploy.sh              — npm test → restart → verify active → push to GitHub
lib/
  progression.js       — EXERCISES, startingState(), nextState() — THE rules
  routes.js            — all HTTP; cache-bust stamp; plannedEntries(); applyProgression()
public/
  index.html           — all four screens (home / session / summary / history)
  style.css            — all styles
  sw.js                — service worker (network-first, cache fallback)
  manifest.json        — PWA manifest; icon.svg + icon-{180,192,512,maskable}.png
  js/
    app.js             — entry: boot, screen routing, SW registration
    state.js           — the S bag + localStorage helpers
    util.js            — $, esc, mmss, dayLabel, toast, showScreen, beep, buzz
    sync.js            — local-first save + offline retry queue
    home.js            — Today screen (prescription + stats)
    session.js         — live workout: sets, weight stepper, rest timer, wake lock
    summary.js         — post-workout outcomes + deload button
    history.js         — past workouts + weight sparklines
test/
  test.js              — progression rules + API smoke (isolated server, temp store)
  client-check.js      — headless chromium: runs a full 15-set workout, fails on any JS error
data/store.json        — live data (gitignored)
```

## Store schema

```js
state = {
  progress: { exerciseId: { weight, target } },   // what to lift NEXT time
  workouts: [{
    id,            // client-minted ('w' + base36) so offline retries upsert, not duplicate
    date,          // 'YYYY-MM-DD' local
    startedAt, finishedAt, done,
    applied,       // true once progression has been rolled in — makes replay idempotent
    outcomes,      // [{ id, action, weight, target, note, suggestWeight?, canDrop? }]
    entries: [{ id, weight, target, sets: [r,r,r], skipped }],
  }],
  settings: { restSec, includeOptional },
  seq: 1,
}
```

## HTTP routes

| Route | Purpose |
|---|---|
| `GET /` | shell, with cache-bust stamp injected |
| `GET /api/state` | exercises, rules, progress, settings, planned entries, workouts |
| `POST /api/workout` | upsert a workout (full snapshot); `done:true` applies progression once |
| `POST /api/adjust` | manual weight/target override (machine minimums, accepting a deload) |
| `POST /api/settings` | `includeOptional`, `restSec` |
| `DELETE /api/workout/:id` | remove a logged workout |

## Key conventions

- **`lib/progression.js` is the single source of truth for the rules.** Don't
  mirror `nextState()` into client code — the summary screen renders server
  outcomes, and shows "will update when you're back online" if the POST failed.
- **Local-first.** Every write hits localStorage before the network (`sync.js`).
  A whole workout runs with no signal; the queue drains on reconnect. The client
  mints workout ids so a replayed save upserts instead of duplicating.
- **Progression applies exactly once** per workout (`applied` flag) — an offline
  retry of a finished workout must not advance the weights twice. Tested.
- **`esc()`** for any user content interpolated into HTML.
- **`store.save()`** after every mutation.
- **No build step.** `style.css` gets `?v=STAMP`; the JS tree is served under a
  `/js-<STAMP>/` prefix (query params don't propagate through `import`), stripped
  in `lib/routes.js`. The stamp is set at startup, so **restart to bust caches**.
- **`[hidden]` needs help.** An author `display` rule beats the UA `[hidden]`
  rule — `.rest[hidden]{display:none}` exists for exactly that reason. Assert
  visibility in tests via layout (`offsetWidth`/`getClientRects`), not `.hidden`.

## Deployment

```bash
npm run deploy                   # npm test → restart → verify active → push to GitHub
sudo systemctl status workout    # logs
sudo journalctl -u workout -n 50
```

The push is non-fatal so a deploy doesn't fail when offline. The restart is what busts
client caches — the `/js-<STAMP>/` prefix is stamped at server startup.

Ingress lives in `~/.cloudflared/config.yml` (shared with the-square and
liner-note); the tunnel is `hot-seat`. Restart `cloudflared` after editing it.
