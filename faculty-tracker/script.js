// ====================================================================
//  Faculty Availability & Location Tracking System
//  ─────────────────────────────────────────────────────────────────
//  MODULE 1 — User Authentication (Supabase Auth)
//  MODULE 2 — Faculty GPS Location Tracking
//  MODULE 3 — Campus Map Visualization (Leaflet + OpenStreetMap)
//  MODULE 4 — Real-Time Data Synchronization (Supabase Realtime)
//
//  ⚠️  Before running, replace the 3 placeholders:
//       SUPABASE_URL  ·  SUPABASE_ANON_KEY  ·  Google Maps key in index.html
// ====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Configuration ────────────────────────────────────────────────
const APP_CONFIG = globalThis.APP_CONFIG || {};
const SUPABASE_URL      = APP_CONFIG.SUPABASE_URL || 'https://ffdsapdnrwuhobcrbgjl.supabase.co';
const SUPABASE_ANON_KEY = APP_CONFIG.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmZHNhcGRucnd1aG9iY3JiZ2psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0MjU4OTgsImV4cCI6MjA4NzAwMTg5OH0.ChK4ADjvyUQhdColQFswy1v2ezj88_0LNxCPG6KVAAQ';

/** Campus centre coordinates (Madurai campus default) */
const CAMPUS_CENTER = { lat: 9.9252, lng: 78.1198 };

// ── Custom Storage Adapter ─────────────────────────────────────────
// Edge's Tracking Prevention blocks localStorage when the site is served
// from an IP address (e.g. 10.72.26.224). This adapter tries localStorage
// first, falls back to sessionStorage, then falls back to a plain object
// in memory. Auth sessions will persist for the tab lifetime at minimum.
const _memStore = {};
const _storage = (() => {
  // Try localStorage
  try {
    localStorage.setItem('_ft_test', '1');
    localStorage.removeItem('_ft_test');
    return localStorage;
  } catch (_) {}
  // Try sessionStorage
  try {
    sessionStorage.setItem('_ft_test', '1');
    sessionStorage.removeItem('_ft_test');
    console.warn('[Auth] localStorage blocked — using sessionStorage (session will end when tab closes)');
    return sessionStorage;
  } catch (_) {}
  // In-memory fallback
  console.warn('[Auth] sessionStorage blocked — using in-memory storage (no persistence)');
  return {
    getItem:    (k)    => _memStore[k] ?? null,
    setItem:    (k, v) => { _memStore[k] = v; },
    removeItem: (k)    => { delete _memStore[k]; },
  };
})();

// ── Supabase Client ──────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage:              _storage,
    persistSession:       true,
    autoRefreshToken:     true,
    detectSessionInUrl:   false,
  },
});

// ── App State ────────────────────────────────────────────────────
let map          = null;
let myMarker     = null;
let watchId      = null;
let isTracking   = false;
let isFaculty    = false;
let currentUser  = null;
let cachedProfile = null;
let facultyStore = {};
let realtimeChannel = null;
let dashboardReady  = false;
let lastUpdateTime  = null;    // epoch ms of last faculty_locations write
let timeCounterTimer = null;   // setInterval reference

// ====================================================================
//  HELPERS — UI
// ====================================================================

function $(id) { return document.getElementById(id); }

function getLocalhostUrl() {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const port = location.port ? `:${location.port}` : '';
  return `${protocol}//localhost${port}${location.pathname}`;
}

function isSecureOriginForGeolocation() {
  return location.protocol === 'https:'
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '::1';
}

function isNativeCapacitorRuntime() {
  try {
    return !!globalThis.Capacitor?.isNativePlatform?.();
  } catch (_) {
    return false;
  }
}

function getNativeGeolocationPlugin() {
  return globalThis.Capacitor?.Plugins?.Geolocation || null;
}

function normalizeGeolocationError(err) {
  const message = String(err?.message || err || 'Unknown geolocation error');
  const lower = message.toLowerCase();
  let code = Number(err?.code);

  if (!Number.isFinite(code)) {
    if (lower.includes('denied') || lower.includes('permission')) code = 1;
    else if (lower.includes('timeout')) code = 3;
    else code = 2;
  }

  return { code, message };
}

function hasValidCoords(lat, lng) {
  const latNum = Number.parseFloat(lat);
  const lngNum = Number.parseFloat(lng);
  return Number.isFinite(latNum) && Number.isFinite(lngNum);
}

function getSupabaseHost() {
  try {
    return new URL(SUPABASE_URL).host;
  } catch (_) {
    return SUPABASE_URL;
  }
}

function isLikelyNetworkError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('failed to fetch')
    || msg.includes('networkerror')
    || msg.includes('err_name_not_resolved')
    || msg.includes('dns')
    || msg.includes('timed out');
}

function formatBackendError(action, err) {
  const msg = String(err?.message || err || '').trim();
  if (isLikelyNetworkError(err)) {
    return `Cannot ${action}. Unable to reach backend (${getSupabaseHost()}). Check internet or update SUPABASE_URL.`;
  }
  return msg || `Cannot ${action}.`;
}

let backendReachability = { checkedAt: 0, ok: null };

