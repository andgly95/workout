// Today screen — the prescription for the next workout.
import { S } from './state.js';
import { $, esc, dayLabel, todayStr, parseDay, toast } from './util.js';
import { setActivePlan, subscribePush } from './sync.js';
import { alertsSupported, alertsOn, enableAlerts, muteAlerts } from './alarm.js';

let onEditPlan = () => {};

export function exName(id) {
  const e = (S.wire?.exercises || []).find(x => x.id === id);
  return e ? e.name : id;
}
export function exShort(id) {
  const e = (S.wire?.exercises || []).find(x => x.id === id);
  return e && e.short ? e.short : null;
}
// How much this machine moves in one notch. The server owns the number — the
// client looks it up rather than keeping a second table that could drift.
export function exStep(id) {
  const e = (S.wire?.exercises || []).find(x => x.id === id);
  return (e && e.step) || S.wire?.rules?.weightStep || 5;
}
// The active plan, and its ladder. `wire.rules` is deliberately the active plan's
// rules under the name the session screen always used, so nothing downstream had
// to learn about plans at all.
export const activePlan = () =>
  (S.wire?.plans || []).find(p => p.id === S.wire.activePlanId) || (S.wire?.plans || [])[0] || null;
export const planRules = () => S.wire?.rules || { sets: 3, minReps: 8, maxReps: 12, repStep: 2 };

// This plan's sessions only. Counting an upper day towards a lower day's streak
// would make both numbers mean nothing.
function doneWorkouts() {
  const id = S.wire?.activePlanId;
  return (S.wire?.workouts || []).filter(w => w.done && (!id || w.planId === id));
}

// Monday-anchored week count — matches how a "1-3x per week" target is read.
function thisWeekCount() {
  const now = parseDay(todayStr());
  const dow = (now.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(now); monday.setDate(now.getDate() - dow);
  return doneWorkouts().filter(w => parseDay(w.date) >= monday).length;
}

// What the last completed workout did to each exercise, for the little pills.
function lastOutcomeMap() {
  const done = doneWorkouts();
  const last = done[done.length - 1];
  const map = {};
  if (last && last.outcomes) for (const o of last.outcomes) map[o.id] = o.action;
  return map;
}

function statsHtml() {
  const done = doneWorkouts();
  const last = done[done.length - 1];
  const wk = thisWeekCount();
  return `
    <div class="stat"><b>${wk}<small style="font-size:13px;color:var(--dim)">/3</small></b><span>This week</span></div>
    <div class="stat"><b>${done.length}</b><span>Total</span></div>
    <div class="stat"><b style="font-size:15px;padding-top:4px">${last ? esc(dayLabel(last.date)) : '—'}</b><span>Last lift</span></div>`;
}

// What the schedule says about today, in words. Only a plan with a schedule set
// says anything at all — an unscheduled plan is not overdue, it is just a plan.
function scheduleLine(p) {
  const st = p && p.status;
  if (!st || st.mode === 'off') return null;
  if (st.due) {
    return st.overdueDays > 0
      ? `Due — ${st.overdueDays} day${st.overdueDays === 1 ? '' : 's'} overdue`
      : 'Due today';
  }
  if (st.doneToday) return 'Done today';
  if (!st.next) return null;
  const tomorrow = st.next === dayStr(new Date(Date.now() + 86400000));
  return tomorrow ? 'Next: tomorrow' : `Next: ${dayLabel(st.next)}`;
}

const dayStr = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// The picker exists only once there is a choice to make. With one plan the home
// screen is exactly what it was before plans existed — that's the whole point of
// disclosing it progressively rather than always showing a list of one.
function renderPlanRow() {
  const plans = (S.wire?.plans || []).filter(p => !p.archived);
  const row = $('planRow');
  row.hidden = plans.length < 2;
  if (plans.length < 2) return;
  row.innerHTML = plans.map(p => {
    const due = p.status && p.status.due ? '<i class="due"></i>' : '';
    return `<button data-plan="${esc(p.id)}"
      class="${p.id === S.wire.activePlanId ? 'on' : ''}">${esc(p.name)}${due}</button>`;
  }).join('');
  row.querySelectorAll('[data-plan]').forEach(b => {
    b.addEventListener('click', async () => {
      if (b.dataset.plan === S.wire.activePlanId) return;
      await setActivePlan(b.dataset.plan);
      renderHome();
    });
  });
}

export function renderHome() {
  if (!S.wire) return;

  const plan = activePlan();
  renderPlanRow();

  const line = scheduleLine(plan);
  const sub = S.session
    ? 'Workout in progress'
    : [line, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })]
      .filter(Boolean).join(' · ');
  $('homeSub').textContent = sub;
  $('homeSub').classList.toggle('due', !S.session && !!(plan && plan.status && plan.status.due));
  // The plan's own name and the way into editing it. One plan or six, this is
  // where you go to change what the workout is.
  $('planName').textContent = plan ? plan.name : 'No workout';
  $('planMeta').textContent = plan
    ? `${plan.exerciseIds.length} machine${plan.exerciseIds.length === 1 ? '' : 's'} · ${plan.rulesLabel}`
    : '';
  $('streakRow').innerHTML = statsHtml();

  const outcomes = lastOutcomeMap();
  const planned = S.wire.planned || [];
  $('todayList').innerHTML = planned.map(p => {
    const act = outcomes[p.id];
    const pill = act === 'weight-up' ? `<span class="pill up">+${exStep(p.id)} lb</span>`
      : act === 'reps-up' ? '<span class="pill up">+2 reps</span>'
      : act === 'suggest-deload' ? '<span class="pill down">missed</span>'
      : act === 'hold' ? '<span class="pill hold">repeat</span>' : '';
    const short = exShort(p.id);
    return `<div class="ex-card">
      <div class="n">
        <b>${esc(exName(p.id))}${pill}</b>
        ${short ? `<small>${esc(short)}</small>` : ''}
      </div>
      <div class="presc">
        <b>${p.weight} lb</b>
        <small>3 × ${p.target}</small>
      </div>
    </div>`;
  }).join('') || '<div class="empty-note">No exercises.</div>';

  $('btnStart').textContent = S.session ? 'Resume workout' : 'Start workout';
  $('btnStart').disabled = !plan || !plan.exerciseIds.length;
  renderAlertRow();
}

