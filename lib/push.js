// Scheduled reminders, over Web Push.
//
// CLAUDE.md says Web Push is the wrong answer for the REST TIMER, and it is: that
// alert has to fire ninety seconds from now in a gym basement, so it goes on the
// audio thread. A daily reminder is the opposite problem — it fires hours from
// now, the phone will have had signal at some point, and the app is closed, which
// is exactly the case only push can serve. Same app, two alerts, two mechanisms,
// for reasons that don't generalise from one to the other.
//
// The keypair is generated on first use into gitignored config. Subscriptions
// live in the store so they survive a restart, and are pruned when the push
// service says they're gone — a stale endpoint is otherwise a permanent error in
// the log every evening.
const webpush = require('web-push');
const store = require('./../store');
const { state } = store;
const config = require('./config');
const schedule = require('./schedule');
const calendar = require('./calendar');

const CHECK_MS = 60000;
// Attempts per plan per day before giving up until tomorrow.
const MAX_TRIES = 5;
let timer = null;

// Lazily minted, so a checkout that never asks for push never grows a keypair.
function keys() {
  let k = config.get('vapid');
  if (!k || !k.publicKey || !k.privateKey) {
    k = webpush.generateVAPIDKeys();
    config.set({ vapid: k });
    console.log('push: generated a VAPID keypair in', config.FILE);
  }
  return k;
}

// Contact address the push service can complain to. Not a secret, but it is
// deployment-specific, so it stays out of the repo with a neutral default.
const subject = () => config.get('vapidSubject', 'mailto:lift@localhost');

function publicKey() {
  try { return keys().publicKey; } catch (_) { return null; }
}

// Whether a keypair EXISTS. Deliberately not used to gate send() — see below.
function configured() {
  const k = config.get('vapid');
  return !!(k && k.publicKey && k.privateKey);
}

function addSub(raw) {
  const sub = raw && typeof raw === 'object' ? raw : {};
  // Real push services are always https. Loopback is allowed too, and only
  // loopback: it is the one way to point this at a stand-in and find out that the
  // whole chain works, which matters because the failure mode of getting it wrong
  // is silence rather than an error.
  const ok = typeof sub.endpoint === 'string'
    && (/^https:\/\//.test(sub.endpoint) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(sub.endpoint));
  if (!ok) return null;
  const keysIn = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  if (typeof keysIn.p256dh !== 'string' || typeof keysIn.auth !== 'string') return null;
  const clean = {
    endpoint: sub.endpoint.slice(0, 800),
    keys: { p256dh: String(keysIn.p256dh).slice(0, 200), auth: String(keysIn.auth).slice(0, 100) },
    at: Date.now(),
  };
  // One row per endpoint — re-subscribing on the same device must not stack up
  // duplicate notifications.
  state.push.subs = state.push.subs.filter(s => s.endpoint !== clean.endpoint);
  state.push.subs.push(clean);
  store.save();
  return clean;
}

function removeSub(endpoint) {
  const before = state.push.subs.length;
  state.push.subs = state.push.subs.filter(s => s.endpoint !== String(endpoint || ''));
  if (state.push.subs.length !== before) store.save();
  return before - state.push.subs.length;
}

// Fan out to every device. A 404/410 means the subscription is dead for good, so
// it gets dropped rather than retried forever.
async function send(payload) {
  if (!state.push.subs.length) return 0;
  // Mint here rather than gating on configured(). Gating on it meant the FIRST
  // ever send returned 0 without minting anything and without an error — and in
  // production that path is only reachable when a device subscribed before
  // anything read the public key, which is exactly the case you'd never notice
  // until a reminder didn't arrive.
  let k;
  try { k = keys(); } catch (e) { console.error('push: no keypair —', e.message); return 0; }
  webpush.setVapidDetails(subject(), k.publicKey, k.privateKey);
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const sub of [...state.push.subs]) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) removeSub(sub.endpoint);
      else console.error('push send failed:', code || (e && e.message));
    }
  }
  return sent;
}

/* ── the sender loop ────────────────────────────────────────────────────── */

// The last day a plan was actually completed — what the interval modes roll off.
function lastDoneFor(planId) {
  const days = (state.workouts || [])
    .filter(w => w.done && w.planId === planId)
    .map(w => w.date)
    .sort();
  return days.length ? days[days.length - 1] : null;
}

// One pass. Split out from the interval so it can be driven directly in a test
// with an injected clock instead of waiting a minute for a tick.
async function tick(now = new Date()) {
  if (!state.push.subs.length) return [];
  const today = calendar.dayStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const fired = [];

  for (const plan of state.plans || []) {
    if (plan.archived) continue;
    const sent = state.push.sent[plan.id];
    if (!schedule.reminderDue(plan.schedule, today, lastDoneFor(plan.id), nowMin, sent)) continue;
    const tried = state.push.tried[plan.id];
    if (tried && tried.day === today && tried.n >= MAX_TRIES) continue;

    const names = plan.exerciseIds
      .map(id => (state.exercises.find(e => e.id === id) || {}).name)
      .filter(Boolean);
    const sentTo = await send({
      title: 'Lift',
      body: `${plan.name} is due today`,
      // Enough to decide from the lock screen whether you're going.
      detail: names.slice(0, 6).join(' · '),
      planId: plan.id,
    });
    // Only mark it sent if something actually went out — marking regardless would
    // burn today's one nudge on a momentary outage and you'd never hear about it.
    // But a failure that isn't 404/410 (a rejected subject, a service having a bad
    // day) would then retry every single minute and log every single time, which on
    // a Pi is a real nuisance. So attempts are counted and capped: a blip is
    // survived, a permanent misconfiguration goes quiet.
    if (!sentTo) {
      const t = state.push.tried[plan.id];
      state.push.tried[plan.id] = t && t.day === today ? { day: today, n: t.n + 1 } : { day: today, n: 1 };
      store.save();
      continue;
    }
    state.push.sent[plan.id] = today;
    delete state.push.tried[plan.id];
    store.save();
    fired.push(plan.id);
  }
  return fired;
}

function start() {
  if (timer || process.env.NO_PUSH) return;
  timer = setInterval(() => { tick().catch(e => console.error('push tick:', e.message)); }, CHECK_MS);
  if (timer.unref) timer.unref();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { publicKey, configured, addSub, removeSub, send, tick, start, stop, lastDoneFor, CHECK_MS, MAX_TRIES };