async function isBackendReachable(force = false) {
  const cacheMs = 30000;
  if (!force && backendReachability.ok !== null && (Date.now() - backendReachability.checkedAt) < cacheMs) {
    return backendReachability.ok;
  }

  try {
    await fetch(SUPABASE_URL, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
    backendReachability = { checkedAt: Date.now(), ok: true };
  } catch (_) {
    backendReachability = { checkedAt: Date.now(), ok: false };
  }

  return backendReachability.ok;
}

/** Show the HTTPS warning inside the tracking panel if not on a secure origin */
function checkHttpsWarning() {
  const isSecure = isSecureOriginForGeolocation();
  const warn = $('https-warning');
  const link = $('localhost-link');
  if (!warn) return;
  if (isSecure) {
    warn.classList.add('hidden');
  } else {
    const localhostUrl = getLocalhostUrl();
    if (link) { link.textContent = localhostUrl; link.href = localhostUrl; }
    warn.classList.remove('hidden');
  }
}

function setStatus(msg, live = false) {
  $('status-text').textContent = msg;
  const dot = $('status-dot');
  dot.className = 'status-dot' + (live ? ' live' : '');
}

function showToast(msg, type = 'info', duration = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function setLoading(btnId, loading) {
  const btn  = $(btnId);
  if (!btn) return;
  btn.querySelector('.btn-text').classList.toggle('hidden', loading);
  btn.querySelector('.btn-loader').classList.toggle('hidden', !loading);
  btn.disabled = loading;
}

function hideSplash() {
  const splash = $('splash-screen');
  if (!splash) return;             // already removed by safety-net timer
  splash.classList.add('fade-out');
  setTimeout(() => { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 400);
}

function showPage(id) {
  ['login-screen', 'dashboard'].forEach(p => {
    $(p).classList.toggle('hidden', p !== id);
  });
}

function setAuthTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('login-form').classList.toggle('active-form', tab === 'login');
  $('login-form').classList.toggle('hidden',      tab !== 'login');
  $('signup-form').classList.toggle('active-form', tab === 'signup');
  $('signup-form').classList.toggle('hidden',       tab !== 'signup');
}

// ====================================================================
//  MODULE 3 — CAMPUS MAP VISUALIZATION
// ====================================================================

/** Initialize Leaflet map — returns a Promise that resolves once tiles are ready */
function initMap() {
  return new Promise(resolve => {
    if (map) { resolve(); return; }

    // ── Define tile layers ───────────────────────────────────────────
    const streetLayer = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 20,
      }
    );

    const satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution:
          'Tiles © <a href="https://www.esri.com">Esri</a> — ' +
          'Source: Esri, Maxar, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN',
        maxZoom: 19,
      }
    );

    // Labels overlay for satellite mode (roads/place names on top of imagery)
    const labelsLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, opacity: 0.8 }
    );

    // ── Create map ────────────────────────────────────────────────
    map = L.map('map', { preferCanvas: true, zoomControl: true })
           .setView([CAMPUS_CENTER.lat, CAMPUS_CENTER.lng], 17);

    streetLayer.addTo(map);   // start on street view

    // ── Layer switcher buttons ───────────────────────────────────────
    let activeTileLayer = streetLayer;
    let activeMode      = 'street';

    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.layer;
        if (mode === activeMode) return;

        // Swap tile layers
        map.removeLayer(activeTileLayer);
        if (activeMode === 'satellite') map.removeLayer(labelsLayer);

        if (mode === 'street') {
          streetLayer.addTo(map);
          activeTileLayer = streetLayer;
          $('map').style.filter = '';
        } else {
          satelliteLayer.addTo(map);
          labelsLayer.addTo(map);
          activeTileLayer = satelliteLayer;
          $('map').style.filter = '';
        }

        activeMode = mode;

        // Toggle active class on buttons
        document.querySelectorAll('.layer-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.layer === mode)
        );

        showToast(mode === 'satellite' ? '🛰 Satellite view' : '🗺 Street view', 'info', 1500);
      });
    });

    // ── Staggered invalidateSize ────────────────────────────────────
    const forceSize = () => map && map.invalidateSize(true);
    setTimeout(forceSize, 50);
    setTimeout(forceSize, 200);
    setTimeout(forceSize, 600);
    setTimeout(forceSize, 1500);

    // Resolve after first tile load or 800 ms
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    map.once('load', done);
    setTimeout(done, 800);
  });
}

/** Color per availability status */
function markerColor(status) {
  return { available: '#22c55e', busy: '#ef4444', offline: '#9ca3af' }[status] ?? '#9ca3af';
}

/**
 * Build a Leaflet L.divIcon for a faculty marker.
 * @param {'available'|'busy'|'offline'} status
 * @param {boolean} flash  — true briefly after an update to trigger CSS flash
 * @param {boolean} isYou  — true for the faculty's own self-marker
 */
function makeMarkerIcon(status, flash = false, isYou = false) {
  const cls = ['rt-marker-wrap', status, isYou ? 'you' : '', flash ? 'flash' : '']
    .filter(Boolean).join(' ');
  return L.divIcon({
    className:   '',           // suppress Leaflet's default white box
    html:        `<div class="${cls}"><div class="rt-ring"></div><div class="rt-dot"></div></div>`,
    iconSize:    [24, 24],
    iconAnchor:  [12, 12],
    tooltipAnchor: [12, 0],
  });
}

/** Flash the LIVE badge briefly */
function flashBadge() {
  const badge = $('realtime-badge');
  if (!badge) return;
  badge.classList.add('flash');
  setTimeout(() => badge.classList.remove('flash'), 600);
}

/** Update the LIVE badge label to show online faculty count */
function updateBadgeCount() {
  const n = Object.values(facultyStore).filter(r => r.availability_status !== 'offline').length;
  const lbl = $('realtime-label');
  if (lbl) lbl.textContent = n > 0 ? `LIVE · ${n} online` : 'LIVE';
}

/** Start the "Updated X s ago" counter in the bottom-left overlay */
function startTimeCounter() {
  if (timeCounterTimer) clearInterval(timeCounterTimer);
  timeCounterTimer = setInterval(() => {
    if (!lastUpdateTime) return;
    const sec = Math.round((Date.now() - lastUpdateTime) / 1000);
    const el  = $('last-updated');
    if (!el) return;
    if (sec < 5)   el.textContent = 'Updated just now';
    else if (sec < 60) el.textContent = `Updated ${sec}s ago`;
    else el.textContent = `Updated ${Math.floor(sec/60)}m ago`;
  }, 3000);
}

/** Fit map view to show all current faculty markers */
function fitAllMarkers() {
  if (!map) return;
  const points = [];
  Object.values(facultyStore).forEach(r => {
    if (hasValidCoords(r.latitude, r.longitude)) {
      points.push([parseFloat(r.latitude), parseFloat(r.longitude)]);
    }
  });
  if (myMarker) {
    const ll = myMarker.getLatLng();
    points.push([ll.lat, ll.lng]);
  }
  if (points.length === 0) return;
  if (points.length === 1) {
    map.setView(points[0], 17);
  } else {
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 18 });
  }
}

