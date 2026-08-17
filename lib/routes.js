// HTTP surface. Everything is JSON except the shell.
// Auth is Cloudflare Access in front of the tunnel — there is no in-app login.
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./../store');
const { state } = store;
const P = require('./progression');
const plan = require('./plan');
const sched = require('./schedule');
const push = require('./push');
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

const planById = (id) => (state.plans || []).find(p => p.id === id) || null;
const activePlan = () => planById(state.activePlanId) || (state.plans || [])[0] || null;
const exById = (id) => (state.exercises || []).find(e => e.id === id) || null;

// A machine's increment. From the catalogue now, not from a constant.
const stepOf = (id) => { const e = exById(id); return e && e.step > 0 ? e.step : P.WEIGHT_STEP; };

// Ladder options for one exercise under one plan: the plan's rep rules plus this
// machine's own weight step.
const optsFor = (p, exId) => ({ ...p.rules, step: stepOf(exId) });

// The last day this plan was actually completed — what an interval schedule rolls
// off, and what tells "due today" from "already done".
function lastDoneFor(planId) {
  const days = (state.workouts || []).filter(w => w.done && w.planId === planId).map(w => w.date).sort();
  return days.length ? days[days.length - 1] : null;
}

// The prescription for a workout that hasn't been performed yet.
function plannedEntries(p = activePlan()) {
  if (!p) return [];
  return p.exerciseIds.map((id) => {
    const cur = plan.currentFor(state, p, id);
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
function sanitizeEntries(raw, p) {
  if (!Array.isArray(raw)) return [];
  const rules = (p && p.rules) || P.DEFAULT_RULES;
  const known = new Set((state.exercises || []).map(e => e.id));
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
function applyProgression(w) {
  if (w.applied) return [];
  const p = planById(w.planId) || activePlan();
  if (!p) return [];
  const prog = plan.planProgress(state, p.id);
  const out = [];
  for (const en of w.entries) {
    if (en.skipped) continue;
    if (en.sets.every(s => s === null)) continue; // never started — no signal
    const res = P.nextState({ weight: en.weight, target: en.target }, en.sets, optsFor(p, en.id));
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
function supersededBy(w, exId) {
  const key = (x) => `${x.date} ${String(x.startedAt || 0).padStart(16, '0')}`;
  return state.workouts.some(x =>
    x !== w && x.done && x.planId === w.planId && key(x) > key(w) &&
    (x.entries || []).some(e => e.id === exId && !e.skipped && e.sets.some(v => v !== null)));
}

// Recompute one entry's outcome after the fact — the workout is already finished
// and already applied, so this is a correction, not a first pass. The outcome is
// rewritten in place (kept in entry order) and rolled into the prescription only
// if nothing later has spoken for that exercise since.
function reapplyEntry(w, en) {
  const p = planById(w.planId) || activePlan();
  const res = P.nextState({ weight: en.weight, target: en.target }, en.sets, optsFor(p, en.id));
  const byId = new Map((w.outcomes || []).map(o => [o.id, o]));
  byId.set(en.id, { id: en.id, ...res });
  w.outcomes = w.entries.map(e => byId.get(e.id)).filter(Boolean);
  // Only a later workout of the SAME plan can supersede this one — plan B logging
  // the leg press says nothing about plan A's leg press, which is the whole point
  // of keeping their weights apart.
  const stale = supersededBy(w, en.id);
  if (!stale) plan.planProgress(state, p.id)[en.id] = { weight: res.weight, target: res.target };
  return { ...res, appliedToPlan: !stale };
}

// One shape for a plan wherever it is returned, so a create/patch reply carries
// the same computed fields (`rulesLabel`, schedule `status`) the client reads off
// /api/state. Worded on the server because the label is a statement about what
// nextState() will do, and the two must not drift.
function wirePlan(x) {
  return {
    ...x,
    rulesLabel: P.describeRules(x.rules),
    status: sched.statusOf(x.schedule, todayStr(), lastDoneFor(x.id)),
    lastDone: lastDoneFor(x.id),
  };
}

function wire() {
  const p = activePlan();
  const today = todayStr();
  return {
    // The catalogue, and every plan with its own rules and schedule status. The
    // client draws a picker only when there's more than one — see progressive
    // disclosure in CLAUDE.md.
    exercises: state.exercises,
    plans: (state.plans || []).map(wirePlan),
    activePlanId: p ? p.id : null,
    // `rules` is the ACTIVE plan's ladder. Kept at this name and shape so the
    // session and summary screens read exactly what they always did.
    rules: p ? { ...p.rules, weightStep: P.WEIGHT_STEP } : { ...P.DEFAULT_RULES, weightStep: P.WEIGHT_STEP },
    progress: p ? plan.planProgress(state, p.id) : {},
    settings: state.settings,
    planned: plannedEntries(p),
    workouts: state.workouts.slice(-200),
    today,
    // Only this plan's sessions colour the calendar and the sparklines — mixing
    // an upper day into a lower day's history would make both unreadable.
    heatmap: calendar.buildHeatmap(
      (state.workouts || []).filter(w => !p || w.planId === p.id), today),
    push: { key: push.publicKey(), subscribed: (state.push.subs || []).length > 0 },
  };
}

module.exports = function mount(app) {
  app.use(express.json({ limit: '256kb' }));

  // Serve the versioned JS tree by stripping the stamped prefix.
  app.use((req, _res, next) => {
    const m = req.url.match(/^\/js-[a-z0-9]+\//);
    if (m) req.url = '/js/' + req.url.slice(m[0].length);
    next();
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

  app.get('/api/state', (_req, res) => res.json(wire()));

  // Upsert a workout. The client sends the whole thing every time (it is small),
  // so an offline queue can just replay the latest snapshot.
  app.post('/api/workout', (req, res) => {
    const b = req.body || {};
    // A workout belongs to the plan it was started from, not to whatever is
    // active when it lands — you can switch plans mid-session, and an offline
    // replay can arrive days later.
    const existing = b.id ? state.workouts.find(x => x.id === b.id) : null;
    const p = (existing && planById(existing.planId)) || planById(b.planId) || activePlan();
    if (!p) return res.status(400).json({ error: 'no plan' });
    const entries = sanitizeEntries(b.entries, p);
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
      state.workouts.push(w);
    } else {
      w.entries = entries;
    }

    let outcomes = w.outcomes || [];
    if (b.done && !w.done) {
      w.done = true;
      w.finishedAt = Number(b.finishedAt) || Date.now();
      outcomes = applyProgression(w);
    }
    store.save();
    res.json({ id: w.id, outcomes, state: wire() });
  });

  // Manual override — machine minimums, plate availability, or accepting a deload.
  // Against ONE plan: the same machine under another plan keeps its own weight.
  app.post('/api/adjust', (req, res) => {
    const b = req.body || {};
    const pl = planById(b.planId) || activePlan();
    if (!pl) return res.status(400).json({ error: 'no plan' });
    if (!exById(b.id) || !pl.exerciseIds.includes(b.id)) {
      return res.status(400).json({ error: 'unknown exercise' });
    }
    const cur = plan.currentFor(state, pl, b.id);
    if (b.weight !== undefined) cur.weight = plan.cleanWeight(b.weight);
    if (b.target !== undefined) {
      const t = P.clampReps(b.target, pl.rules.maxReps);
      cur.target = Math.max(pl.rules.minReps, t || pl.rules.minReps);
    }
    store.save();
    res.json(wire());
  });

  /* ── the catalogue ─────────────────────────────────────────────────────
     Machines, independent of any plan. Editing one changes it everywhere it is
     used, which is right: a machine that got re-rated was re-rated for everybody.
     Deleting one pulls it out of every plan, because a plan holding a dangling id
     is how `planned` would start shipping undefined weights. */

  app.get('/api/exercises', (_req, res) => res.json(wire()));

  app.post('/api/exercise', (req, res) => {
    if ((state.exercises || []).length >= plan.MAX_EXERCISES) {
      return res.status(400).json({ error: 'too many exercises' });
    }
    const ex = plan.cleanExercise(req.body || {}, store.nextId('e'));
    if (!ex) return res.status(400).json({ error: 'needs a name' });
    state.exercises.push(ex);
    // Added from inside a plan? Put it at the end of that plan too, which is
    // what "add a machine" means from where you tapped it.
    const into = planById((req.body || {}).planId);
    if (into && into.exerciseIds.length < plan.MAX_PER_PLAN) into.exerciseIds.push(ex.id);
    store.save();
    res.json({ exercise: ex, state: wire() });
  });

  app.patch('/api/exercise/:id', (req, res) => {
    const ex = exById(req.params.id);
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
    res.json({ exercise: ex, state: wire() });
  });

  app.delete('/api/exercise/:id', (req, res) => {
    const i = (state.exercises || []).findIndex(e => e.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not found' });
    const [gone] = state.exercises.splice(i, 1);
    for (const pl of state.plans) pl.exerciseIds = pl.exerciseIds.filter(x => x !== gone.id);
    // Logged workouts keep their entries — history is what happened, and pruning
    // it would rewrite the past to match a decision made today.
    store.save();
    res.json(wire());
  });

  /* ── plans ─────────────────────────────────────────────────────────────── */

  app.post('/api/plan', (req, res) => {
    if ((state.plans || []).length >= plan.MAX_PLANS) {
      return res.status(400).json({ error: 'too many plans' });
    }
    const b = req.body || {};
    // A new plan starts as a copy of the one you were looking at unless told
    // otherwise — "Workout B" is almost always "A, but different", and starting
    // from an empty list means rebuilding it by hand.
    const from = planById(b.copyOf);
    const draft = {
      name: b.name || `Workout ${String.fromCharCode(65 + (state.plans || []).length)}`,
      exerciseIds: b.exerciseIds || (from ? from.exerciseIds : []),
      rules: b.rules || (from ? from.rules : plan.defaultRules()),
      schedule: b.schedule || sched.defaultSchedule(),
    };
    const made = plan.cleanPlan(draft, store.nextId('p'), state.exercises);
    if (!made) return res.status(400).json({ error: 'needs a name' });
    state.plans.push(made);
    // Carry the weights over too. The machines are the same machines — starting a
    // copy back at the catalogue's seed weight would hand you a number from
    // whenever you first set the app up. They diverge from here, which is the
    // point of keeping them apart.
    if (from) {
      const src = plan.planProgress(state, from.id);
      const dst = plan.planProgress(state, made.id);
      for (const id of made.exerciseIds) if (src[id]) dst[id] = { ...src[id] };
    }
    store.save();
    res.json({ plan: wirePlan(made), state: wire() });
  });

  app.patch('/api/plan/:id', (req, res) => {
    const pl = planById(req.params.id);
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
    }, pl.id, state.exercises);
    if (!merged) return res.status(400).json({ error: 'needs a name' });
    Object.assign(pl, merged);
    // Changing the schedule should let a reminder fire again today rather than
    // being suppressed by one already sent under the old rule.
    if (b.schedule !== undefined) delete state.push.sent[pl.id];
    store.save();
    res.json({ plan: wirePlan(pl), state: wire() });
  });

  app.post('/api/plan/active', (req, res) => {
    const pl = planById((req.body || {}).id);
    if (!pl) return res.status(404).json({ error: 'not found' });
    state.activePlanId = pl.id;
    store.save();
    res.json(wire());
  });

  app.delete('/api/plan/:id', (req, res) => {
    if ((state.plans || []).length <= 1) {
      return res.status(400).json({ error: 'the last plan cannot be deleted' });
    }
    const i = state.plans.findIndex(x => x.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not found' });
    const [gone] = state.plans.splice(i, 1);
    // The weights go with it. Its logged workouts stay — they happened.
    delete state.progress[gone.id];
    delete state.push.sent[gone.id];
    if (state.activePlanId === gone.id) state.activePlanId = state.plans[0].id;
    store.save();
    res.json(wire());
  });

  /* ── push reminders ────────────────────────────────────────────────────── */

  app.post('/api/push/subscribe', (req, res) => {
    const sub = push.addSub((req.body || {}).subscription);
    if (!sub) return res.status(400).json({ error: 'bad subscription' });
    res.json(wire());
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    push.removeSub((req.body || {}).endpoint);
    res.json(wire());
  });

  // Prove the whole chain — keys, subscription, service worker — without waiting
  // for six o'clock. There is no other way to find out that it doesn't work.
  app.post('/api/push/test', async (_req, res) => {
    const sent = await push.send({
      title: 'Lift', body: 'Reminders are working', detail: 'This is a test',
    });
    res.json({ sent });
  });

  app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    // restSec used to be global; it belongs to a plan's rules now. Accepted here
    // still, and forwarded, so an old client (or a queued write from one) doesn't
    // silently lose the setting.
    if (b.restSec !== undefined) {
      const pl = activePlan();
      if (pl) pl.rules = plan.cleanRules({ ...pl.rules, restSec: b.restSec });
    }
    store.save();
    res.json(wire());
  });

  // Undo an accidental skip on a workout that's already logged. The sets you
  // actually did go back on the record and the prescription catches up — which
  // is the point, since a skip means "no signal" and quietly costs you the
  // progression for that machine.
  app.post('/api/workout/:id/unskip', (req, res) => {
    const w = state.workouts.find(x => x.id === req.params.id);
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
    const outcome = w.done ? reapplyEntry(w, en) : null;
    store.save();
    res.json({ outcome, state: wire() });
  });

  app.delete('/api/workout/:id', (req, res) => {
    const i = state.workouts.findIndex(w => w.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not found' });
    state.workouts.splice(i, 1);
    store.save();
    res.json(wire());
  });

  app.use(express.static(PUBLIC, { maxAge: '1h' }));
};

module.exports.todayStr = todayStr;
module.exports.plannedEntries = plannedEntries;
module.exports.applyProgression = applyProgression;
