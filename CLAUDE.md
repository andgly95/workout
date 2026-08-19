# Lift — CLAUDE.md

Progressive-overload workout tracker. **The program is data**: you build your own
workouts, each with its own overload rules and schedule, and switch between them.

**Multi-user.** Two ways in — **Cloudflare Access** (preferred here, since the
tunnel is already in front) or **Google Sign-In** — and one set of users behind
them. Andrew owns the instance; everyone else lands as `pending` and waits to be
approved from inside the app.

Live at **https://workout.guess-ai.app** (Cloudflare tunnel `hot-seat` → `localhost:3003`).
Repo: `github.com/andgly95/workout` (**public**).

## Stack

Same shape as `~/the-square`, minus socket.io (single user — plain REST is enough):

- **Runtime:** Node.js v22, no build step — `node server.js` is production
- **Server:** Express, thin `server.js` + CommonJS modules in `lib/`
- **Deps:** `express`, `web-push` (reminders), `google-auth-library` (sign-in)
- **Store:** single JSON file (`data/store.json`) via `store.js` — no database
- **Frontend:** vanilla JS ES modules in `public/js/` + plain HTML/CSS
- **Deployment:** systemd service `workout` on the Pi, port 3003
- **Tests:** `npm test` — 125 rules/schedule/plan/push/auth/access/calendar/API assertions + a headless-chromium check

## Accounts — read this before touching any route

`lib/auth.js` is the only thing between a stranger and somebody's training log.
Three rules, and everything else follows from them:

1. **A session cookie is HMAC-signed.** Unsigned, tampered or expired → no user.
   Stateless (`<base64url payload>.<sig>`), so there is no session table to grow
   and a restart doesn't sign everyone out. Deleting `sessionSecret` from config
   signs *everybody* out — that is the whole revocation story and it is enough here.
2. **`pending` until approved.** A stranger who signs in gets a user record and
   **no data slice at all**. They can read their own status and nothing else.
3. **Every data route runs against `req.d`**, the slice belonging to whoever the
   cookie says you are. **There is no route that accepts a user id.**

Rule 3 is the one that matters. A uid in a path or a body is how a multi-user app
leaks — it takes one handler that forgets to check it against the session. Here
there is nothing to forget, because the id is never accepted. A friend who knows
your plan id and PATCHes it gets a 404: the lookup happens in *their* slice, so it
simply isn't there. That has a test, and so does every other route.

- **`d` is threaded explicitly** into every helper (`activePlan(d)`,
  `plannedEntries(d, p)`, `wire(d, user)`…). A helper that could reach the whole
  store on its own is a helper that could return somebody else's plan.
- **The guard is applied to path prefixes in one place**, not remembered per
  handler. The failure mode of the per-handler version is a route that silently
  serves everybody.
- **Google ID tokens are verified with `google-auth-library`.** RS256 + JWKS
  caching + every `iss`/`aud`/`exp` edge case is exactly the sort of thing that
  looks right and isn't. An **unverified** email is rejected outright, or anyone
  could claim an address they don't control.
- **The user id is the Google `sub`, never the email.** Emails change hands.
- **`ownerEmail` in config decides who the owner is.** Without it the first person
  to sign in wins, which is fine on a box only you can reach and is not fine the
  moment you hand the URL out. Set it.
- **The owner adopts the pre-accounts data** — `state.legacy`, set aside by
  store.js on load. Adoption happens in `dataFor()`, not in the sign-in route, so
  it is exercised by every authenticated request rather than only on the single
  most consequential request of the app's life.
- **The owner cannot be denied.** There would be nobody left to approve anyone.
- Denying somebody **keeps their data**, so letting them back in doesn't cost them
  their history.

### Two doors, one set of users

Cloudflare Access and Google Sign-In are identity **sources**. Both end in
`upsertUser()`, so the approval queue, the data slices and everything downstream
are identical whichever way somebody arrived — a third source later is a function,
not a refactor.

| | Cloudflare Access | Google Sign-In |
|---|---|---|
| who authenticates | Cloudflare, before the request reaches the Pi | the app, after it does |
| config | `cfAccessTeam` + `cfAccessAud` | `googleClientId` |
| the user sees | nothing — already signed in | a Google button |
| unauthenticated traffic | never reaches the origin | reaches it and gets a 401 |

