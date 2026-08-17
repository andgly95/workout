// The program as DATA. This file is what used to be a hardcoded array in
// progression.js: a catalogue of exercises you can edit, and named plans that
// each pick some of them and carry their own overload rules and schedule.
//
// Pure apart from taking an id-minter — sanitization, defaults and the migration
// off the old shape all live here so there is one gate everything passes through,
// the same reason `cleanItem` exists in the trips app. A field this file doesn't
// know is dropped, so ADD IT HERE FIRST or a PATCH will appear to work and change
// nothing.
const P = require('./progression');
const schedule = require('./schedule');

const NAME_MAX = 40;
const MAX_PLANS = 12;
const MAX_EXERCISES = 40;
// A plan with nothing in it isn't a plan, and past about a dozen machines you're
// not doing one session any more.
const MAX_PER_PLAN = 15;

/* ── the exercise catalogue ─────────────────────────────────────────────── */

const str = (v, max = NAME_MAX) => String(v == null ? '' : v).slice(0, max).trim();

// `Number(v) || fallback` is wrong for every number here, and subtly: a submitted
// ZERO is present-but-illegal, not absent, and would silently become the default
// instead of clamping to the minimum — `sets: 0` came back as 3. Absent means
// absent (undefined, null, empty string); anything else gets clamped.
function num(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Math.round(num(v, dflt))));

// A weight step has to be a real notch on a stack: positive, and a whole number,
// because no machine has a 2.5 lb pin that anyone can find.
const cleanStep = (v) => clamp(v, 1, 100, P.WEIGHT_STEP);
const cleanWeight = (v) => clamp(v, 0, 2000, 0);

function cleanExercise(raw, id) {
  const name = str(raw && raw.name);
  if (!name) return null;
  const short = str(raw && raw.short);
  return {
    id,
    name,
    // A second label for a machine that goes by two names — "Vertical Traction"
    // on the plate, "Lat Pulldown" everywhere else.
    short: short && short !== name ? short : null,
    step: cleanStep(raw && raw.step),
    weight: cleanWeight(raw && raw.weight),
  };
}

/* ── overload rules, per plan ───────────────────────────────────────────── */

// The ladder is target minReps → +repStep → … → maxReps → heavier, back to
// minReps. Every one of those is now a knob, which means the guards matter: a
// maxReps below minReps, or a repStep of zero, would make a plan that can never
// advance and would look like the app was broken rather than misconfigured.
function cleanRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sets = clamp(r.sets, 1, 10, P.SETS);
  const minReps = clamp(r.minReps, 1, 50, P.MIN_REPS);
  const maxReps = clamp(r.maxReps, minReps, 100, P.MAX_REPS);
  return {
    sets,
    minReps,
    maxReps,
    // Never 0 — a plan whose target can't move would sit at minReps forever.
    // Never more than the whole range, or the ladder has one rung.
    repStep: clamp(r.repStep, 1, Math.max(1, maxReps - minReps), P.REP_STEP),
    restSec: clamp(r.restSec, 10, 600, P.REST_SEC),
  };
}

const defaultRules = () => cleanRules({});

/* ── plans ──────────────────────────────────────────────────────────────── */

function cleanPlan(raw, id, catalogue) {
  const known = new Set((catalogue || []).map(e => e.id));
  const name = str(raw && raw.name);
  if (!name) return null;
  // Ordered, deduped, and only ids that exist — a plan can't reference a machine
  // you deleted, which is what keeps `plannedEntries` from ever going undefined.
  const ids = Array.isArray(raw && raw.exerciseIds)
    ? [...new Set(raw.exerciseIds.map(String).filter(x => known.has(x)))].slice(0, MAX_PER_PLAN)
    : [];
  return {
    id,
    name,
    exerciseIds: ids,
    rules: cleanRules(raw && raw.rules),
    schedule: schedule.clean(raw && raw.schedule),
    archived: !!(raw && raw.archived),
  };
}

/* ── progress, keyed per plan ───────────────────────────────────────────────
   The same machine in two plans keeps two weights. The rep target is part of the
   progression state, so a plan built on 3x5 and one built on 3x12 would drag each
   other's weight around if they shared — and a plan whose exercises don't overlap
   pays nothing for the extra nesting. */

