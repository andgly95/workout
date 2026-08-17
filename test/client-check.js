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
    env: {
      ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'store.json'),
      // Keeps the minted VAPID keypair out of the working tree, and the once-a-
      // minute reminder sender out of the run.
      CONFIG_FILE: path.join(dir, 'config.json'), NO_PUSH: '1',
    },
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

    // Ask the layout, not the property: an author `display` rule can defeat
    // [hidden] and leave the rest overlay covering the whole session screen.
    const visible = (id) => evalJs(
      `(() => { const e = document.getElementById('${id}');
        return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); })()`);

    // Home renders the starter plan — all six seeded machines.
    const cards = await evalJs(`document.querySelectorAll('#todayList .ex-card').length`);
    check(cards === 6, `expected 6 exercise cards, got ${cards}`);
    const firstCard = await evalJs(`document.querySelector('#todayList .ex-card').innerText.replace(/\\n/g,' ')`);
    check(/Leg Press/.test(firstCard) && /140 lb/.test(firstCard), `bad first card: ${firstCard}`);

    // ── progressive disclosure: one plan shows no picker ─────────────────
    // With a single plan the home screen has to be exactly what it was before
    // plans existed. A list of one is not a choice.
    check(!(await visible('planRow')), 'the plan picker must stay hidden with one plan');
    check(/My workout/.test(await evalJs(`document.getElementById('planName').innerText`)),
      'the plan name should be on the home screen');
    check(/8 → 10 → 12/.test(await evalJs(`document.getElementById('planMeta').innerText`)),
      'the ladder should be stated in words, from the server');

    // ── the plan editor ─────────────────────────────────────────────────
    await evalJs(`document.getElementById('btnEditPlan').click()`);
    await sleep(500);
    check(await visible('scr-plan'), 'the plan editor did not open');
    check(await evalJs(`document.querySelectorAll('#planMachines .pm-row').length`) === 6,
      'every machine should be listed and reorderable');
    // Both settings sections are collapsed: the summary line is readable without
    // opening anything, and the knobs are one tap away.
    check(await evalJs(`document.querySelectorAll('#planDiscs .disc').length`) === 2,
      'expected the overload and schedule sections');
    check(await evalJs(`document.querySelectorAll('#planDiscs .disc-bd').length`) === 0,
      'both sections must start collapsed — that is the disclosure');
    check(/8 → 10 → 12/.test(await evalJs(`document.querySelector('#planDiscs .disc-hd small').innerText`)),
      'the collapsed overload section should say what it does');

    // Reorder: the leg press moves down and the prescription follows.
    await evalJs(`document.querySelector('#planMachines .pm-row [data-move="1"]').click()`);
    await sleep(600);
    check(/Chest Press/.test(await evalJs(`document.querySelector('#planMachines .pm-bd b').innerText`)),
      'moving the first machine down did not reorder the plan');
    // Put it back — the rest of this run exercises the known program.
    await evalJs(`document.querySelectorAll('#planMachines .pm-row')[1].querySelector('[data-move="-1"]').click()`);
    await sleep(600);
    check(/Leg Press/.test(await evalJs(`document.querySelector('#planMachines .pm-bd b').innerText`)),
      'moving it back up did not restore the order');

    // Drop one, and it leaves the prescription.
    await evalJs(`document.querySelectorAll('#planMachines .pm-row [data-drop]')[5].click()`);
    await sleep(600);
    check(await evalJs(`document.querySelectorAll('#planMachines .pm-row').length`) === 5,
      'removing a machine did not take it out of the plan');

    // Open the overload section and change the ladder.
    await evalJs(`document.querySelectorAll('#planDiscs .disc-hd')[0].click()`);
    await sleep(300);
    check(await visible('planDiscs'), 'the disclosure body is not on screen');
    check(await evalJs(`document.querySelectorAll('#planDiscs .disc-bd .fix-row').length`) === 5,
      'expected sets / min / max / step / rest');
    await evalJs(`document.querySelector('#planDiscs [data-rule="sets"][data-d="1"]').click()`);
    await sleep(600);
    check(/4 sets/.test(await evalJs(`document.querySelector('#planDiscs .disc-hd small').innerText`)),
      'the summary must follow the change it describes');

    // ── the schedule ────────────────────────────────────────────────────
    await evalJs(`document.querySelectorAll('#planDiscs .disc-hd')[1].click()`);
    await sleep(300);
    await evalJs(`document.querySelector('#planDiscs [data-mode="interval"]').click()`);
    await sleep(600);
    check(/Every 2 days/.test(await evalJs(`document.querySelectorAll('#planDiscs .disc-hd small')[1].innerText`)),
      'every-other-day should read back as such');
    await evalJs(`document.querySelectorAll('#planDiscs .disc-hd')[1].click()`);
    await sleep(200);
    await evalJs(`document.querySelectorAll('#planDiscs .disc-hd')[1].click()`);
    await sleep(300);
    await evalJs(`document.querySelector('#planDiscs [data-mode="weekdays"]').click()`);
    await sleep(600);
    await evalJs(`document.querySelector('#planDiscs [data-dow="3"]').click()`);
    await sleep(600);
    check(/Wed/.test(await evalJs(`document.querySelectorAll('#planDiscs .disc-hd small')[1].innerText`)),
      'picking a weekday should read back as that day');

    // A schedule with no history behind it is due NOW — deterministic whatever day
    // this suite runs on, unlike a weekday rule.
    await evalJs(`document.querySelector('#planDiscs [data-mode="interval"]').click()`);
    await sleep(700);
    check(/every.*day/i.test(await evalJs(`document.getElementById('pushNote').innerText`))
      || (await evalJs(`document.getElementById('pushNote').innerText`)).length > 10,
      'the reminder note should say whether it can actually reach you');
    await evalJs(`document.getElementById('planBack').click()`);
    await sleep(600);
    check(/Due today/.test(await evalJs(`document.getElementById('homeSub').innerText`)),
      `a scheduled plan with no history should read as due: ${await evalJs(`document.getElementById('homeSub').innerText`)}`);
    check(await evalJs(`document.getElementById('homeSub').classList.contains('due')`),
      'and it is the one thing on this screen worth colouring');
    // Back off the schedule so the rest of the run is unscheduled.
    await evalJs(`document.getElementById('btnEditPlan').click()`);
    await sleep(400);
    await evalJs(`document.querySelectorAll('#planDiscs .disc-hd')[1].click()`);
    await sleep(300);
    await evalJs(`document.querySelector('#planDiscs [data-mode="off"]').click()`);
    await sleep(600);

    // ── a second plan, and the picker appearing ─────────────────────────
    await evalJs(`document.getElementById('planNew').click()`);
    await sleep(800);
    check(/Workout B/.test(await evalJs(`document.getElementById('planTitle').innerText`)),
      'a new plan should be named for you');
    check(await evalJs(`document.querySelectorAll('#planMachines .pm-row').length`) === 5,
      'a new plan copies the one you were looking at rather than starting empty');
    await evalJs(`document.getElementById('planBack').click()`);
    await sleep(500);
    check(await visible('planRow'), 'two plans must surface the picker');
    check(await evalJs(`document.querySelectorAll('#planRow [data-plan]').length`) === 2,
      'expected a chip per plan');

    // Switching plans switches the prescription, and each keeps its own weights.
    await evalJs(`document.querySelectorAll('#planRow [data-plan]')[1].click()`);
    await sleep(700);
    check(/Workout B/.test(await evalJs(`document.getElementById('planName').innerText`)),
      'tapping a chip did not switch plans');
    await evalJs(`document.querySelectorAll('#planRow [data-plan]')[0].click()`);
    await sleep(700);
    check(/My workout/.test(await evalJs(`document.getElementById('planName').innerText`)),
      'could not switch back');
    // Put the plan back to three sets so the rest of the run is the known program.
    await evalJs(`document.getElementById('btnEditPlan').click()`);
    await sleep(400);
    await evalJs(`document.querySelectorAll('#planDiscs .disc-hd')[0].click()`);
    await sleep(300);
    await evalJs(`document.querySelector('#planDiscs [data-rule="sets"][data-d="-1"]').click()`);
    await sleep(600);
    await evalJs(`document.getElementById('planBack').click()`);
    await sleep(500);
    check(await evalJs(`document.querySelectorAll('#todayList .ex-card').length`) === 5,
      'home should show the five machines the plan now has');

    // Start and run the whole workout: 5 exercises x 3 sets.
    await evalJs(`document.getElementById('btnStart').click()`);
    await sleep(400);
    check(await evalJs(`document.getElementById('scr-session').classList.contains('active')`), 'session screen did not open');
    check(/Leg Press/.test(await evalJs(`document.getElementById('exName').innerText`)), 'wrong first exercise');

    check(!(await visible('restPane')), 'rest overlay is covering the session screen');

    // Weight stepper — one notch is the MACHINE's step, so the leg press moves 20.
    await evalJs(`document.getElementById('wUp').click()`);
    check(await evalJs(`document.getElementById('exWeight').innerText`) === '160',
      'the stepper should move the leg press by its own 20 lb increment');
    await evalJs(`document.getElementById('wDown').click()`);
    check(await evalJs(`document.getElementById('exWeight').innerText`) === '140', 'weight − failed');

    // Rep chips.
    await evalJs(`document.querySelector('#repChips button[data-r="12"]').click()`);
    check(await evalJs(`document.getElementById('repVal').innerText`) === '12', 'rep chip failed');
    await evalJs(`document.querySelector('#repChips button[data-r="8"]').click()`);

    // The rest alert is queued on the AUDIO thread the moment rest starts, not
    // when the countdown hits zero — on a backgrounded iOS PWA no timer ever
    // runs to see it hit zero. Importing the module by its stamped URL gets the
    // same instance app.js is using, so this reads the real state rather than
    // needing a debug hook in production code.
    const alarmPending = () => evalJs(`(async () => {
      const src = document.querySelector('script[type=module]').getAttribute('src');
      const m = await import(src.replace('app.js', 'alarm.js'));
      return m.alarmPending();
    })()`);

    const exNow = () => evalJs(`document.getElementById('exName').innerText`);
    const subNow = () => evalJs(`document.getElementById('exSub').innerText`);
    const dotStates = () => evalJs(
      `Array.from(document.querySelectorAll('#exDots .dotbtn i')).map(i => i.className)`);
    const dotNames = () => evalJs(
      `Array.from(document.querySelectorAll('#exDots .dotbtn')).map(b => b.getAttribute('aria-label'))`);
    const inSession = () => evalJs(`document.getElementById('scr-session').classList.contains('active')`);

    // One set of Leg Press, then the machine gets taken.
    await evalJs(`document.getElementById('btnLogSet').click()`);
    await sleep(250);
    check(await visible('restPane'), 'rest pane did not open after the first set');
    check(await alarmPending() === true,
      'starting a rest did not schedule the alert on the audio thread');
    await evalJs(`document.getElementById('btnSkipRest').click()`);
    await sleep(200);
    check(!(await visible('restPane')), 'rest pane did not close');
    check(await alarmPending() === false,
      'skipping rest must unschedule the tone, or it fires mid-set');

    // ── the occupied machine ────────────────────────────────────────────
    // "Machine busy" sends it to the back of the queue and moves you on. It must
    // NOT count as skipped: the set already logged has to survive.
    check(/Leg Press/.test(await exNow()), 'should still be on Leg Press');
    await evalJs(`document.getElementById('btnBusy').click()`);
    await sleep(300);
    check(/Chest Press/.test(await exNow()),
      `busy should move on to the next machine, got ${await exNow()}`);
    const names = await dotNames();
    check(/Leg Press/.test(names[names.length - 1]),
      `the busy machine should be last in the queue, got ${names.join(', ')}`);
    // Half-finished is its own state — that is the dot you have to come back to.
    check((await dotStates()).includes('part'),
      'a machine with sets logged but unfinished should read as part-done');

    // ── going back to it, at any point ──────────────────────────────────
    // Tapping its dot jumps straight there, and it must resume on set 2 — which
    // only works because the set index is derived from the entry, not stored on
    // the session.
    await evalJs(`Array.from(document.querySelectorAll('#exDots .dotbtn')).pop().click()`);
    await sleep(300);
    check(/Leg Press/.test(await exNow()), 'tapping a dot did not jump to that machine');
    check(/Set 2 of 3/.test(await subNow()),
      `coming back should resume on set 2, got: ${await subNow()}`);
    // And back out again to carry on where we were.
    await evalJs(`document.querySelectorAll('#exDots .dotbtn')[0].click()`);
    await sleep(300);
    check(/Chest Press/.test(await exNow()), 'jumping back to the first dot failed');

    // Skip one machine outright, so history has an accidental skip to undo later.
    // Undo it once in-session first — a skipped machine used to be a dead end you
    // could jump to and not get out of.
    check(/Chest Press/.test(await exNow()), 'expected to be on Chest Press');
    await evalJs(`document.getElementById('btnSkipEx').click()`);
    await sleep(300);
    await evalJs(`document.querySelectorAll('#exDots .dotbtn')[0].click()`);
    await sleep(300);
    check(/Chest Press/.test(await exNow()), 'could not jump back to the skipped machine');
    check(await visible('btnUnskip'), 'a skipped machine must offer a way back');
    await evalJs(`document.getElementById('btnUnskip').click()`);
    await sleep(300);
    check(/Set 1 of 3/.test(await subNow()),
      `undoing a skip should hand the machine back on set 1, got: ${await subNow()}`);
    check(!(await visible('btnUnskip')), 'undo should go away once it is undone');
    // Now skip it for real and leave it that way.
    await evalJs(`document.getElementById('btnSkipEx').click()`);
    await sleep(300);

    // Log everything that's left, in whatever order the queue ended up in.
    // Driving it by "is the session still open" rather than a fixed 15 is what
    // makes this test survive a reorder at all.
    let logged = 1;
    for (let i = 0; i < 30 && await inSession(); i++) {
      await evalJs(`document.getElementById('btnLogSet').click()`);
      await sleep(250);
      logged++;
      if (!(await inSession())) break;
      if (!(await visible('restPane'))) continue;   // moved on without resting
      if (i === 1) {
        // +30s tears the rest down and rebuilds it. If it forgot to re-queue the
        // tone you would get a silent rest and no way to tell until the gym.
        await evalJs(`document.getElementById('btnAddRest').click()`);
        await sleep(200);
        check(await alarmPending() === true, '+30s dropped the alert instead of moving it');
      }
      await evalJs(`document.getElementById('btnSkipRest').click()`);
      await sleep(200);
      check(!(await visible('restPane')), `rest pane did not close after set ${i + 1}`);
    }
    check(logged === 12, `expected 12 sets across 4 machines (one skipped), logged ${logged}`);

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

    // The rest-alerts switch is offered on the home screen.
    check(await visible('alertRow'), 'the rest-alerts row should be on the home screen');

    // History renders with the calendar and the chart.
    await evalJs(`document.getElementById('btnHistory').click()`);
    await sleep(500);
    check(await evalJs(`document.querySelectorAll('#historyList .h-card').length`) >= 1, 'no history card');
    check(await evalJs(`document.querySelectorAll('#chartWrap .chart').length`) >= 1, 'no chart');

    // ── the twelve-week calendar ────────────────────────────────────────
    // By layout, not by property: a collapsed grid would still have 84 nodes.
    check(await visible('calWrap'), 'the calendar is in the DOM but not on screen');
    const squares = await evalJs(`document.querySelectorAll('#calWrap .hm-col i').length`);
    check(squares === 84, `expected 84 day squares, got ${squares}`);
    check(await evalJs(`document.querySelectorAll('#calWrap .hm-col').length`) === 12,
      'expected twelve week columns');
    const sqW = await evalJs(
      `document.querySelector('#calWrap .hm-col i').getBoundingClientRect().width`);
    check(sqW >= 8, `day squares are too small to hit with a thumb: ${sqW}px`);

    // The workout just logged should light today's square and carry its id.
    check(await evalJs(`document.querySelectorAll('#calWrap .hm-col i[data-w]').length`) >= 1,
      'the workout just logged did not light a square');

    // Tapping a lit square flashes its card in the list below.
    await evalJs(`document.querySelector('#calWrap .hm-col i[data-w]').click()`);
    await sleep(400);
    check(await evalJs(`document.querySelectorAll('#historyList .h-card.lit').length`) === 1,
      'tapping a day did not highlight its workout');
    check(/a week/.test(await evalJs(`document.querySelector('#calWrap .hm-foot').innerText`)),
      'the calendar should report the per-week rate');

    // ── undoing that skip, after the fact ───────────────────────────────
    // The whole point is that the prescription catches up: a skip is "no signal"
    // and silently costs that machine its advance, so a repair that only edited
    // the record would be cosmetic.
    const chestTarget = () => evalJs(
      `(async () => (await (await fetch('/api/state')).json())
        .planned.find(p => p.id === 'chest-press').target)()`);
    const chestBefore = await chestTarget();
    check(await visible('historyList'), 'history list is not on screen');
    check(await evalJs(`document.querySelectorAll('#historyList [data-fix]').length`) === 1,
      'the skipped lift should be the one tappable line in history');
    await evalJs(`document.querySelector('#historyList [data-fix]').click()`);
    await sleep(300);
    check(await visible('fixPane'), 'the fix sheet did not open');
    check(/Chest Press/.test(await evalJs(`document.getElementById('fixTitle').innerText`)),
      'the fix sheet named the wrong machine');
    check(await evalJs(`document.querySelectorAll('#fixSets .fix-row').length`) === 3,
      'expected one stepper per set');
    // It defaults to what was prescribed, so the usual repair is a single tap.
    check(await evalJs(`document.querySelector('#fixSets .fix-row b').innerText`) === String(chestBefore),
      'the sets should default to the target that was prescribed');
    await evalJs(`document.getElementById('fixSave').click()`);
    await sleep(700);
    check(!(await visible('fixPane')), 'the fix sheet did not close');
    check(await evalJs(`document.querySelectorAll('#historyList [data-fix]').length`) === 0,
      'the line should stop reading as skipped once it is fixed');
    const chestAfter = await chestTarget();
    check(chestAfter === chestBefore + 2,
      `the prescription must catch up: ${chestBefore} -> ${chestAfter}`);

    await evalJs(`document.getElementById('btnBackHome').click()`);
    await sleep(300);

    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
    console.log('client-check: ok — full workout, calendar and alerts all clean');
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