// The switch controls the BANNER only. The tone is scheduled on the audio thread
// whatever this says, because that's the alert that reaches you with the phone
// locked in a pocket — see alarm.js.
function renderAlertRow() {
  const row = $('alertRow');
  if (!alertsSupported()) { row.hidden = true; return; }
  row.hidden = false;
  const denied = Notification.permission === 'denied';
  $('optAlerts').checked = alertsOn();
  $('optAlerts').disabled = denied;
  const scheduled = (S.wire?.plans || []).some(p => p.schedule && p.schedule.mode !== 'off');
  $('alertSub').textContent = denied
    ? 'blocked — turn notifications on for Lift in Settings'
    : scheduled
      ? 'rest timer, and a nudge when a workout is due'
      : 'banner when the rest timer runs out';
}

export function initHome(onStart, onHistory, onEdit) {
  onEditPlan = onEdit || (() => {});
  $('btnStart').addEventListener('click', onStart);
  $('btnHistory').addEventListener('click', onHistory);
  $('btnEditPlan').addEventListener('click', () => onEditPlan(S.wire?.activePlanId));
  // The permission prompt only works from a gesture, which this is.
  $('optAlerts').addEventListener('change', async (e) => {
    if (!e.target.checked) { muteAlerts(true); return renderAlertRow(); }
    const ok = await enableAlerts();
    if (!ok) toast('Allow notifications for Lift to get the banner');
    // Same permission, two uses: the rest banner while you're in the app, and the
    // pushed reminder when you're not. Granting once buys both, so this is where
    // the subscription is registered rather than behind a second switch.
    else await subscribePush();
    renderAlertRow();
  });
}
