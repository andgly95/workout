// Deployment-local config: things that are true of THIS install and must never
// reach the repo. Currently just the VAPID keypair that signs push messages.
//
// `config.local.json` is gitignored and written 0600. The file is created lazily —
// nothing generates keys until something actually asks for the public one — and
// the path is overridable so the test suite never writes into the working tree.
const fs = require('fs');
const path = require('path');

const FILE = process.env.CONFIG_FILE || path.join(__dirname, '..', 'config.local.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; }
}

function write(cfg) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error('config write failed:', e.message);
    return false;
  }
}

function get(key, fallback = null) {
  const v = read()[key];
  return v === undefined ? fallback : v;
}

function set(patch) {
  const cfg = { ...read(), ...patch };
  write(cfg);
  return cfg;
}

module.exports = { FILE, read, get, set };
