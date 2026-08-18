// Characterization suite. Layer 1 exercises the progression rules directly;
// layer 2 boots a real server against a throwaway store and drives the API.
const assert = require('assert');
const crypto = require('crypto');
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
      const r = P.nextState(st, [st.target, st.target, st.target], { step });
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
      P.nextState({ weight: w, target: 12 }, [12, 12, 12], { step: P.stepFor(id) }).weight;
    assert.strictEqual(up('leg-press', 165), 185);
    assert.strictEqual(up('chest-press', 95), 105);
    assert.strictEqual(up('low-row', 95), 105);
    assert.strictEqual(up('lat-pulldown', 75), 85);
    assert.strictEqual(up('overhead', 35), 40);
    assert.strictEqual(up('leg-curl', 75), 85);
  });

  await t('a deload drops by the same step it climbs by', () => {
    const r = P.nextState({ weight: 185, target: 8 }, [8, 6, 8], { step: P.stepFor('leg-press') });
    assert.strictEqual(r.action, 'suggest-deload');
    assert.strictEqual(r.suggestWeight, 165, 'a leg press has no 5 lb pin either');
    assert.strictEqual(r.canDrop, true);
    assert.strictEqual(r.weight, 185, 'still never applied automatically');
  });

  await t('the floor is one of the machine\'s own increments', () => {
    // 5 lb is not a leg press weight, so the floor moves up with the step.
    const r = P.nextState({ weight: 20, target: 8 }, [3, 3, 3], { step: 20 });
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

/* ── 1c. the schedule ───────────────────────────────────────────────────────
   Pure, and takes `today` as an argument rather than reading a clock, which is
   the only reason any of this is testable. The rule that earns the most rows:
   an overdue workout stays DUE. Quietly sliding it to tomorrow is how a schedule
   stops meaning anything. */

async function scheduleRules() {
  console.log('\nschedule');
  const SC = require('../lib/schedule');
  // 2026-08-17 is a Monday. Every date below is picked off that week.
  const MON = '2026-08-17', TUE = '2026-08-18', WED = '2026-08-19';
  const THU = '2026-08-20', FRI = '2026-08-21', SUN = '2026-08-23';

  await t('an unscheduled plan is never due and never overdue', () => {
    const st = SC.statusOf({ mode: 'off' }, MON, null);
    assert.strictEqual(st.due, false);
    assert.strictEqual(st.next, null);
  });

  await t('weekdays: due on its days, silent on the others', () => {
    const mwf = { mode: 'weekdays', days: [1, 3, 5] };
    assert.strictEqual(SC.statusOf(mwf, MON, null).due, true, 'Monday is one of them');
    assert.strictEqual(SC.statusOf(mwf, TUE, MON).due, false, 'Tuesday is not');
    assert.strictEqual(SC.statusOf(mwf, TUE, MON).next, WED, 'and points at Wednesday');
    assert.strictEqual(SC.statusOf(mwf, WED, MON).due, true);
  });

  await t('weekdays: doing it today clears today and looks past it', () => {
    const mwf = { mode: 'weekdays', days: [1, 3, 5] };
    const st = SC.statusOf(mwf, MON, MON);
    assert.strictEqual(st.due, false, 'already done');
    assert.strictEqual(st.doneToday, true);
    assert.strictEqual(st.next, WED, 'the next one is Wednesday, not today again');
  });

  await t('weekdays: a missed day stays due, and says how overdue', () => {
    // Scheduled Monday, last done the Monday before, now Thursday.
    const st = SC.statusOf({ mode: 'weekdays', days: [1] }, THU, '2026-08-10');
    assert.strictEqual(st.due, true, 'Monday came and went — it is still owed');
    assert.strictEqual(st.overdueDays, 3, 'Mon -> Thu');
    assert.strictEqual(st.next, THU, 'and reads as due NOW rather than on a past date');
  });

  await t('interval: every other day counts from the one you FINISHED', () => {
    const every2 = { mode: 'interval', everyN: 2 };
    assert.strictEqual(SC.statusOf(every2, MON, MON).next, WED, 'done Monday -> Wednesday');
    assert.strictEqual(SC.statusOf(every2, TUE, MON).due, false, 'Tuesday is a rest day');
    assert.strictEqual(SC.statusOf(every2, WED, MON).due, true);
    // Skipping Wednesday does not reschedule to Friday — it is simply late.
    const late = SC.statusOf(every2, FRI, MON);
    assert.strictEqual(late.due, true);
    assert.strictEqual(late.overdueDays, 2, 'due Wednesday, now Friday');
  });

  await t('interval: every 3 days, and every single day', () => {
    assert.strictEqual(SC.statusOf({ mode: 'interval', everyN: 3 }, WED, MON).due, false);
    assert.strictEqual(SC.statusOf({ mode: 'interval', everyN: 3 }, THU, MON).due, true);
    assert.strictEqual(SC.statusOf({ mode: 'interval', everyN: 1 }, TUE, MON).due, true);
  });

  await t('interval: with no history at all it is due now, not never', () => {
    const st = SC.statusOf({ mode: 'interval', everyN: 2 }, MON, null);
    assert.strictEqual(st.due, true, 'a schedule you just set should start today');
  });

  await t('interval: an anchor stands in until there is a session to roll off', () => {
    const st = SC.statusOf({ mode: 'interval', everyN: 2, anchor: MON }, TUE, null);
    assert.strictEqual(st.due, false);
    assert.strictEqual(st.next, WED);
  });

  await t('the day walk survives a DST change', () => {
    // 2026-03-08 is the US spring-forward. Adding milliseconds lands at 23:00 the
    // day before and would report the wrong day — the same trap calendar.js has a
    // row for.
    const st = SC.statusOf({ mode: 'interval', everyN: 2 }, '2026-03-10', '2026-03-08');
    assert.strictEqual(st.due, true, 'two days after the 8th is the 10th, DST or not');
    assert.strictEqual(SC.daysBetween('2026-03-08', '2026-03-10'), 2);
    assert.strictEqual(SC.daysBetween('2026-11-01', '2026-11-03'), 2, 'and falling back');
  });

  await t('a schedule is sanitized into something that can be honoured', () => {
    const c = SC.clean({ mode: 'nonsense', days: [9, 3, 3, -1, 0], everyN: 99, at: '25:00' });
    assert.strictEqual(c.mode, 'off', 'an unknown mode is off, not a crash');
    assert.deepStrictEqual(c.days, [0, 3], 'out-of-range dropped, deduped, sorted');
    assert.strictEqual(c.everyN, SC.MAX_EVERY, 'clamped');
    assert.strictEqual(c.at, '18:00', 'a bad time falls back rather than sticking');
  });

  await t('weekdays with no days picked is inert, not an infinite search', () => {
    const st = SC.statusOf({ mode: 'weekdays', days: [] }, MON, null);
    assert.strictEqual(st.due, false);
    assert.strictEqual(st.next, null);
  });

  await t('a reminder fires once, after its time, only when due', () => {
    const mon = { mode: 'weekdays', days: [1], at: '18:00' };
    assert.strictEqual(SC.reminderDue(mon, MON, null, 17 * 60, null), false, 'not yet 18:00');
    assert.strictEqual(SC.reminderDue(mon, MON, null, 18 * 60, null), true);
    assert.strictEqual(SC.reminderDue(mon, MON, null, 19 * 60, MON), false, 'already sent today');
    assert.strictEqual(SC.reminderDue(mon, TUE, null, 19 * 60, null), false, 'not a Monday');
    assert.strictEqual(SC.reminderDue(mon, MON, MON, 19 * 60, null), false, 'already trained');
  });

  await t('every weekday resolves to itself, Sunday included', () => {
    for (let d = 0; d <= 6; d++) {
      const date = SC.nextOnOrAfter({ mode: 'weekdays', days: [d] }, MON, null);
      assert.strictEqual(SC.dowOf(date), d, `day ${d}`);
    }
    assert.strictEqual(SC.nextOnOrAfter({ mode: 'weekdays', days: [0] }, MON, null), SUN);
  });
}

/* ── 1d. the plan gate ──────────────────────────────────────────────────────
   Every rule is now a knob, so the guards are what stop a plan being configured
   into one that can never advance — which would look like a broken app rather
   than a bad setting. */

async function planRules() {
  console.log('\nplans');
  const PL = require('../lib/plan');

  await t('a plan cannot be configured so the target can never move', () => {
    const r = PL.cleanRules({ sets: 3, minReps: 8, maxReps: 12, repStep: 0 });
    assert.ok(r.repStep >= 1, 'a zero rep step would sit at 8 forever');
    const flat = PL.cleanRules({ minReps: 5, maxReps: 5, repStep: 9 });
    assert.strictEqual(flat.repStep, 1, 'and it cannot exceed the range it steps through');
  });

  await t('maxReps can never sit below minReps', () => {
    const r = PL.cleanRules({ minReps: 10, maxReps: 4 });
    assert.strictEqual(r.minReps, 10);
    assert.strictEqual(r.maxReps, 10, 'clamped up to meet it, not left inverted');
  });

  await t('a 5x5 plan advances by WEIGHT, since it has no rep rungs', () => {
    const r = PL.cleanRules({ sets: 5, minReps: 5, maxReps: 5, repStep: 1 });
    const out = P.nextState({ weight: 200, target: 5 }, [5, 5, 5, 5, 5], { ...r, step: 10 });
    assert.strictEqual(out.action, 'weight-up', 'nowhere to send the target, so the bar goes up');
    assert.strictEqual(out.weight, 210);
    assert.strictEqual(out.target, 5);
  });

  await t('a plan with a longer ladder climbs every rung', () => {
    const r = PL.cleanRules({ sets: 4, minReps: 5, maxReps: 8, repStep: 1 });
    let st = { weight: 100, target: r.minReps };
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(st.target);
      const out = P.nextState(st, Array(r.sets).fill(st.target), { ...r, step: 10 });
      st = { weight: out.weight, target: out.target };
    }
    assert.deepStrictEqual(seen, [5, 6, 7, 8, 5], '5-6-7-8 then heavier and back to 5');
    assert.strictEqual(st.weight, 110);
  });

  await t('a set count out of range is clamped, not honoured', () => {
    assert.strictEqual(PL.cleanRules({ sets: 0 }).sets, 1);
    assert.strictEqual(PL.cleanRules({ sets: 99 }).sets, 10);
    assert.strictEqual(PL.cleanRules({ restSec: 2 }).restSec, 10);
  });

  await t('an exercise needs a name and a real weight step', () => {
    assert.strictEqual(PL.cleanExercise({ name: '   ' }, 'e1'), null, 'no name, no machine');
    const e = PL.cleanExercise({ name: 'Hack Squat', step: 0, weight: -5 }, 'e1');
    assert.strictEqual(e.step, 1, 'a zero step would never move the weight');
    assert.strictEqual(e.weight, 0);
    // A second label only earns its place if it differs.
    assert.strictEqual(PL.cleanExercise({ name: 'Row', short: 'Row' }, 'e2').short, null);
  });

  await t('a plan cannot hold a machine that does not exist', () => {
    const cat = [{ id: 'a' }, { id: 'b' }];
    const p = PL.cleanPlan({ name: 'A', exerciseIds: ['a', 'ghost', 'b', 'a'] }, 'p1', cat);
    assert.deepStrictEqual(p.exerciseIds, ['a', 'b'],
      'unknown dropped and duplicates collapsed — a dangling id is how `planned` ships undefined');
  });

  await t('the old single-program store folds into one plan, losing nothing', () => {
    const before = {
      progress: { 'leg-press': { weight: 165, target: 10 }, overhead: { weight: 35, target: 8 } },
      workouts: [{ id: 'w1', done: true, date: '2026-08-01', entries: [] }],
      settings: { restSec: 75, includeOptional: true },
      seq: 1,
    };
    let n = 0;
    PL.migrate(before, (p) => `${p}${++n}`);
    assert.strictEqual(before.plans.length, 1);
    const p = before.plans[0];
    assert.strictEqual(before.activePlanId, p.id);
    assert.strictEqual(p.rules.restSec, 75, 'the global rest setting became the plan\'s');
    assert.strictEqual(p.exerciseIds.length, 6, 'includeOptional was true, so the leg curl came');
    // The weights move under the plan, and nothing is left at the top level.
    assert.deepStrictEqual(before.progress[p.id]['leg-press'], { weight: 165, target: 10 });
    assert.strictEqual(before.progress['leg-press'], undefined);
    assert.strictEqual(before.workouts[0].planId, p.id, 'old sessions belong to it too');
  });

  await t('a store that had the optional lift OFF keeps it off', () => {
    const before = { progress: {}, workouts: [], settings: { includeOptional: false }, seq: 1 };
    let n = 0;
    PL.migrate(before, (p) => `${p}${++n}`);
    assert.ok(!before.plans[0].exerciseIds.includes('leg-curl'),
      'migrating must not silently add a lift someone had switched off');
  });

  await t('migrating twice changes nothing the second time', () => {
    const st = { progress: { overhead: { weight: 35, target: 8 } }, workouts: [], settings: {}, seq: 1 };
    let n = 0;
    const mint = (p) => `${p}${++n}`;
    PL.migrate(st, mint);
    const once = JSON.stringify(st);
    PL.migrate(st, mint);
    assert.strictEqual(JSON.stringify(st), once, 'load is not a mutation you can stack');
  });
}

/* ── 1e. the reminder sender ────────────────────────────────────────────────
   lib/push.js is the one module here that touches the store, so this section
   points DATA_FILE at a temp file BEFORE requiring it. Nothing else in this
   process loads store.js, so the live data is never opened. `tick` takes its
   clock as an argument, which is the only reason any of this is testable. */

async function reminderSender() {
  console.log('\nreminder sender');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-push-'));
  process.env.DATA_FILE = path.join(dir, 'store.json');
  process.env.CONFIG_FILE = path.join(dir, 'config.json');
  fs.writeFileSync(process.env.DATA_FILE,
    JSON.stringify({ progress: {}, workouts: [], settings: {}, seq: 1 }));

  const store = require('../store');
  const push = require('../lib/push');
  const PL = require('../lib/plan');
  assert.ok(store.FILE.startsWith(os.tmpdir()), 'refusing to run against the real store');
  // Push is per-user now: one active person, one slice, their own devices.
  const st = store.state;
  st.users = { u1: { id: 'u1', email: 'a@b.c', status: 'active', owner: true } };
  st.data = { u1: PL.seedUserData(store.nextId) };
  const d = st.data.u1;
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  const today = require('../lib/calendar').dayStr(new Date());

  await t('with nothing subscribed the sender does nothing at all', async () => {
    d.plans[0].schedule = { mode: 'weekdays', days: [0, 1, 2, 3, 4, 5, 6], at: '06:00', everyN: 2, anchor: null };
    assert.deepStrictEqual(await push.tick(at(9, 0)), [],
      'a fresh checkout must stay silent, not error');
  });

  await t('a subscription is validated before it is stored', () => {
    assert.strictEqual(push.addSub(d, { endpoint: 'ftp://nope' }), null, 'scheme');
    assert.strictEqual(push.addSub(d, { endpoint: 'https://a.example/x' }), null, 'no keys');
    // A REAL P-256 public key, so the send that follows fails because the service
    // is unreachable and not because the key was nonsense — otherwise the retry
    // test below would be measuring the wrong failure.
    const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
    assert.ok(push.addSub(d, {
      endpoint: 'https://127.0.0.1:1/dead',
      keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    }), 'a well-formed one is kept');
    assert.strictEqual(d.push.subs.length, 1);
  });

  await t('a send that fails is NOT marked sent, so a blip does not eat the nudge', async () => {
    // Port 1 refuses instantly — a stand-in for "the push service is having a day".
    assert.deepStrictEqual(await push.tick(at(7, 0)), [], 'nothing went out');
    assert.strictEqual(d.push.sent[d.plans[0].id], undefined,
      'marking it sent here would lose today\'s reminder for good');
    assert.strictEqual(d.push.tried[d.plans[0].id].n, 1, 'but the attempt is counted');
  });

  await t('and retries are capped, so a broken endpoint goes quiet', async () => {
    for (let i = 0; i < push.MAX_TRIES + 3; i++) await push.tick(at(7, i + 1));
    assert.strictEqual(d.push.tried[d.plans[0].id].n, push.MAX_TRIES,
      'an error logged every minute forever is its own kind of outage');
  });

  await t('before its time, nothing is attempted', async () => {
    d.push.tried = {};
    assert.deepStrictEqual(await push.tick(at(5, 30)), []);
    assert.strictEqual(d.push.tried[d.plans[0].id], undefined, 'not even tried');
  });

  await t('a plan already trained today raises no reminder', async () => {
    d.push.tried = {};
    d.workouts.push({ id: 'w1', planId: d.plans[0].id, done: true, date: today, entries: [] });
    assert.deepStrictEqual(await push.tick(at(9, 0)), []);
    assert.strictEqual(d.push.tried[d.plans[0].id], undefined);
    d.workouts.pop();
  });

  await t('an archived plan is never nagged about', async () => {
    d.push.tried = {};
    d.plans[0].archived = true;
    assert.deepStrictEqual(await push.tick(at(9, 0)), []);
    assert.strictEqual(d.push.tried[d.plans[0].id], undefined);
    d.plans[0].archived = false;
  });

  await t('unsubscribing removes the device', () => {
    assert.strictEqual(push.removeSub(d, 'https://127.0.0.1:1/dead'), 1);
    assert.strictEqual(d.push.subs.length, 0);
  });

  push.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.DATA_FILE;
  delete process.env.CONFIG_FILE;
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

// The VAPID keypair is minted on first use into CONFIG_FILE. Pointed at the temp
// dir so `npm test` never writes a config into the working tree, and NO_PUSH
// keeps the once-a-minute sender out of the run entirely.
//
// AUTH: every data route needs a session. Rather than a test-only bypass in
// production code — which is how a bypass eventually ships — the suite pre-writes
// the session secret into CONFIG_FILE and the users into the store, then signs its
// own cookies with exactly the code the server verifies with.
const AUTH = require('../lib/auth');
const SECRET = 'test-secret-not-a-real-one-0123456789';
const OWNER = 'g-owner', FRIEND = 'g-friend', WAITING = 'g-waiting';
const cookieFor = (uid) => `${AUTH.COOKIE}=${encodeURIComponent(AUTH.sign(uid, SECRET))}`;

// Defaults to the owner. Pass `as` to speak as somebody else, or null to be
// signed out.
function api(method, p, body, as = OWNER) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (as) headers.cookie = cookieFor(as);
  return fetch(BASE + p, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

// The three people every assertion below runs against.
function seedUsers(storeFile, cfgFile) {
  const person = (id, email, extra) => ({
    id, email, name: email.split('@')[0], picture: null,
    status: 'active', owner: false, createdAt: 1, lastSeen: 1, ...extra,
  });
  fs.writeFileSync(storeFile, JSON.stringify({
    users: {
      [OWNER]: person(OWNER, 'owner@example.com', { owner: true }),
      [FRIEND]: person(FRIEND, 'friend@example.com'),
      [WAITING]: person(WAITING, 'waiting@example.com', { status: 'pending' }),
    },
    data: {}, legacy: null, seq: 1,
  }));
  fs.writeFileSync(cfgFile, JSON.stringify({ sessionSecret: SECRET }), { mode: 0o600 });
}

async function waitUp(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Not /api/state — that is 401 without a session now, which is the point.
    try { const r = await fetch(BASE + '/api/auth/me'); if (r.ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

async function server() {
  console.log('\nserver / api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-test-'));
  const dataFile = path.join(dir, 'store.json');
  const cfgFile = path.join(dir, 'config.json');
  seedUsers(dataFile, cfgFile);

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, CONFIG_FILE: cfgFile, NO_PUSH: '1' },
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

  await t('a fresh store seeds a catalogue and one plan holding all of it', async () => {
    const { body } = await api('GET', '/api/state');
    assert.strictEqual(body.exercises.length, 6, 'the catalogue is seeded');
    assert.strictEqual(body.plans.length, 1, 'and one plan to start from');
    const p = body.plans[0];
    assert.strictEqual(body.activePlanId, p.id);
    // `optional` is gone as a concept — a machine is in a plan or it isn't, and
    // taking one out is now a tap rather than a hardcoded flag.
    assert.strictEqual(p.exerciseIds.length, 6, 'all six are in the starter plan');
    assert.strictEqual(body.planned.length, 6);
    assert.strictEqual(body.planned[0].id, 'leg-press');
    assert.strictEqual(body.planned[0].weight, 140);
    assert.strictEqual(body.planned[0].sets.length, 3, 'one blank per set in the rules');
    assert.deepStrictEqual(body.rules,
      { sets: 3, minReps: 8, maxReps: 12, repStep: 2, restSec: 90, weightStep: 5 },
      'wire.rules is the ACTIVE plan\'s ladder, under the name the session screen uses');
    assert.strictEqual(p.rulesLabel, '3 sets · 8 → 10 → 12 reps, then heavier');
  });

  await t('taking a machine out of a plan takes it out of the prescription', async () => {
    const { body: st } = await api('GET', '/api/state');
    const p = st.plans[0];
    const without = p.exerciseIds.filter(x => x !== 'leg-curl');
    const { body: a } = await api('PATCH', `/api/plan/${p.id}`, { exerciseIds: without });
    assert.strictEqual(a.state.planned.length, 5);
    assert.ok(!a.state.planned.some(x => x.id === 'leg-curl'));
    // Back in, at the end — order is the order you perform them.
    const { body: b } = await api('PATCH', `/api/plan/${p.id}`,
      { exerciseIds: [...without, 'leg-curl'] });
    assert.strictEqual(b.state.planned.length, 6);
    assert.strictEqual(b.state.planned[5].id, 'leg-curl');
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

  /* ── plans over HTTP ─────────────────────────────────────────────────── */

  await t('a second plan copies the first rather than starting empty', async () => {
    const { body: st } = await api('GET', '/api/state');
    const { body } = await api('POST', '/api/plan', { copyOf: st.plans[0].id });
    assert.strictEqual(body.plan.name, 'Workout B', 'named for you');
    assert.deepStrictEqual(body.plan.exerciseIds, st.plans[0].exerciseIds,
      '"B" is nearly always "A but different"');
    assert.strictEqual(body.state.activePlanId, st.plans[0].id,
      'creating a plan must not yank you out of the one you are mid-programme on');
  });

  await t('a copied plan starts at the weights you are actually lifting', async () => {
    const { body: st } = await api('GET', '/api/state');
    const [a, b] = st.plans;
    const aLeg = st.progress['leg-press'].weight;
    await api('POST', '/api/plan/active', { id: b.id });
    const { body: bst } = await api('GET', '/api/state');
    assert.strictEqual(bst.progress['leg-press'].weight, aLeg,
      'not back at the seed weight from whenever the app was set up');
    await api('POST', '/api/plan/active', { id: a.id });
  });

  await t('the same machine then progresses independently in each plan', async () => {
    const { body: st } = await api('GET', '/api/state');
    const [a, b] = st.plans;
    const aBefore = st.progress['leg-press'];
    // Finish a session on B, and check A did not move with it.
    await api('POST', '/api/plan/active', { id: b.id });
    const { body: bst } = await api('GET', '/api/state');
    await api('POST', '/api/workout', {
      id: 'w-planb', planId: b.id, done: true,
      entries: bst.planned.map(p => ({ ...p, target: 12, sets: [12, 12, 12] })),
    });
    const { body: bAfter } = await api('GET', '/api/state');
    const bLeg = bAfter.progress['leg-press'];
    await api('POST', '/api/plan/active', { id: a.id });
    const { body: aAfter } = await api('GET', '/api/state');
    assert.deepStrictEqual(aAfter.progress['leg-press'], aBefore,
      'a session on B must not touch A — that is the whole reason they are keyed apart');
    assert.strictEqual(bLeg.weight, aBefore.weight + 20, 'B climbed by the leg press step');
  });

  await t('a plan can be given a 5x5 ladder and the prescription follows', async () => {
    const { body: st } = await api('GET', '/api/state');
    const b = st.plans[1];
    const { body } = await api('PATCH', `/api/plan/${b.id}`, {
      rules: { sets: 5, minReps: 5, maxReps: 5, repStep: 1 },
    });
    assert.strictEqual(body.plan.rules.sets, 5);
    assert.strictEqual(body.plan.rulesLabel, '5 sets · 5 reps, then heavier');
    await api('POST', '/api/plan/active', { id: b.id });
    const { body: act } = await api('GET', '/api/state');
    assert.strictEqual(act.planned[0].sets.length, 5, 'five blanks, not three');
    assert.strictEqual(act.rules.minReps, 5);
    await api('POST', '/api/plan/active', { id: st.plans[0].id });
  });

  await t('a plan gate rejects what would make it unusable', async () => {
    const { body: st } = await api('GET', '/api/state');
    const id = st.plans[0].id;
    const { status } = await api('PATCH', `/api/plan/${id}`, { name: '   ' });
    assert.strictEqual(status, 400, 'a plan must have a name');
    const { body } = await api('PATCH', `/api/plan/${id}`, { rules: { repStep: 0 } });
    assert.ok(body.plan.rules.repStep >= 1, 'a zero rep step is clamped, not stored');
    const { body: g } = await api('PATCH', `/api/plan/${id}`, { exerciseIds: ['ghost'] });
    assert.deepStrictEqual(g.plan.exerciseIds, [], 'unknown ids dropped');
    // Put it back, or every later assertion is against an empty plan.
    await api('PATCH', `/api/plan/${id}`, { exerciseIds: st.plans[0].exerciseIds });
  });

  await t('the last plan cannot be deleted', async () => {
    const { body: st } = await api('GET', '/api/state');
    for (const p of st.plans.slice(1)) await api('DELETE', `/api/plan/${p.id}`);
    const { body: one } = await api('GET', '/api/state');
    assert.strictEqual(one.plans.length, 1);
    const { status } = await api('DELETE', `/api/plan/${one.plans[0].id}`);
    assert.strictEqual(status, 400, 'there has to be something to lift');
  });

  await t('a new machine joins the catalogue and the plan you added it from', async () => {
    const { body: st } = await api('GET', '/api/state');
    const id = st.plans[0].id;
    const { body } = await api('POST', '/api/exercise', {
      name: 'Hack Squat', step: 25, weight: 90, planId: id,
    });
    assert.strictEqual(body.exercise.step, 25);
    const p = body.state.plans.find(x => x.id === id);
    assert.ok(p.exerciseIds.includes(body.exercise.id), 'added where you added it from');
    assert.strictEqual(body.state.planned[body.state.planned.length - 1].weight, 90,
      'and it comes into the prescription at its own starting weight');
  });

  await t('deleting a machine pulls it from every plan but keeps the history', async () => {
    const { body: st } = await api('GET', '/api/state');
    const hack = st.exercises.find(e => e.name === 'Hack Squat');
    const loggedBefore = st.workouts.length;
    const { body } = await api('DELETE', `/api/exercise/${hack.id}`);
    assert.ok(!body.exercises.some(e => e.id === hack.id));
    assert.ok(!body.plans.some(p => p.exerciseIds.includes(hack.id)),
      'a plan holding a dangling id is how `planned` ships undefined weights');
    assert.strictEqual(body.workouts.length, loggedBefore,
      'history is what happened — deleting a machine today must not rewrite it');
  });

  /* ── reminders ───────────────────────────────────────────────────────── */

  await t('the wire ships a push key so a device can subscribe', async () => {
    const { body } = await api('GET', '/api/state');
    assert.ok(body.push.key && body.push.key.length > 20, 'a VAPID public key');
    assert.strictEqual(body.push.subscribed, false, 'nothing has subscribed yet');
  });

  await t('a subscription is validated, stored once per device, and removable', async () => {
    const sub = {
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: 'x'.repeat(80), auth: 'y'.repeat(20) },
    };
    assert.strictEqual((await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'nope' } })).status,
      400, 'a bad subscription is refused rather than stored');
    const { body } = await api('POST', '/api/push/subscribe', { subscription: sub });
    assert.strictEqual(body.push.subscribed, true);
    // Re-subscribing the same device must not stack up duplicate notifications.
    await api('POST', '/api/push/subscribe', { subscription: sub });
    const { body: st } = await api('GET', '/api/state');
    assert.strictEqual(st.push.subscribed, true);
    const { body: gone } = await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    assert.strictEqual(gone.push.subscribed, false);
  });

  /* ── auth ────────────────────────────────────────────────────────────────
     The boundary. Everything else in this suite is a feature; this is the part
     that decides whether handing the URL to a friend is safe. */

  await t('signed out, the whole data surface is 401', async () => {
    for (const [m, p, b] of [
      ['GET', '/api/state'], ['POST', '/api/workout', { entries: [] }],
      ['POST', '/api/plan', {}], ['PATCH', '/api/plan/p1', {}], ['DELETE', '/api/plan/p1'],
      ['POST', '/api/exercise', { name: 'x' }], ['PATCH', '/api/exercise/e1', {}],
      ['DELETE', '/api/exercise/e1'], ['POST', '/api/adjust', {}],
      ['POST', '/api/settings', {}], ['POST', '/api/push/subscribe', {}],
      ['POST', '/api/plan/active', {}], ['GET', '/api/admin/users'],
    ]) {
      const { status } = await api(m, p, b, null);
      assert.strictEqual(status, 401, `${m} ${p} must not answer a stranger`);
    }
  });

  await t('a forged or tampered cookie is not a session', async () => {
    const real = AUTH.sign(OWNER, SECRET);
    const bad = [
      'nonsense',
      real.slice(0, -1) + (real.slice(-1) === 'a' ? 'b' : 'a'),   // flipped signature
      AUTH.sign(OWNER, 'a-different-secret-entirely-0123456789'), // signed by someone else
      `${Buffer.from(JSON.stringify({ u: OWNER, e: Date.now() + 1e9 })).toString('base64url')}.`,
    ];
    for (const token of bad) {
      const r = await fetch(BASE + '/api/state', { headers: { cookie: `${AUTH.COOKIE}=${token}` } });
      assert.strictEqual(r.status, 401, `accepted a bad cookie: ${token.slice(0, 24)}`);
    }
  });

  await t('an expired session is refused even though it is correctly signed', () => {
    const past = AUTH.sign(OWNER, SECRET, Date.now() - (AUTH.MAX_AGE_DAYS + 1) * 86400000);
    assert.strictEqual(AUTH.verify(past, SECRET), null);
    assert.strictEqual(AUTH.verify(AUTH.sign(OWNER, SECRET), SECRET), OWNER, 'a fresh one still works');
  });

  await t('a pending user gets nothing but their own status', async () => {
    const { status } = await api('GET', '/api/state', null, WAITING);
    assert.strictEqual(status, 401, 'waiting is not the same as being in');
    const r = await fetch(BASE + '/api/auth/me', { headers: { cookie: cookieFor(WAITING) } });
    const b = await r.json();
    assert.strictEqual(b.status, 'pending', 'but they can see that they are waiting');
    assert.strictEqual(b.me.email, 'waiting@example.com');
  });

  await t('two people cannot see each other\'s programs', async () => {
    // Give each of them something distinctive.
    await api('POST', '/api/exercise', { name: 'OWNER SECRET MACHINE' }, OWNER);
    await api('POST', '/api/exercise', { name: 'FRIEND SECRET MACHINE' }, FRIEND);

    const { body: mine } = await api('GET', '/api/state', null, OWNER);
    const { body: theirs } = await api('GET', '/api/state', null, FRIEND);

    const names = (w) => w.exercises.map(e => e.name).join('|');
    assert.ok(/OWNER SECRET/.test(names(mine)) && !/FRIEND SECRET/.test(names(mine)),
      'the owner must not see the friend\'s catalogue');
    assert.ok(/FRIEND SECRET/.test(names(theirs)) && !/OWNER SECRET/.test(names(theirs)),
      'and the friend must not see the owner\'s');
    // Separate plans, separate workouts, separate ids.
    assert.notStrictEqual(mine.plans[0].id, theirs.plans[0].id);
    assert.notDeepStrictEqual(mine.workouts, theirs.workouts);
  });

  await t('one person cannot touch another person\'s plan by id', async () => {
    const { body: mine } = await api('GET', '/api/state', null, OWNER);
    const target = mine.plans[0].id;
    // The friend knows the id and asks for it directly — the resolution happens in
    // THEIR slice, so it simply isn't there.
    const patch = await api('PATCH', `/api/plan/${target}`, { name: 'PWNED' }, FRIEND);
    assert.strictEqual(patch.status, 404, 'no cross-user write');
    const del = await api('DELETE', `/api/plan/${target}`, null, FRIEND);
    assert.ok(del.status === 404 || del.status === 400, 'no cross-user delete');
    const act = await api('POST', '/api/plan/active', { id: target }, FRIEND);
    assert.strictEqual(act.status, 404, 'and it cannot be made active either');

    const { body: after } = await api('GET', '/api/state', null, OWNER);
    assert.notStrictEqual(after.plans[0].name, 'PWNED', 'the owner\'s plan is untouched');
  });

  await t('a workout posted by one person never lands in another\'s log', async () => {
    const { body: f } = await api('GET', '/api/state', null, FRIEND);
    const before = (await api('GET', '/api/state', null, OWNER)).body.workouts.length;
    await api('POST', '/api/workout', {
      id: 'w-friend-only', planId: f.plans[0].id, done: true,
      entries: f.planned.map(p => ({ ...p, sets: [8, 8, 8] })),
    }, FRIEND);
    const { body: mine } = await api('GET', '/api/state', null, OWNER);
    assert.strictEqual(mine.workouts.length, before, 'the owner\'s log did not grow');
    assert.ok(!mine.workouts.some(w => w.id === 'w-friend-only'));
    // And the friend's own progression did advance, so this is isolation and not
    // the write silently failing.
    const { body: f2 } = await api('GET', '/api/state', null, FRIEND);
    assert.ok(f2.workouts.some(w => w.id === 'w-friend-only'));
  });

  await t('a friend\'s push subscription is not on the owner\'s devices', async () => {
    const sub = {
      endpoint: 'https://push.example.com/friend-device',
      keys: { p256dh: 'x'.repeat(80), auth: 'y'.repeat(20) },
    };
    await api('POST', '/api/push/subscribe', { subscription: sub }, FRIEND);
    const { body: mine } = await api('GET', '/api/state', null, OWNER);
    const { body: theirs } = await api('GET', '/api/state', null, FRIEND);
    assert.strictEqual(theirs.push.subscribed, true);
    assert.strictEqual(mine.push.subscribed, false, 'a reminder must not fan out to everybody');
  });

  await t('only the owner sees who is waiting, or decides', async () => {
    const { body: mine } = await api('GET', '/api/state', null, OWNER);
    assert.ok(mine.pending.some(u => u.email === 'waiting@example.com'),
      'the owner is shown the queue');
    const { body: theirs } = await api('GET', '/api/state', null, FRIEND);
    assert.deepStrictEqual(theirs.pending, [], 'nobody else is even told there is one');

    assert.strictEqual((await api('GET', '/api/admin/users', null, FRIEND)).status, 403);
    assert.strictEqual((await api('POST', `/api/admin/user/${WAITING}`, { status: 'active' }, FRIEND)).status,
      403, 'a friend cannot let their own friends in');
  });

  await t('approving somebody gives them a program of their own', async () => {
    assert.strictEqual((await api('GET', '/api/state', null, WAITING)).status, 401);
    const { status } = await api('POST', `/api/admin/user/${WAITING}`, { status: 'active' }, OWNER);
    assert.strictEqual(status, 200);
    const { body } = await api('GET', '/api/state', null, WAITING);
    assert.strictEqual(body.plans.length, 1, 'a fresh starter plan');
    assert.strictEqual(body.exercises.length, 6, 'and the seeded catalogue');
    assert.strictEqual(body.workouts.length, 0, 'and nobody else\'s history');
    assert.strictEqual(body.me.owner, false);
  });

  await t('the owner cannot lock themselves out, and bad statuses are refused', async () => {
    assert.strictEqual((await api('POST', `/api/admin/user/${OWNER}`, { status: 'denied' })).status,
      400, 'there would be nobody left to approve anyone');
    assert.strictEqual((await api('POST', `/api/admin/user/${WAITING}`, { status: 'wat' })).status, 400);
    assert.strictEqual((await api('POST', '/api/admin/user/nobody', { status: 'active' })).status, 404);
  });

  await t('denying somebody keeps their history for if you change your mind', async () => {
    await api('POST', `/api/admin/user/${WAITING}`, { status: 'denied' }, OWNER);
    assert.strictEqual((await api('GET', '/api/state', null, WAITING)).status, 401, 'shut out');
    await api('POST', `/api/admin/user/${WAITING}`, { status: 'active' }, OWNER);
    const { status } = await api('GET', '/api/state', null, WAITING);
    assert.strictEqual(status, 200, 'and let back in without starting over');
  });

  await t('the owner adopts the pre-accounts program; nobody else can', async () => {
    // A store written before accounts existed, with a distinctive machine in it.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-legacy-'));
    const f2 = path.join(dir2, 'store.json');
    const c2 = path.join(dir2, 'config.json');
    seedUsers(f2, c2);
    const seeded = JSON.parse(fs.readFileSync(f2, 'utf8'));
    seeded.legacy = {
      exercises: [{ id: 'legacy-machine', name: 'LEGACY MACHINE', short: null, step: 10, weight: 100 }],
      plans: [{
        id: 'legacy-plan', name: 'From before accounts', exerciseIds: ['legacy-machine'],
        rules: { sets: 3, minReps: 8, maxReps: 12, repStep: 2, restSec: 90 },
        schedule: { mode: 'off', days: [], everyN: 2, at: '18:00', anchor: null }, archived: false,
      }],
      activePlanId: 'legacy-plan',
      progress: { 'legacy-plan': { 'legacy-machine': { weight: 175, target: 10 } } },
      workouts: [{ id: 'w-old', planId: 'legacy-plan', date: '2026-08-01', done: true, applied: true, entries: [] }],
      push: { subs: [], sent: {}, tried: {} }, settings: {},
    };
    fs.writeFileSync(f2, JSON.stringify(seeded));

    const port2 = PORT + 3;
    const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port2), DATA_FILE: f2, CONFIG_FILE: c2, NO_PUSH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base2 = `http://127.0.0.1:${port2}`;
    const get = (as) => fetch(base2 + '/api/state', { headers: { cookie: cookieFor(as) } })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base2 + '/api/auth/me')).ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 150));
    }

    // The friend goes first, on purpose: a race must not hand them the data.
    const friend = await get(FRIEND);
    assert.strictEqual(friend.status, 200);
    assert.ok(!friend.body.exercises.some(e => e.name === 'LEGACY MACHINE'),
      'only the owner inherits what was there before accounts');
    assert.strictEqual(friend.body.workouts.length, 0);

    const owner = await get(OWNER);
    assert.ok(owner.body.exercises.some(e => e.name === 'LEGACY MACHINE'), 'the owner gets it');
    assert.strictEqual(owner.body.plans[0].name, 'From before accounts');
    assert.strictEqual(owner.body.planned[0].weight, 175, 'at the weight they left off at');
    assert.strictEqual(owner.body.workouts.length, 1, 'with their history');

    // Adopted exactly once — a second request must not re-adopt or wipe. Posted
    // to THIS server, not the suite's main one.
    await fetch(base2 + '/api/exercise', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieFor(OWNER) },
      body: JSON.stringify({ name: 'AFTER ADOPTION' }),
    });
    const again = await get(OWNER);
    assert.ok(again.body.exercises.some(e => e.name === 'LEGACY MACHINE'));
    assert.ok(again.body.exercises.some(e => e.name === 'AFTER ADOPTION'));

    child2.kill('SIGTERM');
    await new Promise(r => child2.on('exit', r));
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
  });

  await t('signing out clears the cookie', async () => {
    const r = await fetch(BASE + '/api/auth/signout', {
      method: 'POST', headers: { cookie: cookieFor(OWNER) },
    });
    assert.ok(/Max-Age=0/.test(r.headers.get('set-cookie') || ''), 'the cookie is expired, not just forgotten');
  });

  await t('data survives a restart', async () => {
    const { body: before } = await api('GET', '/api/state');
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, CONFIG_FILE: cfgFile, NO_PUSH: '1' },
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
  await scheduleRules();
  await planRules();
  await reminderSender();
  await calendarGrid();
  await server();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
})().catch((e) => {
  console.error(e);
  if (child) child.kill('SIGKILL');
  process.exit(1);
});
