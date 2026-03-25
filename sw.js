self.addEventListener('fetch', (event) => {
  // This is a minimal service worker to enable PWA installation
  event.respondWith(
    fetch(event.request).catch(() => {
      return new Response("Offline mode not implemented yet.");
    })
  );
});
