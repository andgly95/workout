// Google sign-in, sessions, and the boundary between one person's data and
// everyone else's.
//
// This file is the only thing standing between a stranger and your training log,
// so the rules it enforces are deliberately few and stated once:
//
//   1. A session cookie is HMAC-signed. Unsigned, expired or tampered → no user.
//   2. A user is `pending` until the owner approves them. Pending users can read
//      their own status and NOTHING else — no data slice is even created.
//   3. Every data route resolves the slice from `req.user.id`, never from
//      anything the client sent. There is no route that takes a user id.
//
// Rule 3 is the one that matters. A uid in a path or a body is how a multi-user
// app leaks: it only takes one handler that forgets to check it against the
// session. Here there is nothing to forget, because the id is never accepted.
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'lift_session';
const MAX_AGE_DAYS = 120;   // a gym app you open twice a week; re-login is friction
const CLOCK_SKEW_S = 60;

/* ── the session cookie ─────────────────────────────────────────────────── */

// Minted lazily like the VAPID pair, into the same gitignored config. Rotating it
// (deleting the key) signs everybody out, which is the whole revocation story and
// is enough at this scale.
function secret() {
  let s = config.get('sessionSecret');
  if (!s) {
    s = crypto.randomBytes(32).toString('base64url');
    config.set({ sessionSecret: s });
    console.log('auth: generated a session secret in', config.FILE);
  }
  return s;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

// `<payload>.<sig>` where payload is base64url JSON. Stateless on purpose: no
// session table to grow, and a restart doesn't sign everyone out.
function sign(uid, sec = secret(), now = Date.now()) {
  const payload = b64(JSON.stringify({ u: uid, e: now + MAX_AGE_DAYS * 86400000 }));
  return `${payload}.${hmac(payload, sec)}`;
}

function hmac(payload, sec) {
  return crypto.createHmac('sha256', sec).update(payload).digest('base64url');
}

// Returns the uid, or null. Never throws — a malformed cookie is just not a
// session, and a handler that had to try/catch this would eventually forget to.
function verify(token, sec = secret(), now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = hmac(payload, sec);
  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // mismatch rather than returning false.
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let data;
  try { data = JSON.parse(unb64(payload)); } catch (_) { return null; }
  if (!data || typeof data.u !== 'string' || typeof data.e !== 'number') return null;
  if (data.e < now) return null;
  return data.u;
}

// No cookie-parser dependency for one cookie.
function readCookie(header, name = COOKIE) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieHeader(token, { secure = true } = {}) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',                  // never readable from JS, so XSS can't lift it
    'SameSite=Lax',              // survives the return trip from Google
    `Max-Age=${MAX_AGE_DAYS * 86400}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const clearHeader = () =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/* ── Google ─────────────────────────────────────────────────────────────── */

// The client ID is not a secret (it ships to the browser), but it is
// deployment-specific, so it lives in config rather than the repo.
const clientId = () => config.get('googleClientId', null);

let client = null;
function googleClient() {
  if (!client) {
    const { OAuth2Client } = require('google-auth-library');
    client = new OAuth2Client(clientId());
  }
  return client;
}

// Verify an ID token from Google Identity Services. Hand-rolling RS256 + JWKS
// caching + every `iss`/`aud`/`exp` edge case is exactly the sort of thing that
// looks right and isn't, so this is the one place a library earns its keep.
//
// Returns the claims we care about, or null. `sub` is the user id: it is stable
// and unique forever, which an email address is not.
async function verifyGoogleToken(idToken) {
  const aud = clientId();
  if (!aud) throw new Error('googleClientId is not configured');
  const ticket = await googleClient().verifyIdToken({ idToken, audience: aud });
  const p = ticket.getPayload();
  if (!p || !p.sub) return null;
  // An unverified email must not be trusted for the owner check below, or anyone
  // could claim an address they don't control.
  if (!p.email || p.email_verified !== true) return null;
  return {
    id: String(p.sub),
    email: String(p.email).toLowerCase(),
    name: String(p.name || p.email).slice(0, 60),
    picture: typeof p.picture === 'string' ? p.picture.slice(0, 300) : null,
  };
}

module.exports = {
  COOKIE, MAX_AGE_DAYS, CLOCK_SKEW_S,
  secret, sign, verify, readCookie, cookieHeader, clearHeader,
  clientId, verifyGoogleToken,
};
