'use strict';

const cachePrefix = 'figgjaraetlan-public-shell-';
const shellCache = `${cachePrefix}__FIGGJARAETLAN_BUILD__`;
const shellPath = '/';
const publicAssets = new Map([
  [shellPath, ['text/html']],
  ['/manifest.webmanifest', ['application/manifest+json', 'application/json']],
  ['/icon.svg', ['image/svg+xml']],
  ['/icon-192.png', ['image/png']],
  ['/icon-512.png', ['image/png']],
  ['/apple-touch-icon.png', ['image/png']],
]);

function assetUrl(path) {
  return new URL(path, self.location.origin).href;
}

async function installShell() {
  const downloaded = await Promise.all(Array.from(publicAssets, async ([path, types]) => {
    const url = assetUrl(path);
    const response = await fetch(url, { cache: 'reload', credentials: 'omit', redirect: 'error' });
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (!response.ok || !types.includes(contentType)) {
      throw new Error(`Could not cache public asset ${path}`);
    }
    return [url, response];
  }));

  const cache = await caches.open(shellCache);
  for (const [url, response] of downloaded) {
    await cache.put(url, response);
  }
}

self.addEventListener('install', (event) => {
  // Let open app windows finish on their current build before the update takes over.
  event.waitUntil(installShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== shellCache)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function serveAsset(path, request) {
  const cache = await caches.open(shellCache);
  return await cache.match(assetUrl(path)) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return;

  const { pathname } = url;
  if (request.mode === 'navigate' && (pathname === shellPath || pathname === '/index.html')) {
    event.respondWith(serveAsset(shellPath, request));
  } else if (pathname !== shellPath && publicAssets.has(pathname)) {
    event.respondWith(serveAsset(pathname, request));
  }
});
