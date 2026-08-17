// When is a plan next due? Pure — no I/O, no store access, no clock. Every
// answer is a function of (schedule, today, the day you last did it), which is
// what makes the whole thing truth-tableable and is why `today` is a parameter
// rather than something this file reads for itself.
//
// Two modes, because people describe training two different ways:
//
//   weekdays  "Mondays, Wednesdays and Fridays"    — a fixed grid
//   interval  "every other day", "every 3 days"    — rolling off the last one
//
// The interval mode rolls off the LAST COMPLETED session, not off a fixed anchor,
// because that is what "every other day" means to the person saying it: do it
// Monday and the next one is Wednesday. A fixed grid would keep marking days due
// while you were away and then expect you back on its own rhythm. The anchor
// only gets used before there is any history to roll from.
//
// Missing a day leaves the plan DUE, not rescheduled. An overdue workout is
// still the workout you owe; quietly sliding it to tomorrow is how a schedule
// stops meaning anything.
const { parseDay, addDays, dayStr } = require('./calendar');

const MODES = ['off', 'weekdays', 'interval'];
const MIN_EVERY = 1;
const MAX_EVERY = 14;
// How far ahead `next` is willing to look before giving up. Two weeks covers
// every weekday set and every interval we allow; an empty `days` array would
// otherwise spin forever.
const HORIZON = 28;

function defaultSchedule() {
  return { mode: 'off', days: [], everyN: 2, at: '18:00', anchor: null };
}

// 0 = Sunday, matching Date#getDay so nothing has to convert.
const dowOf = (date) => parseDay(date).getDay();

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

// Whole days from a to b, walked on the calendar so a DST hour can't round it
// down to the day before.
function daysBetween(a, b) {
  let n = 0;
  let cur = parseDay(a);
  const end = parseDay(b);
  if (end < cur) {
    while (dayStr(cur) !== dayStr(end) && n > -HORIZON * 2) { cur = addDays(cur, -1); n--; }
    return n;
  }
  while (dayStr(cur) !== dayStr(end) && n < HORIZON * 2) { cur = addDays(cur, 1); n++; }
  return n;
}

function clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(s.mode) ? s.mode : 'off';
  // Deduped and sorted, so two schedules that mean the same thing look the same.
  const days = Array.isArray(s.days)
    ? [...new Set(s.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  // Same trap as lib/plan.js: `Number(v) || 2` would turn a submitted 0 into 2
  // rather than clamping it to 1. Absent means absent; illegal gets clamped.
  const n = s.everyN === '' || s.everyN === null || s.everyN === undefined
    ? 2 : Number(s.everyN);
  const everyN = Math.min(MAX_EVERY, Math.max(MIN_EVERY, Math.round(Number.isFinite(n) ? n : 2)));
  return {
    mode,
    days,
    everyN,
    at: isTime(s.at) ? s.at : '18:00',
    anchor: isDay(s.anchor) ? s.anchor : null,
  };
}

// The day this plan is next expected, ON OR AFTER `from`. Null when nothing is
// scheduled — an unscheduled plan is not overdue, it is just a plan.
function nextOnOrAfter(sched, from, lastDone) {
  const s = clean(sched);
  if (s.mode === 'off') return null;

  if (s.mode === 'weekdays') {
    if (!s.days.length) return null;
    let cur = parseDay(from);
    for (let i = 0; i <= HORIZON; i++) {
      if (s.days.includes(cur.getDay())) return dayStr(cur);
      cur = addDays(cur, 1);
    }
    return null;
  }

  // interval: everyN days after the last one you actually did. With no history,
  // the anchor stands in — and with neither, today is as good a start as any.
  const base = isDay(lastDone) ? lastDone : (s.anchor || from);
  const target = isDay(lastDone) || s.anchor
    ? dayStr(addDays(parseDay(base), s.everyN))
    : from;
  return target < from ? from : target;
}

// The whole answer for one plan, in the shape the wire ships and the client
// renders. `due` is deliberately true for anything overdue: the workout you owe
// does not stop being owed because you missed its day.
function statusOf(sched, today, lastDone) {
  const s = clean(sched);
  if (s.mode === 'off') return { mode: 'off', due: false, next: null, overdueDays: 0, at: s.at };

  // Already done today — the next one is tomorrow's problem, whatever the rule.
  if (lastDone === today) {
    return {
      mode: s.mode,
      due: false,
      doneToday: true,
      next: nextOnOrAfter(s, dayStr(addDays(parseDay(today), 1)), lastDone),
      overdueDays: 0,
      at: s.at,
    };
  }

  const next = nextOnOrAfter(s, lastDone ? dayStr(addDays(parseDay(lastDone), 1)) : today, lastDone);
  const due = !!next && next <= today;
  return {
    mode: s.mode,
    due,
    doneToday: false,
    // Once you're overdue, the useful thing to show is that it's due NOW, not the
    // date it was supposed to be.
    next: due ? today : next,
    overdueDays: due && next < today ? daysBetween(next, today) : 0,
    at: s.at,
  };
}

// Is a reminder for this plan owed at this moment? Separate from statusOf so the
// sender has one thing to ask and so it can be tested without a clock: `nowMin`
// is minutes since local midnight, `sentOn` the day we last notified.
function reminderDue(sched, today, lastDone, nowMin, sentOn) {
  const st = statusOf(sched, today, lastDone);
  if (!st.due) return false;
  if (sentOn === today) return false;            // one nudge a day, not a stream
  const [h, m] = clean(sched).at.split(':').map(Number);
  return nowMin >= h * 60 + m;
}

module.exports = {
  MODES, MIN_EVERY, MAX_EVERY, HORIZON,
  defaultSchedule, clean, statusOf, nextOnOrAfter, reminderDue, daysBetween, dowOf,
};
