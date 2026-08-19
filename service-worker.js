/**
 * Service Worker - ScoreKeeper Pro
 * v2.12 : mise à jour PWA renforcée pour Android/Chrome
 */

const CACHE_NAME = 'scorekeeper-v2.12';
const ASSETS_TO_CACHE = [
  './index.html',
  './style.css?v=2.12',
  './app.js?v=2.12',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Installation : forcer le téléchargement réseau des fichiers de cette version.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(
        ASSETS_TO_CACHE.map((url) => new Request(url, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
  );
});

// Activation : supprimer tous les anciens caches puis prendre le contrôle immédiatement.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Pour une navigation, préférer le réseau afin de détecter une nouvelle version
  // dès le prochain lancement. Hors ligne, revenir à index.html en cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Les ressources versionnées peuvent rester Cache First.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