/** Create or update an animated divIcon marker for one faculty row */
function upsertMarker(row, opts = {}) {
  const { flash = true, updateUI = true } = opts;
  if (!map) { console.warn('[upsertMarker] map not ready, skipping:', row); return; }
  if (!hasValidCoords(row?.latitude, row?.longitude)) {
    console.warn('[upsertMarker] no coordinates for:', row?.name);
    return;
  }

  const lat    = parseFloat(row.latitude);
  const lng    = parseFloat(row.longitude);
  const key    = row.user_id;
  const status = row.availability_status || 'offline';
  const label  = `${row.name} · ${status}`;

  if (facultyStore[key]?.marker) {
    // Update existing marker — show flash animation
    const m = facultyStore[key].marker;
    m.setLatLng([lat, lng]);
    m.setIcon(makeMarkerIcon(status, flash));
    m.setTooltipContent(label);
    // Remove flash class after animation completes (~500 ms)
    if (flash) {
      setTimeout(() => {
        if (facultyStore[key]?.marker) {
          facultyStore[key].marker.setIcon(makeMarkerIcon(status, false));
        }
      }, 550);
    }
  } else {
    // New marker
    const marker = L.marker([lat, lng], { icon: makeMarkerIcon(status) }).addTo(map);
    marker.bindTooltip(label, { sticky: true, direction: 'top', offset: [0, -8] });
    marker.on('click', () => openModal(key));
    if (!facultyStore[key]) facultyStore[key] = {};
    facultyStore[key].marker = marker;
  }

  facultyStore[key] = { ...facultyStore[key], ...row };

  // Update all reactive UI
  if (updateUI) {
    lastUpdateTime = Date.now();
    $('last-updated').textContent = 'Updated just now';
    flashBadge();
    updateBadgeCount();
    updateStats();
    updateFacultyList();
  }

  // Flash the corresponding sidebar list item briefly
  const li = document.querySelector(`.faculty-list-item[data-uid="${key}"]`);
  if (li) {
    li.classList.remove('flash');
    void li.offsetWidth;           // force reflow to restart animation
    li.classList.add('flash');
    setTimeout(() => li.classList.remove('flash'), 600);
  }
}

/** Remove marker when a faculty row is deleted */
function removeMarker(userId) {
  if (facultyStore[userId]?.marker) {
    facultyStore[userId].marker.remove();
    delete facultyStore[userId];
    updateStats();
    updateFacultyList();
  }
}

// ====================================================================
//  MODULE 4 — REAL-TIME DATA SYNCHRONIZATION
// ====================================================================

/** Subscribe to Supabase Realtime on faculty_locations, THEN load snapshot */
function subscribeRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  realtimeChannel = supabase.channel('faculty-locations-' + Date.now())
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'faculty_locations' },
      ({ new: row }) => {
        console.log('[RT] INSERT', row);
        upsertMarker(row);
        showToast(`📍 ${row.name} is now on the map`, 'info', 2500);
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'faculty_locations' },
      ({ new: row }) => {
        console.log('[RT] UPDATE', row);
        upsertMarker(row);
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'faculty_locations' },
      ({ old: row }) => {
        console.log('[RT] DELETE', row);
        removeMarker(row.user_id);
      }
    )
    .subscribe(async (status) => {
      console.log('[RT] channel status:', status);
      if (status === 'SUBSCRIBED') {
        setStatus('Live · Connected', true);
        $('realtime-badge').classList.remove('offline');
        // Load initial snapshot AFTER channel is confirmed live
        // so no updates are missed between subscribe and fetch
        await loadAllLocations();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setStatus('⚠️ Realtime disconnected — retrying…', false);
        $('realtime-badge').classList.add('offline');
        // Retry after 5 seconds
        setTimeout(() => { if (currentUser) subscribeRealtime(); }, 5000);
      } else {
        setStatus('Connecting to live data…', false);
        $('realtime-badge').classList.add('offline');
      }
    });
}

/** Load all faculty rows once (called from subscribeRealtime SUBSCRIBED callback) */
async function loadAllLocations() {
  console.log('[loadAllLocations] fetching all faculty_locations…');
  let data = null;
  let error = null;
  try {
    const result = await supabase
      .from('faculty_locations')
      .select('*');
    data = result.data;
    error = result.error;
  } catch (err) {
    const msg = formatBackendError('load locations', err);
    console.error('[loadAllLocations] network error:', err);
    setStatus('Backend unreachable', false);
    showToast(msg, 'error', 8000);
    return;
  }

  if (error) {
    if (error.code === '42P01') {
      setStatus('Setup needed: run SQL to create tables', false);
      showToast('⚠️ faculty_locations table missing — run the Supabase SQL setup', 'error', 8000);
    } else {
      console.error('[loadAllLocations] error:', error.message);
      showToast('Could not load locations: ' + error.message, 'error', 5000);
    }
    return;
  }

  console.log('[loadAllLocations] got', data.length, 'rows:', data);
  if (data.length === 0) {
    setStatus('No faculty sharing location yet', false);
    showToast('ℹ️ No faculty are sharing their location right now', 'info', 4000);
  } else {
    Object.values(facultyStore).forEach(r => { if (r?.marker) r.marker.remove(); });
    facultyStore = {};
    data.forEach(r => upsertMarker(r, { flash: false, updateUI: false }));
    updateBadgeCount();
    updateStats();
    updateFacultyList();
    lastUpdateTime = Date.now();
    $('last-updated').textContent = 'Updated just now';
    setStatus('Live · Connected', true);
    // Auto-fit map to show all loaded markers
    setTimeout(fitAllMarkers, 300);
  }
  // Start the "X seconds ago" counter
  startTimeCounter();
}

// ====================================================================
//  SIDEBAR — Stats & Faculty List
// ====================================================================

function updateStats() {
  const rows = Object.values(facultyStore);
  $('count-available').textContent = rows.filter(r => r.availability_status === 'available').length;
  $('count-busy').textContent      = rows.filter(r => r.availability_status === 'busy').length;
  $('count-offline').textContent   = rows.filter(r => r.availability_status === 'offline').length;
}

