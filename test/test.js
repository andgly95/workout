// Characterization suite. Layer 1 exercises the progression rules directly;
// layer 2 boots a real server against a throwaway store and drives the API.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../lib/progression');

let pass = 0;
const fails = [];
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok   ${name}`); })
    .catch((e) => { fails.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); });
}

/* ── 1. progression rules ──────────────────────────────────────────────── */

async function rules() {
  console.log('\nprogression rules');

  await t('starting weights match the program', () => {
    const s = P.startingState();
    assert.strictEqual(s['leg-press'].weight, 140);
    assert.strictEqual(s['chest-press'].weight, 80);
    assert.strictEqual(s['low-row'].weight, 80);
    assert.strictEqual(s['lat-pulldown'].weight, 60);
    assert.strictEqual(s['overhead'].weight, 25);
    assert.strictEqual(s['leg-curl'].weight, 60);
    for (const id of Object.keys(s)) assert.strictEqual(s[id].target, 8);
  });

  await t('leg curl is the only optional lift', () => {
    assert.deepStrictEqual(P.EXERCISES.filter(e => e.optional).map(e => e.id), ['leg-curl']);
  });

  await t('8/8/8 at target 8 → target 10, weight unchanged', () => {
    const r = P.nextState({ weight: 80, target: 8 }, [8, 8, 8]);
    assert.strictEqual(r.action, 'reps-up');
    assert.strictEqual(r.target, 10);
    assert.strictEqual(r.weight, 80);
  });

  await t('10/10/10 at target 10 → target 12', () => {
    const r = P.nextState({ weight: 80, target: 10 }, [10, 10, 10]);
    assert.strictEqual(r.action, 'reps-up');
    assert.strictEqual(r.target, 12);
    assert.strictEqual(r.weight, 80);
  });

  await t('12/12/12 → +5 lb and target resets to 8', () => {
    const r = P.nextState({ weight: 80, target: 12 }, [12, 12, 12]);
    assert.strictEqual(r.action, 'weight-up');
    assert.strictEqual(r.weight, 85);
    assert.strictEqual(r.target, 8);
  });

  await t('3x12 jumps the weight even if target was only 8', () => {
    const r = P.nextState({ weight: 140, target: 8 }, [12, 12, 12]);
    assert.strictEqual(r.action, 'weight-up');
    assert.strictEqual(r.weight, 145);
    assert.strictEqual(r.target, 8);
  });

  await t('one set short of target → hold, nothing changes', () => {
    const r = P.nextState({ weight: 80, target: 10 }, [10, 9, 10]);
    assert.strictEqual(r.action, 'hold');
    assert.strictEqual(r.weight, 80);
    assert.strictEqual(r.target, 10);
  });

  await t('any set under 8 → deload OFFERED, never applied automatically', () => {
    const r = P.nextState({ weight: 80, target: 8 }, [8, 7, 8]);
    assert.strictEqual(r.action, 'suggest-deload');
    assert.strictEqual(r.weight, 80, 'weight must not drop on its own');
    assert.strictEqual(r.target, 8);
    assert.strictEqual(r.suggestWeight, 75);
    assert.strictEqual(r.canDrop, true);
  });

  await t('missing 8 outranks hitting a higher target on other sets', () => {
    const r = P.nextState({ weight: 60, target: 12 }, [12, 12, 5]);
    assert.strictEqual(r.action, 'suggest-deload');
  });

  await t('deload will not go below the floor', () => {
    const r = P.nextState({ weight: 5, target: 8 }, [3, 3, 3]);
    assert.strictEqual(r.suggestWeight, 5);
    assert.strictEqual(r.canDrop, false);
  });

  await t('blank sets count as a miss', () => {
    const r = P.nextState({ weight: 80, target: 8 }, [8, 8, null]);
    assert.strictEqual(r.action, 'suggest-deload');
  });

  await t('reps are capped at 12', () => {
    assert.strictEqual(P.clampReps(30), 12);
    assert.strictEqual(P.clampReps(-4), 0);
    const r = P.nextState({ weight: 80, target: 8 }, [20, 20, 20]);
    assert.strictEqual(r.weight, 85);
  });

  await t('full ladder: 140 lb leg press takes 3 workouts to reach 145', () => {
    let st = { weight: 140, target: 8 };
    const seen = [];
    for (let i = 0; i < 3; i++) {
      seen.push(`${st.weight}x${st.target}`);
      const r = P.nextState(st, [st.target, st.target, st.target]);
      st = { weight: r.weight, target: r.target };
    }
    assert.deepStrictEqual(seen, ['140x8', '140x10', '140x12']);
    assert.deepStrictEqual(st, { weight: 145, target: 8 });
  });

  await t('a stalled lift repeats forever until the reps come', () => {
    let st = { weight: 100, target: 10 };
    for (let i = 0; i < 5; i++) {
      const r = P.nextState(st, [10, 9, 9]);
      assert.strictEqual(r.action, 'hold');
      st = { weight: r.weight, target: r.target };
    }
    assert.deepStrictEqual(st, { weight: 100, target: 10 });
  });
}

/* ── 2. server / API ───────────────────────────────────────────────────── */

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

function api(method, p, body) {
  return fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function waitUp(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

async function server() {
  console.log('\nserver / api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-test-'));
  const dataFile = path.join(dir, 'store.json');

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  try {
    await waitUp();
  } catch (e) {
    console.log('server log:\n' + log);
    throw e;
  }

  await t('GET /api/state seeds the program', async () => {
    const { body } = await api('GET', '/api/state');
    assert.strictEqual(body.planned.length, 5, 'leg curl excluded by default');
    assert.strictEqual(body.planned[0].id, 'leg-press');
    assert.strictEqual(body.planned[0].weight, 140);
    assert.strictEqual(body.planned[0].target, 8);
    assert.strictEqual(body.rules.restSec, 90);
    assert.strictEqual(body.rules.sets, 3);
  });

  await t('enabling the optional lift adds it to the plan', async () => {
    let { body } = await api('POST', '/api/settings', { includeOptional: true });
    assert.strictEqual(body.planned.length, 6);
    assert.ok(body.planned.some(p => p.id === 'leg-curl'));
    ({ body } = await api('POST', '/api/settings', { includeOptional: false }));
    assert.strictEqual(body.planned.length, 5);
  });

  await t('finishing a workout advances the prescription', async () => {
    const { body: st } = await api('GET', '/api/state');
    const entries = st.planned.map(p => ({ ...p, sets: [p.target, p.target, p.target] }));
    const { body } = await api('POST', '/api/workout', { id: 'wtest1', entries, done: true });
    const legs = body.outcomes.find(o => o.id === 'leg-press');
    assert.strictEqual(legs.action, 'reps-up');
    assert.strictEqual(body.state.progress['leg-press'].target, 10);
    assert.strictEqual(body.state.progress['leg-press'].weight, 140);
    assert.strictEqual(body.state.planned[0].target, 10);
  });

  await t('re-posting the same finished workout does not double-apply', async () => {
    const { body: before } = await api('GET', '/api/state');
    const target = before.progress['leg-press'].target;
    const entries = before.planned.map(p => ({ ...p, sets: [p.target, p.target, p.target] }));
    const { body } = await api('POST', '/api/workout', { id: 'wtest1', entries, done: true });
    assert.strictEqual(body.state.progress['leg-press'].target, target,
      'a replayed offline save must not advance twice');
    assert.strictEqual(body.state.workouts.filter(w => w.id === 'wtest1').length, 1);
  });

  await t('a client-minted id upserts instead of duplicating', async () => {
    const { body: st } = await api('GET', '/api/state');
    const entries = st.planned.map(p => ({ ...p, sets: [null, null, null] }));
    await api('POST', '/api/workout', { id: 'wabc123', entries, done: false });
    entries[0].sets = [8, null, null];
    await api('POST', '/api/workout', { id: 'wabc123', entries, done: false });
    const { body } = await api('GET', '/api/state');
    const mine = body.workouts.filter(w => w.id === 'wabc123');
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].entries[0].sets[0], 8);
  });

  await t('skipped and untouched lifts do not move', async () => {
    const { body: st } = await api('GET', '/api/state');
    const before = JSON.parse(JSON.stringify(st.progress));
    const entries = st.planned.map((p, i) => ({
      ...p,
      skipped: i === 0,
      sets: i === 1 ? [null, null, null] : [p.target, p.target, p.target],
    }));
    const { body } = await api('POST', '/api/workout', { id: 'wskip', entries, done: true });
    assert.deepStrictEqual(body.state.progress[entries[0].id], before[entries[0].id]);
    assert.deepStrictEqual(body.state.progress[entries[1].id], before[entries[1].id]);
  });

  await t('adjust accepts a deload', async () => {
    const { body } = await api('POST', '/api/adjust', { id: 'overhead', weight: 20, target: 8 });
    assert.strictEqual(body.progress.overhead.weight, 20);
    assert.strictEqual(body.progress.overhead.target, 8);
  });

  await t('adjust rejects an unknown exercise', async () => {
    const { status } = await api('POST', '/api/adjust', { id: 'nope', weight: 10 });
    assert.strictEqual(status, 400);
  });

  await t('garbage input is rejected, not persisted', async () => {
    const { status } = await api('POST', '/api/workout', { entries: [{ id: 'bogus' }] });
    assert.strictEqual(status, 400);
  });

  await t('reps over the cap are clamped server-side', async () => {
    const { body: st } = await api('GET', '/api/state');
    const entries = [{ id: 'low-row', weight: st.progress['low-row'].weight, target: 8, sets: [99, 99, 99] }];
    const { body } = await api('POST', '/api/workout', { id: 'wclamp', entries, done: true });
    const w = body.state.workouts.find(x => x.id === 'wclamp');
    assert.deepStrictEqual(w.entries[0].sets, [12, 12, 12]);
  });

  await t('the shell serves with a cache-busted asset stamp', async () => {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    assert.ok(/style\.css\?v=[a-z0-9]+/.test(html), 'style.css not stamped');
    assert.ok(/\/js-[a-z0-9]+\/app\.js/.test(html), 'js prefix not stamped');
    const m = html.match(/\/js-[a-z0-9]+\//)[0];
    const js = await fetch(BASE + m + 'app.js');
    assert.strictEqual(js.status, 200, 'stamped js path must resolve');
  });

  await t('every client module parses and its imports resolve', async () => {
    const seen = new Set();
    const walk = async (p) => {
      if (seen.has(p)) return;
      seen.add(p);
      const r = await fetch(BASE + p);
      assert.strictEqual(r.status, 200, `${p} → ${r.status}`);
      const src = await r.text();
      new Function(`return async () => {}`); // sanity
      for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) {
        await walk('/js/' + m[1].replace(/^\.\//, ''));
      }
    };
    await walk('/js/app.js');
    assert.ok(seen.size >= 7, `expected the whole module graph, saw ${seen.size}`);
  });

  await t('data survives a restart', async () => {
    const { body: before } = await api('GET', '/api/state');
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitUp();
    const { body: after } = await api('GET', '/api/state');
    assert.deepStrictEqual(after.progress, before.progress);
    assert.strictEqual(after.workouts.length, before.workouts.length);
  });

  child.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/* ── run ───────────────────────────────────────────────────────────────── */

(async () => {
  await rules();
  await server();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
})().catch((e) => {
  console.error(e);
  if (child) child.kill('SIGKILL');
  process.exit(1);
});
