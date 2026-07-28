// History screen — past workouts plus a weight sparkline per exercise.
import { S } from './state.js';
import { $, esc, dayLabel, mmss } from './util.js';
import { exName } from './home.js';

function sparkline(points) {
  if (points.length < 2) return '';
  const w = 100, h = 40;
  const lo = Math.min(...points), hi = Math.max(...points);
  const span = hi - lo || 1;
  const step = w / (points.length - 1);
  const xy = points.map((v, i) => [i * step, h - ((v - lo) / span) * h]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  const [lx, ly] = xy[xy.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polygon points="${area}" fill="rgba(74,222,128,.12)"/>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="var(--accent)"
      vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export function renderHistory() {
  const done = (S.wire?.workouts || []).filter(w => w.done);
  const wrap = $('chartWrap');
  const list = $('historyList');

  if (!done.length) {
    wrap.innerHTML = '';
    list.innerHTML = '<div class="empty-note">No workouts logged yet.<br>Your history will build up here.</div>';
    return;
  }

  // Weight over time, per exercise.
  const exIds = (S.wire?.exercises || []).map(e => e.id);
  wrap.innerHTML = exIds.map(id => {
    const pts = [];
    for (const w of done) {
      const en = (w.entries || []).find(x => x.id === id);
      if (en && !en.skipped && en.sets.some(s => s !== null)) pts.push(en.weight);
    }
    if (!pts.length) return '';
    const first = pts[0], last = pts[pts.length - 1];
    const delta = last - first;
    return `<div class="chart">
      <div class="ct">${esc(exName(id))}</div>
      ${sparkline(pts)}
      <div class="cv">
        <span>${pts.length} session${pts.length === 1 ? '' : 's'}</span>
        <span><b>${last} lb</b>${delta ? ` &nbsp;<span style="color:var(--accent)">+${delta}</span>` : ''}</span>
      </div>
    </div>`;
  }).join('');

  list.innerHTML = done.slice().reverse().map(w => {
    const dur = w.finishedAt && w.startedAt ? mmss((w.finishedAt - w.startedAt) / 1000) : null;
    const lines = (w.entries || []).map(en => {
      if (en.skipped) {
        return `<div class="h-line"><em>${esc(exName(en.id))}</em><i style="opacity:.5">skipped</i></div>`;
      }
      const sets = en.sets.map(s => (s === null ? '–' : s)).join(' · ');
      return `<div class="h-line">
        <em>${esc(exName(en.id))}</em>
        <i><b>${en.weight} lb</b> &nbsp;${sets}</i>
      </div>`;
    }).join('');
    return `<div class="h-card">
      <div class="hd"><b>${esc(dayLabel(w.date))}</b><span>${dur || ''}</span></div>
      ${lines}
    </div>`;
  }).join('');
}
