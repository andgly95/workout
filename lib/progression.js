// Progressive-overload rules. Pure functions — no state, no I/O.
//
// The ladder, per exercise:
//   target 8  → hit 8/8/8   → target 10
//   target 10 → hit 10/10/10 → target 12
//   target 12 → hit 12/12/12 → weight +1 step, target back to 8
//   any set below 8          → offer a 1-step drop (never automatic — "may")
//   anything else            → hold, repeat the same weight and target
//
// The step is PER MACHINE, not global: a leg press stack has no 5 lb pin, and an
// overhead press moving 20 at a time would go from liftable to impossible in one
// workout. `step` on each exercise below is what that machine actually supports;
// WEIGHT_STEP is only the fallback for anything that doesn't name one.

const SETS = 3;
const REST_SEC = 90;
const MIN_REPS = 8;
const MAX_REPS = 12;
const REP_STEP = 2;
const WEIGHT_STEP = 5;
const MIN_WEIGHT = 5;

// Starting prescription. Order here is the order they're performed — though a
// session can reorder its own copy when a machine is occupied, which is a fact
// about that afternoon and never written back here.
const EXERCISES = [
  { id: 'leg-press',    name: 'Leg Press',       weight: 140, step: 20, optional: false },
  { id: 'chest-press',  name: 'Chest Press',     weight: 80,  step: 10, optional: false },
  { id: 'low-row',      name: 'Low Row',         weight: 80,  step: 10, optional: false },
  { id: 'lat-pulldown', name: 'Vertical Traction', short: 'Lat Pulldown', weight: 60, step: 10, optional: false },
  { id: 'overhead',     name: 'Overhead Press',  weight: 25,  step: 5,  optional: false },
  { id: 'leg-curl',     name: 'Leg Curl',        weight: 60,  step: 10, optional: true },
];

// The increment for one machine. Looked up by id rather than carried on a logged
// entry: how big a jump the stack supports is a fact about the machine, not about
// the sets you did on it, and storing it per entry would let the two disagree.
function stepFor(id) {
  const e = EXERCISES.find(x => x.id === id);
  return e && e.step > 0 ? e.step : WEIGHT_STEP;
}

// A fresh per-exercise progression state.
function startingState() {
  const out = {};
  for (const e of EXERCISES) out[e.id] = { weight: e.weight, target: MIN_REPS };
  return out;
}

function clampReps(n, max = MAX_REPS) {
  n = Math.round(Number(n) || 0);
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

// The ladder's shape, when a plan doesn't say otherwise. Every one of these is a
// per-plan knob now (see lib/plan.js cleanRules) — these are the numbers the
// original program was built on and remain the defaults for a new plan.
const DEFAULT_RULES = { sets: SETS, minReps: MIN_REPS, maxReps: MAX_REPS, repStep: REP_STEP, restSec: REST_SEC };

// Given the state an exercise was performed at and the reps actually logged,
// return the state for the NEXT workout plus what happened and why.
//
// `reps` is an array of rep counts. Sets left blank count as 0 (a miss).
// `opts` carries the machine's increment (`step`) and the plan's own ladder —
// sets / minReps / maxReps / repStep. Everything defaults to the original
// program, so the whole existing truth table still exercises those numbers.
//
// Still pure, and still the only place these rules live. Making them arguments
// rather than having this file look a plan up is what keeps that true.
function nextState(cur, reps, opts = {}) {
  const r = { ...DEFAULT_RULES, step: WEIGHT_STEP, ...(opts || {}) };
  const weight = Number(cur.weight) || 0;
  const target = Number(cur.target) || r.minReps;
  const got = Array.from({ length: r.sets }, (_, i) => clampReps(reps[i], r.maxReps));
  const low = Math.min(...got);

  if (low >= r.maxReps) {
    return {
      weight: weight + r.step,
      target: r.minReps,
      action: 'weight-up',
      note: `${r.maxReps}x${r.sets} cleared — up to ${weight + r.step} lb, back to ${r.minReps} reps`,
    };
  }
  if (low >= target) {
    const next = Math.min(target + r.repStep, r.maxReps);
    // A plan whose min and max are the same rung (5x5 every time) has nowhere to
    // send the target, so clearing it is a weight jump, not a rep jump.
    if (next > target) {
      return {
        weight,
        target: next,
        action: 'reps-up',
        note: `Target hit — aim for ${next} reps next time`,
      };
    }
    return {
      weight: weight + r.step,
      target: r.minReps,
      action: 'weight-up',
      note: `${target}x${r.sets} cleared — up to ${weight + r.step} lb`,
    };
  }
  if (low < r.minReps) {
    // A machine cannot go lighter than one of its own increments, so the floor
    // moves with the step: 20 on the leg press, 5 on the overhead press.
    const floor = Math.max(MIN_WEIGHT, r.step);
    const dropped = Math.min(weight, Math.max(floor, weight - r.step));
    const canDrop = dropped < weight;
    return {
      weight,
      target,
      action: 'suggest-deload',
      suggestWeight: dropped,
      // Only a real drop if we aren't already at the floor.
      canDrop,
      note: canDrop
        ? `Missed ${r.minReps} on a set — you can drop to ${dropped} lb`
        : `Missed ${r.minReps} on a set — already as light as this machine goes`,
    };
  }
  return {
    weight,
    target,
    action: 'hold',
    note: `Short of ${target} — repeat ${weight} lb`,
  };
}

// The ladder in one line, for the plan editor: "3 sets · 8 → 10 → 12 reps, then
// heavier". Lives here because it is a statement about these rules, and a UI that
// worded it itself would drift from what nextState actually does.
function describeRules(r) {
  const rules = { ...DEFAULT_RULES, ...(r || {}) };
  const rungs = [];
  for (let t = rules.minReps; t <= rules.maxReps && rungs.length < 8; t += rules.repStep) rungs.push(t);
  if (rungs[rungs.length - 1] !== rules.maxReps) rungs.push(rules.maxReps);
  return `${rules.sets} set${rules.sets === 1 ? '' : 's'} · `
    + (rungs.length > 1 ? `${rungs.join(' → ')} reps, then heavier` : `${rungs[0]} reps, then heavier`);
}

module.exports = {
  SETS, REST_SEC, MIN_REPS, MAX_REPS, REP_STEP, WEIGHT_STEP, MIN_WEIGHT,
  DEFAULT_RULES, EXERCISES, stepFor, startingState, clampReps, nextState, describeRules,
};
