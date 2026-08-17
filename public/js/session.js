// The live workout: one exercise at a time, 3 sets, 90s rest.
import { S, LS, saveLocal, loadLocal } from './state.js';
import { $, esc, mmss, todayStr, toast, showScreen, buzz } from './util.js';
import { newWorkoutId, saveWorkout } from './sync.js';
import { exName, exStep, planRules } from './home.js';
import { primeAudio, scheduleAlarm, cancelAlarm, notify } from './alarm.js';

const RING_C = 339.29; // 2πr for r=54

let onFinish = () => {};

/* ── lifecycle ─────────────────────────────────────────────────────────── */

export function restoreSession() {
  const s = loadLocal(LS.session, null);
  // Drop a stale session left open from a previous day.
  if (s && s.date === todayStr() && Array.isArray(s.entries) && s.entries.length) {
    S.session = s;
  } else if (s) {
    saveLocal(LS.session, null);
  }
}

function persist() { saveLocal(LS.session, S.session); }

function snapshot(done = false) {
  const s = S.session;
  return {
    id: s.id,
    planId: s.planId,
    date: s.date,
    startedAt: s.startedAt,
    entries: s.entries.map(e => ({
      id: e.id, weight: e.weight, target: e.target, sets: e.sets, skipped: e.skipped,
    })),
    done,
    finishedAt: done ? Date.now() : null,
  };
}

export function startSession() {
  primeAudio();
  if (!S.session) {
    // `planned` already arrives with the right number of empty sets for this
    // plan's rules — don't overwrite it with three.
    const planned = (S.wire?.planned || []).map(p => ({ ...p, sets: p.sets.map(() => null) }));
    if (!planned.length) return toast('Nothing in this workout yet');
    S.session = {
      id: newWorkoutId(),
      // Pinned at the start, not read at save time: you can switch plans while a
      // session is open, and an offline replay can land days later.
      planId: S.wire.activePlanId,
      date: todayStr(),
      startedAt: Date.now(),
      entries: planned,
      exIdx: 0,
      reps: planned[0].target,
    };
    persist();
  }
  requestWakeLock();
  startElapsed();
  showScreen('scr-session');
  renderSession();
}

export function endSessionUI() {
  stopRest();
  stopElapsed();
  releaseWakeLock();
}

/* ── wake lock (keep the screen on between sets) ───────────────────────── */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen');
  } catch (_) {}
}
function releaseWakeLock() {
  try { S.wakeLock && S.wakeLock.release(); } catch (_) {}
  S.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.session && $('scr-session').classList.contains('active')) requestWakeLock();
});

/* ── elapsed clock ─────────────────────────────────────────────────────── */

function startElapsed() {
  stopElapsed();
  const tick = () => {
    if (!S.session) return;
    $('elapsed').textContent = mmss((Date.now() - S.session.startedAt) / 1000);
  };
  tick();
  S.tickTimer = setInterval(tick, 1000);
}
function stopElapsed() { clearInterval(S.tickTimer); S.tickTimer = null; }

/* ── where you are ─────────────────────────────────────────────────────
   The current machine is an index into `entries`; WHICH SET you're on is
   derived from what that machine has logged. Keeping a session-level
   `setIdx` was fine while the order was fixed, but the moment you can walk
   away from a half-finished machine and come back it is a bug — the set
   you're up to belongs to the exercise, not to the session. Derive it and
   coming back is correct by construction. */

function cur() { return S.session.entries[S.session.exIdx]; }

// The set to log next, or -1 when this machine is finished with.
const nextSet = (e) => e.sets.findIndex(v => v === null);
const spent = (e) => e.skipped || nextSet(e) === -1;
const allSpent = () => S.session.entries.every(spent);

// The next machine that still has work, from `from` onwards, WRAPPING. The wrap
// is what makes "come back later" need no extra state: once everything after
// you is done it walks round to the one you left behind.
function nextIdx(from) {
  const en = S.session.entries, n = en.length;
  for (let k = 0; k < n; k++) {
    const i = (((from + k) % n) + n) % n;
    if (!spent(en[i])) return i;
  }
  return -1;
}

function goTo(i) {
  const s = S.session;
  if (i < 0 || i >= s.entries.length) return;
  s.exIdx = i;
  s.reps = cur().target;
  persist();
  renderSession();
}

/* ── render ────────────────────────────────────────────────────────────── */