function getSearchFilter() {
  const input = $('faculty-search');
  return input ? input.value.trim() : '';
}

function updateFacultyList(filter = getSearchFilter()) {
  const list = $('faculty-list');
  const query = filter.trim().toLowerCase();
  const rows = Object.values(facultyStore)
    .filter(r => {
      if (!query) return true;
      const hay = [r.name, r.department, r.availability_status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(query);
    });

  if (rows.length === 0) {
    list.innerHTML = `<li class="list-placeholder">${query ? 'No results.' : 'No faculty online yet.'}</li>`;
    return;
  }

  list.innerHTML = rows
    .sort((a, b) => {
      const order = { available: 0, busy: 1, offline: 2 };
      return (order[a.availability_status] ?? 3) - (order[b.availability_status] ?? 3);
    })
    .map(r => `
      <li class="faculty-list-item" data-uid="${r.user_id}">
        <span class="fl-dot" style="background:${markerColor(r.availability_status)}"></span>
        <div>
          <div class="fl-name">${r.name}</div>
          <div class="fl-dept">${r.department || 'Faculty'}</div>
        </div>
        <span class="fl-status ${r.availability_status}">${r.availability_status}</span>
      </li>`)
    .join('');

  // Click → open modal
  list.querySelectorAll('.faculty-list-item').forEach(li => {
    li.addEventListener('click', () => openModal(li.dataset.uid));
  });
}

// ── Faculty search ──────────────────────────────────────────────
$('faculty-search').addEventListener('input', e => updateFacultyList(e.target.value));

// ── Refresh button ──────────────────────────────────────────────
$('refresh-btn').addEventListener('click', async () => {
  const btn = $('refresh-btn');
  btn.style.transform = 'rotate(360deg)';
  setTimeout(() => btn.style.transform = '', 300);
  await loadAllLocations();
  showToast('Faculty list refreshed', 'success', 2000);
});

// ── Fit-all button (zoom to show every marker) ─────────────────
$('fit-btn').addEventListener('click', () => {
  fitAllMarkers();
  if (Object.keys(facultyStore).length === 0 && !myMarker) {
    showToast('No markers on map yet', 'info', 2000);
  }
});

// ── Track-me button (re-center on own GPS position) ────────────
$('track-me-btn').addEventListener('click', () => {
  if (myMarker) {
    const ll = myMarker.getLatLng();
    map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 17));
  }
});

// ====================================================================
//  FACULTY DETAIL MODAL
// ====================================================================

function openModal(userId) {
  const r = facultyStore[userId];
  if (!r) return;

  $('modal-name').textContent   = r.name || 'Unknown';
  $('modal-dept').textContent   = r.department || '–';
  $('modal-time').textContent   = r.updated_at ? new Date(r.updated_at).toLocaleString() : '–';
  $('modal-coords').textContent = hasValidCoords(r.latitude, r.longitude)
    ? `${parseFloat(r.latitude).toFixed(5)}, ${parseFloat(r.longitude).toFixed(5)}`
    : '–';

  const badge = $('modal-status-badge');
  badge.textContent  = r.availability_status;
  badge.className    = `modal-status-badge ${r.availability_status}`;

  $('modal-avatar').textContent = r.availability_status === 'available' ? '👨‍🏫' :
                                   r.availability_status === 'busy'      ? '⏳' : '💤';

  $('faculty-modal').classList.remove('hidden');

  // "Center on Map" button
  $('modal-navigate-btn').onclick = () => {
    closeFacultyModal();
    if (map && hasValidCoords(r.latitude, r.longitude)) {
      map.setView([parseFloat(r.latitude), parseFloat(r.longitude)], 19);
    }
  };
}

function closeFacultyModal() {
  $('faculty-modal').classList.add('hidden');
}

$('modal-close').addEventListener('click', closeFacultyModal);
$('modal-backdrop').addEventListener('click', closeFacultyModal);

// ====================================================================
//  MODULE 1 — USER AUTHENTICATION
// ====================================================================

// ── Tab Switcher ────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setAuthTab(btn.dataset.tab);
  });
});

// ── Password visibility toggle ───────────────────────────────────
document.querySelectorAll('.toggle-pw').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = $(btn.dataset.target);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
});

// ── Login ────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = $('login-email').value.trim();
  const password = $('login-password').value;
  const errEl    = $('login-error');
  errEl.classList.add('hidden');
  setLoading('login-btn', true);

  try {
    const reachable = await isBackendReachable(true);
    if (!reachable) {
      throw new Error(`Unable to reach backend (${getSupabaseHost()}). Check SUPABASE_URL and internet.`);
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('email not confirmed')) {
        errEl.innerHTML =
          '📧 Email not confirmed yet.<br>' +
          'Check your inbox, or go to <b>Supabase → Authentication → Settings</b> ' +
          'and disable <b>"Enable email confirmations"</b> to skip this step.';
      } else if (msg.includes('rate limit') || msg.includes('429')) {
        errEl.innerHTML =
          '⚠️ Too many attempts. Wait a few minutes, or disable email confirmations in ' +
          '<b>Supabase → Authentication → Settings</b>.';
      } else {
        errEl.textContent = error.message;
      }
      errEl.classList.remove('hidden');
      return;
    }
    // Success handled by onAuthStateChange
  } catch (err) {
    const msg = formatBackendError('sign in', err);
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    showToast(msg, 'error', 8000);
  } finally {
    setLoading('login-btn', false);
  }
});

