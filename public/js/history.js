// History screen — a twelve-week calendar, a weight sparkline per exercise, and
// the workouts themselves.
//
// The calendar grid arrives computed in the wire (`lib/calendar.js`): week
// alignment and day bucketing are the kind of thing that should exist once and
// have a truth table, the same reason the client doesn't re-derive progression.
// This file only draws it.
import { S } from './state.js';
import { $, esc, dayLabel, mmss, toast } from './util.js';
import { exName } from './home.js';
import { unskipEntry } from './sync.js';

let onChange = () => {};

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function heatmapHtml(hm) {
  if (!hm || !hm.cells.length) return '';

  // Columns are weeks, rows are days — a phone is taller than it is wide, but
  // twelve columns of seven still fits across, and reading down a column as a
  // week is how every calendar works.
  const cols = Array.from({ length: hm.weeks }, (_, w) => {
    const days = hm.cells.filter(c => c.week === w).map((c) => {
      const cls = [`l${c.level}`, c.future ? 'future' : ''].filter(Boolean).join(' ');
      const title = c.level
        ? `${c.date} · ${c.sets} sets · ${Math.round(c.volume).toLocaleString()} lb moved`
        : c.date;
      return `<i class="${cls}" data-day="${esc(c.date)}"${c.id ? ` data-w="${esc(c.id)}"` : ''}
        title="${esc(title)}"></i>`;
    }).join('');
    return `<div class="hm-col">${days}</div>`;
  }).join('');

  const months = hm.months.map((m, i) => {
    const next = hm.months[i + 1];
    const span = (next ? next.week : hm.weeks) - m.week;
    return `<span style="flex:${span}">${esc(m.label)}</span>`;
  }).join('');

  return `<div class="heat">
    <div class="hm-months">${months}</div>
    <div class="hm-body">
      <div class="hm-dow">${DOW.map(d => `<i>${d}</i>`).join('')}</div>
      <div class="hm-grid">${cols}</div>
    </div>
    <div class="hm-foot">
      <span><b>${hm.sessions}</b> in ${hm.weeks} weeks · <b>${hm.perWeek}</b> a week</span>
      <span class="hm-key">less ${[0, 1, 2, 3, 4].map(l => `<i class="l${l}"></i>`).join('')} more</span>
    </div>
  </div>`;
}

function sparkline(points) {
  if (points.length < 2) return '';
  const w = 100, h = 40;
  const lo = Math.min(...points), hi = Math.max(...points);
  const flat = hi === lo;
  const span = hi - lo || 1;
  const step = w / (points.length - 1);
  // A lift that hasn't moved is a flat line through the MIDDLE. Scaling it the
  // normal way pins it to the floor, which reads as having dropped to zero.
  const xy = points.map((v, i) => [i * step, flat ? h / 2 : h - ((v - lo) / span) * h]);
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
  const cal = $('calWrap');

  // The calendar is drawn even with nothing in it — an empty twelve weeks is
  // itself the useful picture, and it gives the screen a shape to fill.
  cal.innerHTML = heatmapHtml(S.wire?.heatmap);
  cal.querySelectorAll('[data-w]').forEach((el) => {
    el.addEventListener('click', () => jumpTo(el.dataset.w));
  });

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
        // The only line here you can have got wrong with one mis-tap, so it's
        // the only one that's tappable.
        return `<button class="h-line skipped" data-fix="${esc(w.id)}" data-ex="${esc(en.id)}">
          <em>${esc(exName(en.id))}</em><i>skipped · tap to fix</i>
        </button>`;
      }
      const sets = en.sets.map(s => (s === null ? '–' : s)).join(' · ');
      return `<div class="h-line">
        <em>${esc(exName(en.id))}</em>
        <i><b>${en.weight} lb</b> &nbsp;${sets}</i>
      </div>`;
    }).join('');
    return `<div class="h-card" data-card="${esc(w.id)}">
      <div class="hd"><b>${esc(dayLabel(w.date))}</b><span>${dur || ''}</span></div>
      ${lines}
    </div>`;
  }).join('');

  list.querySelectorAll('[data-fix]').forEach((el) => {
    el.addEventListener('click', () => openFix(el.dataset.fix, el.dataset.ex));
  });
}

/* ── undoing a skip, after the fact ────────────────────────────────────────
   A skip means "no signal": applyProgression steps over it entirely, so one
   mis-tap silently costs you that machine's advance for the week. The fix has
   to put the sets back on the record AND catch the prescription up, which is
   why it goes through a route rather than being a local edit. */

let fixing = null;   // { wId, exId, sets: [n|null, n|null, n|null] }

function openFix(wId, exId) {
  const w = (S.wire?.workouts || []).find(x => x.id === wId);
  const en = w && (w.entries || []).find(x => x.id === exId);
  if (!en) return;
  // Default to what was prescribed. Nine times out of ten that's what you did,
  // and the whole repair is then one tap.
  fixing = { wId, exId, sets: [en.target, en.target, en.target] };
  $('fixTitle').textContent = exName(exId);
  $('fixSub').textContent = `${dayLabel(w.date)} · ${en.weight} lb, target ${en.target}`;
  paintFix();
  $('fixPane').hidden = false;
}

function closeFix() { fixing = null; $('fixPane').hidden = true; }

function paintFix() {
  if (!fixing) return;
  $('fixSets').innerHTML = fixing.sets.map((v, i) => `
    <div class="fix-row">
      <span>Set ${i + 1}</span>
      <button class="rbtn sm" data-set="${i}" data-d="-1" aria-label="Fewer reps">−</button>
      <b class="${v === null ? 'none' : ''}">${v === null ? '–' : v}</b>
      <button class="rbtn sm" data-set="${i}" data-d="1" aria-label="More reps">+</button>
    </div>`).join('');
  $('fixSets').querySelectorAll('[data-d]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.set);
      // 0 is a set you failed; below that is a set you never did, which is what
      // a dash means — the same distinction nextState() already draws between a
      // logged 0 and a blank.
      const next = (fixing.sets[i] === null ? -1 : fixing.sets[i]) + Number(b.dataset.d);
      fixing.sets[i] = next < 0 ? null : Math.min(12, next);
      paintFix();
    });
  });
  $('fixSave').disabled = fixing.sets.every(v => v === null);
}

async function saveFix() {
  if (!fixing) return;
  const btn = $('fixSave');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const res = await unskipEntry(fixing.wId, fixing.exId, fixing.sets);
  btn.textContent = 'Put it back on the record';
  if (!res) {
    btn.disabled = false;
    return toast('Could not save — needs a connection');
  }
  const name = exName(fixing.exId);
  closeFix();
  renderHistory();
  onChange();
  // Say whether the prescription moved, because usually that is the point — and
  // when it didn't, say why rather than looking like nothing happened.
  toast(res.appliedToPlan === false
    ? `${name} corrected — a later workout already set the weight`
    : res.note || `${name} put back`, 4200);
}

export function initHistory(changeHandler) {
  onChange = changeHandler || (() => {});
  $('fixCancel').addEventListener('click', closeFix);
  $('fixSave').addEventListener('click', saveFix);
  $('fixPane').addEventListener('click', (e) => { if (e.target === $('fixPane')) closeFix(); });
}

// Tapping a square scrolls its workout into view and flashes it — the square is
// a link into the list below, not a separate detail screen to navigate back out
// of on a phone.
function jumpTo(id) {
  const el = document.querySelector(`#historyList [data-card="${CSS.escape(id)}"]`);
  if (!el) return;
  $('historyScroll').scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: 'smooth' });
  el.classList.remove('lit');
  void el.offsetWidth;
  el.classList.add('lit');
}