export function renderSession() {
  const s = S.session;
  if (!s) return;
  const e = cur();
  if (!e) return finishSession();

  const set = nextSet(e);
  const done = spent(e);

  $('exName').textContent = exName(e.id);
  $('exSub').textContent = e.skipped ? 'Skipped'
    : set === -1 ? `All ${e.sets.length} sets logged`
    : `Set ${set + 1} of ${e.sets.length} · target ${e.target} reps`;
  $('exWeight').textContent = e.weight;

  // Each dot's state comes from its own ENTRY, never from its position. Once the
  // order can change and you can jump backwards, "everything left of the cursor
  // is finished" stops being true — and a half-done machine deserves to look
  // different from an untouched one, since that is the one you have to return to.
  $('exDots').innerHTML = s.entries.map((en, i) => {
    const logged = en.sets.filter(v => v !== null).length;
    const cls = i === s.exIdx ? 'cur'
      : en.skipped ? 'skip'
      : logged === 3 ? 'done'
      : logged > 0 ? 'part' : '';
    return `<button class="dotbtn" data-jump="${i}"
      aria-label="${esc(exName(en.id))}"><i class="${cls}"></i></button>`;
  }).join('');
  // Tapping a dot is "go back to that one, now" — the other half of being able
  // to walk away from an occupied machine.
  $('exDots').querySelectorAll('[data-jump]').forEach(b => {
    b.addEventListener('click', () => goTo(Number(b.dataset.jump)));
  });

  $('setRows').innerHTML = e.sets.map((v, i) => {
    const state = v === null ? (i === set ? 'cur' : '')
      : v >= e.target ? 'hit' : 'miss';
    return `<div class="set-row ${state}">
      <span>Set ${i + 1}</span>
      <b class="${v === null ? 'empty' : ''}">${v === null ? '–' : v}</b>
    </div>`;
  }).join('');

  // Nothing left to log here: the pad has no job, and the button becomes the way
  // on rather than a control that would silently do nothing.
  $('repPad').classList.toggle('spent', done);
  $('btnLogSet').textContent = done ? 'Next machine' : 'Log set';
  $('btnBusy').hidden = done;
  $('btnSkipEx').hidden = done;
  // A skipped machine used to be a dead end you could jump to and not get out
  // of. The undo sits exactly where the skip button was, which is where the
  // thumb that just mis-tapped is already heading.
  $('btnUnskip').hidden = !e.skipped;

  const r = s.reps ?? e.target;
  $('repVal').textContent = r;
  // The chips span this plan's own rep range, capped at six so they stay
  // thumb-sized — a 5-to-20 plan gets a stepper, not forty chips.
  const { minReps, maxReps } = planRules();
  const span = [];
  for (let n = minReps; n <= maxReps && span.length < 6; n++) span.push(n);
  if (span[span.length - 1] !== maxReps) span[span.length - 1] = maxReps;
  $('repChips').innerHTML = span
    .map(n => `<button data-r="${n}" class="${n === r ? 'on' : ''}">${n}</button>`).join('');
  $('repChips').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => setReps(Number(b.dataset.r)));
  });
}

function setReps(n) {
  S.session.reps = Math.max(0, Math.min(planRules().maxReps, n));
  persist();
  $('repVal').textContent = S.session.reps;
  $('repVal').classList.remove('pop'); void $('repVal').offsetWidth; $('repVal').classList.add('pop');
  $('repChips').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', Number(b.dataset.r) === S.session.reps);
  });
}

/* ── logging a set ─────────────────────────────────────────────────────── */

function logSet() {
  const s = S.session;
  const e = cur();
  const set = nextSet(e);
  // Standing on a machine that's already finished — the button says "Next
  // machine" and this is what it does.
  if (set === -1 || e.skipped) {
    if (allSpent()) return finishSession();
    return goTo(nextIdx(s.exIdx + 1));
  }

  e.sets[set] = s.reps ?? e.target;
  persist();
  saveWorkout(snapshot(false)); // fire-and-forget; queued if offline

  // The workout ends when every machine is spent, not when you reach the end of
  // the list — after a reorder those are different things.
  if (allSpent()) return finishSession();

  // Hold the next ENTRY, not its index: the list can be reordered while you rest
  // and an index would then point at whatever moved into that slot.
  const moveOn = spent(e) ? s.entries[nextIdx(s.exIdx + 1)] : null;

  // Show the completed set state, then rest.
  renderSession();
  const nextLabel = moveOn
    ? `Next: <b>${esc(exName(moveOn.id))}</b>`
    : `Next: <b>Set ${set + 2} of ${e.sets.length}</b>`;
  // The same thing again without markup, for the notification body.
  const nextPlain = moveOn
    ? `Next up: ${exName(moveOn.id)}`
    : `Set ${set + 2} of ${e.sets.length} · ${e.weight} lb`;
  startRest(nextLabel, () => {
    if (moveOn) goTo(s.entries.indexOf(moveOn));
    else { s.reps = e.target; persist(); renderSession(); }
  }, undefined, nextPlain);
}

// Occupied. Send this machine to the back of the queue and carry on with the
// next one — it keeps whatever sets are already logged against it, so coming
// back picks up exactly where you left off. Deliberately NOT `skipped`: skipping
// says "not doing this today" and forfeits the progression.
function busyExercise() {
  const s = S.session;
  const e = cur();
  const target = nextIdx(s.exIdx + 1);
  if (target === -1 || target === s.exIdx) {
    return toast('Nothing else left — this is the last machine');
  }
  const moveOn = s.entries[target];
  s.entries.splice(s.exIdx, 1);
  s.entries.push(e);
  goTo(s.entries.indexOf(moveOn));
  // The reorder is part of the snapshot, so a phone that dies mid-workout comes
  // back with the same queue.
  saveWorkout(snapshot(false));
  toast(`${exName(e.id)} moved to the end — come back to it`);
}