// ── Sign Up ──────────────────────────────────────────────────────
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name     = $('signup-name').value.trim();
  const dept     = $('signup-dept').value.trim();
  const email    = $('signup-email').value.trim();
  const role     = $('signup-role').value;
  const password = $('signup-password').value;
  const errEl    = $('signup-error');
  const succEl   = $('signup-success');
  errEl.classList.add('hidden');
  succEl.classList.add('hidden');
  setLoading('signup-btn', true);

  try {
    const reachable = await isBackendReachable(true);
    if (!reachable) {
      throw new Error(`Unable to reach backend (${getSupabaseHost()}). Check SUPABASE_URL and internet.`);
    }

    // 1. Create auth user
    const { data, error: signUpErr } = await supabase.auth.signUp({ email, password });

    if (signUpErr) {
      const msg = signUpErr.message.toLowerCase();

      // Rate limit hit (429 / "email rate limit exceeded")
      if (msg.includes('rate limit') || msg.includes('429') || msg.includes('over_email_send_rate_limit')) {
        errEl.innerHTML =
          '⚠️ Email rate limit reached (Supabase free tier: 3 emails/hour).<br><br>' +
          '<b>Fix:</b> In your Supabase Dashboard → <b>Authentication → Settings</b> → ' +
          'disable <b>"Enable email confirmations"</b>, then try again.';
        errEl.classList.remove('hidden');
        return;
      }

      // Account already exists → fall through to login
      if (msg.includes('already registered') || msg.includes('already exists')) {
        const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
        if (signInErr) {
          errEl.textContent = 'Account exists — wrong password? ' + signInErr.message;
          errEl.classList.remove('hidden');
        }
        return;
      }

      errEl.textContent = signUpErr.message;
      errEl.classList.remove('hidden');
      return;
    }

    // 2. Insert profile — works even if email confirmation is pending
    //    because we have the user.id from the signUp response
    const userId = data.user?.id ?? data.session?.user?.id;
    if (userId) {
      const { error: profileErr } = await supabase.from('profiles').upsert({
        id:         userId,
        name,
        department: dept,
        role,
      });
      if (profileErr) console.warn('Profile insert error:', profileErr.message);
    }

    // If session is immediately available (email confirmation disabled in Supabase),
    // onAuthStateChange will pick it up. Otherwise show confirmation message.
    if (!data.session) {
      succEl.textContent = '✅ Account created! Check your email inbox to confirm, then come back to Login.';
      succEl.classList.remove('hidden');
    }
  } catch (err) {
    const msg = formatBackendError('sign up', err);
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    showToast(msg, 'error', 8000);
  } finally {
    setLoading('signup-btn', false);
  }
});

// ── Auth State Listener ─────────────────────────────────────────
supabase.auth.onAuthStateChange(async (_event, session) => {
  if (session?.user) {
    currentUser = session.user;
    if (!dashboardReady) {
      try {
        await initDashboard(session.user.id);
      } catch (err) {
        console.error('[AuthState] initDashboard failed:', err);
        showToast(formatBackendError('load dashboard', err), 'error', 8000);
        resetUI();
      }
    }
  } else {
    // Session ended — go to login. resetUI() does all cleanup.
    resetUI();
  }
});

/** Reset everything back to logged-out state — always synchronous + safe */
function resetUI() {
  currentUser    = null;
  cachedProfile  = null;
  isFaculty      = false;
  dashboardReady = false;

  // Unsubscribe realtime
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  // Clear all map markers
  Object.values(facultyStore).forEach(r => { if (r?.marker) r.marker.remove(); });
  facultyStore = {};
  if (myMarker) { myMarker.remove(); myMarker = null; }
  if (map) {
    map.remove();
    map = null;   // force full re-init on next login
  }

  // Reset tracking state
  isTracking = false;
  lastUpdateTime = null;
  if (watchId !== null) {
    if (typeof watchId === 'string') {
      const geo = getNativeGeolocationPlugin();
      if (geo?.clearWatch) {
        geo.clearWatch({ id: watchId }).catch(e => {
          console.warn('[GPS] native clearWatch failed during reset:', e?.message || e);
        });
      }
    } else if (navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }
  if (timeCounterTimer) { clearInterval(timeCounterTimer); timeCounterTimer = null; }
  const trackMeBtn = $('track-me-btn');
  if (trackMeBtn) trackMeBtn.classList.add('hidden');

  // Reset all UI elements
  const logoutBtn = $('logout-btn');
  if (logoutBtn) { logoutBtn.disabled = false; logoutBtn.textContent = '⏻ Logout'; }
  const trackBtn = $('track-btn');
  if (trackBtn) { trackBtn.textContent = '▶ Start Sharing Location'; trackBtn.classList.remove('tracking'); }
  const gpsStatus = $('gps-status');
  if (gpsStatus) gpsStatus.textContent = '';
  const accBar = $('accuracy-bar');
  if (accBar) accBar.classList.add('hidden');
  const loginEmail = $('login-email');
  if (loginEmail) loginEmail.value = '';
  const loginPw = $('login-password');
  if (loginPw) loginPw.value = '';
  const signupName = $('signup-name');
  if (signupName) signupName.value = '';
  const signupDept = $('signup-dept');
  if (signupDept) signupDept.value = '';
  const signupEmail = $('signup-email');
  if (signupEmail) signupEmail.value = '';
  const signupPw = $('signup-password');
  if (signupPw) signupPw.value = '';
  const loginErr = $('login-error');
  if (loginErr) loginErr.classList.add('hidden');
  const signupErr = $('signup-error');
  if (signupErr) signupErr.classList.add('hidden');
  const signupSuccess = $('signup-success');
  if (signupSuccess) signupSuccess.classList.add('hidden');
  const searchInput = $('faculty-search');
  if (searchInput) searchInput.value = '';
  const facultyList = $('faculty-list');
  if (facultyList) facultyList.innerHTML = '<li class="list-placeholder">No faculty online yet.</li>';
  ['count-available','count-busy','count-offline'].forEach(id => {
    const el = $(id); if (el) el.textContent = '0';
  });
  const lbl = $('realtime-label');  if (lbl) lbl.textContent = 'LIVE';
  const lu  = $('last-updated');    if (lu)  lu.textContent  = 'Waiting for data…';

  showPage('login-screen');
  setAuthTab('login');
}

/** Load profile, show dashboard, init map, subscribe realtime */
async function initDashboard(userId) {
  dashboardReady = true;
  console.log('[initDashboard] starting for userId:', userId);

  // Reset logout button in case it was left in loading state
  const logoutBtn = $('logout-btn');
  if (logoutBtn) { logoutBtn.disabled = false; logoutBtn.textContent = '⏻ Logout'; }

  // ── Step 1: Show dashboard ────────────────────────────────────────
  setStatus('Loading…');
  showPage('dashboard');

  // ── Step 2: Init map (double-RAF so browser paints container first) ──
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await initMap();
  console.log('[initDashboard] map ready');

  // ── Step 3: Subscribe realtime immediately so map data loads now ──
  // Do NOT wait for profile — faculty dots must show even while profile loads.
  setStatus('Connecting to live data…');
  subscribeRealtime();

  // ── Step 4: Fetch profile (with 6-second timeout) ────────────────
  setStatus('Loading profile…');
  let profile = null;
  let profileErr = null;
  try {
    const profilePromise = supabase
      .from('profiles')
      .select('name, role, department')
      .eq('id', userId)
      .maybeSingle();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Profile fetch timed out after 6s')), 6000)
    );
    const result = await Promise.race([profilePromise, timeoutPromise]);
    profile    = result.data;
    profileErr = result.error;
  } catch (e) {
    console.warn('[initDashboard] profile fetch threw:', e.message);
    profileErr = { message: e.message, code: 'TIMEOUT' };
  }

  if (profileErr) {
    console.warn('[initDashboard] profile error:', profileErr.code, profileErr.message);
  }
  console.log('[initDashboard] profile:', profile);

  // ── Step 5: Apply profile to UI ──────────────────────────────────
  if (!profile || !profile.role) {
    // No profile or role not set — show setup panel
    $('profile-setup-panel').classList.remove('hidden');
    $('tracking-panel').classList.add('hidden');
    if (profile?.name)       $('setup-name').value = profile.name;
    if (profile?.department) $('setup-dept').value = profile.department;
    $('user-badge').textContent = currentUser.email + ' · ❓ Unknown role';
    const setupMsg = $('setup-msg');
    if (profileErr?.code === '42P01') {
      if (setupMsg) setupMsg.innerHTML =
        '⚠️ The <b>profiles</b> table is missing.<br>' +
        'Run the SQL setup in your Supabase dashboard first.';
    } else if (profileErr?.code === 'TIMEOUT') {
      if (setupMsg) setupMsg.innerHTML =
        '⚠️ Could not load your profile (network timeout).<br>' +
        'Check your internet connection, then reload.';
    } else {
      if (setupMsg) setupMsg.innerHTML =
        '⚠️ Profile not found.<br>Fill in your details to continue.';
    }
    setStatus('Profile setup required — see sidebar', false);
    return;
  }

  $('profile-setup-panel').classList.add('hidden');
  cachedProfile = profile;
  isFaculty     = profile.role === 'faculty';
  const displayName = profile.name || currentUser.email;
  const roleLbl     = isFaculty ? '👨‍🏫 Faculty' : '🎓 Student';

  $('user-badge').textContent = `${displayName} · ${roleLbl}`;
  $('tracking-panel').classList.toggle('hidden', !isFaculty);
  if (isFaculty) checkHttpsWarning();

  console.log('[initDashboard] role:', profile.role, '| isFaculty:', isFaculty);
  // realtime was already subscribed in Step 3 — nothing more to do
}

