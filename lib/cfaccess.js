// Cloudflare Access as an identity source.
//
// Access sits in front of the tunnel, does the Google (or whatever) login itself,
// and hands the origin a signed JWT — `Cf-Access-Jwt-Assertion`, or the
// `CF_Authorization` cookie. If it verifies, the person is already authenticated
// and the app never has to show a sign-in button at all.
//
// **The header is verified, never trusted.** That is the whole point of this
// file. Anyone who can reach the origin directly — over the LAN, or if the tunnel
// is ever bypassed — can set any header they like, so believing
// `Cf-Access-Authenticated-User-Email` (which is the tempting one-liner) is a
// total auth bypass for anyone on the same network. The signature is checked
// against the team's published keys and every claim is checked with it.
const crypto = require('crypto');
const config = require('./config');

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

let cache = { at: 0, keys: null, team: null };

const team = () => config.get('cfAccessTeam', null);
// The Access application's AUD tag. Without it a token minted for ANY app on the
// same team would be accepted here, which is a real hole on a team that fronts
// several apps — and this one fronts four.
const audience = () => config.get('cfAccessAud', null);

const configured = () => !!(team() && audience());

// Both derive from the team name, and both can be overridden in config — for a
// self-hoster fronting this differently, and so the verifier can be pointed at a
// stand-in JWKS in the test suite instead of being a branch nobody ever runs.
// Not a weakening: anything that can write config already owns the box.
const issuer = () => config.get('cfAccessIssuer', null) || `https://${team()}.cloudflareaccess.com`;
const certsUrl = () => config.get('cfAccessCertsUrl', null) || `${issuer()}/cdn-cgi/access/certs`;

async function jwks(fetchImpl = fetch) {
  if (cache.keys && cache.team === team() && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const r = await fetchImpl(certsUrl());
  if (!r.ok) throw new Error(`Access certs ${r.status}`);
  const body = await r.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  cache = { at: Date.now(), keys, team: team() };
  return keys;
}

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Verify an RS256 JWT against a JWKS. Pure — takes the keys and the clock — so the
// whole thing can be driven from a locally generated keypair in the test suite
// instead of being a code path nobody exercises until it matters.
//
// `alg` is pinned. Reading the algorithm out of the header and honouring it is
// the classic JWT bug: `none` authenticates everyone, and HS256 lets the public
// key be used as an HMAC secret.
function verifyJwt(token, keys, { iss, aud, now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h64, p64, s64] = parts;

  let head, claims;
  try { head = b64urlJson(h64); claims = b64urlJson(p64); } catch (_) { return null; }
  if (!head || head.alg !== 'RS256' || !head.kid) return null;
  if (!claims || typeof claims !== 'object') return null;

  const jwk = (keys || []).find(k => k.kid === head.kid && (!k.alg || k.alg === 'RS256'));
  if (!jwk) return null;

  let key;
  try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch (_) { return null; }
  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${h64}.${p64}`),
    key,
    Buffer.from(s64, 'base64url'),
  );
  if (!ok) return null;

  const secs = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < secs) return null;
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > secs) return null;
  if (iss && claims.iss !== iss) return null;
  // `aud` may be a string or an array, per the JWT spec.
  if (aud) {
    const list = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!list.includes(aud)) return null;
  }
  return claims;
}

// Pull the assertion off a request. Cloudflare sends both; either is fine, and
// neither is believed until verifyJwt has had it.
function tokenFrom(req) {
  const h = req.headers['cf-access-jwt-assertion'];
  if (typeof h === 'string' && h) return h;
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'CF_Authorization') return part.slice(i + 1).trim();
  }
  return null;
}

// → { id, email, name, picture, via } or null. Never throws: a failure to reach
// Cloudflare's certs must degrade to "not signed in via Access", not to a 500 on
// every request.
async function identify(req, deps = {}) {
  if (!configured()) return null;
  const token = tokenFrom(req);
  if (!token) return null;
  let keys;
  try { keys = await (deps.jwks ? deps.jwks() : jwks()); } catch (e) {
    console.error('cfaccess: could not fetch certs —', e.message);
    return null;
  }
  const claims = verifyJwt(token, keys, { iss: issuer(), aud: audience(), now: deps.now });
  if (!claims || !claims.email || !claims.sub) return null;
  return {
    // Namespaced, so an Access user id can never collide with a Google `sub`.
    id: `cf:${claims.sub}`,
    email: String(claims.email).toLowerCase(),
    name: String(claims.email).split('@')[0].slice(0, 60),
    picture: null,
    via: 'cloudflare',
  };
}

// What Cloudflare actually sent, WITHOUT verifying it.
//
// Only ever for the setup diagnostic below: finding the AUD tag is a chicken-and-
// egg problem, since you cannot verify an assertion until you have configured the
// audience you are trying to read off it. Nothing here is trusted for auth, and
// nothing is disclosed — every value comes out of a token the caller sent us.
function peek(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return { malformed: true };
  try {
    const c = b64urlJson(parts[1]);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    return {
      iss: typeof c.iss === 'string' ? c.iss : null,
      aud: aud.filter(x => typeof x === 'string'),
      email: typeof c.email === 'string' ? c.email : null,
      expiresAt: typeof c.exp === 'number' ? new Date(c.exp * 1000).toISOString() : null,
    };
  } catch (_) { return { malformed: true }; }
}

module.exports = {
  peek,
  configured, issuer, audience, certsUrl, jwks, verifyJwt, tokenFrom, identify,
  JWKS_TTL_MS, CLOCK_SKEW_S,
  _resetCache: () => { cache = { at: 0, keys: null, team: null }; },
};
