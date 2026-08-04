export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function mmss(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 'YYYY-MM-DD' → local Date (avoids the UTC shift of `new Date('2026-01-02')`).
export function parseDay(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function dayLabel(s) {
  const d = parseDay(s);
  const diff = Math.round((parseDay(todayStr()) - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer = null;
export function toast(msg, ms = 2000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  const sc = document.querySelector(`#${id} .scroll`);
  if (sc) sc.scrollTop = 0;
}

// No-op on iOS Safari, which has never supported the Vibration API — the
// scheduled tone in alarm.js is what actually reaches you there. Kept because
// it costs nothing and is the better signal anywhere that does support it.
export function buzz(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {}
}

// Sound lives in alarm.js, which owns the one AudioContext: the end-of-rest
// tone has to be SCHEDULED on the audio thread rather than played on demand,
// and two contexts fighting over iOS's audio session would break exactly that.
