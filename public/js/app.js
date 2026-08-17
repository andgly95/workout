// Entry point: boot, screen routing, service-worker registration.
import { S } from './state.js';
import { $, showScreen, toast } from './util.js';
import { initSync, fetchState, flushQueue } from './sync.js';
import { initHome, renderHome } from './home.js';
import { initSession, startSession, restoreSession, endSessionUI, renderSession } from './session.js';
import { renderSummary } from './summary.js';
import { initHistory, renderHistory } from './history.js';
import { initPlan, openPlan } from './plan.js';

function goHome() {
  endSessionUI();
  showScreen('scr-home');
  renderHome();
}

function goHistory() {
  renderHistory();
  showScreen('scr-history');
}

async function onFinish(snap, synced) {
  renderSummary(snap, synced);
  showScreen('scr-done');
  if (!synced) toast('Saved on device');
}

async function boot() {
  initSync();
  await fetchState();

  if (!S.wire) {
    document.body.innerHTML =
      '<div style="padding:60px 24px;text-align:center;color:#8d9aab;font:16px system-ui">' +
      'Could not load. Check your connection and reload.</div>';
    return;
  }

  restoreSession();

  initHome(startSession, goHistory, openPlan);
  initSession(onFinish, goHome);
  // Correcting a skip changes the next prescription, so Today has to be redrawn
  // even though you're standing on the history screen when you do it.
  initHistory(renderHome);
  // Editing the program changes today's prescription, so Home is redrawn on the
  // way back out rather than only on the next load.
  initPlan(renderHome, goHome);
  $('btnDoneClose').addEventListener('click', goHome);
  $('btnBackHome').addEventListener('click', goHome);

  renderHome();
  showScreen('scr-home');
  flushQueue();

  // A resumed session should redraw against fresh wire data when we come back.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if ($('scr-session').classList.contains('active')) renderSession();
    else if ($('scr-home').classList.contains('active')) fetchState().then(renderHome);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
