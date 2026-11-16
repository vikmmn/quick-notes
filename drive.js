// Google Drive access for Quick Notes (the same approach as 2nd Brain Notes).
// Real mode talks to the Drive API with the user's own Google sign-in.
// Demo mode (no CLIENT_ID, #demo in the address, or any address other than APP_ORIGIN) uses a pretend Drive in memory.
(function () {
  var CFG = window.APP_CONFIG;
  var API = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var FIELDS = 'id,name,mimeType,modifiedTime,createdTime,parents,md5Checksum,trashed';
  var FOLDER = 'application/vnd.google-apps.folder';
  var SCOPE = 'https://www.googleapis.com/auth/drive';

  function fail(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function qs(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  // ---------------- Real Google Drive ----------------
  function RealDrive() {
    var token = null, expiresAt = 0, client = null;
    try {
      var saved = JSON.parse(sessionStorage.getItem('drive-token') || 'null');
      if (saved && saved.expiresAt > Date.now()) { token = saved.token; expiresAt = saved.expiresAt; }
    } catch (e) {}

    function loadGis() {
      if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve;
        s.onerror = function () { reject(fail('offline', 'Could not reach Google sign-in. Check your internet connection.')); };
        document.head.appendChild(s);
      });
    }

    // Must be called from a tap or click: Google opens a small sign-in window.
    async function signIn() {
      await loadGis();
      if (!client) {
        client = google.accounts.oauth2.initTokenClient({ client_id: CFG.CLIENT_ID, scope: SCOPE, callback: function () {} });
      }
      return new Promise(function (resolve, reject) {
        client.callback = function (r) {
          if (r.error) return reject(fail('signin', r.error_description || r.error));
          token = r.access_token;
          expiresAt = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
          try {
            localStorage.setItem('signed-in-before', '1');
            sessionStorage.setItem('drive-token', JSON.stringify({ token: token, expiresAt: expiresAt }));
          } catch (e) {}
          resolve();
        };
        client.error_callback = function (e) {
          reject(fail('signin', e && e.type === 'popup_closed' ? 'The Google sign-in window was closed.' :
            e && e.type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Allow pop-ups for this app.' :
            'Google sign-in did not finish.'));
        };
        var before = false;
        try { before = localStorage.getItem('signed-in-before') === '1'; } catch (e) {}
        client.requestAccessToken({ prompt: before ? '' : 'consent' });
      });
    }

    function signedIn() { return !!token && Date.now() < expiresAt; }
    function minutesLeft() { return token ? (expiresAt - Date.now()) / 60000 : 0; }

    async function api(url, opts) {
      if (!navigator.onLine) throw fail('offline', 'No internet connection.');
      if (!signedIn()) throw fail('auth', 'Please sign in to Google again.');
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      var r;
      try { r = await fetch(url, Object.assign({}, opts, { headers: headers })); }
      catch (e) { throw fail('offline', 'No internet connection, or Google Drive could not be reached.'); }
      if (r.status === 401) {
        token = null;
        try { sessionStorage.removeItem('drive-token'); } catch (e) {}
        throw fail('auth', 'Your Google sign-in has ended. Please sign in again.');
      }
      if (!r.ok) {
        var msg = r.statusText;
        try { msg = (await r.json()).error.message || msg; } catch (e) {}
        throw fail(r.status === 404 ? 'notfound' : r.status === 403 ? 'forbidden' : r.status === 429 || r.status >= 500 ? 'busy' : 'http',
          msg, { status: r.status });
      }
      return r;
    }

    async function query(q, pageSize, maxPages) {
      var out = [], page = null;
      for (var i = 0; i < (maxPages || 50); i++) {
        var url = API + '/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('nextPageToken,files(' + FIELDS + ')') +
          '&pageSize=' + (pageSize || 1000) + '&spaces=drive' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
        var data = await (await api(url)).json();
        out = out.concat(data.files || []);
        page = data.nextPageToken;
        if (!page) break;
      }
      return out;
    }

    return {
      demo: false,
      signIn: signIn,
      signedIn: signedIn,
      minutesLeft: minutesLeft,
      list: function (folderId) { return query("'" + qs(folderId) + "' in parents and trashed = false"); },
      get: async function (id) { return (await api(API + '/files/' + id + '?fields=' + FIELDS)).json(); },
      readText: async function (id) { return (await api(API + '/files/' + id + '?alt=media')).text(); },
      // Saves into the same file. Refuses (conflict) if it changed elsewhere since it was last seen.
      saveText: async function (id, text, expectedMd5) {
        if (expectedMd5) {
          var now = await (await api(API + '/files/' + id + '?fields=' + FIELDS)).json();
          if (now.trashed || now.md5Checksum !== expectedMd5) return { conflict: true, file: now };
        }
        var r = await api(UPLOAD + '/files/' + id + '?uploadType=media&fields=' + FIELDS, {
          method: 'PATCH', headers: { 'Content-Type': 'text/markdown; charset=UTF-8' }, body: text
        });
        return { file: await r.json() };
      },
      create: async function (name, parentId, text) {
        var b = 'bnd' + Math.random().toString(36).slice(2);
        var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify({ name: name, parents: [parentId], mimeType: 'text/markdown' }) + '\r\n--' + b +
          '\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n' + text + '\r\n--' + b + '--';
        var r = await api(UPLOAD + '/files?uploadType=multipart&fields=' + FIELDS, {
          method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body
        });
        return r.json();
      },
      createFolder: async function (name, parentId) {
        var r = await api(API + '/files?fields=' + FIELDS, {
          method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name: name, parents: [parentId], mimeType: FOLDER })
        });
        return r.json();
      },
      // Moves a file to Drive's trash (it can be restored from there for 30 days).
      trash: async function (id) {
        try {
          await api(API + '/files/' + id + '?fields=id', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true })
          });
        } catch (e) { if (e.code !== 'notfound') throw e; }
      },
      findExact: async function (name, parentId, mime) {
        var q = "name = '" + qs(name) + "' and trashed = false and '" + qs(parentId) + "' in parents" +
          (mime ? " and mimeType = '" + qs(mime) + "'" : '');
        return (await query(q, 10, 1))[0] || null;
      }
    };
  }

  // ---------------- Pretend Drive for demo mode ----------------
  function DemoDrive() {
    var n = 0, files = {}, offline = false, signed = false;
    function add(name, parent, mime, text, daysAgo) {
      var id = 'demo' + (++n);
      var t = new Date(Date.now() - (daysAgo || 0) * 86400000).toISOString();
      files[id] = { id: id, name: name, mimeType: mime, parents: [parent], text: text || '', rev: 1,
        modifiedTime: t, createdTime: t, trashed: false };
      return id;
    }
    var readables = CFG.READABLES_FOLDER_ID;
    add('Books', readables, FOLDER);
    (window.DEMO_NOTES || []).forEach(function (d) {
      var parent = Object.keys(files).filter(function (k) { return files[k].name === d.folder && files[k].mimeType === FOLDER; })[0];
      if (!parent) {
        var notes = Object.keys(files).filter(function (k) { return files[k].name === CFG.NOTES_FOLDER_NAME; })[0] ||
          add(CFG.NOTES_FOLDER_NAME, readables, FOLDER);
        parent = add(d.folder, notes, FOLDER);
      }
      add(d.name, parent, 'text/markdown', d.text, d.daysAgo);
    });

    function md5ish(f) { return f.id + ':' + f.rev; }
    function meta(f) {
      return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, createdTime: f.createdTime,
        parents: f.parents, md5Checksum: f.mimeType === FOLDER ? undefined : md5ish(f), trashed: f.trashed };
    }
    function wait(v) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (offline) reject(fail('offline', 'No internet connection (pretend).'));
          else if (!signed) reject(fail('auth', 'Please sign in to Google again.'));
          else resolve(v);
        }, 150);
      });
    }
    function live() { return Object.keys(files).map(function (k) { return files[k]; }).filter(function (f) { return !f.trashed; }); }
    return {
      demo: true,
      signIn: function () { signed = true; return new Promise(function (r) { setTimeout(r, 200); }); },
      signedIn: function () { return signed; },
      minutesLeft: function () { return signed ? 60 : 0; },
      list: function (folderId) { return wait(live().filter(function (f) { return f.parents[0] === folderId; }).map(meta)); },
      get: function (id) { return files[id] ? wait(meta(files[id])) : Promise.reject(fail('notfound', 'File not found')); },
      readText: function (id) { return wait(files[id].text); },
      saveText: function (id, text, expected) {
        var f = files[id];
        if (!f) return Promise.reject(fail('notfound', 'File not found'));
        if (expected && (f.trashed || md5ish(f) !== expected)) return wait({ conflict: true, file: meta(f) });
        return wait().then(function () {
          f.text = text; f.rev++; f.modifiedTime = new Date().toISOString();
          return { file: meta(f) };
        });
      },
      create: function (name, parentId, text) {
        return wait().then(function () { return meta(files[add(name, parentId, 'text/markdown', text)]); });
      },
      createFolder: function (name, parentId) {
        return wait().then(function () { return meta(files[add(name, parentId, FOLDER)]); });
      },
      trash: function (id) { return wait().then(function () { if (files[id]) files[id].trashed = true; }); },
      findExact: function (name, parentId, mime) {
        var f = live().filter(function (x) { return x.name === name && x.parents[0] === parentId && (!mime || x.mimeType === mime); })[0];
        return wait(f ? meta(f) : null);
      },
      // Demo-only switches, for trying the offline queue and the changed-elsewhere warning.
      setOffline: function (v) { offline = !!v; },
      isOffline: function () { return offline; },
      editElsewhere: function (fileId) {
        var f = files[fileId];
        if (!f) return false;
        f.text = f.text.replace(/\n*$/, '\n\nEdited on the laptop at ' + new Date().toLocaleTimeString() + '.\n');
        f.rev++; f.modifiedTime = new Date().toISOString();
        return true;
      }
    };
  }

  var demo = !CFG.CLIENT_ID || /(^|[#&])demo\b/.test(location.hash) || location.origin !== CFG.APP_ORIGIN;
  window.Drive = demo ? DemoDrive() : RealDrive();
  window.Drive.FOLDER = FOLDER;
})();