Access is the stronger posture: the request doesn't arrive at all unless it passes,
so the exposed surface is Cloudflare's rather than a box in a house. When
`cfAccessTeam`/`cfAccessAud` are set the client is told `clientId: null` and never
loads Google's script.

**The Access header is VERIFIED, never trusted.** This is the whole of
`lib/cfaccess.js` and the reason it isn't three lines. The tempting one-liner is to
read `Cf-Access-Authenticated-User-Email` — but anyone who can reach the origin
directly, over the LAN or if the tunnel is ever bypassed, can set any header they
like. That would be a total auth bypass for everyone on the same network. Instead:

- The JWT signature is checked against the team's published JWKS (cached an hour).
- **`alg` is pinned to RS256.** Honouring the header's own algorithm is the classic
  JWT bug: `none` authenticates everybody and HS256 lets the public key be used as
  an HMAC secret. Both have a test.
- **`aud` is checked** against the Access application's tag. Without it a token
  minted for *any* app on the team would open this one — and this team fronts four.
- `iss`, `exp` and `nbf` are checked, with 60s of clock tolerance.
- A failure to reach Cloudflare's certs degrades to "not signed in", never a 500 on
  every request.
- **Identities are namespaced** (`cf:<sub>`, `google:<sub>`), and a second door is
  linked to an existing user **by verified email**. Safe only because both sources
  verify the address; without it, signing in through Access and then through Google
  would silently hand you two accounts and two training logs.
- Access getting you to the door is **not** the same as being let in — a stranger
  Access admits is still `pending` to the app.
- Signing out redirects to `/cdn-cgi/access/logout`: clearing our own cookie alone
  would just be re-authenticated on the next request.

The verifier is driven from a **locally generated RSA keypair** in the suite, and
one test stands a fake JWKS in front of a whole server, so the crypto path is
exercised rather than being a branch nobody runs until it matters.

### Testing auth without Google

The suite pre-writes `sessionSecret` into `CONFIG_FILE` and the users into the
store, then signs its own cookies with **the same code the server verifies with**.
There is deliberately **no test-only bypass in production code** — that is how a
bypass eventually ships. `client-check.js` does the same and sets the cookie over
CDP.

## The program (the whole point)

**Plans, not a hardcoded program.** `state.exercises` is a catalogue of machines;
`state.plans` are named workouts that each pick some of them, in order, with their
own rules and schedule. `lib/plan.js` is the gate everything passes through — add
a field THERE FIRST or a PATCH will appear to work and change nothing.

```js
plan = { id, name, exerciseIds: [...],       // ordered
         rules:    { sets, minReps, maxReps, repStep, restSec },
         schedule: { mode, days, everyN, at, anchor },
         archived }
```

The default ladder is the original program — 3 sets · 90 s rest · 8–12 reps —
seeded as one plan called "My workout" holding all six original machines.

Starting weights: leg press 140, chest press 80, low row 80, vertical traction
(lat pulldown) 60, overhead press 25, leg curl 60.

### Weights are per PLAN, not per machine

`state.progress[planId][exerciseId]`. The same machine in Workout A and Workout B
keeps two weights, because **the rep target is part of the progression state** — a
plan built on 3×5 and one built on 3×12 would drag each other's weight around if
they shared. Plans whose exercises don't overlap pay nothing for the nesting.

- **Copying a plan copies its weights.** The machines are the same machines;
  starting a copy at the catalogue's seed weight would hand you a number from
  whenever the app was first set up. They diverge from there.
- `supersededBy()` in `routes.js` only counts later workouts **of the same plan** —
  B logging the leg press says nothing about A's leg press.
- The heatmap, the sparklines and the streak count are all filtered to the active
  plan. Mixing an upper day into a lower day's history makes both unreadable.

### `optional` is gone

A machine is in a plan or it isn't, and taking one out is a tap. `includeOptional`
was the only way to switch a lift off; the migration honours whatever it was set to
and then the flag stops existing.

### Progressive disclosure

The rule for the whole editor, because the three things it changes are wanted at
wildly different rates. **Machines are open** (routine). **Progressive overload and
Schedule are collapsed** to one line of plain English stating what they currently
do (changed once, if ever). You can read a whole plan without opening anything.

- The picker on Home **only renders with two or more plans** — with one, the home
  screen is what it was before plans existed. A list of one is not a choice.
- The overload summary comes from **`progression.describeRules()` on the server**,
  not from the client. A label the client worded itself would drift from what
  `nextState` actually does the first time the rules gained a knob.

