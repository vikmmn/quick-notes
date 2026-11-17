// Google Drive access for Serendip (the same approach as 2nd Brain Notes).
// Real mode talks to the Drive API with the user's own Google sign-in.
// Demo mode (no CLIENT_ID, #demo in the address, or any address other than APP_ORIGIN) uses a pretend Drive in memory.
(function () {
  var CFG = window.APP_CONFIG;
  var API = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  var FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,parents,md5Checksum,trashed';
  var FOLDER = 'application/vnd.google-apps.folder';
  // Only the files and folders this app makes, plus files you pick yourself. Never the rest of your Drive.
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';

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
    // The sign-in is kept on this device until Google's hour runs out, so closing the app doesn't sign you out.
    var TOKEN_KEY = 'qn-drive-token';
    try {
      var saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (saved && saved.expiresAt > Date.now()) { token = saved.token; expiresAt = saved.expiresAt; }
    } catch (e) {}
    function account() { try { return localStorage.getItem('qn-account') || ''; } catch (e) { return ''; } }
    // Remember which Google account this is, so renewing skips Google's account picker.
    async function learnAccount() {
      if (account()) return;
      try {
        var r = await fetch(API + '/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + token } });
        var u = (await r.json()).user;
        if (u && u.emailAddress) localStorage.setItem('qn-account', u.emailAddress);
      } catch (e) {}
    }

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

    // ---- Staying signed in (when config.js names a TOKEN_SERVER, the small sign-in helper) ----
    // Google gives a web page only one-hour sign-ins. Signing in once through the helper gives a lasting
    // permission, kept on this device sealed so only the helper can use it; the helper turns it into a fresh
    // one-hour sign-in whenever needed, silently.
    var SERVER = String(CFG.TOKEN_SERVER || '').replace(/\/+$/, '');
    var REFRESH_KEY = 'qn-refresh', STATE_KEY = 'qn-oauth-state', RETURN_KEY = 'qn-oauth-return';
    function refreshBlob() { try { return localStorage.getItem(REFRESH_KEY) || ''; } catch (e) { return ''; } }
    function keep(r) {
      token = r.access_token;
      expiresAt = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
      try {
        localStorage.setItem('signed-in-before', '1');
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: token, expiresAt: expiresAt }));
        if (r.refresh) localStorage.setItem(REFRESH_KEY, r.refresh);
      } catch (e) {}
    }
    var renewing = null, lastError = null;
    function renew() {
      if (!SERVER || !refreshBlob() || !navigator.onLine) return Promise.resolve(false);
      if (!renewing) renewing = (async function () {
        try {
          var r = await fetch(SERVER + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: refreshBlob() }) });
          if (r.status === 401) { try { localStorage.removeItem(REFRESH_KEY); } catch (e) {} return false; } // permission withdrawn
          if (!r.ok) return false;
          keep(await r.json());
          return true;
        } catch (e) { return false; }
      })().then(function (ok) { renewing = null; return ok; });
      return renewing;
    }
    function appRoot() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }
    function lastingSignIn() {
      var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(STATE_KEY, state); localStorage.setItem(RETURN_KEY, location.href); } catch (e) {}
      if (window.Drive && window.Drive.beforeLeave) { try { window.Drive.beforeLeave(); } catch (e) {} }
      var q = { client_id: CFG.CLIENT_ID, redirect_uri: appRoot(), response_type: 'code', scope: SCOPE, access_type: 'offline',
        prompt: 'consent', include_granted_scopes: 'true', state: state };
      if (account()) q.login_hint = account();
      var url = 'https://accounts.google.com/o/oauth2/v2/auth?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
      setTimeout(function () { location.href = url; }, 150); // a moment for the last save on this device
      return new Promise(function () {}); // the page goes to Google and comes back
    }
    // Coming back from Google with ?code=…: hand it to the helper, keep the lasting permission, tidy the address.
    var finished = (async function () {
      if (!SERVER) return;
      var p = new URLSearchParams(location.search), code = p.get('code'), err = p.get('error');
      if (!code && !err) return;
      var expected = null, back = null;
      try { expected = localStorage.getItem(STATE_KEY); back = localStorage.getItem(RETURN_KEY); localStorage.removeItem(STATE_KEY); localStorage.removeItem(RETURN_KEY); } catch (e) {}
      try { history.replaceState(history.state, '', location.pathname); } catch (e) {}
      if (err) { lastError = err === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in did not finish (' + err + ').'; return; }
      if (!expected || p.get('state') !== expected) { lastError = 'That sign-in link was out of date. Please sign in again.'; return; }
      try {
        var r = await fetch(SERVER + '/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, redirect_uri: appRoot() }) });
        var d = await r.json();
        if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || 'The sign-in helper said no.');
        keep(d);
        learnAccount();
        if (back && back.split('?')[0] !== location.href.split('?')[0]) location.replace(back.split('?')[0]);
      } catch (e) { lastError = 'Signing in did not finish: ' + e.message; }
    })();

    // Must be called from a tap or click: Google opens a small sign-in window.
    async function signIn() {
      if (SERVER) return lastingSignIn();
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
            localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: token, expiresAt: expiresAt }));
          } catch (e) {}
          learnAccount();
          resolve();
        };
        client.error_callback = function (e) {
          reject(fail('signin', e && e.type === 'popup_closed' ? 'The Google sign-in window was closed.' :
            e && e.type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Allow pop-ups for this app.' :
            'Google sign-in did not finish.'));
        };
        var before = false;
        try { before = localStorage.getItem('signed-in-before') === '1'; } catch (e) {}
        var opts = { prompt: before ? '' : 'consent' };
        if (before && account()) opts.hint = account();
        client.requestAccessToken(opts);
      });
    }

    function tokenOk() { return !!token && Date.now() < expiresAt; }
    function signedIn() { return tokenOk() || (!!SERVER && !!refreshBlob()); }
    function minutesLeft() { return SERVER && refreshBlob() ? 9999 : token ? (expiresAt - Date.now()) / 60000 : 0; }

    async function api(url, opts, retried) {
      if (!navigator.onLine) throw fail('offline', 'No internet connection.');
      if (!tokenOk() && !(await renew())) throw fail('auth', 'Please sign in to Google again.');
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      var r;
      try { r = await fetch(url, Object.assign({}, opts, { headers: headers })); }
      catch (e) { throw fail('offline', 'No internet connection, or Google Drive could not be reached.'); }
      if (r.status === 401) {
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        if (!retried && await renew()) return api(url, opts, true);
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

    var self = {
      demo: false,
      takeSignInError: function () { var e = lastError; lastError = null; return e; },
      persistent: !!SERVER,
      ready: finished,
      lasting: function () { return !!SERVER && !!refreshBlob(); },
      account: account,
      signOut: function () { token = null; try { [TOKEN_KEY, REFRESH_KEY].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} },
      signIn: signIn,
      signedIn: signedIn,
      minutesLeft: minutesLeft,
      signedInBefore: function () { try { return localStorage.getItem('signed-in-before') === '1'; } catch (e) { return false; } },
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
      rename: async function (id, name) {
        await api(API + '/files/' + id + '?fields=id', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name: name })
        });
      },
      move: async function (id, newParent, oldParent) {
        await api(API + '/files/' + id + '?fields=id&addParents=' + encodeURIComponent(newParent) +
          (oldParent ? '&removeParents=' + encodeURIComponent(oldParent) : ''), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: '{}'
        });
      },
      // For the Keep import: any file (images, audio), part of a big file, and finding Takeout zips.
      upload: async function (name, parentId, blob, mime) {
        var b = 'bnd' + Math.random().toString(36).slice(2);
        var body = new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify({ name: name, parents: [parentId] }) + '\r\n--' + b + '\r\nContent-Type: ' + (mime || 'application/octet-stream') + '\r\n\r\n',
          blob, '\r\n--' + b + '--']);
        var r = await api(UPLOAD + '/files?uploadType=multipart&fields=' + FIELDS, {
          method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body
        });
        return r.json();
      },
      readRange: async function (id, start, end) {
        var r = await api(API + '/files/' + id + '?alt=media', { headers: { Range: 'bytes=' + start + '-' + end } });
        return new Uint8Array(await r.arrayBuffer());
      },
      // Earlier versions of a file, which Drive keeps for about 30 days (up to 100 versions).
      revisions: async function (id) {
        var d = await (await api(API + '/files/' + id + '/revisions?pageSize=200&fields=' + encodeURIComponent('revisions(id,modifiedTime,size)'))).json();
        return d.revisions || [];
      },
      readRevision: async function (id, revId) { return (await api(API + '/files/' + id + '/revisions/' + revId + '?alt=media')).text(); },
      readBlob: async function (id) { return (await api(API + '/files/' + id + '?alt=media')).blob(); },
      size: async function (id) { return Number((await (await api(API + '/files/' + id + '?fields=size')).json()).size); },
      findTakeout: function () {
        return query("name contains 'takeout-' and (mimeType = 'application/x-zip' or mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed') and trashed = false", 50, 1);
      },
      // The app's home folder: marked with a hidden property, so any device finds it again.
      findRoot: async function () {
        var hit = (await query("appProperties has { key='qnRoot' and value='1' } and mimeType = '" + FOLDER + "' and trashed = false", 10, 1))[0];
        if (hit) return hit;
        if (CFG.READABLES_FOLDER_ID) { // notes made by earlier versions
          var old = null;
          try { old = (await query("name = '" + qs(CFG.NOTES_FOLDER_NAME) + "' and '" + qs(CFG.READABLES_FOLDER_ID) + "' in parents and mimeType = '" + FOLDER + "' and trashed = false", 10, 1))[0]; }
          catch (e) { if (e.code === 'auth' || e.code === 'offline') throw e; }
          if (old) {
            await api(API + '/files/' + old.id + '?fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ appProperties: { qnRoot: '1' } }) });
            return old;
          }
        }
        var r = await api(API + '/files?fields=' + FIELDS, {
          method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name: CFG.ROOT_FOLDER_NAME || 'Serendip', mimeType: FOLDER, appProperties: { qnRoot: '1' } })
        });
        return r.json();
      },
      // A folder the app made, found by a hidden mark, so it is found again even after you rename it.
      markedFolder: async function (name, parentId, key) {
        var props = {}; props[key] = '1';
        var hit = (await query("appProperties has { key='" + key + "' and value='1' } and '" + qs(parentId) + "' in parents and trashed = false", 10, 1))[0];
        if (hit) return hit;
        hit = (await query("name = '" + qs(name) + "' and '" + qs(parentId) + "' in parents and mimeType = '" + FOLDER + "' and trashed = false", 10, 1))[0];
        if (hit) {
          await api(API + '/files/' + hit.id + '?fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ appProperties: props }) });
          return hit;
        }
        var r = await api(API + '/files?fields=' + FIELDS, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name: name, parents: [parentId], mimeType: FOLDER, appProperties: props }) });
        return r.json();
      },
      findZips: function (term) {
        return query("name contains '" + qs(term) + "' and (mimeType = 'application/x-zip' or mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed') and trashed = false", 50, 1);
      },
      token: function () {
        if (!signedIn()) return null;
        return { token: tokenOk() ? token : '', expiresAt: tokenOk() ? expiresAt : 0, refresh: SERVER ? refreshBlob() : '', server: SERVER };
      },
      findExact: async function (name, parentId, mime) {
        var q = "name = '" + qs(name) + "' and trashed = false and '" + qs(parentId) + "' in parents" +
          (mime ? " and mimeType = '" + qs(mime) + "'" : '');
        return (await query(q, 10, 1))[0] || null;
      }
    };
    return self;
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
    function folderPath(path) {
      var parent = Object.keys(files).filter(function (k) { return files[k].name === CFG.NOTES_FOLDER_NAME && files[k].parents[0] === readables; })[0] ||
        add(CFG.NOTES_FOLDER_NAME, readables, FOLDER);
      path.split('/').forEach(function (name) {
        var hit = Object.keys(files).filter(function (k) { return files[k].name === name && files[k].mimeType === FOLDER && files[k].parents[0] === parent; })[0];
        parent = hit || add(name, parent, FOLDER);
      });
      return parent;
    }
    (window.DEMO_NOTES || []).forEach(function (d) { add(d.name, folderPath(d.folder), 'text/markdown', d.text, d.daysAgo); });

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
      signedInBefore: function () { return true; },
      list: function (folderId) { return wait(live().filter(function (f) { return f.parents[0] === folderId; }).map(meta)); },
      get: function (id) { return files[id] ? wait(meta(files[id])) : Promise.reject(fail('notfound', 'File not found')); },
      readText: function (id) { return wait(files[id].text); },
      saveText: function (id, text, expected) {
        var f = files[id];
        if (!f) return Promise.reject(fail('notfound', 'File not found'));
        if (expected && (f.trashed || md5ish(f) !== expected)) return wait({ conflict: true, file: meta(f) });
        return wait().then(function () {
          (f.revs = f.revs || []).push({ id: 'r' + f.rev, modifiedTime: f.modifiedTime, size: String(f.text.length), text: f.text });
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
      rename: function (id, name) { return wait().then(function () { files[id].name = name; }); },
      upload: function (name, parentId, blob, mime) { return wait().then(function () { var id = add(name, parentId, mime || 'application/octet-stream', ''); files[id].blob = blob; return meta(files[id]); }); },
      findTakeout: function () { return wait([]); },
      findZips: function () { return wait([]); },
      markedFolder: function (name, parentId) {
        var f = live().filter(function (x) { return x.name === name && x.parents[0] === parentId && x.mimeType === FOLDER; })[0];
        return wait(meta(f ? f : files[add(name, parentId, FOLDER)]));
      },
      findRoot: function () {
        var id = Object.keys(files).filter(function (k) { return files[k].name === CFG.NOTES_FOLDER_NAME && files[k].parents[0] === readables; })[0] || add(CFG.NOTES_FOLDER_NAME, readables, FOLDER);
        return wait(meta(files[id]));
      },
      token: function () { return null; },
      persistent: false, ready: Promise.resolve(), takeSignInError: function () { return null; }, lasting: function () { return false; }, account: function () { return ''; }, signOut: function () { signed = false; },
      readBlob: function (id) { return wait(files[id].blob || new Blob([files[id].text])); },
      revisions: function (id) { var f = files[id]; return wait((f.revs || []).map(function (r) { return { id: r.id, modifiedTime: r.modifiedTime, size: r.size }; }).concat([{ id: 'r' + f.rev, modifiedTime: f.modifiedTime, size: String(f.text.length) }])); },
      readRevision: function (id, revId) { var f = files[id], r = (f.revs || []).filter(function (x) { return x.id === revId; })[0]; return wait(r ? r.text : f.text); },
      _files: files,
      move: function (id, newParent) { return wait().then(function () { files[id].parents = [newParent]; files[id].rev++; }); },
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
