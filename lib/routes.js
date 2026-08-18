// HTTP surface. Everything is JSON except the shell.
//
// MULTI-USER. Every data route runs against `req.d` — the slice belonging to
// whoever the session cookie says you are. There is deliberately no route that
// accepts a user id, so there is no handler that can forget to check one against
// the session; see lib/auth.js for the three rules this rests on.
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./../store');
const { state } = store;
const P = require('./progression');
const plan = require('./plan');
const sched = require('./schedule');
const push = require('./push');
const auth = require('./auth');
const calendar = require('./calendar');

const PUBLIC = path.join(__dirname, '..', 'public');
// Cache-bust stamp: style.css gets ?v=, the JS module tree is served under a
// /js-<stamp>/ prefix (query params don't survive `import` statements).
const STAMP = Date.now().toString(36);

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ── plans ───────────────────────────────────────────────────────────────
   Every prescription is now "this plan, these rules". The plan is resolved once,
   at the top of whatever is asking, and passed down — nothing below here reaches
   for the active plan on its own, so a workout logged against plan A can never be
   scored with plan B's ladder. */

// `d` is always one user's data slice. It is threaded explicitly rather than read
// from a module-level `state`, because a helper that could reach the whole store
// on its own is a helper that could return somebody else's plan.
const planById = (d, id) => (d.plans || []).find(p => p.id === id) || null;
const activePlan = (d) => planById(d, d.activePlanId) || (d.plans || [])[0] || null;
const exById = (d, id) => (d.exercises || []).find(e => e.id === id) || null;

// A machine's increment. From the catalogue now, not from a constant.
const stepOf = (d, id) => { const e = exById(d, id); return e && e.step > 0 ? e.step : P.WEIGHT_STEP; };

// Ladder options for one exercise under one plan: the plan's rep rules plus this
// machine's own weight step.
const optsFor = (d, p, exId) => ({ ...p.rules, step: stepOf(d, exId) });

// The last day this plan was actually completed — what an interval schedule rolls
// off, and what tells "due today" from "already done".
function lastDoneFor(d, planId) {
  const days = (d.workouts || []).filter(w => w.done && w.planId === planId).map(w => w.date).sort();
  return days.length ? days[days.length - 1] : null;
}

// The prescription for a workout that hasn't been performed yet.
function plannedEntries(d, p = activePlan(d)) {
  if (!p) return [];
  return p.exerciseIds.map((id) => {
    const cur = plan.currentFor(d, p, id);
    return {
      id,
      weight: cur.weight,
      target: cur.target,
      sets: Array.from({ length: p.rules.sets }, () => null),
      skipped: false,
    };
  });
}

// Entries are validated against the CATALOGUE, and shaped by the plan they were
// performed under — set count and rep cap both come from its rules.
function sanitizeEntries(d, raw, p) {
  if (!Array.isArray(raw)) return [];
  const rules = (p && p.rules) || P.DEFAULT_RULES;
  const known = new Set((d.exercises || []).map(e => e.id));
  return raw
    .filter(en => en && known.has(en.id))
    .map(en => ({
      id: en.id,
      weight: Math.max(0, Math.round(Number(en.weight) || 0)),
      target: P.clampReps(en.target, rules.maxReps) || rules.minReps,
      sets: Array.from({ length: rules.sets }, (_, i) => {
        const v = Array.isArray(en.sets) ? en.sets[i] : null;
        return v === null || v === undefined || v === '' ? null : P.clampReps(v, rules.maxReps);
      }),
      skipped: !!en.skipped,
    }));
}

// Roll a finished workout into the next prescription. Idempotent: a workout
// that has already been applied is never applied twice (offline retries).
function applyProgression(d, w) {
  if (w.applied) return [];
  const p = planById(d, w.planId) || activePlan(d);
  if (!p) return [];
  const prog = plan.planProgress(d, p.id);
  const out = [];
  for (const en of w.entries) {
    if (en.skipped) continue;
    if (en.sets.every(s => s === null)) continue; // never started — no signal
    const res = P.nextState({ weight: en.weight, target: en.target }, en.sets, optsFor(d, p, en.id));
    prog[en.id] = { weight: res.weight, target: res.target };
    out.push({ id: en.id, ...res });
  }
  w.applied = true;
  w.outcomes = out;
  return out;
}