Progression ladder, per exercise — `lib/progression.js` is the ONLY place these
rules live (the client never re-implements them; the summary screen renders what
the server returned, and shows a pending state when offline):

| Result | Next workout |
|---|---|
| all 3 sets ≥ **12** | weight **up one step**, target back to **8** |
| all 3 sets ≥ target (8 or 10) | target **+2** |
| any set **< 8** | **offer** a one-step drop — never automatic ("may be dropped") |
| otherwise | hold — repeat the same weight and target |

So a lift climbs 8 → 10 → 12 → heavier → 8. `nextState()` is pure; every row
above has a test in `test/test.js`.

**Every one of those numbers is now a per-plan knob.** `nextState(cur, reps, opts)`
takes `{ sets, minReps, maxReps, repStep, step }` and defaults to the original
program, which is why the whole pre-existing truth table still exercises it. Making
them arguments rather than having the file look a plan up is what keeps it pure.

`lib/plan.js cleanRules()` is where the guards live, and they matter because a
misconfigured plan looks like a broken app:

- `maxReps` can never sit below `minReps` — it is clamped up to meet it.
- `repStep` can never be 0 (the target would sit at `minReps` forever) and never
  exceed the range it steps through.
- **A plan with no rep rungs advances by weight.** 5×5 every time means `minReps ===
  maxReps`, so clearing the target has nowhere to send it and `nextState` returns
  `weight-up` instead of a rep bump. Without that, a 5×5 plan could never progress.
- **`Number(v) || default` is wrong for every number here** and was a real bug: a
  submitted `0` is present-but-illegal, not absent, so `sets: 0` came back as 3
  instead of clamping to 1. `num()`/`clamp()` treat only `undefined`/`null`/`''` as
  missing. The same trap is commented in `lib/schedule.js`.

### The step is per machine

| | step |
|---|---|
| leg press | 20 |
| chest press · low row · vertical traction · leg curl | 10 |
| overhead press | 5 |

A leg press stack has no 5 lb pin, and an overhead press climbing 20 at a time
goes from liftable to impossible in one workout. `step` lives on each entry in
`EXERCISES` and is read through **`stepFor(id)`**; `WEIGHT_STEP` (5) survives only
as the fallback for an id that names none.

- **The step is looked up by id, never stored on a logged entry.** How big a jump
  a stack supports is a fact about the machine, not about the sets you did on it
  — carrying a copy on every entry is how the two would come to disagree after a
  machine is re-rated.
- **`nextState(cur, sets, step)`** takes it as an argument rather than doing the
  lookup, so the function stays pure and the whole existing truth table keeps
  testing the default.
- **The deload drops by the same step it climbs by**, and the floor moves with it:
  `max(MIN_WEIGHT, step)`, so a leg press bottoms out at 20 rather than 5. At the
  floor the note says so instead of offering a drop it can't make.
- The client reads `exercises[].step` off the wire (`exStep()` in `home.js`) —
  used by the in-session ± stepper and by the "+20 lb" pill on Today. It does not
  keep a second table.
- **Existing weights aren't on the new grid** (leg press sat at 165 from the old
  +5 ladder, so it next lands on 185). Deliberately not snapped: guessing where a
  stack's grid is anchored is worse than one manual adjust, and `/api/adjust` plus
  the stepper already land on any real number.

## File map

```
server.js              — express setup + listen (~12 lines)
store.js               — JSON read/write, debounced atomic save, SIGTERM flush
deploy.sh              — npm test → restart → verify active → push to GitHub
lib/
  auth.js              — THE boundary: sessions, Google verification, the 3 rules
  cfaccess.js          — Cloudflare Access assertions, VERIFIED not trusted
  progression.js       — nextState(cur, reps, opts) + describeRules(). THE rules. PURE.
  plan.js              — THE gate: catalogue, plans, rules guards, migration
  schedule.js          — due / next / overdue. PURE, no clock. Truth-tabled.
  push.js              — VAPID, subscriptions, the once-a-minute reminder sender
  config.js            — config.local.json (gitignored, 0600); CONFIG_FILE override
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
    auth.js            — sign-in / waiting screens; boot is gated on it
    home.js            — Today screen (prescription + stats + plan picker + alerts)
    plan.js            — the plan editor. Progressive disclosure lives here.
    session.js         — live workout: sets, weight stepper, rest timer, wake lock
    summary.js         — post-workout outcomes + deload button
    history.js         — 12-week calendar, weight sparklines, past workouts
test/
  test.js              — progression + calendar truth tables, API smoke (temp store)
  client-check.js      — headless chromium: runs a full 15-set workout, fails on any JS error
data/store.json        — live data (gitignored)
```

