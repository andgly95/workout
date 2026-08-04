// The training calendar: twelve weeks of days, shaded by how much you lifted.
//
// Pure — no I/O, no store access — and computed on the SERVER so the client only
// has to draw it, the same way it renders progression outcomes rather than
// re-deriving them. Date bucketing is where this sort of thing goes wrong
// (week alignment, a Sunday "today", two workouts on one day), so every one of
// those has a row in the truth table in test/test.js.
//
// Weeks are MONDAY-anchored, which is how "1-3 times a week" is actually read
// and what home.js already counts against.

const WEEKS = 12;
const DAY = 86400000;

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 'YYYY-MM-DD' → local midnight. Never `new Date(str)`, which parses as UTC and
// lands on the previous day for anyone west of Greenwich.
function parseDay(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// Add days on the calendar, not by adding milliseconds: an hour of DST would
// otherwise shift the grid by a whole column twice a year.
function addDays(d, n) {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

// How much work a session actually was: reps moved, times the weight. It's the
// only number that separates a full session from one where you bailed after the
// first exercise, which is exactly what a heatmap should show.
function volumeOf(workout) {
  let volume = 0;
  let sets = 0;
  for (const en of workout.entries || []) {
    if (en.skipped) continue;
    for (const r of en.sets || []) {
      if (r === null || r === undefined) continue;
      volume += (Number(en.weight) || 0) * Number(r);
      sets++;
    }
  }
  return { volume, sets };
}

// Four shades rather than a binary dot: two sessions a week where one was half
// abandoned should not read the same as two full ones. Level is relative to the
// heaviest day in the window, so it re-scales as the weights climb instead of
// saturating against a fixed threshold that stops meaning anything by March.
function levelFor(volume, max) {
  if (!volume) return 0;
  if (!max) return 1;
  const r = volume / max;
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}

// Returns a Monday-anchored grid, oldest week first, always a whole number of
// weeks so the columns line up. `today` is 'YYYY-MM-DD'.
function buildHeatmap(workouts, today, weeks = WEEKS) {
  const end = parseDay(today);
  // The current week is shown whole, including the days that haven't happened
  // yet — a half-drawn final column reads as a missing week.
  const lastMonday = mondayOf(end);
  const start = addDays(lastMonday, -(weeks - 1) * 7);

  const byDate = new Map();
  for (const w of workouts || []) {
    if (!w || !w.done || !w.date) continue;
    const at = parseDay(w.date);
    if (at < start || at > addDays(lastMonday, 6)) continue;
    const { volume, sets } = volumeOf(w);
    // Two sessions in one day are one square; the volumes add.
    const prev = byDate.get(w.date);
    if (prev) { prev.volume += volume; prev.sets += sets; prev.count++; }
    else byDate.set(w.date, { id: w.id, volume, sets, count: 1 });
  }

  let max = 0;
  for (const v of byDate.values()) max = Math.max(max, v.volume);

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const date = dayStr(d);
    const hit = byDate.get(date);
    cells.push({
      date,
      week: Math.floor(i / 7),
      dow: i % 7,                       // 0 = Monday
      future: d > end,
      id: hit ? hit.id : null,
      sets: hit ? hit.sets : 0,
      volume: hit ? hit.volume : 0,
      level: levelFor(hit ? hit.volume : 0, max),
    });
  }

  const sessions = [...byDate.values()].reduce((n, v) => n + v.count, 0);
  return {
    weeks,
    start: dayStr(start),
    end: dayStr(addDays(lastMonday, 6)),
    cells,
    sessions,
    // One decimal, because "2.4 a week" is the number the program is judged on
    // and rounding it to 2 throws away the thing you want to see.
    perWeek: Math.round((sessions / weeks) * 10) / 10,
    // Month boundaries for the column labels — the first week whose Monday falls
    // in a given month owns the label.
    months: monthLabels(start, weeks),
  };
}

function monthLabels(start, weeks) {
  const out = [];
  let last = null;
  for (let w = 0; w < weeks; w++) {
    const d = addDays(start, w * 7);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key !== last) {
      last = key;
      out.push({ week: w, label: d.toLocaleDateString('en-US', { month: 'short' }) });
    }
  }
  return out;
}

module.exports = { buildHeatmap, volumeOf, levelFor, mondayOf, parseDay, addDays, dayStr, WEEKS, DAY };
