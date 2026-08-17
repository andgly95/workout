// The plan editor: what's in a workout, how it overloads, and when it's due.
//
// PROGRESSIVE DISCLOSURE is the organising rule here, because the three things
// this screen can change are wanted at wildly different rates. Reordering and
// adding machines is routine. Changing the rep ladder happens once, if ever.
// Changing the schedule happens once. So the machines are open and the other two
// are collapsed to a single line of plain English that states what they currently
// do — you can read the whole plan without opening anything, and the settings are
// one tap away when you actually want them.
//
// The words in those summary lines come from the SERVER (`plan.rulesLabel`, from
// progression.describeRules). A label the client worded itself would drift from
// what nextState actually does the first time the rules gained a knob.
import { S } from './state.js';
import { $, esc, toast, showScreen } from './util.js';
import { patchPlan, createPlan, deletePlan, saveExercise, createExercise, removeExercise } from './sync.js';

let onChange = () => {};
let onBack = () => {};
let editing = null;      // plan id
let open = {};           // which disclosures are expanded, by key
let exEditing = null;    // exercise id being edited in the sheet, or 'new'

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const plansOf = () => S.wire?.plans || [];
const cur = () => plansOf().find(p => p.id === editing) || null;
const exById = (id) => (S.wire?.exercises || []).find(e => e.id === id) || null;

export function openPlan(id) {
  editing = id || S.wire?.activePlanId;
  open = {};
  showScreen('scr-plan');
  renderPlan();
}

/* ── the machines in this workout ───────────────────────────────────────── */

function machinesHtml(p) {
  if (!p.exerciseIds.length) {
    return `<div class="empty-note" style="padding:26px 10px">
      Nothing in this workout yet.<br>Add a machine below.</div>`;
  }
  return p.exerciseIds.map((id, i) => {
    const e = exById(id);
    if (!e) return '';
    const prog = (S.wire?.progress || {})[id];
    const at = prog ? `${prog.weight} lb · ${prog.target} reps` : `starts at ${e.weight} lb`;
    return `<div class="pm-row" data-ex="${esc(id)}">
      <div class="pm-move">
        <button data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button data-move="1" ${i === p.exerciseIds.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      </div>
      <button class="pm-bd" data-edit-ex>
        <b>${esc(e.name)}</b>
        <small>${esc(at)} · +${e.step} lb a step</small>
      </button>
      <button class="pm-x" data-drop aria-label="Remove from this workout">×</button>
    </div>`;
  }).join('');
}

/* ── the two collapsed sections ─────────────────────────────────────────── */

function disclosure(key, title, summary, body) {
  const isOpen = !!open[key];
  return `<section class="disc ${isOpen ? 'open' : ''}">
    <button class="disc-hd" data-disc="${key}">
      <div>
        <b>${esc(title)}</b>
        <small>${esc(summary)}</small>
      </div>
      <i class="chev">${isOpen ? '⌃' : '⌄'}</i>
    </button>
    ${isOpen ? `<div class="disc-bd">${body}</div>` : ''}
  </section>`;
}

function stepper(label, key, value, hint) {
  return `<div class="fix-row">
    <span>${esc(label)}${hint ? `<em>${esc(hint)}</em>` : ''}</span>
    <button class="rbtn sm" data-rule="${key}" data-d="-1" aria-label="Less">−</button>
    <b>${value}</b>
    <button class="rbtn sm" data-rule="${key}" data-d="1" aria-label="More">+</button>
  </div>`;
}

function rulesBody(p) {
  const r = p.rules;
  return `
    ${stepper('Sets', 'sets', r.sets)}
    ${stepper('Start at', 'minReps', r.minReps, 'reps')}
    ${stepper('Go up to', 'maxReps', r.maxReps, 'reps')}
    ${stepper('Rep step', 'repStep', r.repStep, 'each time you clear it')}
    ${stepper('Rest', 'restSec', r.restSec, 'seconds')}
    <p class="disc-note">Clear every set at ${r.maxReps} reps and the weight goes up by
      whatever that machine's stack supports, and the target drops back to ${r.minReps}.
      Each machine carries its own step — tap one above to change it.</p>`;
}