function planProgress(state, planId) {
  if (!state.progress[planId]) state.progress[planId] = {};
  return state.progress[planId];
}

// What to lift next, seeding from the exercise's own starting weight the first
// time a plan touches it.
function currentFor(state, plan, exId) {
  const prog = planProgress(state, plan.id);
  if (!prog[exId]) {
    const ex = (state.exercises || []).find(e => e.id === exId);
    prog[exId] = { weight: ex ? ex.weight : 0, target: plan.rules.minReps };
  }
  return prog[exId];
}

/* ── the old program, as the first plan ──────────────────────────────────── */

// Everything that used to be `EXERCISES` in progression.js, now seed data. The
// ids are kept verbatim so every logged workout, every progress entry and every
// sparkline in the existing store still resolves.
function seedExercises() {
  return P.EXERCISES.map(e => ({
    id: e.id,
    name: e.name,
    short: e.short || null,
    step: e.step || P.WEIGHT_STEP,
    weight: e.weight,
  }));
}

// Migrate a store written before plans existed. Old shape: one flat
// `progress[exerciseId]`, a global `settings.restSec`, and `includeOptional`
// deciding whether the leg curl was in the program at all.
function migrate(state, mint) {
  let changed = false;

  if (!Array.isArray(state.exercises) || !state.exercises.length) {
    state.exercises = seedExercises();
    changed = true;
  }

  if (!Array.isArray(state.plans) || !state.plans.length) {
    const legacy = state.settings || {};
    const ids = state.exercises
      // `includeOptional` was the only way to switch a lift off. Honour whatever
      // it was set to, then the flag stops existing.
      .filter(e => e.id !== 'leg-curl' || legacy.includeOptional !== false)
      .map(e => e.id);
    state.plans = [{
      id: mint('p'),
      name: 'My workout',
      exerciseIds: ids,
      rules: cleanRules({ restSec: legacy.restSec }),
      schedule: schedule.defaultSchedule(),
      archived: false,
    }];
    changed = true;
  }

  const first = state.plans[0];
  if (!state.activePlanId || !state.plans.some(p => p.id === state.activePlanId)) {
    state.activePlanId = first.id;
    changed = true;
  }

  // Flat progress -> nested under the first plan. Detected by shape: a legacy
  // entry has {weight,target} at the top level, a migrated one holds plan maps.
  if (state.progress && Object.keys(state.progress).length) {
    const flat = {};
    for (const [k, v] of Object.entries(state.progress)) {
      if (v && typeof v === 'object' && ('weight' in v || 'target' in v)) flat[k] = v;
    }
    if (Object.keys(flat).length) {
      const dest = { ...(state.progress[first.id] || {}) };
      for (const [k, v] of Object.entries(flat)) {
        delete state.progress[k];
        if (!dest[k]) dest[k] = { weight: cleanWeight(v.weight), target: clamp(v.target, 1, 100, P.MIN_REPS) };
      }
      state.progress[first.id] = dest;
      changed = true;
    }
  }
  if (!state.progress) { state.progress = {}; changed = true; }

  // Every workout logged before plans belongs to the plan they came from.
  for (const w of state.workouts || []) {
    if (!w.planId) { w.planId = first.id; changed = true; }
  }

  if (!state.push || typeof state.push !== 'object') {
    state.push = { subs: [], sent: {}, tried: {} };
    changed = true;
  }
  if (!Array.isArray(state.push.subs)) { state.push.subs = []; changed = true; }
  if (!state.push.sent || typeof state.push.sent !== 'object') { state.push.sent = {}; changed = true; }
  if (!state.push.tried || typeof state.push.tried !== 'object') { state.push.tried = {}; changed = true; }

  return changed;
}

module.exports = {
  NAME_MAX, MAX_PLANS, MAX_EXERCISES, MAX_PER_PLAN,
  cleanExercise, cleanRules, defaultRules, cleanPlan, cleanStep, cleanWeight, str,
  planProgress, currentFor, seedExercises, migrate,
};
