// The live workout: one exercise at a time, 3 sets, 90s rest.
import { S, LS, saveLocal, loadLocal } from './state.js';
import { $, esc, mmss, todayStr, toast, showScreen, buzz } from './util.js';
import { newWorkoutId, saveWorkout } from './sync.js';
import { exName } from './home.js';
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
    const planned = (S.wire?.planned || []).map(p => ({ ...p, sets: [null, null, null] }));
    if (!planned.length) return toast('Nothing to lift');
    S.session = {
      id: newWorkoutId(),
      date: todayStr(),
      startedAt: Date.now(),
      entries: planned,
      exIdx: 0,
      setIdx: 0,
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

/* ── render ────────────────────────────────────────────────────────────── */

function cur() { return S.session.entries[S.session.exIdx]; }

export function renderSession() {
  const s = S.session;
  if (!s) return;
  const e = cur();
  if (!e) return finishSession();

  $('exName').textContent = exName(e.id);
  $('exSub').textContent = `Set ${s.setIdx + 1} of 3 · target ${e.target} reps`;
  $('exWeight').textContent = e.weight;

  $('exDots').innerHTML = s.entries.map((en, i) => {
    const cls = en.skipped ? 'skip'
      : i < s.exIdx ? 'done'
      : i === s.exIdx ? 'cur' : '';
    return `<i class="${cls}"></i>`;
  }).join('');

  $('setRows').innerHTML = e.sets.map((v, i) => {
    const state = v === null ? (i === s.setIdx ? 'cur' : '')
      : v >= e.target ? 'hit' : 'miss';
    return `<div class="set-row ${state}">
      <span>Set ${i + 1}</span>
      <b class="${v === null ? 'empty' : ''}">${v === null ? '–' : v}</b>
    </div>`;
  }).join('');

  const r = s.reps ?? e.target;
  $('repVal').textContent = r;
  $('repChips').innerHTML = [8, 9, 10, 11, 12]
    .map(n => `<button data-r="${n}" class="${n === r ? 'on' : ''}">${n}</button>`).join('');
  $('repChips').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => setReps(Number(b.dataset.r)));
  });
}

function setReps(n) {
  S.session.reps = Math.max(0, Math.min(12, n));
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
  e.sets[s.setIdx] = s.reps ?? e.target;
  persist();
  saveWorkout(snapshot(false)); // fire-and-forget; queued if offline

  const lastSetOfEx = s.setIdx >= 2;
  const lastEx = s.exIdx >= s.entries.length - 1;

  if (lastSetOfEx && lastEx) return finishSession();

  // Show the completed set state, then rest.
  renderSession();
  const nextLabel = lastSetOfEx
    ? `Next: <b>${esc(exName(s.entries[s.exIdx + 1].id))}</b>`
    : `Next: <b>Set ${s.setIdx + 2} of 3</b>`;
  // The same thing again without markup, for the notification body.
  const nextPlain = lastSetOfEx
    ? `Next up: ${exName(s.entries[s.exIdx + 1].id)}`
    : `Set ${s.setIdx + 2} of 3 · ${e.weight} lb`;
  startRest(nextLabel, () => {
    if (lastSetOfEx) { s.exIdx++; s.setIdx = 0; }
    else { s.setIdx++; }
    s.reps = cur().target;
    persist();
    renderSession();
  }, undefined, nextPlain);
}

function skipExercise() {
  const s = S.session;
  const e = cur();
  e.skipped = true;
  e.sets = [null, null, null];
  persist();
  saveWorkout(snapshot(false));
  if (s.exIdx >= s.entries.length - 1) return finishSession();
  s.exIdx++; s.setIdx = 0; s.reps = cur().target;
  persist();
  renderSession();
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
  $('btnSkipEx').addEventListener('click', skipExercise);
  $('rUp').addEventListener('click', () => setReps((S.session?.reps ?? 8) + 1));
  $('rDown').addEventListener('click', () => setReps((S.session?.reps ?? 8) - 1));

  $('wUp').addEventListener('click', () => bumpWeight(5));
  $('wDown').addEventListener('click', () => bumpWeight(-5));

  $('btnSkipRest').addEventListener('click', () => S.restSkip && S.restSkip());
  $('btnAddRest').addEventListener('click', () => S.restExtend && S.restExtend());

  $('btnQuit').addEventListener('click', quitCb);
}

function bumpWeight(d) {
  const s = S.session;
  if (!s) return;
  const e = cur();
  e.weight = Math.max(0, e.weight + d);
  persist();
  $('exWeight').textContent = e.weight;
  $('exWeight').parentElement.classList.remove('pop');
  void $('exWeight').offsetWidth;
  $('exWeight').parentElement.classList.add('pop');
}