// ── Profile Setup Panel — save name/dept/role then update UI immediately ────
$('setup-save-btn').addEventListener('click', async () => {
  const name = $('setup-name').value.trim();
  const dept = $('setup-dept').value.trim();
  const role = $('setup-role').value;
  const setupMsg = $('setup-msg');

  if (!name) {
    if (setupMsg) setupMsg.innerHTML = '❌ Please enter your name.';
    showToast('Please enter your name', 'error');
    return;
  }

  // Reset any previous error
  if (setupMsg) setupMsg.innerHTML = '⏳ Saving profile…';

  setLoading('setup-save-btn', true);
  let error = null;
  try {
    const result = await supabase.from('profiles').upsert({
      id:         currentUser.id,
      name,
      department: dept,
      role,
    });
    error = result.error;
  } catch (err) {
    error = { message: formatBackendError('save profile', err), code: 'NETWORK' };
  } finally {
    setLoading('setup-save-btn', false);
  }

  if (error) {
    console.error('[Profile save] upsert error:', error);
    const hint = (error.code === '42P01')
      ? ' Run the Supabase setup SQL first (see README).'
      : (error.code === '42501' || error.message.includes('policy'))
        ? ' Row-level security blocked the save. Check your INSERT policy.'
        : '';
    if (setupMsg) setupMsg.innerHTML = `❌ Save failed: ${error.message}${hint}`;
    showToast('Save failed: ' + error.message, 'error', 6000);
    return;
  }

  console.log('[Profile save] success — role:', role, '| name:', name);

  // ── Update state directly from the saved values — no extra DB round-trip ──
  cachedProfile = { name, department: dept, role };
  isFaculty     = (role === 'faculty');
  const roleLbl = isFaculty ? '👨‍🏫 Faculty' : '🎓 Student';

  $('user-badge').textContent = `${name} · ${roleLbl}`;
  $('profile-setup-panel').classList.add('hidden');
  $('tracking-panel').classList.toggle('hidden', !isFaculty);
  if (isFaculty) checkHttpsWarning();

  showToast(`✅ Profile saved! You are ${roleLbl}`, 'success', 3000);

  // Scroll the newly-revealed tracking panel into view so it's obvious
  if (isFaculty) {
    setTimeout(() => {
      const tp = $('tracking-panel');
      if (tp) tp.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  }

  // Re-subscribe realtime with the updated isFaculty flag
  subscribeRealtime();
});

// ── Logout ────────────────────────────────────────────────────────
$('logout-btn').addEventListener('click', async () => {
  const btn = $('logout-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Logging out…';

  // 3-second safety timeout — if signOut hangs, force UI reset anyway
  const fallback = setTimeout(() => {
    console.warn('[Logout] signOut timed out — forcing reset');
    resetUI();
  }, 3000);

  try {
    // Mark self offline first (while token still valid), then sign out
    if (isTracking && currentUser) await markSelfOffline();
    await supabase.auth.signOut();
    // onAuthStateChange fires with session=null → calls resetUI()
  } catch (err) {
    console.warn('[Logout] Error during signOut:', err.message);
    resetUI();   // force reset even on error
  } finally {
    clearTimeout(fallback);
  }
});

// ====================================================================
//  MODULE 2 — FACULTY GPS LOCATION TRACKING
// ====================================================================

$('track-btn').addEventListener('click', () => {
  if (isTracking) stopTracking();
  else void startTracking();
});

/** Change availability status immediately without stopping tracking */
$('availability-select').addEventListener('change', async () => {
  if (!isTracking || !currentUser) return;
  // Re-use the last known coordinates from myMarker
  if (!myMarker) return;
  const { lat, lng } = myMarker.getLatLng();
  const saved = await pushLocation({ latitude: lat, longitude: lng }, $('availability-select').value);
  if (saved) upsertMarker(saved);
});

async function startTracking() {
  const nativeGeo = isNativeCapacitorRuntime() ? getNativeGeolocationPlugin() : null;
  const hasWebGeolocation = !!navigator.geolocation;

  if (!nativeGeo && !hasWebGeolocation) {
    $('gps-status').textContent = '❌ Geolocation is not supported by this browser.';
    $('gps-status').style.color = '#ef4444';
    showToast('Geolocation not supported by this browser.', 'error');
    return;
  }

  // Geolocation in modern browsers requires a secure context.
  const isSecure = isSecureOriginForGeolocation();
  const warn = $('https-warning');
  const link = $('localhost-link');
  if (!isSecure) {
    const localhostUrl = getLocalhostUrl();
    if (warn) warn.classList.remove('hidden');
    if (link) { link.textContent = localhostUrl; link.href = localhostUrl; }
    $('gps-status').textContent = '⚠️ Non-HTTPS origin detected. Trying GPS anyway…';
    $('gps-status').style.color = '#92400e';
    showToast('Use HTTPS for reliable GPS on mobile/laptop.', 'warning', 9000);
  } else {
    if (warn) warn.classList.add('hidden');
  }

  // Early check to provide clear guidance when the user has blocked location.
  if (!nativeGeo) {
    try {
      if (navigator.permissions?.query) {
        const perm = await navigator.permissions.query({ name: 'geolocation' });
        if (perm.state === 'denied') {
          $('gps-status').textContent = '❌ Location permission is blocked. Enable it from browser settings.';
          $('gps-status').style.color = '#ef4444';
          showToast('Location permission blocked by browser settings.', 'error', 9000);
          return;
        }
      }
    } catch (_) {
      // Permissions API is optional; watchPosition will still surface errors if unavailable.
    }
  }

  $('gps-status').style.color = '';

  isTracking = true;
  $('track-btn').textContent = '⏹ Stop Sharing Location';
  $('track-btn').classList.add('tracking');
  $('gps-status').textContent = 'Acquiring GPS signal…';
  $('accuracy-bar').classList.remove('hidden');

  if (nativeGeo) {
    try {
      if (nativeGeo.requestPermissions) {
        const perm = await nativeGeo.requestPermissions();
        if (perm?.location === 'denied' && perm?.coarseLocation === 'denied') {
          const deniedErr = normalizeGeolocationError({ code: 1, message: 'Location permission denied' });
          onGPSError(deniedErr);
          return;
        }
      }

      watchId = await nativeGeo.watchPosition(
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
        (position, err) => {
          if (err) {
            onGPSError(normalizeGeolocationError(err));
            return;
          }
          if (position) {
            void onGPSUpdate(position);
          }
        }
      );
      return;
    } catch (err) {
      onGPSError(normalizeGeolocationError(err));
      return;
    }
  }

  watchId = navigator.geolocation.watchPosition(
    onGPSUpdate,
    onGPSError,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function stopTracking() {
  isTracking = false;
  $('track-btn').textContent = '▶ Start Sharing Location';
  $('track-btn').classList.remove('tracking');
  $('gps-status').textContent = 'Location sharing stopped.';
  $('accuracy-bar').classList.add('hidden');

  if (watchId !== null) {
    if (typeof watchId === 'string') {
      const geo = getNativeGeolocationPlugin();
      if (geo?.clearWatch) {
        geo.clearWatch({ id: watchId }).catch(e => {
          console.warn('[GPS] native clearWatch failed:', e?.message || e);
        });
      }
    } else if (navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = null;
  }
  if (myMarker) { myMarker.remove(); myMarker = null; }

  // Mark faculty offline
  markSelfOffline();
}

/** Full cleanup on logout — now replaced by resetUI(). Kept only as alias. */
async function fullCleanup() { resetUI(); }

function cleanupTracking() {
  if (isTracking) stopTracking();
}

/** Called by geolocation watchPosition on every GPS fix */
async function onGPSUpdate(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  console.log('[GPS] fix:', latitude, longitude, '±', Math.round(accuracy), 'm');

  $('gps-status').textContent = `Acquiring… ±${Math.round(accuracy)} m`;
  $('accuracy-val').textContent = `±${Math.round(accuracy)} m`;

  // Show / move the blue "You" self-marker immediately (no DB wait)
  const latlng = [latitude, longitude];
  if (!map) { console.warn('[GPS] map not ready yet'); return; }
  if (myMarker) {
    myMarker.setLatLng(latlng);
  } else {
    myMarker = L.marker(latlng, { icon: makeMarkerIcon('available', false, true) }).addTo(map);
    myMarker.bindTooltip('📍 You (faculty)', { permanent: true, direction: 'top', offset: [0, -10] });
    // Pan map to own position on first GPS fix
    map.setView(latlng, Math.max(map.getZoom(), 17));
    // Show "center on me" button
    const tmBtn = $('track-me-btn');
    if (tmBtn) tmBtn.classList.remove('hidden');
  }

  // Push coordinates to DB and immediately upsert the marker
  // (don't wait for realtime event — it may come late or not at all)
  const saved = await pushLocation({ latitude, longitude }, $('availability-select').value);
  if (saved) {
    // Immediately render own faculty marker in the faculty list + map
    upsertMarker(saved);
    $('gps-status').textContent = `✅ Sharing location… ±${Math.round(accuracy)} m`;
    $('gps-status').style.color = '';
  }
}

function onGPSError(err) {
  const normalizedErr = normalizeGeolocationError(err);
  const errCode = normalizedErr.code;
  const errMessage = normalizedErr.message;

  console.error('[GPS] error code', errCode, errMessage);
  let msg;
  const errMsg = (errMessage || '').toLowerCase();
  const isSecureOriginBlock = errMsg.includes('secure origin')
    || errMsg.includes('only secure origins')
    || errMsg.includes('insecure origin')
    || errMsg.includes('https')
    || (errCode === 1 && location.protocol !== 'https:'
        && location.hostname !== 'localhost'
        && location.hostname !== '127.0.0.1'
        && location.hostname !== '::1');
  if (errCode === 1 && isSecureOriginBlock) {
    const localhostUrl = getLocalhostUrl();
    msg = '❌ HTTPS required for GPS. Open via: ' + localhostUrl;
    // Show the https warning banner
    const warn = $('https-warning');
    const link = $('localhost-link');
    if (warn) warn.classList.remove('hidden');
    if (link) { link.textContent = localhostUrl; link.href = localhostUrl; }
  } else if (errCode === 1) {
    msg = '❌ Location permission denied. Click the 🔒 icon in the address bar and allow Location.';
  } else if (errCode === 2) {
    msg = '❌ GPS signal unavailable. Try near a window or outdoors.';
  } else if (errCode === 3) {
    msg = '❌ GPS timed out. Move to an open area and try again.';
  } else {
    msg = '❌ GPS error: ' + errMessage;
  }
  // Stop tracking — button must reset
  isTracking = false;
  const tb = $('track-btn');
  if (tb) { tb.textContent = '▶ Start Sharing Location'; tb.classList.remove('tracking'); }
  $('accuracy-bar').classList.add('hidden');
  $('gps-status').textContent = msg;
  $('gps-status').style.color = '#ef4444';
  showToast(msg, 'error', 10000);
}

/**
 * Upsert one row into faculty_locations.
 * Returns the saved payload on success, or null on error.
 */
async function pushLocation(coords, status) {
  if (!currentUser) { console.warn('[pushLocation] no currentUser'); return null; }

  // Must have coordinates to save a meaningful location row
  if (!hasValidCoords(coords?.latitude, coords?.longitude)) {
    console.warn('[pushLocation] called without coords — skipping');
    return null;
  }

  const latitude = Number.parseFloat(coords.latitude);
  const longitude = Number.parseFloat(coords.longitude);

  try {
    // Use cached profile — avoid a DB round-trip on every GPS update
    if (!cachedProfile) {
      const { data, error: pe } = await supabase
        .from('profiles')
        .select('name, department, role')
        .eq('id', currentUser.id)
        .maybeSingle();
      if (pe) console.warn('[pushLocation] profile fetch error:', pe.message);
      cachedProfile = data;
    }

    const payload = {
      user_id:             currentUser.id,
      name:                cachedProfile?.name || currentUser.email,
      department:          cachedProfile?.department || '',
      availability_status: status || 'available',
      latitude,
      longitude,
      updated_at:          new Date().toISOString(),
    };

    console.log('[pushLocation] upserting:', payload);

    const { error } = await supabase
      .from('faculty_locations')
      .upsert(payload, { onConflict: 'user_id' });

    if (error) {
      console.error('[pushLocation] DB error:', error.code, error.message);
      let hint = '';
      if (error.code === '42P01') hint = ' — faculty_locations table missing. Run SQL setup.';
      else if (error.code === '42501' || error.message.includes('policy')) hint = ' — RLS policy blocked insert. Check your Supabase policies.';
      const msg = `❌ DB save failed: ${error.message}${hint}`;
      $('gps-status').textContent = msg;
      $('gps-status').style.color = '#ef4444';
      showToast(msg, 'error', 8000);
      return null;
    }

    console.log('[pushLocation] saved OK');
    return payload;   // caller can use this to immediately render the marker
  } catch (err) {
    const msg = formatBackendError('save live location', err);
    $('gps-status').textContent = `❌ ${msg}`;
    $('gps-status').style.color = '#ef4444';
    showToast(msg, 'error', 8000);
    return null;
  }
}

async function markSelfOffline() {
  if (!currentUser) return;
  let error = null;
  try {
    const result = await supabase
      .from('faculty_locations')
      .update({ availability_status: 'offline', updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id);
    error = result.error;
  } catch (err) {
    console.warn('[markSelfOffline] network error:', formatBackendError('mark offline', err));
    return;
  }
  if (!error) {
    // Update local store immediately so marker turns grey without waiting for RT
    if (facultyStore[currentUser.id]) {
      facultyStore[currentUser.id].availability_status = 'offline';
      const m = facultyStore[currentUser.id].marker;
      if (m) {
        // L.marker uses setIcon() — setStyle() is only for circle/path layers
        m.setIcon(makeMarkerIcon('offline', false, false));
        const tt = m.getTooltip();
        if (tt) tt.setContent(`${facultyStore[currentUser.id].name} · offline`);
      }
      updateStats();
      updateFacultyList();
    }
  }
}

// ====================================================================
//  INIT — Check existing session on page load
// ====================================================================

async function init() {
  try {
    const reachable = await isBackendReachable(true);
    if (!reachable) {
      const msg = `Cannot reach backend (${getSupabaseHost()}). Verify SUPABASE_URL and your internet/DNS.`;
      console.error('[init] backend unreachable:', msg);
      showPage('login-screen');
      setAuthTab('login');
      const errEl = $('login-error');
      if (errEl) {
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
      }
      showToast(msg, 'error', 10000);
      return;
    }

    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      currentUser = session.user;
      await initDashboard(session.user.id);
      // dashboardReady = true is set inside initDashboard,
      // so onAuthStateChange won't double-init
    } else {
      showPage('login-screen');
      setAuthTab('login');
    }
  } catch (err) {
    console.error('Init error:', err);
    showPage('login-screen');
    setAuthTab('login');
    showToast('Connection error: ' + err.message, 'error', 6000);
  } finally {
    clearTimeout(window._splashTimer);   // cancel the safety-net timer
    hideSplash();
  }
}

document.addEventListener('DOMContentLoaded', init);
