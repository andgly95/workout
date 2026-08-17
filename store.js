// JSON-file-backed store — same shape as the-square/store.js (debounced atomic
// writes, sync flush on SIGTERM). Single user, so there is no roster: just the
// current prescription per exercise and the log of workouts.
const fs = require('fs');
const path = require('path');
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

function defaultState() {
  return {
    // The catalogue, and the named plans that pick from it. Both user-editable —
    // lib/plan.js seeds them from the original hardcoded program on first load.
    exercises: [],
    plans: [],
    activePlanId: null,
    // planId -> exerciseId -> { weight, target } : what to lift NEXT time.
    // Nested per plan on purpose — see lib/plan.js.
    progress: {},
    // [{ id, planId, date, startedAt, finishedAt, done, entries:[...] }]
    workouts: [],
    push: { subs: [], sent: {} },
    settings: {},
    seq: 1,
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!state.progress) state.progress = {};
  if (!state.workouts) state.workouts = [];
  if (!state.settings) state.settings = {};
  if (!state.seq) state.seq = 1;
} catch (e) {
  if (e.code !== 'ENOENT') {
    const backup = FILE + '.corrupt-' + Date.now();
    try { fs.copyFileSync(FILE, backup); } catch (_) {}
    console.error(`store load failed (${e.message}) — saved bad file to ${backup}, starting fresh`);
  }
  state = defaultState();
}

let writeTimer = null;
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const tmp = FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), (err) => {
      if (err) return console.error('store write failed:', err.message);
      fs.rename(tmp, FILE, (err2) => {
        if (err2) console.error('store rename failed:', err2.message);
      });
    });
  }, 250);
}

function flushSync() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('store flush failed:', err.message);
  }
}
process.on('SIGTERM', () => { flushSync(); process.exit(0); });
process.on('SIGINT', () => { flushSync(); process.exit(0); });

function nextId(prefix) {
  return `${prefix}${state.seq++}`;
}

// Seed the catalogue and fold a pre-plans store into the new shape. Runs on LOAD
// only, which is why plan.js is the thing that owns it — a container created
// anywhere else would miss stores written since the last restart.
require('./lib/plan').migrate(state, nextId);

// Make sure data/ exists before the first write.
try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (_) {}

module.exports = { state, save, nextId, flushSync, defaultState, FILE };