function scheduleBody(p) {
  const s = p.schedule;
  const modes = [['off', 'Not scheduled'], ['weekdays', 'Certain days'], ['interval', 'Every so often']];
  return `
    <div class="seg" id="schedMode">
      ${modes.map(([m, label]) =>
        `<button data-mode="${m}" class="${s.mode === m ? 'on' : ''}">${esc(label)}</button>`).join('')}
    </div>
    ${s.mode === 'weekdays' ? `
      <div class="dows">
        ${WD.map((d, i) =>
          `<button data-dow="${i}" class="${s.days.includes(i) ? 'on' : ''}">${d[0]}</button>`).join('')}
      </div>` : ''}
    ${s.mode === 'interval' ? `
      ${stepper('Every', 'everyN', s.everyN, s.everyN === 1 ? 'day' : 'days')}
      <p class="disc-note">Counted from the last one you actually finished, not from a
        fixed calendar — do it today and the next is in ${s.everyN} day${s.everyN === 1 ? '' : 's'}.
        Miss one and it stays due rather than quietly sliding.</p>` : ''}
    ${s.mode !== 'off' ? `
      <div class="fix-row">
        <span>Remind me at</span>
        <button class="rbtn sm" data-at="-30" aria-label="Earlier">−</button>
        <b>${esc(s.at)}</b>
        <button class="rbtn sm" data-at="30" aria-label="Later">+</button>
      </div>
      <p class="disc-note" id="pushNote"></p>` : ''}`;
}

function scheduleSummary(p) {
  const s = p.schedule;
  if (s.mode === 'off') return 'Not scheduled';
  if (s.mode === 'weekdays') {
    if (!s.days.length) return 'No days picked yet';
    return `${s.days.map(d => WD[d]).join(', ')} · reminder at ${s.at}`;
  }
  return `Every ${s.everyN === 1 ? 'day' : `${s.everyN} days`} · reminder at ${s.at}`;
}

/* ── render ─────────────────────────────────────────────────────────────── */

export function renderPlan() {
  const p = cur();
  if (!p) return onBack();

  $('planTitle').textContent = p.name;
  $('planNameInput').value = p.name;
  $('planMachines').innerHTML = machinesHtml(p);
  $('planDiscs').innerHTML =
    disclosure('rules', 'Progressive overload', p.rulesLabel, rulesBody(p))
    + disclosure('sched', 'Schedule', scheduleSummary(p), scheduleBody(p));
  $('planDelete').hidden = plansOf().length < 2;

  wire(p);
}

function wire(p) {
  $('planMachines').querySelectorAll('[data-ex]').forEach((row) => {
    const id = row.dataset.ex;
    row.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => move(id, Number(b.dataset.move))));
    row.querySelector('[data-drop]').addEventListener('click', () => drop(id));
    row.querySelector('[data-edit-ex]').addEventListener('click', () => openExercise(id));
  });

  $('planDiscs').querySelectorAll('[data-disc]').forEach((b) => {
    b.addEventListener('click', () => { open[b.dataset.disc] = !open[b.dataset.disc]; renderPlan(); });
  });
  $('planDiscs').querySelectorAll('[data-rule]').forEach((b) => {
    b.addEventListener('click', () => bumpRule(b.dataset.rule, Number(b.dataset.d)));
  });
  $('planDiscs').querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => save({ schedule: { mode: b.dataset.mode } }));
  });
  $('planDiscs').querySelectorAll('[data-dow]').forEach((b) => {
    b.addEventListener('click', () => {
      const d = Number(b.dataset.dow);
      const days = p.schedule.days.includes(d)
        ? p.schedule.days.filter(x => x !== d)
        : [...p.schedule.days, d];
      save({ schedule: { days } });
    });
  });
  $('planDiscs').querySelectorAll('[data-at]').forEach((b) => {
    b.addEventListener('click', () => {
      const [h, m] = p.schedule.at.split(':').map(Number);
      let mins = (h * 60 + m + Number(b.dataset.at) + 1440) % 1440;
      const at = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      save({ schedule: { at } });
    });
  });
  paintPushNote();
}

// Reminders only reach a closed app through push, and push needs the notification
// permission. Say so where the time is set, rather than letting someone pick 18:00
// and hear nothing.
function paintPushNote() {
  const el = $('pushNote');
  if (!el) return;
  const ok = S.wire?.push?.subscribed;
  el.textContent = ok
    ? 'This device will get a notification then, even with the app closed.'
    : 'Turn on rest alerts from the home screen to get this as a notification — otherwise it only shows when you open the app.';
  el.classList.toggle('warn', !ok);
}

/* ── mutations ──────────────────────────────────────────────────────────── */

// Every edit is a PATCH of the whole field, straight away. No save button: this
// screen has a dozen small controls and a phone user should never be wondering
// whether a tap counted.
async function save(patch) {
  const ok = await patchPlan(editing, patch);
  if (!ok) return toast('Could not save — needs a connection');
  renderPlan();
  onChange();
}

const RULE_BOUNDS = {
  sets: [1, 10], minReps: [1, 50], maxReps: [1, 100],
  repStep: [1, 20], restSec: [10, 600], everyN: [1, 14],
};

function bumpRule(key, d) {
  const p = cur();
  if (key === 'everyN') {
    const [lo, hi] = RULE_BOUNDS.everyN;
    return save({ schedule: { everyN: Math.min(hi, Math.max(lo, p.schedule.everyN + d)) } });
  }
  const [lo, hi] = RULE_BOUNDS[key] || [1, 100];
  const step = key === 'restSec' ? 15 : 1;
  const next = Math.min(hi, Math.max(lo, p.rules[key] + d * step));
  save({ rules: { [key]: next } });
}

