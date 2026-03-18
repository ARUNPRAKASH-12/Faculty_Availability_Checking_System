// ====================================================================
//  Service Worker — Faculty Availability & Location Tracker PWA
//  Cache Strategy:
//    · Static shell  → Cache-first (offline capable)
//    · Supabase/Maps → Network-only (always fresh)
//    · Everything else → Stale-while-revalidate
// ====================================================================

const CACHE_VERSION = 'v4';
const CACHE_NAME    = `faculty-tracker-${CACHE_VERSION}`;

const STATIC_SHELL = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
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

  const url = new URL(request.url);

  // 1. Network-only for external APIs
  if (NETWORK_ONLY_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(fetch(request));
    return;
  }

  // 2. Cache-first for static shell files
  if (STATIC_SHELL.some(path => url.pathname === path || url.pathname === '/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) {
          // Revalidate in background
          fetch(request).then(resp => {
            if (resp && resp.status === 200) {
              caches.open(CACHE_NAME).then(c => c.put(request, resp));
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(request).then(resp => {
          if (resp && resp.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(request, resp.clone()));
          }
          return resp;
        });
      })
    );
    return;
  }

  // 3. Stale-while-revalidate for everything else
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      const networkPromise = fetch(request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          cache.put(request, resp.clone());
        }
        return resp;
      }).catch(() => cached);

      return cached ?? networkPromise;
    })
  );
});

// ── Push Notifications (future use) ──────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title ?? 'Faculty Tracker', {
    body:  data.body ?? '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  });
});
