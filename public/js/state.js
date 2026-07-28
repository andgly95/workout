// The S bag — all shared mutable client state (same convention as the-square).
export const S = {
  wire: null,       // last /api/state payload
  session: null,    // in-progress workout, or null
  lastOutcomes: [], // progression results shown on the summary screen
  online: navigator.onLine,
  wakeLock: null,
  restTimer: null,
  tickTimer: null,
};

export const LS = {
  session: 'liftSession',
  wire: 'liftWire',
  queue: 'liftQueue',
};

export function loadLocal(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}

export function saveLocal(key, val) {
  try {
    if (val === null || val === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(val));
  } catch (_) {}
}
