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
- Screen wake-lock during a session; beep and vibrate when rest hits zero.
- Installable PWA.

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
