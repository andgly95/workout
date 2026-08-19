// Signing in, and the two screens you see before you're let in.
//
// The app boots against /api/auth/me, which is safe to call signed out. Three
// answers, three destinations: anon → the sign-in screen, pending → a holding
// screen, active → the app. Nothing else in the client needs to know about auth
// at all, which is the point of resolving it once here.
import { $, esc, toast } from './util.js';

let onSignedIn = () => {};
let clientId = null;
let via = 'google';

export const state = { status: 'anon', me: null };

export async function checkAuth() {
  try {
    const r = await fetch('/api/auth/me', { cache: 'no-store' });
    const b = await r.json();
    state.status = b.status || 'anon';
    state.me = b.me || null;
    clientId = b.clientId || null;
    via = b.via || 'google';
    return state.status;
  } catch (_) {
    // No network. If we've been in before, the cached shell and the local queue
    // still work — a gym basement must not look like being signed out.
    state.status = localStorage.getItem('liftWasIn') ? 'active' : 'anon';
    return state.status;
  }
}

export function showAuthScreen(status) {
  $('scr-auth').classList.add('active');
  const anon = status !== 'pending';
  $('authSignIn').hidden = !anon;
  $('authPending').hidden = anon;
  if (anon) mountGoogle();
  else $('authPendingWho').textContent = state.me ? state.me.email : '';
}

// Google Identity Services renders its own button. Loaded on demand rather than
// in the shell, so somebody already signed in never fetches it — and so a gym
// with no signal doesn't sit waiting on accounts.google.com.
function mountGoogle() {
  // Behind Cloudflare Access there is nothing to press: Access authenticates you
  // before the request reaches the app at all, so landing here means its
  // assertion did not verify — which is worth saying plainly rather than
  // offering a button that cannot help.
  if (via === 'cloudflare') {
    $('authNote').textContent =
      'This app is behind Cloudflare Access and your login was not recognised. '
      + 'Reload the page, or sign in again through Cloudflare.';
    $('authNote').hidden = false;
    return;
  }
  if (!clientId) {
    $('authNote').textContent =
      'Sign-in is not configured on this server yet (no Google client ID).';
    $('authNote').hidden = false;
    return;
  }
  if (window.google && window.google.accounts) return renderButton();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = renderButton;
  s.onerror = () => {
    $('authNote').textContent = 'Could not reach Google. Check your connection.';
    $('authNote').hidden = false;
  };
  document.head.appendChild(s);
}

function renderButton() {
  try {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (resp) => submit(resp.credential),
    });
    window.google.accounts.id.renderButton($('gbtn'), {
      theme: 'filled_black', size: 'large', shape: 'pill',
      text: 'continue_with', width: 280,
    });
  } catch (_) {
    $('authNote').textContent = 'Could not start Google sign-in.';
    $('authNote').hidden = false;
  }
}

async function submit(credential) {
  if (!credential) return;
  $('authNote').hidden = true;
  try {
    const r = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const b = await r.json();
    if (!r.ok) {
      $('authNote').textContent = b.error || 'That did not work.';
      $('authNote').hidden = false;
      return;
    }
    state.status = b.status;
    state.me = b.me || null;
    if (b.status === 'active') {
      localStorage.setItem('liftWasIn', '1');
      $('scr-auth').classList.remove('active');
      onSignedIn();
    } else {
      showAuthScreen('pending');
    }
  } catch (_) {
    $('authNote').textContent = 'Could not reach the server.';
    $('authNote').hidden = false;
  }
}

export async function signOut() {
  try { await fetch('/api/auth/signout', { method: 'POST' }); } catch (_) {}
  localStorage.removeItem('liftWasIn');
  // Behind Access, clearing our cookie alone changes nothing — Access would just
  // re-authenticate you on the next request. Its own logout is what ends the
  // session, so send them there.
  if (via === 'cloudflare') {
    location.href = '/cdn-cgi/access/logout';
    return;
  }
  // A full reload is the honest way to drop every trace of the last person from
  // memory. Anything less means hoping each module cleared its own copy.
  location.reload();
}

export function initAuth(signedInHandler) {
  onSignedIn = signedInHandler;
  $('authRefresh').addEventListener('click', async () => {
    const s = await checkAuth();
    if (s === 'active') {
      localStorage.setItem('liftWasIn', '1');
      $('scr-auth').classList.remove('active');
      onSignedIn();
    } else {
      toast(s === 'pending' ? 'Not yet — still waiting' : 'Signed out');
      showAuthScreen(s);
    }
  });
  $('authSignOut').addEventListener('click', signOut);
}
