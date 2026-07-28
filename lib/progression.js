// Progressive-overload rules. Pure functions — no state, no I/O.
//
// The ladder, per exercise:
//   target 8  → hit 8/8/8   → target 10
//   target 10 → hit 10/10/10 → target 12
//   target 12 → hit 12/12/12 → weight +5, target back to 8
//   any set below 8          → offer a 5 lb drop (never automatic — "may")
//   anything else            → hold, repeat the same weight and target

const SETS = 3;
const REST_SEC = 90;
const MIN_REPS = 8;
const MAX_REPS = 12;
const REP_STEP = 2;
const WEIGHT_STEP = 5;
const MIN_WEIGHT = 5;

// Starting prescription. Order here is the order they're performed.
const EXERCISES = [
  { id: 'leg-press',    name: 'Leg Press',       weight: 140, optional: false },
  { id: 'chest-press',  name: 'Chest Press',     weight: 80,  optional: false },
  { id: 'low-row',      name: 'Low Row',         weight: 80,  optional: false },
  { id: 'lat-pulldown', name: 'Vertical Traction', short: 'Lat Pulldown', weight: 60, optional: false },
  { id: 'overhead',     name: 'Overhead Press',  weight: 25,  optional: false },
  { id: 'leg-curl',     name: 'Leg Curl',        weight: 60,  optional: true },
];

// A fresh per-exercise progression state.
function startingState() {
  const out = {};
  for (const e of EXERCISES) out[e.id] = { weight: e.weight, target: MIN_REPS };
  return out;
}

function clampReps(n) {
  n = Math.round(Number(n) || 0);
  if (n < 0) return 0;
  if (n > MAX_REPS) return MAX_REPS;
  return n;
}

// Given the state an exercise was performed at and the reps actually logged,
// return the state for the NEXT workout plus what happened and why.
//
// `sets` is an array of rep counts. Sets left blank count as 0 (a miss).
function nextState(cur, sets) {
  const weight = Number(cur.weight) || 0;
  const target = Number(cur.target) || MIN_REPS;
  const reps = Array.from({ length: SETS }, (_, i) => clampReps(sets[i]));
  const low = Math.min(...reps);

  if (low >= MAX_REPS) {
    return {
      weight: weight + WEIGHT_STEP,
      target: MIN_REPS,
      action: 'weight-up',
      note: `${MAX_REPS}x${SETS} cleared — up to ${weight + WEIGHT_STEP} lb, back to ${MIN_REPS} reps`,
    };
  }
  if (low >= target) {
    const next = Math.min(target + REP_STEP, MAX_REPS);
    return {
      weight,
      target: next,
      action: 'reps-up',
      note: `Target hit — aim for ${next} reps next time`,
    };
  }
  if (low < MIN_REPS) {
    const dropped = Math.max(MIN_WEIGHT, weight - WEIGHT_STEP);
    return {
      weight,
      target,
      action: 'suggest-deload',
      suggestWeight: dropped,
      // Only a real drop if we aren't already at the floor.
      canDrop: dropped < weight,
      note: `Missed ${MIN_REPS} on a set — you can drop to ${dropped} lb`,
    };
  }
  return {
    weight,
    target,
    action: 'hold',
    note: `Short of ${target} — repeat ${weight} lb`,
  };
}

module.exports = {
  SETS, REST_SEC, MIN_REPS, MAX_REPS, REP_STEP, WEIGHT_STEP, MIN_WEIGHT,
  EXERCISES, startingState, clampReps, nextState,
};
