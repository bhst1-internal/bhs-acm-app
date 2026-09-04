self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('bhs-acm-store-v2').then((cache) => cache.addAll([
      './index.html',
      './manifest.json'
    ])),
  );
});

self.addEventListener('fetch', (e) => {
  // CRITICAL FIX: Bypass Service Worker for Google Apps Script requests
  if (e.request.url.includes('script.google.com') || e.request.url.includes('script.googleusercontent.com')) {
    return; // Let the browser handle live network request directly
  }

  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