## An occupied machine — walking away and coming back

A gym is not a queue you control. **"Machine busy"** sends the current exercise to
the back of that session's list and moves you to the next one; the **dots along the
top are buttons**, so you can jump to any machine at any point. All of it lives in
`public/js/session.js`.

- **Busy is not skip.** Skipping says "not doing this today" and forfeits the
  progression; busy keeps every set already logged and expects you back. Two
  buttons, because they mean opposite things about your next prescription.
- **The set you're on is DERIVED, not stored.** `nextSet(e)` is the first unlogged
  slot on that entry. The session used to hold one `setIdx`, which was fine while
  the order was fixed and is a bug the moment you can leave a machine half-done —
  the set index belongs to the exercise, not to the session. Deriving it is what
  makes coming back land on set 2 correctly, with no reconciliation.
- **`nextIdx(from)` wraps.** That wrap is the whole "come back later" mechanism:
  once everything after you is finished it walks round to the one you left. No
  "deferred" flag exists, because position already says it.
- **Dot state comes from the entry, never from its position.** "Everything left of
  the cursor is done" stops being true the moment you can reorder or jump. A
  part-done machine gets its own half-filled dot — that's the one you owe a visit.
- **A reorder holds the ENTRY, not its index**, across the splice and across a rest
  period. An index would point at whatever moved into that slot.
- **The workout ends when every machine is spent**, not when you reach the end of
  the array — after a reorder those are different things.
- The reordered list is what gets posted, so a phone that dies mid-workout comes
  back with the same queue. `applyProgression` iterates entries and is
  order-independent; `plannedEntries()` always rebuilds in program order, because
  the deferral was a fact about that afternoon, not a new plan.

## Undoing a skip

A skip means **"no signal"** — `applyProgression` steps over it entirely — so one
mis-tap costs that machine its advance for the week and nothing says so. Two ways
back, because you notice at two different times:

- **In session**, a skipped machine is reachable by its dot and now offers
  **"Undo skip"** where the Skip button was — the thumb that just mis-tapped is
  already there. It hands the machine back on set 1.
- **After the fact**, a skipped line in History is the one tappable line in the
  list, opening a sheet of three set steppers **defaulted to the target that was
  prescribed** — so the usual repair is a single tap.

`POST /api/workout/:id/unskip` is the only route that edits a *finished* workout,
and the rules that keep it honest are all on the server:

- **It has to move the prescription, or it's cosmetic.** `reapplyEntry()` reruns
  `nextState()` on the corrected entry and rewrites `w.outcomes` in entry order.
- **`supersededBy()` is the guard.** If a LATER finished workout already logged
  that exercise, *that* is what set the current weight — correcting an older
  record must not wind the prescription back to what it would have been at the
  time. The reply carries `appliedToPlan` so the UI can say which happened
  instead of looking like nothing did.
