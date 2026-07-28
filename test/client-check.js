// Drives headless chromium over the DevTools protocol (raw WebSocket, no extra
// deps) against a throwaway server: runs a whole workout — every set of every
// exercise — and fails on any JS exception or console error.
// Skips (exit 0) when chromium isn't installed.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let CHROME = null;
for (const bin of ['chromium', 'chromium-browser', 'google-chrome']) {
  try { execFileSync('which', [bin], { stdio: 'pipe' }); CHROME = bin; break; } catch (_) {}
}
if (!CHROME) { console.log('client-check: no chromium found, skipping'); process.exit(0); }

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
      }),
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) listeners.forEach(fn => fn(msg));
    };
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-cc-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'store.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let slog = '';
  server.stdout.on('data', d => { slog += d; });
  server.stderr.on('data', d => { slog += d; });

  const up = Date.now() + 10000;
  while (Date.now() < up) {
    try { if ((await fetch(BASE + '/api/state')).ok) break; } catch (_) {}
    await sleep(150);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lift-prof-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9333', '--no-sandbox',
    '--disable-gpu', '--window-size=430,900', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const errors = [];
  let cdp = null, fail = null;

  const cleanup = () => {
    try { cdp && cdp.close(); } catch (_) {}
    chrome.kill('SIGKILL');
    server.kill('SIGTERM');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    let wsUrl = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !wsUrl) {
      try {
        const r = await fetch('http://127.0.0.1:9333/json/version');
        wsUrl = (await r.json()).webSocketDebuggerUrl;
      } catch (_) { await sleep(200); }
    }
    if (!wsUrl) throw new Error('chromium devtools never came up');

    cdp = await connectCdp(wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p = {}) => cdp.send(m, p, sessionId);

    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push('EXCEPTION: ' + (d.exception?.description || d.text));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const t = msg.params.entry.text || '';
        // The SW registration is expected to fail over plain http in headless.
        if (!/service ?worker/i.test(t)) errors.push('CONSOLE: ' + t);
      }
    });

    await S('Runtime.enable');
    await S('Log.enable');
    await S('Page.enable');
    await S('Page.navigate', { url: BASE + '/' });
    await sleep(2500);

    const evalJs = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(expr + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };

    const check = (cond, msg) => { if (!cond) throw new Error(msg); };

    // Home renders the program.
    const cards = await evalJs(`document.querySelectorAll('#todayList .ex-card').length`);
    check(cards === 5, `expected 5 exercise cards, got ${cards}`);
    const firstCard = await evalJs(`document.querySelector('#todayList .ex-card').innerText.replace(/\\n/g,' ')`);
    check(/Leg Press/.test(firstCard) && /140 lb/.test(firstCard), `bad first card: ${firstCard}`);

    // Optional lift toggles in and back out.
    await evalJs(`document.getElementById('optLegCurl').click()`);
    await sleep(500);
    check(await evalJs(`document.querySelectorAll('#todayList .ex-card').length`) === 6, 'leg curl did not appear');
    await evalJs(`document.getElementById('optLegCurl').click()`);
    await sleep(500);

    // Start and run the whole workout: 5 exercises x 3 sets.
    await evalJs(`document.getElementById('btnStart').click()`);
    await sleep(400);
    check(await evalJs(`document.getElementById('scr-session').classList.contains('active')`), 'session screen did not open');
    check(/Leg Press/.test(await evalJs(`document.getElementById('exName').innerText`)), 'wrong first exercise');

    // Ask the layout, not the property: an author `display` rule can defeat
    // [hidden] and leave the rest overlay covering the whole session screen.
    const visible = (id) => evalJs(
      `(() => { const e = document.getElementById('${id}');
        return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); })()`);
    check(!(await visible('restPane')), 'rest overlay is covering the session screen');

    // Weight stepper.
    await evalJs(`document.getElementById('wUp').click()`);
    check(await evalJs(`document.getElementById('exWeight').innerText`) === '145', 'weight + failed');
    await evalJs(`document.getElementById('wDown').click()`);
    check(await evalJs(`document.getElementById('exWeight').innerText`) === '140', 'weight − failed');

    // Rep chips.
    await evalJs(`document.querySelector('#repChips button[data-r="12"]').click()`);
    check(await evalJs(`document.getElementById('repVal').innerText`) === '12', 'rep chip failed');
    await evalJs(`document.querySelector('#repChips button[data-r="8"]').click()`);

    for (let i = 0; i < 15; i++) {
      const last = i === 14;
      await evalJs(`document.getElementById('btnLogSet').click()`);
      await sleep(250);
      if (last) break;
      check(await visible('restPane'), `rest pane did not open after set ${i + 1}`);
      await evalJs(`document.getElementById('btnSkipRest').click()`);
      await sleep(200);
      check(!(await visible('restPane')), `rest pane did not close after set ${i + 1}`);
    }

    await sleep(900);
    check(await evalJs(`document.getElementById('scr-done').classList.contains('active')`), 'summary screen did not open');
    const summary = await evalJs(`document.getElementById('doneList').innerText`);
    check(/Leg Press/.test(summary), 'summary missing exercises');
    check(/10 reps/.test(summary) || /aim for 10/.test(summary), `summary missing progression note:\n${summary}`);

    await evalJs(`document.getElementById('btnDoneClose').click()`);
    await sleep(600);
    check(await evalJs(`document.getElementById('scr-home').classList.contains('active')`), 'did not return home');
    const homeAfter = await evalJs(`document.getElementById('todayList').innerText.replace(/\\n/g,' ')`);
    check(/3 × 10/.test(homeAfter), `home did not advance to 3 × 10:\n${homeAfter}`);

    // History renders with the chart.
    await evalJs(`document.getElementById('btnHistory').click()`);
    await sleep(500);
    check(await evalJs(`document.querySelectorAll('#historyList .h-card').length`) >= 1, 'no history card');
    check(await evalJs(`document.querySelectorAll('#chartWrap .chart').length`) >= 1, 'no chart');
    await evalJs(`document.getElementById('btnBackHome').click()`);
    await sleep(300);

    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
    console.log('client-check: ok — full workout ran clean');
  } catch (e) {
    fail = e;
    console.error('client-check FAILED:', e.message);
    if (errors.length) console.error(errors.join('\n'));
    if (slog) console.error('--- server log ---\n' + slog.slice(-1500));
  } finally {
    cleanup();
  }
  process.exit(fail ? 1 : 0);
})();
