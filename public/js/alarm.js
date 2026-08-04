// The end-of-rest alert, built to survive the app being in the background.
//
// THE PROBLEM: on iOS a PWA that isn't in front is frozen within seconds. Not
// throttled — frozen. setInterval stops, setTimeout stops, the service worker
// stops. So the old approach (an interval that beeps when it sees the clock run
// out) simply never fired if you locked the phone or flicked to something else
// between sets, which is most of a rest period.
//
// THE FIX: schedule the tone on the AUDIO thread, at an absolute
// AudioContext time, the moment the rest starts. Web Audio renders ahead on its
// own clock and keeps going while the main thread is frozen — as long as the
// audio session stays alive, which is what the near-silent keep-alive source is
// for. iOS keeps a PWA's audio session running in the background while
// something is playing; it suspends the context the moment nothing is.
//
// This also works with no signal, which matters: the whole app is built to run
// a full workout in a gym basement. Web Push would be the textbook answer and is
// useless here for exactly that reason — see CLAUDE.md.
//
// The notification is a bonus on top, not the mechanism. It shows whenever the
// main thread is alive to raise it; the sound is what actually reaches you
// through a pocket.

let actx = null;
let scheduled = null;   // { nodes, at, deadline }
let keepAlive = null;

function ctx() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (_) { actx = null; }
  return actx;
}

// Called from the first user gesture, so iOS unlocks the context and we can
// make sound later without one.
export function primeAudio() { ctx(); }

/* ── keeping the audio session alive ───────────────────────────────────── */

// Amplitude 1e-4 is 80 dB below full scale: inaudible on any speaker, but a
// real signal rather than digital silence, which some platforms optimise away
// along with the session we are trying to hold open.
function silentBuffer(a) {
  const buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * 0.5)), a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = i % 2 ? 1e-4 : -1e-4;
  return buf;
}

function startKeepAlive(seconds) {
  stopKeepAlive();
  const a = ctx();
  if (!a) return;
  try {
    const src = a.createBufferSource();
    src.buffer = silentBuffer(a);
    src.loop = true;
    const g = a.createGain();
    g.gain.value = 1;
    src.connect(g); g.connect(a.destination);
    src.start();
    // Stop a little after the alarm — holding the session open indefinitely
    // would keep the phone's audio route busy long after the workout.
    src.stop(a.currentTime + seconds + 2);
    keepAlive = { src, g };
  } catch (_) {}
}

function stopKeepAlive() {
  if (!keepAlive) return;
  try { keepAlive.src.stop(); } catch (_) {}
  try { keepAlive.src.disconnect(); keepAlive.g.disconnect(); } catch (_) {}
  keepAlive = null;
}

/* ── the alarm ─────────────────────────────────────────────────────────── */

function tone(a, at, freq, dur, gain = 0.28) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  // Ramp rather than switch, or it clicks.
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(a.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
  return [o, g];
}

// Schedule the two-tone alert `seconds` from now. Everything is queued on the
// audio thread up front, so nothing here needs the main thread to be running
// when it goes off.
export function scheduleAlarm(seconds) {
  cancelAlarm();
  const a = ctx();
  if (!a) return false;
  const at = a.currentTime + Math.max(0, seconds);
  const nodes = [
    ...tone(a, at, 880, 0.18),
    ...tone(a, at + 0.22, 1174, 0.26),
    ...tone(a, at + 0.52, 1174, 0.30),
  ];
  startKeepAlive(seconds);
  // The wall clock too: the audio clock stops if the context is ever suspended,
  // and we need to know that happened.
  scheduled = { nodes, at, deadline: Date.now() + seconds * 1000 };
  return true;
}

// Is an alert currently queued on the audio thread? Exported so the headless
// check can assert the scheduling really happened rather than only that nothing
// threw — a silently-failing alarm looks exactly like a working one from
// outside.
export const alarmPending = () => !!scheduled;

export function cancelAlarm() {
  if (scheduled) {
    for (const n of scheduled.nodes) {
      try { n.stop && n.stop(); } catch (_) {}
      try { n.disconnect(); } catch (_) {}
    }
    scheduled = null;
  }
  stopKeepAlive();
}

// If the context was suspended anyway, its clock froze and the tone would now
// fire wildly late — a beep minutes after you already got back to the bench.
// Drop it instead. The rest pane's own catch-up handles the state.
function dropIfStale() {
  if (!scheduled) return;
  if (Date.now() > scheduled.deadline + 1500) cancelAlarm();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  dropIfStale();
  // You're looking at the app, so the banner has done its job. Clearing it here
  // rather than when the timer ends matters: that happens microseconds after
  // raising it and would race the notification away before it was ever seen.
  clearNotifications();
});

/* ── notifications ─────────────────────────────────────────────────────── */

const MUTED = 'liftAlertsMuted';

export const alertsSupported = () =>
  typeof Notification !== 'undefined' && 'serviceWorker' in navigator;

const muted = () => {
  try { return localStorage.getItem(MUTED) === '1'; } catch (_) { return false; }
};

// Browser permission can be granted but never revoked from script, so the
// toggle owns a separate mute rather than pretending it can hand the permission
// back. The SOUND is not affected either way — that's the alert that actually
// works through a pocket, and there is no reason to want it off.
export const alertsOn = () =>
  alertsSupported() && Notification.permission === 'granted' && !muted();

export function muteAlerts(on) {
  try {
    if (on) localStorage.setItem(MUTED, '1');
    else localStorage.removeItem(MUTED);
  } catch (_) {}
}

// Must be called from a user gesture — iOS ignores it otherwise.
export async function enableAlerts() {
  if (!alertsSupported()) return false;
  muteAlerts(false);
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch (_) { return false; }
}

// iOS only raises notifications through the service worker registration —
// `new Notification()` is not supported in a PWA there at all.
export async function notify(title, body) {
  if (!alertsOn()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    await reg.showNotification(title, {
      body,
      tag: 'lift-rest',      // one at a time — replace, never stack
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/' },
    });
    return true;
  } catch (_) { return false; }
}

export async function clearNotifications() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.getNotifications) return;
    for (const n of await reg.getNotifications({ tag: 'lift-rest' })) n.close();
  } catch (_) {}
}
