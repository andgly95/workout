// JSON-file-backed store — same shape as the-square/store.js (debounced atomic
// writes, sync flush on SIGTERM). Single user, so there is no roster: just the
// current prescription per exercise and the log of workouts.
const fs = require('fs');
const path = require('path');
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

function defaultState() {
  return {
    // Google `sub` -> the person. `status` gates everything: a stranger who signs
    // in is `pending` and has NO data slice at all until the owner approves them.
    users: {},
    // uid -> that person's whole program. One slice per user, never shared, and
    // always resolved from the session — see lib/auth.js.
    data: {},
    // A store written before accounts existed, waiting to be adopted by the owner
    // on their first sign-in. Null once claimed.
    legacy: null,
    seq: 1,
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
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

// Fold a pre-accounts store into the new shape. The single user's whole program
// is moved aside into `state.legacy` rather than being assigned to an id we can't
// know yet — a Google `sub` only exists once somebody signs in. The first owner
// to arrive adopts it (see lib/routes.js), and until then it is untouched.
//
// Runs on LOAD only, which is why it lives here: a container created anywhere
// else would miss stores written since the last restart.
(function migrateStore() {
  if (!state.users) state.users = {};
  if (!state.data) state.data = {};
  if (state.legacy === undefined) state.legacy = null;
  // The pre-accounts shape is recognised by its own top-level program fields.
  if (Array.isArray(state.plans) || Array.isArray(state.workouts)) {
    state.legacy = {
      exercises: state.exercises || [],
      plans: state.plans || [],
      activePlanId: state.activePlanId || null,
      progress: state.progress || {},
      workouts: state.workouts || [],
      push: state.push || { subs: [], sent: {}, tried: {} },
      settings: state.settings || {},
    };
    delete state.exercises; delete state.plans; delete state.activePlanId;
    delete state.progress; delete state.workouts; delete state.push;
    delete state.settings;
    console.log('store: pre-accounts data set aside for the first owner to adopt');
  }
  // Anything already per-user still gets its own containers backfilled.
  const plan = require('./lib/plan');
  for (const d of Object.values(state.data)) plan.migrate(d, nextId);
  if (state.legacy) plan.migrate(state.legacy, nextId);
})();

// Make sure data/ exists before the first write.
try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (_) {}

module.exports = { state, save, nextId, flushSync, defaultState, FILE };
