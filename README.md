# Lift

A personal progressive-overload workout tracker. Single user, no accounts — it
runs on a Raspberry Pi behind a Cloudflare tunnel, with Cloudflare Access in
front of it instead of a login screen.

Node + Express, vanilla ES modules, a JSON file for storage, **no build step**.
`node server.js` is production.

## The program

Three sets, ninety seconds' rest, 8–12 reps, on the same machines every time.

| Result | Next workout |
|---|---|
| all three sets at **12** | weight **+5 lb**, target back to **8** |
| all three sets at target (8 or 10) | target **+2** |
| any set below **8** | **offers** a 5 lb drop — never automatic |
| otherwise | repeat the same weight and target |

So a lift climbs 8 → 10 → 12 → +5 lb → 8. The rules live in exactly one place,
`lib/progression.js`, as pure functions with a test for every row above. The
client renders what the server returned rather than reimplementing them.

## Built for a gym, not a desk

- **Works with no signal.** Every set saves to the device first and drains to the
  server when it reconnects. The client mints workout IDs, so a replayed offline
  save updates the workout instead of duplicating it, and progression applies
  exactly once — a bad connection can't double-advance your weights.
- Screen wake-lock during a session.
- Installable PWA.

## The rest alert has to survive your pocket

An iOS PWA that isn't in front is *frozen* within seconds — not throttled,
frozen. Every timer stops, including the service worker's. So a rest timer that
beeps when its interval sees the clock run out never fires at all if you lock the
phone between sets, which is most of a rest period.

Lift schedules the tone on the **audio thread**, at an absolute `AudioContext`
time, the moment the rest starts. Web Audio renders ahead on its own clock and
keeps going while the main thread is frozen, held open by a near-silent
keep-alive source. It works with the screen off, and it works with no signal —
which is why it isn't Web Push, the textbook answer that needs a network at
exactly the moment this app is designed not to have one. The notification banner
is a bonus on top; the sound is the mechanism.

## Twelve weeks at a glance

The History screen opens on a calendar: twelve Monday-anchored weeks, each day
shaded by how much you actually moved, relative to the heaviest day in the
window so it re-scales as the weights climb. Four shades rather than a dot,
because a session you bailed out of halfway shouldn't read like a full one. Tap
a day to jump to that workout.

The grid is computed server-side in `lib/calendar.js` and has its own truth
table — day bucketing is where calendars go wrong, and none of it shows up until
a square lands on the wrong weekday months later. There's a test pinned to the
March DST week for exactly that reason.

## Running it

```bash
npm install
npm test          # rules + API smoke + a headless-chromium check
npm start         # PORT=3003 by default
```

`npm test` runs a real browser through a full fifteen-set workout and fails on
any JS error. That check earned its keep immediately: it caught a rest-timer
overlay covering the whole screen, which the property-based assertion it replaced
had been happily reporting as hidden.

See `CLAUDE.md` for the full architecture notes.
