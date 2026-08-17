// Network-first with cache fallback: deploys are never stale, but the app still
// opens (and a whole workout still runs) with no signal in a gym basement.
const CACHE = 'lift-shell-v1';
const SHELL = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Tapping "Rest over" should put you back on the set you were about to do, not
// open a second copy of the app on top of the running session.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow ? self.clients.openWindow('/') : undefined;
    })
  );
});

// A scheduled reminder, pushed from the Pi. This is the ONE alert that arrives
// with the app closed — the rest tone can't work this way (it has to fire ninety
// seconds from now, possibly with no signal) and a daily nudge can't work the
// other way (nothing on the device is awake to raise it). See lib/push.js.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Lift', {
    body: [d.body, d.detail].filter(Boolean).join('\n'),
    // Its own tag, so a reminder never replaces a live rest alert or vice versa.
    tag: 'lift-due',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: '/' },
  }));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API — stale weights would be worse than an error.
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(request).then(hit => hit || caches.match('/'))
      )
  );
});