- **Refuses what would corrupt a record:** an unknown workout or exercise (404),
  an entry that isn't skipped (400 — a second call would advance the weight
  twice), and all-blank sets (400 — that's a skip by another name). A refused
  call leaves the entry exactly as it was.
- **Not offline-queued.** The queue's contract is "latest full snapshot per
  workout id"; a correction that merges with server state doesn't fit it, and
  this is a repair you make at a desk, not mid-set in a basement.

## Scheduling and reminders

`lib/schedule.js` is **pure and takes `today` as an argument** rather than reading a
clock — that is the only reason any of it is testable, and it has the truth table to
show for it. Two modes, because people describe training two ways:

| mode | means |
|---|---|
| `weekdays` | "Mondays, Wednesdays and Fridays" — a fixed grid |
| `interval` | "every other day", "every 3 days" — **rolling off the last one you finished** |

- **`interval` rolls off the last COMPLETED session, not a fixed anchor.** That is
  what "every other day" means to the person saying it: do it Monday, next is
  Wednesday. A fixed grid would keep marking days due while you were away and then
  expect you back on its own rhythm. The `anchor` only stands in before there is any
  history to roll from.
- **Missing a day leaves it DUE, not rescheduled**, and `overdueDays` says by how
  much. Quietly sliding it to tomorrow is how a schedule stops meaning anything.
- **Days are walked with `addDays`** (shared with `calendar.js`), never by adding
  86400000 — same DST trap, same pinned test.
- An unscheduled plan is not overdue, it is just a plan. `mode: 'off'` returns
  `due: false, next: null`, and Home says nothing at all.
- `weekdays` with an empty `days` array is inert. `HORIZON` bounds the search so it
  can't spin.

### Web Push, and why it's right here when it was wrong for the rest timer

The rest-alert section below says Web Push is the wrong answer, and it is — **for
that alert**. A daily reminder is the opposite problem, and the two reasons don't
generalise:

| | rest tone | due reminder |
|---|---|---|
| fires | 90 s from now | hours from now |
| network | must work with none | phone will have had some |
| app state | in front, frozen, or locked | closed |
| mechanism | audio thread (`alarm.js`) | Web Push (`lib/push.js`) |

- **VAPID keys are minted lazily** into `config.local.json` (gitignored, 0600). The
  path is overridable with `CONFIG_FILE`, which is how `npm test` never writes a
  config into the working tree.
- **`send()` mints its own keypair.** It used to be gated on `configured()`, which
  is false before the first mint — so the very first reminder returned 0 and sent
  nothing, with no error. Reachable in production only when a device subscribed
  before anything read the public key, i.e. exactly the case nobody would notice
  until a notification didn't arrive.
- **A failed send is not marked sent** — marking regardless would burn today's one
  nudge on a momentary outage. But attempts are **counted and capped** at
  `MAX_TRIES`, because a failure that isn't 404/410 (a rejected subject, a bad day
  at the push service) would otherwise retry and log every single minute forever.
- **404/410 prunes the subscription**; anything else keeps it and retries.
- One notification per plan per day (`push.sent[planId]`), and an archived plan is
  never nagged about.
- `addSub` requires https **or loopback**. Loopback only, and only so the whole
  chain can be pointed at a stand-in and verified — the failure mode of getting
  push wrong is silence, not an error.
- The service worker has its own `push` handler with **`tag: 'lift-due'`**, so a
  reminder never replaces a live rest alert or vice versa.
- **One permission, two uses.** The existing rest-alerts switch grants notification
  permission and the subscription is registered off the back of it, rather than
  behind a second switch that asks for the same thing.
- `POST /api/push/test` exists because there is no other way to find out the chain
  works without waiting for six o'clock.

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
  // Google `sub` -> the person. `status` gates everything.
  users: { uid: { id, email, name, picture, status, owner, createdAt, lastSeen } },
  // uid -> that person's whole program. One slice each, never shared, always
  // resolved from the session.
  data: { uid: userData },
  // The pre-accounts program, waiting for the owner's first request. Null once
  // adopted.
  legacy: userData | null,
  seq: 1,
}

