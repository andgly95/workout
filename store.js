// JSON-file-backed store — same shape as the-square/store.js (debounced atomic
// writes, sync flush on SIGTERM). Single user, so there is no roster: just the
// current prescription per exercise and the log of workouts.
const fs = require('fs');
const path = require('path');
const { startingState } = require('./lib/progression');

const FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

function defaultState() {
  return {
    // exerciseId -> { weight, target } : what to lift NEXT time
    progress: startingState(),
    // [{ id, date, startedAt, finishedAt, done, entries:[{ id, weight, target, sets:[], skipped }] }]
    workouts: [],
    settings: { restSec: 90, includeOptional: false },
    seq: 1,
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!state.progress) state.progress = startingState();
  if (!state.workouts) state.workouts = [];
  if (!state.settings) state.settings = { restSec: 90, includeOptional: false };
  if (!state.seq) state.seq = 1;
  // Backfill any exercise added to the program after this store was created.
  const seed = startingState();
  for (const id of Object.keys(seed)) if (!state.progress[id]) state.progress[id] = seed[id];
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

// Make sure data/ exists before the first write.
try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (_) {}

module.exports = { state, save, nextId, flushSync, defaultState, FILE };
