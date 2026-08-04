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
- **Tests:** `npm test` — 44 rules/calendar/API assertions + a headless-chromium check

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
  calendar.js          — the 12-week heatmap grid. PURE. Monday-anchored, DST-safe.
  routes.js            — all HTTP; cache-bust stamp; plannedEntries(); applyProgression()
public/
  index.html           — all four screens (home / session / summary / history)
  style.css            — all styles
  sw.js                — service worker (network-first, cache fallback) + notificationclick
  manifest.json        — PWA manifest; icon.svg + icon-{180,192,512,maskable}.png
  js/
    app.js             — entry: boot, screen routing, SW registration
    state.js           — the S bag + localStorage helpers
    util.js            — $, esc, mmss, dayLabel, toast, showScreen, buzz
    alarm.js           — THE rest alert: audio-thread scheduling + notifications
    sync.js            — local-first save + offline retry queue
    home.js            — Today screen (prescription + stats + the alerts switch)
    session.js         — live workout: sets, weight stepper, rest timer, wake lock
    summary.js         — post-workout outcomes + deload button
    history.js         — 12-week calendar, weight sparklines, past workouts
test/
  test.js              — progression + calendar truth tables, API smoke (temp store)
  client-check.js      — headless chromium: runs a full 15-set workout, fails on any JS error
data/store.json        — live data (gitignored)
```

## The rest alert — read this before touching the timer

**The rest timer is not what makes the sound.** On iOS a PWA that isn't in front
is *frozen* within seconds — not throttled, frozen. `setInterval` stops,
`setTimeout` stops, the service worker stops. The old design beeped from the
interval when it saw the clock run out, which meant it never fired at all if you
locked the phone or switched apps between sets, which is most of a rest period.

So `alarm.js` **schedules the tone on the audio thread the moment rest starts**,
at an absolute `AudioContext` time. Web Audio renders ahead on its own clock and
keeps going while the main thread is frozen — as long as the audio session stays
alive, which is what the near-silent keep-alive source is for (amplitude 1e-4:
inaudible, but a real signal, since digital silence gets optimised away along
with the session). This also works with **no signal**, which matters because the
whole app is built to run a workout in a gym basement.

- `startRest()` calls `scheduleAlarm(total)`. `stopRest()` calls `cancelAlarm()`
  — skipping or extending **must** unschedule, or the tone goes off mid-set.
  Both directions are asserted in `client-check.js` via `alarmPending()`.
- `paint()` no longer beeps. It fires on whichever tick happens to run after you
  unlock the phone, which would be minutes late.
- If the context was suspended anyway its clock froze, so the queued tone would
  now play wildly late. `dropIfStale()` bins it on the next `visibilitychange`.
- **The notification is a bonus, not the mechanism.** It shows whenever the main
  thread is alive to raise it; the sound is what reaches you through a pocket.
  iOS only raises notifications through `ServiceWorkerRegistration.showNotification`
  — `new Notification()` does nothing in a PWA there.
- The home-screen switch controls the **banner only**. Permission can be granted
  but never revoked from script, so the toggle owns a separate `liftAlertsMuted`
  rather than pretending it can hand the permission back. The sound is never off.
- `navigator.vibrate` does nothing on iOS. `buzz()` stays for anywhere that has it.

**Web Push is the textbook answer and is the wrong one here**: it needs a network
at the exact moment the app is designed not to have one.

## The training calendar

`lib/calendar.js` is pure and computed **server-side**, shipped as `wire.heatmap`
— the client draws it and never buckets days itself, the same reason it renders
progression outcomes rather than re-deriving them. Twelve Monday-anchored weeks;
the current week is shown whole, with days after today outlined rather than
shaded, because a half-drawn final column reads as a missing week.

- Shading is **relative to the heaviest day in the window**, so it re-scales as
  the weights climb instead of saturating against a fixed threshold that stops
  meaning anything by March. Four levels, not a binary dot: a session you bailed
  out of halfway shouldn't read like a full one.
- Volume is `weight × reps` summed over logged sets. Skipped exercises and
  unlogged sets contribute nothing.
- **Days are walked with `setDate`, never by adding 86400000.** Adding a day
  across the March DST change lands at 23:00 the same day and shifts the whole
  grid by a column. There is a test pinned to that week.
- Two sessions on one day are one square with the volumes added, but both still
  count towards the per-week rate.
- Tapping a square scrolls its card into view and flashes it, rather than opening
  a detail screen you then have to navigate back out of on a phone.

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
| `GET /api/state` | exercises, rules, progress, settings, planned entries, workouts, `heatmap` |
| `POST /api/workout` | upsert a workout (full snapshot); `done:true` applies progression once |
| `POST /api/adjust` | manual weight/target override (machine minimums, accepting a deload) |
| `POST /api/settings` | `includeOptional`, `restSec` |
| `DELETE /api/workout/:id` | remove a logged workout |

## Key conventions

- **`lib/progression.js` and `lib/calendar.js` are pure and are the source of
  truth.** Don't mirror `nextState()` or the day bucketing into client code — the
  summary screen renders server outcomes and shows "will update when you're back
  online" if the POST failed, and `history.js` only draws the grid it is handed.
- **Anything that has to happen while the app is backgrounded belongs on the
  audio thread, not on a timer.** See The rest alert.
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
