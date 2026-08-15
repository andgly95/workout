// Local-first sync. Gym wifi is bad, so nothing in the UI ever waits on the
// network: every write lands in localStorage first, then drains to the server.
// The client mints workout ids and always sends the FULL workout snapshot, so
// the server upsert is idempotent and the queue only needs the latest per id.
import { S, LS, loadLocal, saveLocal } from './state.js';
import { $ } from './util.js';

export function newWorkoutId() {
  return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function setOnline(v) {
  S.online = v;
  $('offline').hidden = v || !queue().length;
}

function queue() { return loadLocal(LS.queue, []); }

function enqueue(payload) {
  const q = queue().filter(p => p.id !== payload.id);
  q.push(payload);
  saveLocal(LS.queue, q.slice(-40));
}

function dequeue(id) {
  saveLocal(LS.queue, queue().filter(p => p.id !== id));
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export function applyWire(w) {
  if (!w) return;
  S.wire = w;
  saveLocal(LS.wire, w);
}

export async function fetchState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    applyWire(await r.json());
    setOnline(true);
  } catch (_) {
    S.wire = S.wire || loadLocal(LS.wire, null);
    setOnline(false);
  }
  return S.wire;
}

// Save a workout. Resolves as soon as it is durable ON DEVICE; the network
// round-trip is best-effort. Returns { outcomes } when the server answered.
export async function saveWorkout(payload) {
  enqueue(payload);
  try {
    const res = await post('/api/workout', payload);
    dequeue(payload.id);
    applyWire(res.state);
    setOnline(true);
    return { synced: true, outcomes: res.outcomes || [] };
  } catch (_) {
    setOnline(false);
    return { synced: false, outcomes: null };
  }
}

export async function adjust(id, patch) {
  try {
    applyWire(await post('/api/adjust', { id, ...patch }));
    return true;
  } catch (_) { return false; }
}

// Undo a skip on a workout that's already logged. Deliberately NOT queued
// offline: the queue's contract is "latest full snapshot per workout id", and a
// correction that has to merge with whatever the server holds doesn't fit it.
// Fails loudly instead, which is the honest answer for a repair you're making
// at a desk rather than mid-set in a basement.
export async function unskipEntry(workoutId, id, sets) {
  try {
    const res = await post(`/api/workout/${workoutId}/unskip`, { id, sets });
    applyWire(res.state);
    return res.outcome || {};
  } catch (_) { return null; }
}

export async function saveSettings(patch) {
  // Reflect immediately so the toggle never feels laggy, then confirm.
  if (S.wire && S.wire.settings) Object.assign(S.wire.settings, patch);
  try {
    applyWire(await post('/api/settings', patch));
    return true;
  } catch (_) { return false; }
}

export async function flushQueue() {
  const q = queue();
  if (!q.length) return;
  for (const p of q) {
    try {
      const res = await post('/api/workout', p);
      dequeue(p.id);
      applyWire(res.state);
    } catch (_) { setOnline(false); return; }
  }
  setOnline(true);
}

export function initSync() {
  window.addEventListener('online', () => { setOnline(true); flushQueue(); });
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushQueue();
  });
  setInterval(flushQueue, 30000);
}