// Hit Skip by mistake. Hand the machine back with nothing logged — you're
// standing at it, so you're about to do set 1.
function unskipExercise() {
  const e = cur();
  if (!e.skipped) return;
  e.skipped = false;
  e.sets = e.sets.map(() => null);
  S.session.reps = e.target;
  persist();
  saveWorkout(snapshot(false));
  renderSession();
}

function skipExercise() {
  const s = S.session;
  const e = cur();
  e.skipped = true;
  e.sets = e.sets.map(() => null);
  persist();
  saveWorkout(snapshot(false));
  if (allSpent()) return finishSession();
  goTo(nextIdx(s.exIdx));
}

async function finishSession() {
  stopRest();
  const snap = snapshot(true);
  const s = S.session;
  S.session = null;
  saveLocal(LS.session, null);
  endSessionUI();

  const res = await saveWorkout(snap);
  S.lastOutcomes = res.outcomes || [];
  onFinish(snap, res.synced, s);
}

/* ── rest timer ────────────────────────────────────────────────────────── */

function startRest(nextLabel, done, durationSec, plainLabel) {
  const total = durationSec || S.wire?.rules?.restSec || 90;
  const deadline = Date.now() + total * 1000;
  const pane = $('restPane');
  const ring = $('ringFg');
  let fired = false;

  $('restNext').innerHTML = nextLabel;
  pane.hidden = false;
  pane.classList.remove('flash');

  // Queue the alert on the audio thread NOW, not when the countdown reaches
  // zero. By then this interval may not have run for a minute — on iOS it will
  // not have run at all, because a backgrounded PWA is frozen outright.
  scheduleAlarm(total);

  const paint = () => {
    const left = Math.max(0, (deadline - Date.now()) / 1000);
    $('restNum').textContent = Math.ceil(left);
    ring.style.strokeDashoffset = String(RING_C * (1 - left / total));
    if (left <= 5) pane.classList.add('flash');
    if (left <= 0 && !fired) {
      fired = true;
      // No beep here — the alarm was scheduled up front and has already
      // sounded. Beeping again would fire late, on whichever tick happens to
      // run after you unlock the phone.
      buzz([120, 80, 120]);
      notify('Rest over', plainLabel || 'Back to it');
      stopRest();
      done();
    }
  };
  paint();
  S.restTimer = setInterval(paint, 250);

  S.restSkip = () => { stopRest(); done(); };
  // +30s: restart the countdown from whatever is left, plus 30.
  S.restExtend = () => {
    const left = Math.max(0, (deadline - Date.now()) / 1000);
    stopRest();
    startRest(nextLabel, done, Math.round(left) + 30, plainLabel);
  };
}

function stopRest() {
  clearInterval(S.restTimer);
  S.restTimer = null;
  // Skipping or extending has to unschedule the tone, or it goes off in the
  // middle of the next set. The banner is NOT dismissed here: this runs
  // immediately after raising it, and would race its own notification away.
  // alarm.js clears it when you come back to the app instead.
  cancelAlarm();
  const pane = $('restPane');
  if (pane) { pane.hidden = true; pane.classList.remove('flash'); }
}

/* ── wiring ────────────────────────────────────────────────────────────── */

export function initSession(finishCb, quitCb) {
  onFinish = finishCb;

  $('btnLogSet').addEventListener('click', logSet);
  $('btnBusy').addEventListener('click', busyExercise);
  $('btnSkipEx').addEventListener('click', skipExercise);
  $('btnUnskip').addEventListener('click', unskipExercise);
  $('rUp').addEventListener('click', () => setReps((S.session?.reps ?? 8) + 1));
  $('rDown').addEventListener('click', () => setReps((S.session?.reps ?? 8) - 1));

  // One notch is whatever this machine's stack supports — 20 on the leg press,
  // 5 on the overhead press.
  $('wUp').addEventListener('click', () => bumpWeight(1));
  $('wDown').addEventListener('click', () => bumpWeight(-1));

  $('btnSkipRest').addEventListener('click', () => S.restSkip && S.restSkip());
  $('btnAddRest').addEventListener('click', () => S.restExtend && S.restExtend());

  $('btnQuit').addEventListener('click', quitCb);
}

function bumpWeight(notches) {
  const s = S.session;
  if (!s) return;
  const e = cur();
  e.weight = Math.max(0, e.weight + notches * exStep(e.id));
  persist();
  $('exWeight').textContent = e.weight;
  $('exWeight').parentElement.classList.remove('pop');
  void $('exWeight').offsetWidth;
  $('exWeight').parentElement.classList.add('pop');
}
