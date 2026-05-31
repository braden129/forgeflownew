self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) =>
        Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)))
      ),
      self.registration.unregister(),
      self.clients.matchAll({ type: "window" }).then((clients) =>
        Promise.all(clients.map((client) => client.navigate(client.url)))
      ),
    ])
  );
});