userData = {
  // The catalogue of machines, and the named workouts that pick from it.
  exercises: [{ id, name, short, step, weight }],
  plans: [{ id, name, exerciseIds, rules, schedule, archived }],
  activePlanId,
  // planId -> exerciseId -> { weight, target } : what to lift NEXT time.
  // Nested per plan on purpose — the rep target is part of the state.
  progress: { planId: { exerciseId: { weight, target } } },
  workouts: [{
    id,            // client-minted ('w' + base36) so offline retries upsert, not duplicate
    planId,        // pinned when the session STARTS, not read at save time
    date,          // 'YYYY-MM-DD' local
    startedAt, finishedAt, done,
    applied,       // true once progression has been rolled in — makes replay idempotent
    outcomes,      // [{ id, action, weight, target, note, suggestWeight?, canDrop? }]
    entries: [{ id, weight, target, sets: [r,…], skipped }],   // as many as the plan's rules
  }],
  push: { subs: [{ endpoint, keys, at }], sent: { planId: 'YYYY-MM-DD' },
          tried: { planId: { day, n } } },
  settings: {},   // restSec moved into plan.rules; nothing global is left
}
```

**Wire-only** (computed in `wire()`, never stored): `plans[].rulesLabel`,
`plans[].status` (from `schedule.statusOf`), `plans[].lastDone`, `heatmap`,
`push.key`, `push.subscribed`. `rules` on the wire is the **active plan's** ladder,
under the name the session screen always used — which is why almost nothing
downstream had to learn about plans at all.

`plannedEntries()` always rebuilds in the plan's order, so a "Machine busy"
reordering is a fact about that afternoon and is never written back to the plan.

## HTTP routes

| Route | Purpose |
|---|---|
| `GET /` | shell, with cache-bust stamp injected |
| `GET /api/state` | exercises, rules, progress, settings, planned entries, workouts, `heatmap` |
| `POST /api/workout` | upsert a workout (full snapshot); `done:true` applies progression once |
| `POST /api/adjust` | manual weight/target override (machine minimums, accepting a deload) |
| `POST /api/exercise` · `PATCH`/`DELETE /api/exercise/:id` | the machine catalogue |
| `POST /api/plan` · `PATCH`/`DELETE /api/plan/:id` | plans; `copyOf` clones one |
| `POST /api/plan/active` | which workout you're doing |
| `POST /api/push/subscribe` · `/unsubscribe` · `/test` | reminders |
| `POST /api/settings` | `restSec` (forwarded into the active plan's rules) |
| `POST /api/auth/google` | ID token in, session cookie out. **Public.** |
| `GET /api/auth/me` | status / clientId — safe signed out, and what the client boots on |
| `POST /api/auth/signout` | expires the cookie |
| `GET /api/admin/users` · `POST /api/admin/user/:id` | **owner only** — who is waiting, and letting them in |
| `POST /api/workout/:id/unskip` | undo an accidental skip and catch the weight up |
| `DELETE /api/workout/:id` | remove a logged workout |

## Key conventions

- **Ordering lives in the client and is tested in the browser.** `lib/` is
  CommonJS and `public/js/` is ESM with no build step, so the session queue can't
  be a shared pure module the way `progression.js` is. `client-check.js` covers it
  by driving the real UI: defer a machine, assert it moved and reads part-done,
  tap its dot, assert it resumes on set 2.
- **`lib/progression.js`, `lib/calendar.js` and `lib/schedule.js` are pure and are
  the source of truth.** `schedule.js` takes `today` as an argument and `nextState`
  takes its rules as an argument — neither reaches for the active plan or a clock,
  which is what keeps both testable and is why the guards live in `lib/plan.js`.
- **`lib/plan.js` is the gate.** Everything entering the store as program data goes
  through `cleanExercise` / `cleanRules` / `cleanPlan`. A field it doesn't know is
  dropped, so **add it there first**.
- **The plan is resolved once, at the top of whatever is asking, and passed down.**
  Nothing below reaches for the active plan on its own, so a workout logged against
  A can never be scored with B's ladder.
- **Cache-busting is anchored on the attribute.** `.replace('/js/', …)` took the
  first occurrence anywhere in the file, and an HTML comment mentioning a path under
  `public/js/` was enough to eat the stamp and ship unstamped JS. It's
  `src="/js/` → `src="/js-STAMP/`, global, now.
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

**`config.local.json` (gitignored, 0600) must configure at least one door, or
nobody can sign in — including you.** The app has no bypass.

```json
{ "cfAccessTeam": "your-team",            // ← Access: the bit before
  "cfAccessAud": "<application AUD tag>", //   .cloudflareaccess.com, and the
  "ownerEmail": "you@gmail.com",          //   app's Audience tag
  "vapidSubject": "mailto:you@gmail.com" }
```

`cfAccessAud` is on the Access application's *Overview* tab as **Application
Audience (AUD) Tag**. Set the Access policy to allow whoever you want to *reach*
the app — the app's own queue decides who gets an account.

For Google instead, `googleClientId` from an **OAuth 2.0 Web application**
credential with the live origin under *Authorized JavaScript origins*. No client
secret — ID tokens are verified against Google's public keys. Setting both is fine;
Access wins when its assertion verifies.

`ownerEmail` should always be set. Without it the owner is whoever signs in first,
which is fine on a box only you can reach and is not fine once you hand the URL out.

```bash
npm run deploy                   # npm test → restart → verify active → push to GitHub
sudo systemctl status workout    # logs
sudo journalctl -u workout -n 50
```

The push is non-fatal so a deploy doesn't fail when offline. The restart is what busts
client caches — the `/js-<STAMP>/` prefix is stamped at server startup.

Ingress lives in `~/.cloudflared/config.yml` (shared with the-square and
liner-note); the tunnel is `hot-seat`. Restart `cloudflared` after editing it.