function move(id, d) {
  const p = cur();
  const ids = [...p.exerciseIds];
  const i = ids.indexOf(id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  save({ exerciseIds: ids });
}

// Out of THIS workout, not out of the catalogue — the machine is still there for
// another plan, and deleting it outright is a separate, louder action.
function drop(id) {
  const p = cur();
  save({ exerciseIds: p.exerciseIds.filter(x => x !== id) });
}

/* ── the exercise sheet ─────────────────────────────────────────────────── */

function openExercise(id) {
  exEditing = id || 'new';
  const e = id ? exById(id) : null;
  $('exTitle').textContent = e ? e.name : 'New machine';
  $('exfName').value = e ? e.name : '';
  $('exfShort').value = e && e.short ? e.short : '';
  $('exfWeight').value = e ? e.weight : 0;
  $('exfStep').value = e ? e.step : 5;
  // Only offered when it's already in the catalogue, and it is the loud version:
  // this pulls the machine out of every plan that uses it.
  $('exDelete').hidden = !id;
  $('exSheet').hidden = false;
}

function closeExercise() { exEditing = null; $('exSheet').hidden = true; }

async function saveExerciseForm() {
  const body = {
    name: $('exfName').value.trim(),
    short: $('exfShort').value.trim(),
    weight: Number($('exfWeight').value),
    step: Number($('exfStep').value),
  };
  if (!body.name) return toast('Give it a name');
  const ok = exEditing === 'new'
    ? await createExercise({ ...body, planId: editing })
    : await saveExercise(exEditing, body);
  if (!ok) return toast('Could not save — needs a connection');
  closeExercise();
  renderPlan();
  onChange();
}

async function dropExerciseEntirely() {
  const e = exById(exEditing);
  if (!e) return;
  const used = plansOf().filter(p => p.exerciseIds.includes(e.id)).length;
  const msg = used > 1
    ? `Delete ${e.name} from all ${used} workouts? Your logged history keeps it.`
    : `Delete ${e.name}? Your logged history keeps it.`;
  if (!confirm(msg)) return;
  const ok = await removeExercise(e.id);
  if (!ok) return toast('Could not delete');
  closeExercise();
  renderPlan();
  onChange();
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

export function initPlan(changeHandler, backHandler) {
  onChange = changeHandler || (() => {});
  onBack = backHandler || (() => {});

  $('planBack').addEventListener('click', () => onBack());
  $('planNameInput').addEventListener('change', () => {
    const name = $('planNameInput').value.trim();
    if (name && name !== cur()?.name) save({ name });
  });
  $('planAddEx').addEventListener('click', () => openExercise(null));
  $('planAddExisting').addEventListener('click', pickExisting);

  $('planNew').addEventListener('click', async () => {
    // Copied from the one you're looking at: "Workout B" is nearly always "A but
    // different", and an empty list means rebuilding it by hand.
    const made = await createPlan({ copyOf: editing });
    if (!made) return toast('Could not create that');
    editing = made.id;
    open = {};
    renderPlan();
    onChange();
  });

  $('planDelete').addEventListener('click', async () => {
    const p = cur();
    if (!p || !confirm(`Delete ${p.name}? Its weights go with it; the sessions you logged stay.`)) return;
    const ok = await deletePlan(p.id);
    if (!ok) return toast('Could not delete');
    onChange();
    onBack();
  });

  $('exCancel').addEventListener('click', closeExercise);
  $('exSave').addEventListener('click', saveExerciseForm);
  $('exDelete').addEventListener('click', dropExerciseEntirely);
  $('exSheet').addEventListener('click', (e) => { if (e.target === $('exSheet')) closeExercise(); });
  $('pickCancel').addEventListener('click', () => { $('pickSheet').hidden = true; });
}

// Machines already in the catalogue but not in this plan — the other half of
// "add", and the reason adding to B doesn't mean retyping A.
function pickExisting() {
  const p = cur();
  const spare = (S.wire?.exercises || []).filter(e => !p.exerciseIds.includes(e.id));
  if (!spare.length) return toast('Every machine you have is already in here');
  $('pickList').innerHTML = spare.map(e =>
    `<button class="pick-row" data-pick="${esc(e.id)}">
      <b>${esc(e.name)}</b><small>${e.weight} lb · +${e.step}</small>
    </button>`).join('');
  $('pickList').querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', () => {
      $('pickSheet').hidden = true;
      save({ exerciseIds: [...p.exerciseIds, b.dataset.pick] });
    });
  });
  $('pickSheet').hidden = false;
  $('pickSheet').onclick = (e) => { if (e.target === $('pickSheet')) $('pickSheet').hidden = true; };
}
