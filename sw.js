// Keeps the installed app exactly as it is until you tap "Update now".
// Releasing a new version = change VERSION below (and in config.js), then publish.
var VERSION = '3.15.1';
var SHELL_CACHE = 'qn-shell-' + VERSION;
var SHELL = [
  './', './index.html', './import.html', './import.js', './notion.html', './notion.js', './ink.js', './privacy.html', './bug.js', './screenshot.js', './zip.js', './app.js', './notes.js', './canvas.js', './search.js', './vendor.js', './drive.js', './config.js', './demo-data.js', './manifest.webmanifest',
  './fonts/lora.woff2', './fonts/jetbrains-mono.woff2', './fonts/caveat.woff2', './fonts/permanent-marker.woff2', './fonts/playfair-display.woff2',
  './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  // No skipWaiting here: a new version waits until the app asks for it.
  // Fetch fresh copies (past any stale copy GitHub's servers still hold for a few minutes after a release),
  // and check each one really is this version before keeping it.
  event.waitUntil(caches.open(SHELL_CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) {
      return fetch(new Request(u + (u.indexOf('?') < 0 ? '?' : '&') + 'v=' + VERSION, { cache: 'reload' })).then(function (r) {
        if (!r.ok) throw new Error('Could not fetch ' + u);
        if (u === './config.js') return r.clone().text().then(function (t) {
          if (t.indexOf("'" + VERSION + "'") < 0) throw new Error('Not published yet');
          return c.put(u, r);
        });
        return c.put(u, r);
      });
    }));
  }));
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

// ---------- Sending changes while the phone sleeps (Background Sync) ----------
// When the app goes to the background it writes its unsent changes to an outbox in IndexedDB and asks for a
// 'qn-push'. The browser runs this even after it has frozen or closed the app, and again when the
// connection comes back. Each change is claimed before it is sent, so the app and this never send the same one.
var API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
self.addEventListener('sync', function (event) {
  if (event.tag === 'qn-push') event.waitUntil(drain());
});
function idb() {
  return new Promise(function (resolve) {
    var r = indexedDB.open('quick-notes');
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { resolve(null); };
    r.onupgradeneeded = function () { r.transaction.abort(); resolve(null); }; // no data yet: nothing to send
  });
}
function done(t) { return new Promise(function (ok, bad) { t.oncomplete = function () { ok(); }; t.onerror = t.onabort = function () { bad(t.error); }; }); }
function claimNext(db) {
  var job = null, t = db.transaction('outbox', 'readwrite'), os = t.objectStore('outbox');
  os.getAll().onsuccess = function (e) {
    job = e.target.result.filter(function (j) { return j.status === 'pending'; })[0] || null;
    if (job) { job.status = 'inflight'; job.started = Date.now(); os.put(job); }
  };
  return done(t).then(function () { return job; });
}
function release(db, job) {
  var t = db.transaction('outbox', 'readwrite'), os = t.objectStore('outbox');
  os.get(job.noteId).onsuccess = function (e) { var j = e.target.result; if (j && j.status === 'inflight') { j.status = 'pending'; os.put(j); } };
  return done(t);
}
// Records the result, and updates the note's own copy too, in case the app was closed and starts afresh.
function finish(db, job) {
  var t = db.transaction(['outbox', 'notes'], 'readwrite'), notes = t.objectStore('notes');
  t.objectStore('outbox').put(job);
  var r = job.result || {};
  if (!r.conflict && !r.error) notes.get(job.noteId).onsuccess = function (e) {
    var n = e.target.result;
    if (!n) return;
    if (job.kind === 'trash') { if (n.deleted && n.v === job.v) notes.delete(n.id); else { n.fileId = null; n.md5 = null; n.fileName = null; notes.put(n); } return; }
    n.fileId = r.id; n.md5 = r.md5; n.fileName = r.name || n.fileName; n.folderId = job.parent; n.moveFrom = null;
    if (n.v === job.v) n.dirty = false;
    notes.put(n);
  };
  return done(t);
}
async function drive(url, token, opts) {
  opts = opts || {};
  var r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token }) }));
  if (r.status === 401) { var e = new Error('signed out'); e.stop = true; throw e; }
  if (r.status === 429 || r.status >= 500) { var b = new Error('busy'); b.retry = true; throw b; }
  return r;
}
async function send(job, token) {
  var F = 'id,name,md5Checksum,trashed';
  if (job.kind === 'trash') {
    await drive(API + '/files/' + job.fileId + '?fields=id', token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"trashed":true}' });
    return {};
  }
  if (job.kind === 'save') {
    if (job.md5) {
      var now = await drive(API + '/files/' + job.fileId + '?fields=' + F, token);
      if (!now.ok) return { error: now.status };
      now = await now.json();
      if (now.trashed || now.md5Checksum !== job.md5) return { conflict: true }; // changed elsewhere: the app asks you
    }
    var q = job.moveFrom ? '&addParents=' + encodeURIComponent(job.parent) + '&removeParents=' + encodeURIComponent(job.moveFrom) : '';
    var r = await drive(UPLOAD + '/files/' + job.fileId + '?uploadType=media&fields=' + F + q, token,
      { method: 'PATCH', headers: { 'Content-Type': 'text/markdown; charset=UTF-8' }, body: job.text });
    if (!r.ok) return { error: r.status };
    var f = await r.json();
    return { id: f.id, md5: f.md5Checksum, name: f.name };
  }
  var b = 'bnd' + Math.random().toString(36).slice(2);
  var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name: job.name, parents: [job.parent], mimeType: 'text/markdown' }) + '\r\n--' + b +
    '\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n' + job.text + '\r\n--' + b + '--';
  var c = await drive(UPLOAD + '/files?uploadType=multipart&fields=' + F, token,
    { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body });
  if (!c.ok) return { error: c.status };
  var m = await c.json();
  return { id: m.id, md5: m.md5Checksum, name: m.name };
}
async function drain() {
  var db = await idb();
  if (!db || !db.objectStoreNames.contains('outbox')) return;
  var tok = await new Promise(function (ok) {
    var r = db.transaction('meta', 'readonly').objectStore('meta').get('token');
    r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ok(null); };
  });
  if (!tok) return;
  // The one-hour sign-in ran out: with the sign-in helper, get a fresh one; without it, the app sends them later.
  async function renew() {
    if (!tok.refresh || !tok.server) return false;
    try {
      var r = await fetch(tok.server + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: tok.refresh }) });
      if (!r.ok) return false;
      var d = await r.json();
      tok.token = d.access_token; tok.expiresAt = Date.now() + (Number(d.expires_in || 3600) - 120) * 1000;
      return true;
    } catch (e) { return false; }
  }
  if ((!tok.token || tok.expiresAt < Date.now()) && !(await renew())) return;
  var renewed = false;
  var retry = null, sent = 0;
  for (;;) {
    var job = await claimNext(db);
    if (!job) break;
    try {
      job.result = await send(job, tok.token);
      job.status = 'done';
      await finish(db, job); sent++;
    } catch (e) {
      await release(db, job);
      if (e.stop && !renewed && (await renew())) { renewed = true; continue; } // sign-in ran out mid-way: renew once
      if (!e.stop) retry = e; // offline or Drive busy: the browser tries again later
      break;
    }
  }
  if (sent) {
    var list = await self.clients.matchAll({ type: 'window' });
    list.forEach(function (c) { c.postMessage('qn-sent'); });
  }
  if (retry) throw retry;
}