// Has a LATER finished workout already logged this exercise? If so, THAT is what
// set the current weight, and correcting an older record must not wind the
// prescription back to what it would have been at the time.
function supersededBy(d, w, exId) {
  const key = (x) => `${x.date} ${String(x.startedAt || 0).padStart(16, '0')}`;
  return d.workouts.some(x =>
    x !== w && x.done && x.planId === w.planId && key(x) > key(w) &&
    (x.entries || []).some(e => e.id === exId && !e.skipped && e.sets.some(v => v !== null)));
}

// Recompute one entry's outcome after the fact — the workout is already finished
// and already applied, so this is a correction, not a first pass. The outcome is
// rewritten in place (kept in entry order) and rolled into the prescription only
// if nothing later has spoken for that exercise since.
function reapplyEntry(d, w, en) {
  const p = planById(d, w.planId) || activePlan(d);
  const res = P.nextState({ weight: en.weight, target: en.target }, en.sets, optsFor(d, p, en.id));
  const byId = new Map((w.outcomes || []).map(o => [o.id, o]));
  byId.set(en.id, { id: en.id, ...res });
  w.outcomes = w.entries.map(e => byId.get(e.id)).filter(Boolean);
  // Only a later workout of the SAME plan can supersede this one — plan B logging
  // the leg press says nothing about plan A's leg press, which is the whole point
  // of keeping their weights apart.
  const stale = supersededBy(d, w, en.id);
  if (!stale) plan.planProgress(d, p.id)[en.id] = { weight: res.weight, target: res.target };
  return { ...res, appliedToPlan: !stale };
}

// One shape for a plan wherever it is returned, so a create/patch reply carries
// the same computed fields (`rulesLabel`, schedule `status`) the client reads off
// /api/state. Worded on the server because the label is a statement about what
// nextState() will do, and the two must not drift.
function wirePlan(d, x) {
  return {
    ...x,
    rulesLabel: P.describeRules(x.rules),
    status: sched.statusOf(x.schedule, todayStr(), lastDoneFor(d, x.id)),
    lastDone: lastDoneFor(d, x.id),
  };
}

function wire(d, user) {
  const p = activePlan(d);
  const today = todayStr();
  return {
    // Who you are, so the client can render an account row and know whether to
    // show the owner's approvals card. Never used to select data.
    me: user ? { id: user.id, email: user.email, name: user.name, picture: user.picture, owner: !!user.owner } : null,
    pending: user && user.owner
      ? Object.values(state.users).filter(u => u.status === 'pending')
        .map(u => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, at: u.createdAt }))
      : [],
    // The catalogue, and every plan with its own rules and schedule status. The
    // client draws a picker only when there's more than one — see progressive
    // disclosure in CLAUDE.md.
    exercises: d.exercises,
    plans: (d.plans || []).map(x => wirePlan(d, x)),
    activePlanId: p ? p.id : null,
    // `rules` is the ACTIVE plan's ladder. Kept at this name and shape so the
    // session and summary screens read exactly what they always did.
    rules: p ? { ...p.rules, weightStep: P.WEIGHT_STEP } : { ...P.DEFAULT_RULES, weightStep: P.WEIGHT_STEP },
    progress: p ? plan.planProgress(d, p.id) : {},
    settings: d.settings,
    planned: plannedEntries(d, p),
    workouts: d.workouts.slice(-200),
    today,
    // Only this plan's sessions colour the calendar and the sparklines — mixing
    // an upper day into a lower day's history would make both unreadable.
    heatmap: calendar.buildHeatmap(
      (d.workouts || []).filter(w => !p || w.planId === p.id), today),
    push: { key: push.publicKey(), subscribed: (d.push.subs || []).length > 0 },
  };
}

/* ── who you are ─────────────────────────────────────────────────────────
   The session cookie is the ONLY source of identity. `req.user` is the record,
   `req.d` their data slice. A pending user gets neither — they have no slice at
   all until the owner approves them, which is what makes "pending" mean something
   rather than being a flag a handler has to remember to consult. */

function userFrom(req) {
  const uid = auth.verify(auth.readCookie(req.headers.cookie));
  if (!uid) return null;
  const u = state.users[uid];
  return u && u.status === 'active' ? u : null;
}

