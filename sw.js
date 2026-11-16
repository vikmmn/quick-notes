// Keeps the installed app exactly as it is until you tap "Update now".
// Releasing a new version = change VERSION below (and in config.js), then publish.
var VERSION = '2.0.0';
var SHELL_CACHE = 'qn-shell-' + VERSION;
var SHELL = [
  './', './index.html', './app.js', './notes.js', './canvas.js', './search.js', './vendor.js', './drive.js', './config.js', './demo-data.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  // No skipWaiting here: a new version waits until the app asks for it.
  event.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('qn-shell-') === 0 && k !== SHELL_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // The app itself (including "Share to" links like ./?text=…): always the approved, cached version.
  // Google sign-in and Google Drive go straight to the network.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (c) {
        return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); });
      })
    );
  }
});
