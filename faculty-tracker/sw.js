// ====================================================================
//  Service Worker — Faculty Availability & Location Tracker PWA
//  Cache Strategy:
//    · Static shell  → Cache-first (offline capable)
//    · Supabase/Maps → Network-only (always fresh)
//    · Everything else → Stale-while-revalidate
// ====================================================================

const CACHE_VERSION = 'v10';
const CACHE_NAME    = `faculty-tracker-${CACHE_VERSION}`;

const STATIC_SHELL = [
  './index.html',
  './app-config.js',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/facultytrack-logo.svg',
  './lib/leaflet.js',
  './lib/leaflet.css',
];

// Hostnames that must NEVER be served from cache
const NETWORK_ONLY_HOSTS = [
  'supabase.co',
  'tile.openstreetmap.org',      // OSM street tiles
  'arcgisonline.com',            // Esri satellite tiles
  'esm.sh',
];

function toScopedPath(url) {
  const scopePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
  let path = url.pathname;
  if (scopePath && path.startsWith(scopePath)) {
    path = path.slice(scopePath.length) || '/';
  }
  return path;
}

function isStaticShellRequest(url) {
  const scopedPath = toScopedPath(url);
  return scopedPath === '/'
    || STATIC_SHELL.some(path => scopedPath === path.replace(/^\.\//, '/'));
}

function expectsJson(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json')
    || request.url.includes('/auth/v1/')
    || request.url.includes('/rest/v1/')
    || request.url.includes('/realtime/v1/');
}

async function offlineFallback(request) {
  if (request.mode === 'navigate' || request.destination === 'document') {
    const cachedShell = await caches.match(new URL('./index.html', self.registration.scope).toString());
    if (cachedShell) return cachedShell;
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><title>Offline</title></head><body><h1>Offline</h1><p>Network unavailable. Please reconnect and reload.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  if (expectsJson(request)) {
    return new Response(
      JSON.stringify({
        error: 'network_unavailable',
        message: 'Network unavailable. Check internet connection and backend URL.'
      }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  return new Response('Network unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// ── Install: pre-cache app shell ─────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing…');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove stale caches ────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Ignore unsupported request combinations in some browsers.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);

  // 1. Network-only for external APIs
  if (NETWORK_ONLY_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(
      fetch(request).catch(() => offlineFallback(request))
    );
    return;
  }

  // 2. Cache-first for static shell files
  if (isStaticShellRequest(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const scopedPath = toScopedPath(url);
        const cacheKey = new URL(scopedPath === '/' ? './index.html' : `.${scopedPath}`, self.registration.scope).toString();
        const cached = (await cache.match(request)) || (await cache.match(cacheKey));

        if (cached) {
          // Revalidate in background
          fetch(request).then(resp => {
            if (resp && resp.status === 200) {
              cache.put(request, resp.clone());
            }
          }).catch(() => {});
          return cached;
        }

        return fetch(request).then(resp => {
          if (resp && resp.status === 200) {
            cache.put(request, resp.clone());
          }
          return resp;
        }).catch(() => offlineFallback(request));
      })
    );
    return;
  }

  // 3. Stale-while-revalidate for everything else
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkPromise = fetch(request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          cache.put(request, resp.clone());
        }
        return resp;
      }).catch(() => null);

      const networkResp = await networkPromise;
      return cached || networkResp || offlineFallback(request);
    })
  );
});

// ── Push Notifications (future use) ──────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title ?? 'FacultyTrack', {
    body:  data.body ?? '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  });
});
