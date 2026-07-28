// Post-workout summary. Progression outcomes are computed server-side (single
// source of truth — lib/progression.js); offline we show a pending state rather
// than duplicating the rules here and letting them drift.
import { S } from './state.js';
import { $, esc, mmss, toast } from './util.js';
import { exName } from './home.js';
import { adjust } from './sync.js';

export function renderSummary(snap, synced) {
  const worked = (snap.entries || []).filter(e => !e.skipped && e.sets.some(s => s !== null));
  const dur = snap.finishedAt && snap.startedAt ? mmss((snap.finishedAt - snap.startedAt) / 1000) : '';
  const totalReps = worked.reduce((n, e) => n + e.sets.reduce((m, s) => m + (s || 0), 0), 0);
  const volume = worked.reduce((n, e) => n + e.sets.reduce((m, s) => m + (s || 0) * e.weight, 0), 0);

  $('doneTitle').textContent = worked.length ? 'Workout complete' : 'Workout closed';
  $('doneSub').textContent = worked.length
    ? `${dur} · ${totalReps} reps · ${volume.toLocaleString()} lb moved`
    : 'Nothing logged';

  if (!synced) {
    $('doneList').innerHTML =
      `<div class="out-card"><div class="note" style="color:var(--warn)">
        Saved on this device. Next weights update as soon as you're back online.
      </div></div>` + worked.map(e => plainCard(e)).join('');
    return;
  }

  const byId = {};
  for (const o of S.lastOutcomes) byId[o.id] = o;

  $('doneList').innerHTML = worked.map(e => {
    const o = byId[e.id];
    if (!o) return plainCard(e);
    const cls = o.action === 'weight-up' ? 'up' : o.action === 'suggest-deload' ? 'down' : '';
    const sets = e.sets.map(s => (s === null ? '–' : s)).join(' · ');
    const deload = o.action === 'suggest-deload' && o.canDrop
      ? `<button class="deload-btn" data-drop="${esc(e.id)}" data-w="${o.suggestWeight}">Drop to ${o.suggestWeight} lb</button>`
      : '';
    return `<div class="out-card ${cls}">
      <div class="top">
        <b>${esc(exName(e.id))}</b>
        <span class="sets">${e.weight} lb · ${sets}</span>
      </div>
      <div class="note">${esc(o.note)}</div>
      ${deload}
    </div>`;
  }).join('') || '<div class="empty-note">Nothing logged.</div>';

  $('doneList').querySelectorAll('[data-drop]').forEach(b => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      const ok = await adjust(b.dataset.drop, { weight: Number(b.dataset.w), target: 8 });
      if (ok) { b.textContent = `Dropped to ${b.dataset.w} lb`; toast('Weight lowered'); }
      else { b.disabled = false; toast('Could not save — try later'); }
    });
  });
}

function plainCard(e) {
  const sets = e.sets.map(s => (s === null ? '–' : s)).join(' · ');
  return `<div class="out-card">
    <div class="top"><b>${esc(exName(e.id))}</b><span class="sets">${e.weight} lb · ${sets}</span></div>
  </div>`;
}
