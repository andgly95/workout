// HTTP surface. Everything is JSON except the shell.
// Auth is Cloudflare Access in front of the tunnel — there is no in-app login.
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./../store');
const { state } = store;
const P = require('./progression');
const calendar = require('./calendar');

const PUBLIC = path.join(__dirname, '..', 'public');
// Cache-bust stamp: style.css gets ?v=, the JS module tree is served under a
// /js-<stamp>/ prefix (query params don't survive `import` statements).
const STAMP = Date.now().toString(36);

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The prescription for a workout that hasn't been performed yet.
function plannedEntries() {
  return P.EXERCISES
    .filter(e => !e.optional || state.settings.includeOptional)
    .map(e => {
      const cur = state.progress[e.id] || { weight: e.weight, target: P.MIN_REPS };
      return {
        id: e.id,
        weight: cur.weight,
        target: cur.target,
        sets: [null, null, null],
        skipped: false,
      };
    });
}

function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const known = new Map(P.EXERCISES.map(e => [e.id, e]));
  return raw
    .filter(en => en && known.has(en.id))
    .map(en => ({
      id: en.id,
      weight: Math.max(0, Math.round(Number(en.weight) || 0)),
      target: P.clampReps(en.target) || P.MIN_REPS,
      sets: Array.from({ length: P.SETS }, (_, i) => {
        const v = Array.isArray(en.sets) ? en.sets[i] : null;
        return v === null || v === undefined || v === '' ? null : P.clampReps(v);
      }),
      skipped: !!en.skipped,
    }));
}

// Roll a finished workout into the next prescription. Idempotent: a workout
// that has already been applied is never applied twice (offline retries).
function applyProgression(w) {
  if (w.applied) return [];
  const out = [];
  for (const en of w.entries) {
    if (en.skipped) continue;
    if (en.sets.every(s => s === null)) continue; // never started — no signal
    const res = P.nextState({ weight: en.weight, target: en.target }, en.sets, P.stepFor(en.id));
    state.progress[en.id] = { weight: res.weight, target: res.target };
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
    x !== w && x.done && key(x) > key(w) &&
    (x.entries || []).some(e => e.id === exId && !e.skipped && e.sets.some(v => v !== null)));
}

// Recompute one entry's outcome after the fact — the workout is already finished
// and already applied, so this is a correction, not a first pass. The outcome is
// rewritten in place (kept in entry order) and rolled into the prescription only
// if nothing later has spoken for that exercise since.
function reapplyEntry(w, en) {
  const res = P.nextState({ weight: en.weight, target: en.target }, en.sets, P.stepFor(en.id));
  const byId = new Map((w.outcomes || []).map(o => [o.id, o]));
  byId.set(en.id, { id: en.id, ...res });
  w.outcomes = w.entries.map(e => byId.get(e.id)).filter(Boolean);
  const stale = supersededBy(w, en.id);
  if (!stale) state.progress[en.id] = { weight: res.weight, target: res.target };
  return { ...res, appliedToPlan: !stale };
}

function wire() {
  return {
    exercises: P.EXERCISES,
    rules: {
      sets: P.SETS, restSec: state.settings.restSec,
      minReps: P.MIN_REPS, maxReps: P.MAX_REPS,
      repStep: P.REP_STEP,
      // The fallback only. Each machine's real increment rides on its entry in
      // `exercises` above, because they differ — see stepFor().
      weightStep: P.WEIGHT_STEP,
    },
    progress: state.progress,
    settings: state.settings,
    planned: plannedEntries(),
    workouts: state.workouts.slice(-200),
    today: todayStr(),
    // Computed here, not in the client — day bucketing and week alignment are
    // exactly the kind of thing that should have one implementation and a truth
    // table, like the progression rules.
    heatmap: calendar.buildHeatmap(state.workouts, todayStr()),
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
    html = html.replace('style.css', `style.css?v=${STAMP}`).replace('/js/', `/js-${STAMP}/`);
    res.type('html').send(html);
  });

  app.get('/api/state', (_req, res) => res.json(wire()));

  // Upsert a workout. The client sends the whole thing every time (it is small),
  // so an offline queue can just replay the latest snapshot.
  app.post('/api/workout', (req, res) => {
    const b = req.body || {};
    const entries = sanitizeEntries(b.entries);
    if (!entries.length) return res.status(400).json({ error: 'no entries' });

    let w = b.id ? state.workouts.find(x => x.id === b.id) : null;
    if (!w) {
      w = {
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
  app.post('/api/adjust', (req, res) => {
    const { id, weight, target } = req.body || {};
    if (!state.progress[id]) return res.status(400).json({ error: 'unknown exercise' });
    if (weight !== undefined) {
      state.progress[id].weight = Math.max(0, Math.round(Number(weight) || 0));
    }
    if (target !== undefined) {
      const t = P.clampReps(target);
      state.progress[id].target = Math.max(P.MIN_REPS, t || P.MIN_REPS);
    }
    store.save();
    res.json(wire());
  });

  app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    if (b.includeOptional !== undefined) state.settings.includeOptional = !!b.includeOptional;
    if (b.restSec !== undefined) {
      state.settings.restSec = Math.min(600, Math.max(10, Math.round(Number(b.restSec) || 90)));
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
