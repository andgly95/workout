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

  await t('12/12/12 → up one step and target resets to 8', () => {
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

  await t('full ladder: 140 lb leg press takes 3 workouts to reach 160', () => {
    const step = P.stepFor('leg-press');
    let st = { weight: 140, target: 8 };
    const seen = [];
    for (let i = 0; i < 3; i++) {
      seen.push(`${st.weight}x${st.target}`);
      const r = P.nextState(st, [st.target, st.target, st.target], step);
      st = { weight: r.weight, target: r.target };
    }
    assert.deepStrictEqual(seen, ['140x8', '140x10', '140x12']);
    assert.deepStrictEqual(st, { weight: 160, target: 8 });
  });

  /* Every machine climbs by what its own stack supports. This is the table the
     rest of the app reads — the client looks the step up rather than keeping a
     second copy, so getting it wrong here is the only way to get it wrong. */

  await t('each machine has the step its stack supports', () => {
    assert.deepStrictEqual(
      Object.fromEntries(P.EXERCISES.map(e => [e.id, P.stepFor(e.id)])),
      {
        'leg-press': 20,
        'chest-press': 10,
        'low-row': 10,
        'lat-pulldown': 10,
        'overhead': 5,
        'leg-curl': 10,
      });
  });

  await t('an unknown machine falls back to the global step', () => {
    assert.strictEqual(P.stepFor('nonesuch'), P.WEIGHT_STEP);
    assert.strictEqual(P.WEIGHT_STEP, 5);
  });

  await t('clearing 3x12 moves each machine by ITS step, not by five', () => {
    const up = (id, w) =>
      P.nextState({ weight: w, target: 12 }, [12, 12, 12], P.stepFor(id)).weight;
    assert.strictEqual(up('leg-press', 165), 185);
    assert.strictEqual(up('chest-press', 95), 105);
    assert.strictEqual(up('low-row', 95), 105);
    assert.strictEqual(up('lat-pulldown', 75), 85);
    assert.strictEqual(up('overhead', 35), 40);
    assert.strictEqual(up('leg-curl', 75), 85);
  });

  await t('a deload drops by the same step it climbs by', () => {
    const r = P.nextState({ weight: 185, target: 8 }, [8, 6, 8], P.stepFor('leg-press'));
    assert.strictEqual(r.action, 'suggest-deload');
    assert.strictEqual(r.suggestWeight, 165, 'a leg press has no 5 lb pin either');
    assert.strictEqual(r.canDrop, true);
    assert.strictEqual(r.weight, 185, 'still never applied automatically');
  });

  await t('the floor is one of the machine\'s own increments', () => {
    // 5 lb is not a leg press weight, so the floor moves up with the step.
    const r = P.nextState({ weight: 20, target: 8 }, [3, 3, 3], 20);
    assert.strictEqual(r.suggestWeight, 20);
    assert.strictEqual(r.canDrop, false);
    assert.ok(/as light as this machine goes/.test(r.note),
      'at the floor it must not offer a drop it cannot make');
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

/* ── 1b. the training calendar ─────────────────────────────────────────── */
//
// Day bucketing is where a calendar goes wrong, and none of it shows up until a
// square lands on the wrong weekday months later. Every way it can drift gets a
// row here.

async function calendarGrid() {
  console.log('\ntraining calendar');
  const C = require('../lib/calendar');

  // 2026-08-03 is a Monday, 2026-08-04 a Tuesday, 2026-07-29 a Wednesday.
  const w = (date, sets = [10, 10, 10], weight = 100, id = null) => ({
    id: id || `w-${date}`, done: true, date,
    entries: [{ id: 'leg-press', weight, sets, skipped: false }],
  });

  await t('the grid is a whole number of weeks, Monday first', () => {
    const h = C.buildHeatmap([], '2026-08-04');
    assert.strictEqual(h.cells.length, 12 * 7);
    assert.strictEqual(h.cells[0].dow, 0);
    assert.strictEqual(C.parseDay(h.start).getDay(), 1, 'the grid must start on a Monday');
    assert.strictEqual(C.parseDay(h.end).getDay(), 0, 'and end on a Sunday');
  });

  await t('a Sunday "today" still shows its whole week', () => {
    // 2026-08-09 is a Sunday. Cutting the grid at today would drop six days and
    // read as a missing week.
    const h = C.buildHeatmap([], '2026-08-09');
    assert.strictEqual(h.end, '2026-08-09');
    assert.strictEqual(h.cells.filter(c => c.future).length, 0);
  });

  await t('days after today are marked, not shaded', () => {
    const h = C.buildHeatmap([], '2026-08-04');   // a Tuesday
    const future = h.cells.filter(c => c.future);
    assert.strictEqual(future.length, 5, 'Wednesday to Sunday of the current week');
    assert.ok(future.every(c => c.level === 0));
  });

  await t('a workout lands on its own weekday', () => {
    const h = C.buildHeatmap([w('2026-07-29')], '2026-08-04');
    const cell = h.cells.find(c => c.date === '2026-07-29');
    assert.strictEqual(cell.dow, 2, '29 July 2026 is a Wednesday');
    assert.ok(cell.level > 0);
  });

  await t('two sessions on one day are one square, and the volumes add', () => {
    const h = C.buildHeatmap(
      [w('2026-08-03', [10, 10, 10], 100, 'wA'), w('2026-08-03', [5, 5, 5], 100, 'wB')],
      '2026-08-04');
    const day = h.cells.filter(c => c.date === '2026-08-03');
    assert.strictEqual(day.length, 1, 'a date must appear exactly once in the grid');
    assert.strictEqual(day[0].volume, 3000 + 1500);
    assert.strictEqual(h.sessions, 2, 'but both still count towards the rate');
  });

  await t('only finished workouts count', () => {
    const open = { ...w('2026-08-03'), done: false };
    const h = C.buildHeatmap([open], '2026-08-04');
    assert.strictEqual(h.sessions, 0);
    assert.strictEqual(h.cells.find(c => c.date === '2026-08-03').level, 0);
  });

  await t('a skipped exercise adds no volume', () => {
    const skipped = {
      entries: [{ id: 'leg-press', weight: 100, sets: [10, 10, 10], skipped: true }],
    };
    assert.strictEqual(C.volumeOf(skipped).volume, 0);
    assert.strictEqual(C.volumeOf(skipped).sets, 0);
  });

  await t('an unlogged set adds nothing, a logged one adds weight × reps', () => {
    const half = { entries: [{ id: 'x', weight: 80, sets: [10, null, null] }] };
    assert.strictEqual(C.volumeOf(half).volume, 800);
    assert.strictEqual(C.volumeOf(half).sets, 1);
  });

  await t('anything older than the window is left out', () => {
    const h = C.buildHeatmap([w('2025-01-01'), w('2026-08-03')], '2026-08-04');
    assert.strictEqual(h.sessions, 1);
    assert.ok(!h.cells.some(c => c.date === '2025-01-01'));
  });

  await t('shading is relative to the heaviest day, so it never saturates', () => {
    // A light day next to a heavy one has to stay distinguishable — against a
    // fixed threshold everything reads as full green once the weights climb.
    const h = C.buildHeatmap([
      w('2026-08-03', [10, 10, 10], 300),       // 9000
      w('2026-07-29', [10, null, null], 100),   // 1000
    ], '2026-08-04');
    assert.strictEqual(h.cells.find(c => c.date === '2026-08-03').level, 4);
    assert.strictEqual(h.cells.find(c => c.date === '2026-07-29').level, 1,
      'a real session is shaded, never blank');
  });

  await t('levels cover the range without a gap', () => {
    assert.strictEqual(C.levelFor(0, 100), 0);
    assert.strictEqual(C.levelFor(25, 100), 1);
    assert.strictEqual(C.levelFor(50, 100), 2);
    assert.strictEqual(C.levelFor(75, 100), 3);
    assert.strictEqual(C.levelFor(100, 100), 4);
    assert.strictEqual(C.levelFor(5, 0), 1, 'volume with no max is still a session');
  });

  await t('the rate is per week, to one decimal', () => {
    const h = C.buildHeatmap(
      ['2026-08-03', '2026-07-29', '2026-07-27'].map(d => w(d)), '2026-08-04');
    assert.strictEqual(h.sessions, 3);
    assert.strictEqual(h.perWeek, 0.3, '3 in 12 weeks must not round away to 0');
  });

  await t('month labels start a new run only when the month changes', () => {
    const h = C.buildHeatmap([], '2026-08-04');
    const labels = h.months.map(m => m.label);
    assert.deepStrictEqual(labels, [...new Set(labels)], 'no month may appear twice');
    assert.strictEqual(h.months[0].week, 0);
    assert.ok(h.months.length >= 3 && h.months.length <= 4);
  });

  await t('days are walked on the calendar, not by adding 86400000', () => {
    // US DST springs forward on 2026-03-08. Adding a day by arithmetic lands at
    // 23:00 on the 8th, which floors back to the 8th and shifts a whole column.
    assert.strictEqual(C.dayStr(C.addDays(C.parseDay('2026-03-07'), 1)), '2026-03-08');
    assert.strictEqual(C.dayStr(C.addDays(C.parseDay('2026-03-08'), 1)), '2026-03-09');
    assert.strictEqual(C.dayStr(C.addDays(C.parseDay('2026-10-31'), 1)), '2026-11-01');
  });

  await t('a grid spanning a DST change still has seven days in every week', () => {
    const h = C.buildHeatmap([], '2026-03-20');
    assert.strictEqual(h.cells.length, 84);
    for (let wk = 0; wk < 12; wk++) {
      assert.strictEqual(h.cells.filter(c => c.week === wk).length, 7, `week ${wk}`);
    }
    assert.strictEqual([...new Set(h.cells.map(c => c.date))].length, 84,
      'no date may repeat or go missing across the transition');
  });

  await t('an empty history still draws twelve empty weeks', () => {
    const h = C.buildHeatmap([], '2026-08-04');
    assert.strictEqual(h.sessions, 0);
    assert.strictEqual(h.perWeek, 0);
    assert.ok(h.cells.every(c => c.level === 0 && c.id === null));
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

  await t('the wire ships the calendar, so the client never buckets days itself', async () => {
    const { body } = await api('GET', '/api/state');
    const h = body.heatmap;
    assert.ok(h, 'no heatmap on the wire');
    assert.strictEqual(h.cells.length, 84);
    assert.strictEqual(h.weeks, 12);
    // The workouts logged above all happened today.
    const today = h.cells.find(c => c.date === body.today);
    assert.ok(today, "today must be in the window");
    assert.ok(today.level > 0, 'a workout logged today should light its square');
    assert.ok(today.id, 'and carry the id, so tapping it can find the card');
    assert.ok(h.sessions >= 1);
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

  await t('the wire ships each machine\'s own step, so the client never guesses', async () => {
    const { body } = await api('GET', '/api/state');
    const steps = Object.fromEntries(body.exercises.map(e => [e.id, e.step]));
    assert.strictEqual(steps['leg-press'], 20);
    assert.strictEqual(steps['overhead'], 5);
    assert.strictEqual(steps['chest-press'], 10);
    assert.strictEqual(body.rules.weightStep, 5, 'the global one stays as the fallback');
  });

  await t('a finished workout advances each machine by ITS OWN step', async () => {
    // Straight through the real route, because applyProgression looking the step
    // up by id is exactly the wiring that could silently regress to a flat 5.
    const { body: st } = await api('GET', '/api/state');
    const before = {};
    for (const p of st.planned) before[p.id] = p.weight;
    const { body } = await api('POST', '/api/workout', {
      id: 'w-steps',
      // 12s across the board — every machine earns a weight jump at once.
      entries: st.planned.map(p => ({ ...p, target: 12, sets: [12, 12, 12] })),
      done: true,
    });
    const after = body.state.progress;
    for (const p of st.planned) {
      const step = p.id === 'leg-press' ? 20 : p.id === 'overhead' ? 5 : 10;
      assert.strictEqual(after[p.id].weight, before[p.id] + step,
        `${p.id} should climb by ${step}`);
      assert.strictEqual(after[p.id].target, 8, 'and drop back to 8 reps');
    }
  });

  await t('a workout can be logged in a different order than it was planned', async () => {
    // "Machine busy" reorders the session's own copy of the entries, so the
    // reordered list is what gets posted. Progression must not care.
    const { body: st } = await api('GET', '/api/state');
    const shuffled = [...st.planned].reverse().map(p => ({ ...p, sets: [8, 8, 8] }));
    const { body } = await api('POST', '/api/workout', {
      id: 'w-reorder', entries: shuffled, done: true,
    });
    assert.strictEqual(body.outcomes.length, shuffled.length,
      'every machine should still get an outcome');
    for (const o of body.outcomes) assert.strictEqual(o.action, 'reps-up');
    assert.strictEqual(body.state.progress['leg-press'].target, 10,
      'the last machine performed is still the leg press record');
  });

  /* Undoing an accidental skip. A skip means "no signal" — applyProgression
     steps over it — so one mis-tap silently costs that machine its advance.
     Putting it back has to move the prescription too, but only when nothing
     later has already spoken for that exercise. */

  await t('un-skipping puts the sets back and catches the prescription up', async () => {
    const { body: st } = await api('GET', '/api/state');
    const target = st.planned.find(p => p.id === 'low-row').target;
    const entries = st.planned.map(p => p.id === 'low-row'
      ? { ...p, skipped: true, sets: [null, null, null] }
      : { ...p, sets: [p.target, p.target, p.target] });
    await api('POST', '/api/workout', { id: 'w-skip', entries, done: true });

    const { body: mid } = await api('GET', '/api/state');
    assert.strictEqual(mid.progress['low-row'].target, target,
      'a skipped lift must not move on its own');

    const { body } = await api('POST', '/api/workout/w-skip/unskip', {
      id: 'low-row', sets: [target, target, target],
    });
    assert.strictEqual(body.outcome.action, 'reps-up');
    assert.strictEqual(body.outcome.appliedToPlan, true);
    assert.strictEqual(body.state.progress['low-row'].target, target + 2,
      'the prescription has to catch up, or the correction is cosmetic');
    const w = body.state.workouts.find(x => x.id === 'w-skip');
    const en = w.entries.find(e => e.id === 'low-row');
    assert.strictEqual(en.skipped, false);
    assert.deepStrictEqual(en.sets, [target, target, target]);
    assert.ok(w.outcomes.some(o => o.id === 'low-row'), 'the record gains its outcome');
    assert.strictEqual(w.outcomes.length, w.entries.length,
      'and keeps one outcome per entry, in entry order');
  });

  await t('un-skipping an OLD workout fixes the record but not the weight', async () => {
    // The later workout is what set the current prescription. Correcting an
    // older one must not wind it back to what it would have been at the time.
    const { body: st } = await api('GET', '/api/state');
    const plan = st.planned.find(p => p.id === 'overhead');
    await api('POST', '/api/workout', {
      id: 'w-old', date: '2020-01-06', startedAt: 1578300000000, done: true,
      entries: st.planned.map(p => p.id === 'overhead'
        ? { ...p, skipped: true, sets: [null, null, null] }
        : { ...p, sets: [null, null, null], skipped: true }),
    });
    const before = JSON.stringify(st.progress['overhead']);
    const { body } = await api('POST', '/api/workout/w-old/unskip', {
      id: 'overhead', sets: [12, 12, 12],
    });
    assert.strictEqual(body.outcome.appliedToPlan, false, 'it must say it did not apply');
    assert.strictEqual(JSON.stringify(body.state.progress['overhead']), before,
      'a newer workout owns the current weight');
    const en = body.state.workouts.find(x => x.id === 'w-old').entries
      .find(e => e.id === 'overhead');
    assert.strictEqual(en.skipped, false, 'the record is still corrected');
    assert.deepStrictEqual(en.sets, [12, 12, 12]);
  });

  await t('un-skip refuses the cases that would corrupt a record', async () => {
    const bad = async (id, body, code) => {
      const { status } = await api('POST', `/api/workout/${id}/unskip`, body);
      assert.strictEqual(status, code, `${id} ${JSON.stringify(body)}`);
    };
    await bad('nope', { id: 'low-row', sets: [8, 8, 8] }, 404);
    await bad('w-skip', { id: 'nonesuch', sets: [8, 8, 8] }, 404);
    // Already un-skipped — a second call would re-apply the progression again.
    await bad('w-skip', { id: 'low-row', sets: [8, 8, 8] }, 400);

    // All blank is a skip by another name. Needs a genuinely skipped entry, or
    // this passes on the "not skipped" guard and tests nothing.
    const { body: st } = await api('GET', '/api/state');
    await api('POST', '/api/workout', {
      id: 'w-blank', done: true,
      entries: st.planned.map(p => p.id === 'lat-pulldown'
        ? { ...p, skipped: true, sets: [null, null, null] }
        : { ...p, sets: [p.target, p.target, p.target] }),
    });
    await bad('w-blank', { id: 'lat-pulldown', sets: [null, null, null] }, 400);
    const { body: after } = await api('GET', '/api/state');
    assert.strictEqual(
      after.workouts.find(x => x.id === 'w-blank').entries.find(e => e.id === 'lat-pulldown').skipped,
      true, 'a refused un-skip must leave the entry exactly as it was');
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
  await calendarGrid();
  await server();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
})().catch((e) => {
  console.error(e);
  if (child) child.kill('SIGKILL');
  process.exit(1);
});
