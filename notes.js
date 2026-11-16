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
  function shortId() { return Math.random().toString(36).slice(2, 8); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ---------------- File format ----------------
  // ---
  // id, created, updated, labels, pinned, source (any other keys are kept as they are)
  // ---
  // # Title
  //
  // A plain note is just Markdown. A note laid out on the canvas has one section per text box, each after a
  // hidden marker with its position, and its drawings in one hidden block at the end:
  //   <!-- qn:box {"id":"b1","x":0,"y":0,"w":null} -->
  //   Markdown of that box
  //   <!-- qn:ink
  //   {"groups":[{"id":"g1","x":10,"y":200,"strokes":[{"c":"#222","s":3,"p":[[0,0,0.5],…]}]}]}
  //   -->
  // Obsidian and other Markdown apps hide the markers and show the text in reading order.
  var KNOWN = { id: 1, created: 1, updated: 1, labels: 1, pinned: 1, source: 1 };
  var BOX = /^<!-- qn:box (\{.*\}) -->[ \t]*$/;

  function parseLabels(v) {
    v = (v || '').trim();
    if (!v) return [];
    try { var a = JSON.parse(v); if (Array.isArray(a)) return a.map(String).filter(Boolean); } catch (e) {}
    return v.replace(/^\[|\]$/g, '').split(',').map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean);
  }

  function parseCanvas(body) {
    body = String(body || '');
    var ink = [];
    var inkMatch = /\n?<!-- qn:ink\n([\s\S]*?)\n-->[ \t]*\n?/.exec(body);
    if (inkMatch) {
      try { ink = JSON.parse(inkMatch[1]).groups || []; } catch (e) { ink = []; }
      body = body.slice(0, inkMatch.index) + body.slice(inkMatch.index + inkMatch[0].length);
    }
    var lines = body.split('\n'), boxes = [], cur = null, before = [];
    lines.forEach(function (line) {
      var m = BOX.exec(line);
      if (m) {
        var o = {};
        try { o = JSON.parse(m[1]); } catch (e) {}
        cur = { id: o.id || shortId(), x: +o.x || 0, y: +o.y || 0, w: o.w ? +o.w : null, lines: [] };
        boxes.push(cur);
      } else if (cur) cur.lines.push(line);
      else before.push(line);
    });
    var lead = before.join('\n').trim();
    if (lead || !boxes.length) boxes.unshift({ id: 'b0', x: 0, y: 0, w: null, lines: [lead] });
    boxes.forEach(function (b) { b.md = b.lines.join('\n').replace(/^\n+|\s+$/g, ''); delete b.lines; });
    return { boxes: boxes, ink: ink };
  }
  function isPlain(n) {
    var b = n.boxes || [];
    return !(n.ink && n.ink.length) && b.length === 1 && !b[0].x && !b[0].y && !b[0].w;
  }
  function readingOrder(boxes) {
    return (boxes || []).slice().sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
  }
  function bodyOf(n) { // the note's text in reading order, for search and previews
    return readingOrder(n.boxes).map(function (b) { return b.md; }).filter(function (s) { return s && s.trim(); }).join('\n\n');
  }
  function round(v) { return Math.round(v * 10) / 10; }
  function canvasText(n) {
    if (isPlain(n)) return String(n.boxes[0].md || '').replace(/\s+$/, '');
    var parts = readingOrder(n.boxes).map(function (b) {
      return '<!-- qn:box ' + JSON.stringify({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), w: b.w ? Math.round(b.w) : null }) + ' -->\n' +
        String(b.md || '').replace(/\s+$/, '');
    });
    if (n.ink && n.ink.length) {
      var groups = n.ink.map(function (g) {
        return { id: g.id, x: Math.round(g.x), y: Math.round(g.y), strokes: g.strokes.map(function (s) {
          return { c: s.c, s: s.s, h: s.h ? 1 : undefined, p: s.p.map(function (p) { return [round(p[0]), round(p[1]), Math.round((p[2] || 0.5) * 100) / 100]; }) };
        }) };
      });
      parts.push('<!-- qn:ink\n' + JSON.stringify({ groups: groups }) + '\n-->');
    }
    return parts.join('\n\n');
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
    var c = parseCanvas(rest.replace(/\s+$/, ''));
    var fileTime = file && (file.modifiedTime || file.createdTime);
    var n = {
      id: (fm.id || '').trim() || ('file-' + (file ? file.id : uuid())),
      title: title,
      boxes: c.boxes, ink: c.ink, body: '',
      labels: parseLabels(fm.labels),
      pinned: /^\s*true\s*$/i.test(fm.pinned || ''),
      created: (fm.created || '').trim() || (file && file.createdTime) || new Date().toISOString(),
      updated: (fm.updated || '').trim() || fileTime || new Date().toISOString(),
      source: (fm.source || '').trim() || 'notes',
      extra: extra,
      fileId: file ? file.id : null,
      md5: file ? file.md5Checksum : null,
      fileName: file ? file.name : null,
      folderId: file && file.parents ? file.parents[0] : null,
      moveFrom: null,
      dirty: false, deleted: false, conflict: null, v: 0
    };
    n.body = bodyOf(n);
    return n;
  }
  // Notes saved by version 1 kept only `body`: give them a canvas.
  function upgrade(n) {
    if (!n.boxes) { var c = parseCanvas(n.body || ''); n.boxes = c.boxes; n.ink = c.ink; }
    if (!n.ink) n.ink = [];
    if (n.folderId === undefined) n.folderId = null;
    delete n.kind; delete n.folder;
    n.body = bodyOf(n);
    return n;
  }
  function serialize(n) {
    var out = ['---', 'id: ' + n.id, 'created: ' + n.created, 'updated: ' + n.updated,
      'labels: ' + JSON.stringify(n.labels || []), 'pinned: ' + (n.pinned ? 'true' : 'false'), 'source: ' + (n.source || 'notes')]
      .concat(n.extra || [], ['---', '']);
    if (n.title) out.push('# ' + n.title.replace(/\n/g, ' '), '');
    out.push(canvasText(n));
    return out.join('\n').replace(/\s+$/, '') + '\n';
  }
  function plainText(md) {
    return String(md || '').replace(/<[^>]+>/g, '').replace(TASK, '$2').replace(/[*_~`#>]/g, '').replace(/\\\n/g, '\n');
  }
  function firstWords(n) {
    var s = (n.title || '').trim();
    if (!s) {
      var line = plainText(n.body).split('\n').map(function (l) { return l.replace(/^[\s\-\d.]+/, '').trim(); }).filter(Boolean)[0] || '';
      s = line.split(/\s+/).slice(0, 8).join(' ');
    }
    if (!s && n.ink && n.ink.length) s = 'Drawing';
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
    return !String(n.title || '').trim() && !plainText(bodyOf(n)).trim() && !(n.ink && n.ink.length) && !(n.labels || []).length;
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
        var list;
        if (!db) list = Object.keys(mem).map(function (k) { return mem[k]; });
        else { try { list = await req(tx('readonly').getAll()); } catch (e) { db = null; api.persistent = false; list = []; } }
        return list.map(upgrade);
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
  // Push: every changed note is written to its own file (new notes go to their folder, or Notes › Inbox).
  // Pull: every Markdown file under Notes, in any folder depth, is listed; only changed files are downloaded.
  var FIELDS_COPY = ['title', 'boxes', 'ink', 'body', 'labels', 'pinned', 'created', 'updated', 'source', 'extra', 'fileId', 'md5', 'fileName', 'folderId'];
  function Sync(store, notes, hooks) {
    var state = { phase: 'idle', error: null, lastSynced: null };
    var running = false, again = false, againPull = false, timer = null, folders = null, tree = {};
    var KEY = Drive.demo ? null : 'qn-folders';
    try { if (KEY) { var saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved) { folders = saved.ids || null; tree = saved.tree || {}; } } } catch (e) {}

    function saveFolders() { if (KEY) { try { localStorage.setItem(KEY, JSON.stringify({ ids: folders, tree: tree })); } catch (e) {} } }
    function all() { return Object.keys(notes).map(function (k) { return notes[k]; }); }
    function emit() { hooks.status(api.status()); }
    function online() { return navigator.onLine && !(Drive.isOffline && Drive.isOffline()); }
    function ready() { return online() && Drive.signedIn(); }

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
        tree[sub.id] = { id: sub.id, name: name, parentId: top.id };
      }
      folders = f; saveFolders(); hooks.folders();
      return f;
    }

    async function listAll() {
      var out = [], newTree = {}, queue = [{ id: folders.notes, depth: 0 }];
      while (queue.length) {
        var dir = queue.shift();
        var items = await Drive.list(dir.id);
        items.forEach(function (f) {
          if (f.mimeType === FOLDER) {
            if (f.name.charAt(0) === '.' || dir.depth >= 12) return;
            newTree[f.id] = { id: f.id, name: f.name, parentId: dir.id };
            queue.push({ id: f.id, depth: dir.depth + 1 });
          } else if (/\.md$/i.test(f.name)) out.push(f);
        });
      }
      tree = newTree; saveFolders(); hooks.folders();
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
        var target = n.folderId && (tree[n.folderId] || n.folderId === folders.notes) ? n.folderId : folders[CFG.SUBFOLDERS[0]];
        var text = serialize(n);
        if (!n.fileId) {
          var made = await Drive.create(fileName(n), target, text);
          n.fileId = made.id; n.md5 = made.md5Checksum; n.fileName = made.name; n.folderId = target; n.moveFrom = null;
        } else {
          if (n.moveFrom && n.moveFrom !== target) { await Drive.move(n.fileId, target, n.moveFrom); }
          n.moveFrom = null; n.folderId = target;
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
        var parent = f.parents && f.parents[0];
        if (local && local.md5 === f.md5Checksum) {
          if (!local.moveFrom && local.folderId !== parent) { local.folderId = parent; await store.put(local); changed.push(local.id); }
          continue;
        }
        if (local && (local.dirty || local.conflict)) {
          if (!local.conflict) { local.conflict = { md5: f.md5Checksum, trashed: false, modifiedTime: f.modifiedTime }; await store.put(local); changed.push(local.id); }
          continue;
        }
        var fresh = parse(await Drive.readText(f.id), f);
        var target = local || (byId[fresh.id] && !byId[fresh.id].fileId ? byId[fresh.id] : null);
        if (!target && byId[fresh.id]) fresh.id = fresh.id + '-' + f.id.slice(-6); // same id in two files: keep both
        if (target) {
          if (target.dirty) { // created here; its file was made by an earlier push that was cut short
            target.fileId = f.id; target.md5 = null; target.fileName = f.name; target.folderId = parent;
          } else {
            FIELDS_COPY.forEach(function (k) { target[k] = fresh[k]; });
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
        if (e.code === 'notfound') { folders = null; tree = {}; saveFolders(); }
        state.phase = e.code === 'auth' ? 'signin' : e.code === 'offline' ? 'offline' : 'error';
        state.error = e;
      }
      running = false;
      emit();
      if (again) { var p = againPull; again = false; againPull = false; run({ pull: p }); }
    }

    function needReady() {
      if (!online()) { var e = new Error('Folders can only be changed while online.'); e.code = 'offline'; throw e; }
      if (!Drive.signedIn()) { var e2 = new Error('Sign in to Google first (tap the sync button at the top).'); e2.code = 'auth'; throw e2; }
    }

    var api = {
      run: run,
      schedule: function (ms) { clearTimeout(timer); timer = setTimeout(function () { run(); }, ms); },
      status: function () {
        var waiting = all().filter(function (n) { return n.dirty && !n.conflict; });
        var conflicts = all().filter(function (n) { return n.conflict; });
        return { phase: state.phase, error: state.error, lastSynced: state.lastSynced, waiting: waiting, conflicts: conflicts };
      },
      // ---- Folders: Drive folders inside Notes. Changing them needs a connection. ----
      root: function () { return folders && folders.notes; },
      inbox: function () { return folders && folders[CFG.SUBFOLDERS[0]]; },
      tree: function () { return tree; },
      createFolder: async function (name, parentId) {
        needReady(); await ensureFolders();
        var f = await Drive.createFolder(name, parentId || folders.notes);
        tree[f.id] = { id: f.id, name: name, parentId: parentId || folders.notes };
        saveFolders(); hooks.folders();
        return f.id;
      },
      renameFolder: async function (id, name) {
        needReady();
        await Drive.rename(id, name);
        tree[id].name = name; saveFolders(); hooks.folders();
      },
      moveFolder: async function (id, newParent) {
        needReady();
        for (var p = newParent; p; p = tree[p] && tree[p].parentId) if (p === id) throw new Error("A folder can't go inside itself.");
        await Drive.move(id, newParent, tree[id].parentId);
        tree[id].parentId = newParent; saveFolders(); hooks.folders();
      },
      deleteFolder: async function (id) {
        needReady();
        var inside = all().some(function (n) { return !n.deleted && n.folderId === id; }) ||
          Object.keys(tree).some(function (k) { return tree[k].parentId === id; });
        if (inside) throw new Error('Move or delete what is inside it first.');
        var left = await Drive.list(id);
        if (left.length) throw new Error('It still has files in Drive. Move or delete them first.');
        await Drive.trash(id);
        delete tree[id]; saveFolders(); hooks.folders();
      },
      // ---- Changed on another device: three ways out ----
      useTheirs: async function (n) {
        if (n.conflict.trashed) { delete notes[n.id]; await store.del(n.id); hooks.changed([n.id]); return null; }
        var f = await Drive.get(n.fileId);
        var fresh = parse(await Drive.readText(n.fileId), f);
        FIELDS_COPY.forEach(function (k) { n[k] = fresh[k]; });
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
          theirs.id = n.id;
        }
        var mine = JSON.parse(JSON.stringify(n));
        mine.id = uuid(); mine.fileId = null; mine.md5 = null; mine.fileName = null; mine.conflict = null; mine.moveFrom = null;
        mine.dirty = true; mine.v = 1; mine.updated = new Date().toISOString();
        if (theirs) { notes[theirs.id] = theirs; await store.put(theirs); } else { delete notes[n.id]; await store.del(n.id); }
        notes[mine.id] = mine; await store.put(mine);
        hooks.changed([n.id, mine.id]); run();
        return mine;
      }
    };
    return api;
  }

  window.Notes = { parse: parse, serialize: serialize, fileName: fileName, isEmpty: isEmpty, bodyOf: bodyOf, plainText: plainText,
    readingOrder: readingOrder, parseCanvas: parseCanvas, upgrade: upgrade, uuid: uuid, shortId: shortId, TASK: TASK, Store: Store, Sync: Sync };
})();
