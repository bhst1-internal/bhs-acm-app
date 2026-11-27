/**
 * ============================================================================
 * BHS Operation & Maintenance Action Memo (ACM) — Offline Service Worker
 * ============================================================================
 * Matches `APP_VERSION` in index.html and `version` in version.json.
 *
 * Caching & Update Strategy:
 *   1. Pre-caches the core app shell (index.html, manifest.json) and best-effort
 *      caches icons + Chart.js / html2canvas CDNs so offline mode works cleanly.
 *   2. COMPLETELY BYPASSES all Google Apps Script, Google Drive, Google API,
 *      version.json, and non-GET requests so mobile Chrome (Android & iOS)
 *      never encounters stale API responses or opaque redirect/ORB blocks.
 *   3. Waits for `{ type: 'SKIP_WAITING' }` from index.html's Update Banner so
 *      unsaved edits or active cloud syncs are never interrupted mid-session.
 *   4. Cleans up old `bhs-acm-*` caches on activation while leaving IndexedDB
 *      (`BHS_ACM_OfflineDB`) and `localStorage` completely untouched.
 * ============================================================================
 */

// Bump CACHE_VERSION alongside APP_VERSION in index.html and version.json on every release
const CACHE_VERSION = '1.0.0';
const CACHE_NAME = `bhs-acm-v${CACHE_VERSION}`;
const RUNTIME_CACHE = `bhs-acm-cdn-v${CACHE_VERSION}`;

// Required local app shell files
const CORE_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Optional assets & third-party libraries (cached best-effort so missing icons or offline CDNs never fail SW install)
const OPTIONAL_ASSETS = [
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
];

// Hostnames that must ALWAYS bypass the Service Worker and go directly to the network
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'drive.google.com',
  'docs.google.com',
  'accounts.google.com',
  'googleusercontent.com',
  'googleapis.com'
];

// Trusted CDN hostnames allowed into the offline runtime cache
const ALLOWED_CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com'
];

/**
 * Checks whether a request URL belongs to a Google endpoint or dynamic update check
 * that must never be intercepted or cached by the Service Worker.
 */
function shouldBypassRequest(url) {
  // Ignore non-HTTP(S) schemes (e.g. chrome-extension:, blob:, data:)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return true;
  }

  // Always bypass Google Apps Script, Drive, Auth, and Googleusercontent URLs
  const host = url.hostname.toLowerCase();
  for (let i = 0; i < BYPASS_HOSTS.length; i++) {
    const blocked = BYPASS_HOSTS[i];
    if (host === blocked || host.endsWith('.' + blocked)) {
      return true;
    }
  }

  // Never cache version.json or sw.js so PWA update checks always reach the server
  const path = url.pathname.toLowerCase();
  if (path.endsWith('/version.json') || path === '/version.json' || path.endsWith('/sw.js') || path === '/sw.js') {
    return true;
  }

  return false;
}

/**
 * INSTALL EVENT
 * Pre-caches the core shell and optional offline dependencies.
 * Intentionally does NOT call self.skipWaiting() automatically so index.html
 * can show the "Update Available" banner and check for unsaved edits first.
 */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const shellCache = await caches.open(CACHE_NAME);
      await shellCache.addAll(CORE_SHELL_ASSETS);

      // Best-effort cache for icons and CDN libraries
      const cdnCache = await caches.open(RUNTIME_CACHE);
      await Promise.allSettled(
        OPTIONAL_ASSETS.map(async (assetUrl) => {
          try {
            const isExternal = assetUrl.startsWith('http');
            const req = new Request(assetUrl, { mode: isExternal ? 'cors' : 'same-origin' });
            const res = await fetch(req);
            if (res && (res.ok || res.type === 'opaque')) {
              const targetCache = isExternal ? cdnCache : shellCache;
              await targetCache.put(req, res.clone());
            }
          } catch (_) {
            // Silently ignore optional asset failures so installation succeeds
          }
        })
      );
    } catch (err) {
      console.warn('[SW] Pre-cache warning:', err);
    }
  })());
});

/**
 * ACTIVATE EVENT
 * Removes stale `bhs-acm-*` caches from prior versions and takes control of open clients.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('bhs-acm-') && key !== CACHE_NAME && key !== RUNTIME_CACHE)
          .map((oldKey) => caches.delete(oldKey))
      );
      await self.clients.claim();
    } catch (err) {
      console.warn('[SW] Activate cleanup warning:', err);
    }
  })());
});

/**
 * MESSAGE EVENT
 * Allows index.html ("Update Now" button) to trigger immediate activation
 * only after verifying no unsaved Memo Details edits or active uploads exist.
 */
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * FETCH EVENT
 * - Non-GET & Google/version.json requests: bypassed directly to the network.
 * - Page navigations (index.html): Network-first with offline cache fallback.
 * - Same-origin static assets & approved CDNs: Stale-while-revalidate.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never intercept POST/PUT/DELETE requests (e.g., record submit & delete to Google Sheets)
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  if (shouldBypassRequest(url)) return;

  const isSameOrigin = url.origin === self.location.origin;
  const isNavigation = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  // 1. HTML Navigation Requests: Network-first, falling back to cached index.html offline
  if (isSameOrigin && isNavigation) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const freshRes = await fetch(req, { cache: 'no-cache' });
        if (freshRes && freshRes.ok) {
          cache.put('./index.html', freshRes.clone()).catch(() => {});
        }
        return freshRes;
      } catch (_) {
        const cachedExact = await cache.match(req, { ignoreSearch: true });
        if (cachedExact) return cachedExact;
        const cachedIndex = await cache.match('./index.html');
        if (cachedIndex) return cachedIndex;
        return new Response('Offline — BHS ACM cache not available yet. Please reconnect once to initialize.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 2. Same-Origin Static Assets (manifest, icons): Stale-while-revalidate
  if (isSameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);

      return cached || (await networkPromise) || new Response('', { status: 404 });
    })());
    return;
  }

  // 3. Approved CDN Scripts (Chart.js, html2canvas): Stale-while-revalidate for offline charts/JPEG export
  const host = url.hostname.toLowerCase();
  const isAllowedCdn = ALLOWED_CDN_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (isAllowedCdn) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => null);

      return cached || (await networkPromise) || new Response('', { status: 504 });
    })());
  }
});