// The slice, created on demand. Only ever called with an id that came out of a
// verified cookie.
//
// The OWNER's first slice is whatever the app held before accounts existed, if
// anything is still waiting. Adoption lives here rather than in the sign-in route
// because this is the one function every authenticated request goes through — so
// it is exercised constantly instead of only on the single most consequential
// request of the app's life, which is a bad thing to have no coverage of.
function dataFor(uid) {
  if (!state.data[uid]) {
    const u = state.users[uid];
    if (u && u.owner && state.legacy) {
      state.data[uid] = state.legacy;
      state.legacy = null;
      console.log('store: pre-accounts data adopted by', u.email);
    } else {
      state.data[uid] = plan.seedUserData(store.nextId);
    }
  }
  return state.data[uid];
}

const isOwner = (u) => !!(u && u.owner);

module.exports = function mount(app) {
  app.use(express.json({ limit: '256kb' }));

  // Resolve identity once, for everything. Routes below never parse a cookie.
  app.use((req, _res, next) => {
    const u = userFrom(req);
    if (u) {
      req.user = u;
      req.d = dataFor(u.id);
      u.lastSeen = Date.now();
    }
    next();
  });

  // The gate. Applied to the whole data surface in one place rather than
  // remembered per handler — the failure mode of the per-handler version is a
  // route that silently serves everybody.
  const guard = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'sign in' });
    next();
  };
  app.use('/api/state', guard);
  app.use('/api/workout', guard);
  app.use('/api/adjust', guard);
  app.use('/api/settings', guard);
  app.use('/api/exercise', guard);
  app.use('/api/exercises', guard);
  app.use('/api/plan', guard);
  app.use('/api/push', guard);
  app.use('/api/admin', (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'sign in' });
    if (!isOwner(req.user)) return res.status(403).json({ error: 'not yours' });
    next();
  });

  // Serve the versioned JS tree by stripping the stamped prefix.
  app.use((req, _res, next) => {
    const m = req.url.match(/^\/js-[a-z0-9]+\//);
    if (m) req.url = '/js/' + req.url.slice(m[0].length);
    next();
  });

  /* ── signing in ────────────────────────────────────────────────────────
     A Google ID token comes in, a signed session cookie goes out. The FIRST
     person to sign in becomes the owner and adopts whatever the app held before
     accounts existed; everyone after them lands as `pending` and waits.

     `ownerEmail` in config pins that down when it matters — without it the race
     is decided by whoever arrives first, which is fine on a box only you can
     reach and is not fine the moment you hand the URL out. */

  app.post('/api/auth/google', async (req, res) => {
    let claims;
    try {
      claims = await auth.verifyGoogleToken((req.body || {}).credential);
    } catch (e) {
      console.error('auth: token rejected —', e.message);
      return res.status(401).json({ error: 'could not verify that sign-in' });
    }
    if (!claims) return res.status(401).json({ error: 'could not verify that sign-in' });

    let u = state.users[claims.id];
    if (!u) {
      const ownerEmail = String(require('./config').get('ownerEmail', '') || '').toLowerCase();
      const noOwnerYet = !Object.values(state.users).some(x => x.owner);
      const owner = ownerEmail ? claims.email === ownerEmail : noOwnerYet;
      u = {
        ...claims,
        owner,
        // The owner is active immediately — there would be nobody to approve them.
        status: owner ? 'active' : 'pending',
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      state.users[claims.id] = u;
      // Their slice — and, for the owner, everything from before accounts
      // existed — is created by dataFor() on the first authenticated request.
      if (owner) dataFor(u.id);
    } else {
      // Keep the profile fresh, but never let a later sign-in change status.
      u.email = claims.email; u.name = claims.name; u.picture = claims.picture;
      u.lastSeen = Date.now();
    }
    store.save();

    if (u.status === 'denied') return res.status(403).json({ error: 'no access' });
    // A pending user still gets a cookie: it is how they can come back and see
    // whether they've been let in without signing in through Google every time.
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
    res.json({ status: u.status, me: { email: u.email, name: u.name, owner: u.owner } });
  });

  // Safe to call signed out — it is what the client boots against.
  app.get('/api/auth/me', (req, res) => {
    const uid = auth.verify(auth.readCookie(req.headers.cookie));
    const u = uid ? state.users[uid] : null;
    res.json({
      status: u ? u.status : 'anon',
      clientId: auth.clientId(),
      me: u ? { email: u.email, name: u.name, picture: u.picture, owner: !!u.owner } : null,
    });
  });

  app.post('/api/auth/signout', (_req, res) => {
    res.setHeader('Set-Cookie', auth.clearHeader());
    res.json({ status: 'anon' });
  });

  /* ── letting people in ─────────────────────────────────────────────────── */

  app.get('/api/admin/users', (_req, res) => {
    res.json({
      users: Object.values(state.users).map(u => ({
        id: u.id, email: u.email, name: u.name, picture: u.picture,
        status: u.status, owner: !!u.owner, createdAt: u.createdAt, lastSeen: u.lastSeen,
        workouts: (state.data[u.id] ? state.data[u.id].workouts.length : 0),
      })),
    });
  });

  app.post('/api/admin/user/:id', (req, res) => {
    const u = state.users[req.params.id];
    if (!u) return res.status(404).json({ error: 'not found' });
    if (u.owner) return res.status(400).json({ error: 'that is you' });
    const want = String((req.body || {}).status || '');
    if (!['active', 'denied'].includes(want)) return res.status(400).json({ error: 'bad status' });
    u.status = want;
    // Approving creates their program; denying leaves whatever they logged alone,
    // so letting someone back in doesn't cost them their history.
    if (want === 'active') dataFor(u.id);
    store.save();
    res.json(wire(req.d, req.user));
  });

  app.get('/', (_req, res) => {
    let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    // Anchored on the attribute, and global. A bare `.replace('/js/', …)` takes
    // the FIRST occurrence anywhere in the file — an HTML comment mentioning a
    // path under public/js/ was enough to eat the stamp and ship unstamped JS.
    html = html
      .replace('href="style.css"', `href="style.css?v=${STAMP}"`)
      .replace(/src="\/js\//g, `src="/js-${STAMP}/`);
    res.type('html').send(html);
  });

  app.get('/api/state', (req, res) => res.json(wire(req.d, req.user)));

  // Upsert a workout. The client sends the whole thing every time (it is small),
  // so an offline queue can just replay the latest snapshot.
  app.post('/api/workout', (req, res) => {
    const d = req.d;
    const b = req.body || {};
    // A workout belongs to the plan it was started from, not to whatever is
    // active when it lands — you can switch plans mid-session, and an offline
    // replay can arrive days later.
    const existing = b.id ? d.workouts.find(x => x.id === b.id) : null;
    const p = (existing && planById(d, existing.planId)) || planById(d, b.planId) || activePlan(d);
    if (!p) return res.status(400).json({ error: 'no plan' });
    const entries = sanitizeEntries(d, b.entries, p);
    if (!entries.length) return res.status(400).json({ error: 'no entries' });

    let w = existing;
    if (!w) {
      w = {
        planId: p.id,
        // The client mints the id so an offline retry upserts instead of
        // creating a duplicate workout.
        id: /^w[a-z0-9-]{1,40}$/i.test(String(b.id || '')) ? String(b.id) : store.nextId('w'),
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : todayStr(),
        startedAt: Number(b.startedAt) || Date.now(),
        finishedAt: null,
        done: false,
        applied: false,
        entries,
      };
      d.workouts.push(w);
    } else {
      w.entries = entries;
    }

    let outcomes = w.outcomes || [];
    if (b.done && !w.done) {
      w.done = true;
      w.finishedAt = Number(b.finishedAt) || Date.now();
      outcomes = applyProgression(d, w);
    }
    store.save();
    res.json({ id: w.id, outcomes, state: wire(d, req.user) });
  });

  // Manual override — machine minimums, plate availability, or accepting a deload.
  // Against ONE plan: the same machine under another plan keeps its own weight.
  app.post('/api/adjust', (req, res) => {
    const d = req.d;
    const b = req.body || {};
    const pl = planById(d, b.planId) || activePlan(d);
    if (!pl) return res.status(400).json({ error: 'no plan' });
    if (!exById(d, b.id) || !pl.exerciseIds.includes(b.id)) {
      return res.status(400).json({ error: 'unknown exercise' });
    }
    const cur = plan.currentFor(d, pl, b.id);
    if (b.weight !== undefined) cur.weight = plan.cleanWeight(b.weight);
    if (b.target !== undefined) {
      const t = P.clampReps(b.target, pl.rules.maxReps);
      cur.target = Math.max(pl.rules.minReps, t || pl.rules.minReps);
    }
    store.save();
    res.json(wire(d, req.user));
  });

  /* ── the catalogue ─────────────────────────────────────────────────────
     Machines, independent of any plan. Editing one changes it everywhere it is
     used, which is right: a machine that got re-rated was re-rated for everybody.
     Deleting one pulls it out of every plan, because a plan holding a dangling id
     is how `planned` would start shipping undefined weights. */

  app.get('/api/exercises', (_req, res) => res.json(wire(d, req.user)));

  app.post('/api/exercise', (req, res) => {
    const d = req.d;
    if ((d.exercises || []).length >= plan.MAX_EXERCISES) {
      return res.status(400).json({ error: 'too many exercises' });
    }
    const ex = plan.cleanExercise(req.body || {}, store.nextId('e'));
    if (!ex) return res.status(400).json({ error: 'needs a name' });
    d.exercises.push(ex);
    // Added from inside a plan? Put it at the end of that plan too, which is
    // what "add a machine" means from where you tapped it.
    const into = planById(d, (req.body || {}).planId);
    if (into && into.exerciseIds.length < plan.MAX_PER_PLAN) into.exerciseIds.push(ex.id);
    store.save();
    res.json({ exercise: ex, state: wire(d, req.user) });
  });

  app.patch('/api/exercise/:id', (req, res) => {
    const d = req.d;
    const ex = exById(d, req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = plan.str(b.name);
      if (!name) return res.status(400).json({ error: 'needs a name' });
      ex.name = name;
    }
    if (b.short !== undefined) {
      const short = plan.str(b.short);
      ex.short = short && short !== ex.name ? short : null;
    }
    if (b.step !== undefined) ex.step = plan.cleanStep(b.step);
    if (b.weight !== undefined) ex.weight = plan.cleanWeight(b.weight);
    store.save();
    res.json({ exercise: ex, state: wire(d, req.user) });
  });

  app.delete('/api/exercise/:id', (req, res) => {
    const d = req.d;
    const i = (d.exercises || []).findIndex(e => e.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not found' });
    const [gone] = d.exercises.splice(i, 1);
    for (const pl of d.plans) pl.exerciseIds = pl.exerciseIds.filter(x => x !== gone.id);
    // Logged workouts keep their entries — history is what happened, and pruning
    // it would rewrite the past to match a decision made today.
    store.save();
    res.json(wire(d, req.user));
  });

  /* ── plans ─────────────────────────────────────────────────────────────── */

  app.post('/api/plan', (req, res) => {
    const d = req.d;
    if ((d.plans || []).length >= plan.MAX_PLANS) {
      return res.status(400).json({ error: 'too many plans' });
    }
    const b = req.body || {};
    // A new plan starts as a copy of the one you were looking at unless told
    // otherwise — "Workout B" is almost always "A, but different", and starting
    // from an empty list means rebuilding it by hand.
    const from = planById(d, b.copyOf);
    const draft = {
      name: b.name || `Workout ${String.fromCharCode(65 + (d.plans || []).length)}`,
      exerciseIds: b.exerciseIds || (from ? from.exerciseIds : []),
      rules: b.rules || (from ? from.rules : plan.defaultRules()),
      schedule: b.schedule || sched.defaultSchedule(),
    };
    const made = plan.cleanPlan(draft, store.nextId('p'), d.exercises);
    if (!made) return res.status(400).json({ error: 'needs a name' });
    d.plans.push(made);
    // Carry the weights over too. The machines are the same machines — starting a
    // copy back at the catalogue's seed weight would hand you a number from
    // whenever you first set the app up. They diverge from here, which is the
    // point of keeping them apart.
    if (from) {
      const src = plan.planProgress(d, from.id);
      const dst = plan.planProgress(d, made.id);
      for (const id of made.exerciseIds) if (src[id]) dst[id] = { ...src[id] };
    }
    store.save();
    res.json({ plan: wirePlan(d, made), state: wire(d, req.user) });
  });

  app.patch('/api/plan/:id', (req, res) => {
    const d = req.d;
    const pl = planById(d, req.params.id);
    if (!pl) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    // Patched through the same gate a create goes through, merged over what's
    // there — so a rules tweak can't arrive with half a rules object.
    const merged = plan.cleanPlan({
      name: b.name !== undefined ? b.name : pl.name,
      exerciseIds: b.exerciseIds !== undefined ? b.exerciseIds : pl.exerciseIds,
      rules: b.rules !== undefined ? { ...pl.rules, ...b.rules } : pl.rules,
      schedule: b.schedule !== undefined ? { ...pl.schedule, ...b.schedule } : pl.schedule,
      archived: b.archived !== undefined ? b.archived : pl.archived,
    }, pl.id, d.exercises);
    if (!merged) return res.status(400).json({ error: 'needs a name' });
    Object.assign(pl, merged);
    // Changing the schedule should let a reminder fire again today rather than
    // being suppressed by one already sent under the old rule.
    if (b.schedule !== undefined) delete d.push.sent[pl.id];
    store.save();
    res.json({ plan: wirePlan(d, pl), state: wire(d, req.user) });
  });

  app.post('/api/plan/active', (req, res) => {
    const d = req.d;
    const pl = planById(d, (req.body || {}).id);
    if (!pl) return res.status(404).json({ error: 'not found' });
    d.activePlanId = pl.id;
    store.save();
    res.json(wire(d, req.user));
  });

  app.delete('/api/plan/:id', (req, res) => {
    const d = req.d;
    if ((d.plans || []).length <= 1) {
      return res.status(400).json({ error: 'the last plan cannot be deleted' });
    }
    const i = d.plans.findIndex(x => x.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not found' });
    const [gone] = d.plans.splice(i, 1);
    // The weights go with it. Its logged workouts stay — they happened.
    delete d.progress[gone.id];
    delete d.push.sent[gone.id];
    if (d.activePlanId === gone.id) d.activePlanId = d.plans[0].id;
    store.save();
    res.json(wire(d, req.user));
  });

  /* ── push reminders ────────────────────────────────────────────────────── */

  app.post('/api/push/subscribe', (req, res) => {
    const d = req.d;
    const sub = push.addSub(d, (req.body || {}).subscription);
    if (!sub) return res.status(400).json({ error: 'bad subscription' });
    res.json(wire(d, req.user));
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const d = req.d;
    push.removeSub(d, (req.body || {}).endpoint);
    res.json(wire(d, req.user));
  });

  // Prove the whole chain — keys, subscription, service worker — without waiting
  // for six o'clock. There is no other way to find out that it doesn't work.
  app.post('/api/push/test', async (_req, res) => {
    const sent = await push.send(d, {
      title: 'Lift', body: 'Reminders are working', detail: 'This is a test',
    });
    res.json({ sent });
  });

  app.post('/api/settings', (req, res) => {
    const d = req.d;
    const b = req.body || {};
    // restSec used to be global; it belongs to a plan's rules now. Accepted here
    // still, and forwarded, so an old client (or a queued write from one) doesn't
    // silently lose the setting.
    if (b.restSec !== undefined) {
      const pl = activePlan(d);
      if (pl) pl.rules = plan.cleanRules({ ...pl.rules, restSec: b.restSec });
    }
    store.save();
    res.json(wire(d, req.user));
  });

  // Undo an accidental skip on a workout that's already logged. The sets you
  // actually did go back on the record and the prescription catches up — which
  // is the point, since a skip means "no signal" and quietly costs you the
  // progression for that machine.
  app.post('/api/workout/:id/unskip', (req, res) => {
    const d = req.d;
    const w = d.workouts.find(x => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const en = (w.entries || []).find(x => x.id === b.id);
    if (!en) return res.status(404).json({ error: 'unknown exercise' });
    if (!en.skipped) return res.status(400).json({ error: 'not skipped' });

    const sets = Array.from({ length: P.SETS }, (_, i) => {
      const v = Array.isArray(b.sets) ? b.sets[i] : null;
      return v === null || v === undefined || v === '' ? null : P.clampReps(v);
    });
    // Un-skipping into an empty record would just be a skip by another name.
    if (sets.every(v => v === null)) return res.status(400).json({ error: 'no reps' });

    en.skipped = false;
    en.sets = sets;
    // Only a finished workout has a prescription to correct; an in-progress one
    // applies as normal when you finish it.
    const outcome = w.done ? reapplyEntry(d, w, en) : null;
    store.save();
    res.json({ outcome, state: wire(d, req.user) });
  });

  app.delete('/api/workout/:id', (req, res) => {
    const d = req.d;
    const i = d.workouts.findIndex(w => w.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not found' });
    d.workouts.splice(i, 1);
    store.save();
    res.json(wire(d, req.user));
  });

  app.use(express.static(PUBLIC, { maxAge: '1h' }));
};

module.exports.todayStr = todayStr;
module.exports.plannedEntries = plannedEntries;
module.exports.applyProgression = applyProgression;
