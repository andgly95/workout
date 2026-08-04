// Today screen — the prescription for the next workout.
import { S } from './state.js';
import { $, esc, dayLabel, todayStr, parseDay, toast } from './util.js';
import { saveSettings } from './sync.js';
import { alertsSupported, alertsOn, enableAlerts, muteAlerts } from './alarm.js';

export function exName(id) {
  const e = (S.wire?.exercises || []).find(x => x.id === id);
  return e ? e.name : id;
}
export function exShort(id) {
  const e = (S.wire?.exercises || []).find(x => x.id === id);
  return e && e.short ? e.short : null;
}

function doneWorkouts() {
  return (S.wire?.workouts || []).filter(w => w.done);
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

export function renderHome() {
  if (!S.wire) return;

  const sub = S.session
    ? 'Workout in progress'
    : new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('homeSub').textContent = sub;
  $('streakRow').innerHTML = statsHtml();

  const outcomes = lastOutcomeMap();
  const planned = S.wire.planned || [];
  $('todayList').innerHTML = planned.map(p => {
    const act = outcomes[p.id];
    const pill = act === 'weight-up' ? '<span class="pill up">+5 lb</span>'
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

  $('optLegCurl').checked = !!S.wire.settings?.includeOptional;
  $('btnStart').textContent = S.session ? 'Resume workout' : 'Start workout';
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
  $('alertSub').textContent = denied
    ? 'blocked — turn notifications on for Lift in Settings'
    : 'banner when the rest timer runs out';
}

export function initHome(onStart, onHistory) {
  $('btnStart').addEventListener('click', onStart);
  $('btnHistory').addEventListener('click', onHistory);
  $('optLegCurl').addEventListener('change', async (e) => {
    await saveSettings({ includeOptional: e.target.checked });
    renderHome();
  });
  // The permission prompt only works from a gesture, which this is.
  $('optAlerts').addEventListener('change', async (e) => {
    if (!e.target.checked) { muteAlerts(true); return renderAlertRow(); }
    const ok = await enableAlerts();
    if (!ok) toast('Allow notifications for Lift to get the banner');
    renderAlertRow();
  });
}
