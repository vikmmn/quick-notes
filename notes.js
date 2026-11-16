// Quick Notes: the note file format, the copy kept on this device, and syncing with Google Drive.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG;
  var Drive = window.Drive;
  var FOLDER = Drive.FOLDER;
  var TASK = /^\s*[-*] \[( |x|X)\] ?(.*)$/;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ---------------- File format ----------------
  // ---
  // id: …            created: ISO     updated: ISO
  // labels: ["a"]    pinned: false    source: notes | keep | notion
  // (any other keys, e.g. archived from a Keep import, are kept as they are)
  // ---
  // # Title
  //
  // The note in Markdown; checklists as "- [ ] item" lines.
  var KNOWN = { id: 1, created: 1, updated: 1, labels: 1, pinned: 1, source: 1 };

  function parseLabels(v) {
    v = (v || '').trim();
    if (!v) return [];
    try { var a = JSON.parse(v); if (Array.isArray(a)) return a.map(String).filter(Boolean); } catch (e) {}
    return v.replace(/^\[|\]$/g, '').split(',').map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean);
  }
  function isChecklist(body) {
    var lines = String(body || '').split('\n').filter(function (l) { return l.trim(); });
    return lines.length > 0 && lines.every(function (l) { return TASK.test(l); });
  }
  function parse(text, file) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    var fm = {}, extra = [], rest = text;
    var m = /^---\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(text);
    if (m) {
      rest = text.slice(m[0].length);
      m[1].split('\n').forEach(function (line) {
        var kv = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
        if (kv && KNOWN[kv[1]]) fm[kv[1]] = kv[2];
        else if (line.trim()) extra.push(line);
      });
    }
    rest = rest.replace(/^\n+/, '');
    var title = '';
    var t = /^# (.*)\n?/.exec(rest);
    if (t) { title = t[1].trim(); rest = rest.slice(t[0].length).replace(/^\n+/, ''); }
    var body = rest.replace(/\s+$/, '');
    var fileTime = file && (file.modifiedTime || file.createdTime);
    return {
      id: (fm.id || '').trim() || ('file-' + (file ? file.id : uuid())),
      title: title,
      body: body,
      kind: isChecklist(body) ? 'list' : 'text',
      labels: parseLabels(fm.labels),
      pinned: /^\s*true\s*$/i.test(fm.pinned || ''),
      created: (fm.created || '').trim() || (file && file.createdTime) || new Date().toISOString(),
      updated: (fm.updated || '').trim() || fileTime || new Date().toISOString(),
      source: (fm.source || '').trim() || 'notes',
      extra: extra,
      fileId: file ? file.id : null,
      md5: file ? file.md5Checksum : null,
      fileName: file ? file.name : null,
      folder: file ? file.folderName : null,
      dirty: false, deleted: false, conflict: null, v: 0
    };
  }
  function serialize(n) {
    var out = ['---', 'id: ' + n.id, 'created: ' + n.created, 'updated: ' + n.updated,
      'labels: ' + JSON.stringify(n.labels || []), 'pinned: ' + (n.pinned ? 'true' : 'false'), 'source: ' + (n.source || 'notes')]
      .concat(n.extra || [], ['---', '']);
    if (n.title) out.push('# ' + n.title.replace(/\n/g, ' '), '');
    out.push(String(n.body || '').replace(/\s+$/, ''));
    return out.join('\n') + '\n';
  }
  function firstWords(n) {
    var s = (n.title || '').trim();
    if (!s) {
      var line = String(n.body || '').split('\n').map(function (l) { return l.replace(TASK, '$2').replace(/^[#>*\-\s]+/, '').trim(); })
        .filter(Boolean)[0] || '';
      s = line.split(/\s+/).slice(0, 8).join(' ');
    }
    s = s.replace(/[\\/:*?"<>|#\[\]^]/g, '-').replace(/\s+/g, ' ').trim();
    if (s.length > 50) s = s.slice(0, 50).replace(/\s+\S*$/, '').trim() || s.slice(0, 50);
    return s || 'Note';
  }
  function fileName(n) {
    var d = new Date(n.created);
    if (isNaN(d)) d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes()) +
      ' ' + firstWords(n) + '.md';
  }
  function isEmpty(n) {
    return !String(n.title || '').trim() && !String(n.body || '').replace(TASK, '$2').trim() && !(n.labels || []).length;
  }

  // ---------------- The copy on this device ----------------
  // IndexedDB in the real app. Demo mode keeps everything in memory, so a reload starts the demo afresh.
  function Store() {
    var db = null, mem = {};
    function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
    function open() {
      if (Drive.demo || !window.indexedDB) return Promise.resolve(null);
      return new Promise(function (resolve) {
        try {
          var r = indexedDB.open('quick-notes', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('notes', { keyPath: 'id' }); };
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }
    function tx(mode) { return db.transaction('notes', mode).objectStore('notes'); }
    var api = {
      persistent: false,
      load: async function () {
        db = await open();
        api.persistent = !!db;
        if (!db) return Object.keys(mem).map(function (k) { return mem[k]; });
        try { return await req(tx('readonly').getAll()); } catch (e) { db = null; api.persistent = false; return []; }
      },
      put: function (n) {
        var copy = JSON.parse(JSON.stringify(n));
        delete copy.isDraft;
        if (!db) { mem[n.id] = copy; return Promise.resolve(); }
        return req(tx('readwrite').put(copy)).catch(function () {});
      },
      del: function (id) {
        if (!db) { delete mem[id]; return Promise.resolve(); }
        return req(tx('readwrite').delete(id)).catch(function () {});
      }
    };
    return api;
  }

  // ---------------- Syncing with Google Drive ----------------
  // Push: every changed note is written to its own file (new notes go to Notes › Inbox).
  // Pull: every Markdown file under Notes is listed; only files whose checksum changed are downloaded.
  function Sync(store, notes, hooks) {
    var state = { phase: 'idle', error: null, lastSynced: null };
    var running = false, again = false, againPull = false, timer = null, folders = null;
    try { folders = JSON.parse(localStorage.getItem(Drive.demo ? 'qn-folders-demo-x' : 'qn-folders') || 'null'); } catch (e) {}
    if (Drive.demo) folders = null;

    function all() { return Object.keys(notes).map(function (k) { return notes[k]; }); }
    function emit() { hooks.status(api.status()); }
    function online() { return navigator.onLine && !(Drive.isOffline && Drive.isOffline()); }

    async function ensureFolders() {
      if (folders && folders.notes) return folders;
      var f = {};
      var top = await Drive.findExact(CFG.NOTES_FOLDER_NAME, CFG.READABLES_FOLDER_ID, FOLDER) ||
        await Drive.createFolder(CFG.NOTES_FOLDER_NAME, CFG.READABLES_FOLDER_ID);
      f.notes = top.id;
      for (var i = 0; i < CFG.SUBFOLDERS.length; i++) {
        var name = CFG.SUBFOLDERS[i];
        var sub = await Drive.findExact(name, top.id, FOLDER) || await Drive.createFolder(name, top.id);
        f[name] = sub.id;
      }
      folders = f;
      if (!Drive.demo) { try { localStorage.setItem('qn-folders', JSON.stringify(f)); } catch (e) {} }
      return f;
    }

    async function listAll() {
      var out = [], queue = [{ id: folders.notes, name: CFG.NOTES_FOLDER_NAME, depth: 0 }];
      while (queue.length) {
        var dir = queue.shift();
        var items = await Drive.list(dir.id);
        items.forEach(function (f) {
          if (f.mimeType === FOLDER) { if (dir.depth < 3 && f.name.charAt(0) !== '.') queue.push({ id: f.id, name: f.name, depth: dir.depth + 1 }); }
          else if (/\.md$/i.test(f.name)) { f.folderName = dir.name; out.push(f); }
        });
      }
      return out;
    }

    async function push() {
      var list = all().filter(function (n) { return n.dirty && !n.conflict; })
        .sort(function (a, b) { return String(a.updated).localeCompare(String(b.updated)); });
      var changed = [];
      for (var i = 0; i < list.length; i++) {
        var n = list[i], v = n.v;
        if (n.deleted) {
          if (n.fileId) await Drive.trash(n.fileId);
          if (n.deleted && n.v === v) { delete notes[n.id]; await store.del(n.id); changed.push(n.id); }
          continue;
        }
        var text = serialize(n);
        if (!n.fileId) {
          var name = fileName(n);
          var made = await Drive.create(name, folders[CFG.SUBFOLDERS[0]], text);
          n.fileId = made.id; n.md5 = made.md5Checksum; n.fileName = made.name; n.folder = CFG.SUBFOLDERS[0];
        } else {
          var r = await Drive.saveText(n.fileId, text, n.md5);
          if (r.conflict) {
            n.conflict = { md5: r.file.md5Checksum, trashed: !!r.file.trashed, modifiedTime: r.file.modifiedTime };
            await store.put(n); changed.push(n.id);
            continue;
          }
          n.md5 = r.file.md5Checksum;
        }
        if (n.v === v) n.dirty = false;
        await store.put(n); changed.push(n.id);
      }
      if (changed.length) hooks.changed(changed);
    }

    async function pull() {
      var remote = await listAll();
      var byFile = {}, byId = {};
      all().forEach(function (n) { if (n.fileId) byFile[n.fileId] = n; byId[n.id] = n; });
      var seen = {}, changed = [];
      for (var i = 0; i < remote.length; i++) {
        var f = remote[i];
        seen[f.id] = true;
        var local = byFile[f.id];
        if (local && local.md5 === f.md5Checksum) { if (!local.folder) local.folder = f.folderName; continue; }
        if (local && (local.dirty || local.conflict)) {
          if (!local.conflict) { local.conflict = { md5: f.md5Checksum, trashed: false, modifiedTime: f.modifiedTime }; await store.put(local); changed.push(local.id); }
          continue;
        }
        var text = await Drive.readText(f.id);
        var fresh = parse(text, f);
        var target = local || (byId[fresh.id] && !byId[fresh.id].fileId ? byId[fresh.id] : null);
        if (target && (target.dirty && target.fileId)) continue;
        if (!target && byId[fresh.id]) fresh.id = fresh.id + '-' + f.id.slice(-6); // same id in two files: keep both
        if (target) {
          if (target.dirty) { // created here, file already made by an earlier push that was cut short
            target.fileId = f.id; target.md5 = null; target.fileName = f.name; target.folder = f.folderName;
          } else {
            ['title', 'body', 'kind', 'labels', 'pinned', 'created', 'updated', 'source', 'extra', 'fileId', 'md5', 'fileName', 'folder']
              .forEach(function (k) { target[k] = fresh[k]; });
            target.v++;
          }
          await store.put(target); changed.push(target.id);
        } else {
          notes[fresh.id] = fresh; await store.put(fresh); changed.push(fresh.id);
        }
      }
      // Files deleted or moved out of Notes on another device: drop the copy here, unless it has unsaved changes.
      var gone = all().filter(function (n) { return n.fileId && !seen[n.fileId] && !n.dirty && !n.conflict; });
      for (var j = 0; j < gone.length; j++) { delete notes[gone[j].id]; await store.del(gone[j].id); changed.push(gone[j].id); }
      if (changed.length) hooks.changed(changed);
    }

    async function run(opts) {
      opts = opts || {};
      clearTimeout(timer); timer = null;
      if (running) { again = true; againPull = againPull || !!opts.pull; return; }
      if (!online()) { state.phase = 'offline'; emit(); return; }
      if (!Drive.signedIn()) { state.phase = 'signin'; emit(); return; }
      running = true; state.phase = 'syncing'; state.error = null; emit();
      try {
        await ensureFolders();
        await push();
        if (opts.pull || !state.lastSynced) { await pull(); await push(); }
        state.phase = 'idle'; state.lastSynced = Date.now();
      } catch (e) {
        if (e.code === 'notfound') { folders = null; try { localStorage.removeItem('qn-folders'); } catch (x) {} }
        state.phase = e.code === 'auth' ? 'signin' : e.code === 'offline' ? 'offline' : 'error';
        state.error = e;
      }
      running = false;
      emit();
      if (again) { var p = againPull; again = false; againPull = false; run({ pull: p }); }
    }

    var api = {
      run: run,
      schedule: function (ms) { clearTimeout(timer); timer = setTimeout(function () { run(); }, ms); },
      status: function () {
        var waiting = all().filter(function (n) { return n.dirty && !n.conflict; });
        var conflicts = all().filter(function (n) { return n.conflict; });
        return { phase: state.phase, error: state.error, lastSynced: state.lastSynced, waiting: waiting, conflicts: conflicts };
      },
      // Changed on another device: three ways out.
      useTheirs: async function (n) {
        if (n.conflict.trashed) { delete notes[n.id]; await store.del(n.id); hooks.changed([n.id]); return null; }
        var f = await Drive.get(n.fileId);
        var fresh = parse(await Drive.readText(n.fileId), f);
        ['title', 'body', 'kind', 'labels', 'pinned', 'created', 'updated', 'source', 'extra', 'md5']
          .forEach(function (k) { n[k] = fresh[k]; });
        n.dirty = false; n.conflict = null; n.v++;
        await store.put(n); hooks.changed([n.id]); emit();
        return n;
      },
      useMine: async function (n) {
        if (n.conflict.trashed) { n.fileId = null; n.md5 = null; } else n.md5 = n.conflict.md5;
        n.conflict = null; n.dirty = true; n.v++;
        await store.put(n); hooks.changed([n.id]); run();
        return n;
      },
      keepBoth: async function (n) {
        var theirs = null;
        if (!n.conflict.trashed) {
          var f = await Drive.get(n.fileId);
          theirs = parse(await Drive.readText(n.fileId), f);
          theirs.id = n.id; theirs.folder = n.folder;
        }
        var mine = JSON.parse(JSON.stringify(n));
        mine.id = uuid(); mine.fileId = null; mine.md5 = null; mine.fileName = null; mine.conflict = null;
        mine.dirty = true; mine.v = 1; mine.updated = new Date().toISOString();
        if (theirs) { notes[theirs.id] = theirs; await store.put(theirs); } else { delete notes[n.id]; await store.del(n.id); }
        notes[mine.id] = mine; await store.put(mine);
        hooks.changed([n.id, mine.id]); run();
        return mine;
      }
    };
    return api;
  }

  window.Notes = { parse: parse, serialize: serialize, fileName: fileName, isChecklist: isChecklist, isEmpty: isEmpty,
    uuid: uuid, TASK: TASK, Store: Store, Sync: Sync };
})();
