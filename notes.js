// Serendipity: the note file format, the copy kept on this device, and syncing with Google Drive.
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
  var KNOWN = { id: 1, created: 1, updated: 1, labels: 1, pinned: 1, source: 1, order: 1, page: 1, device: 1 };
  // (3.36) Which kind of device saved the file last: only used to label both versions of a paragraph rewritten on two devices.
  function deviceName() {
    try { var s = localStorage.getItem('qn-device'); if (s) return s; } catch (e) {}
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|Android/i.test(ua)) return 'phone';
    return 'computer';
  }
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
      try { var j = JSON.parse(inkMatch[1]); ink = window.QNInk.normalize(j.layers ? j.layers : j.groups || []); } catch (e) { ink = []; }
      body = body.slice(0, inkMatch.index) + body.slice(inkMatch.index + inkMatch[0].length);
    }
    // (3.35) Connectors between text boxes and paper: one line, <!-- qn:links [{"id","a","b","e","k"}] -->
    var links = [], lkMatch = /\n?<!-- qn:links (\[[\s\S]*?\]) -->[ \t]*\n?/.exec(body);
    if (lkMatch) {
      try { links = JSON.parse(lkMatch[1]).filter(function (l) { return l && l.a && l.b; }); } catch (e) { links = []; }
      body = body.slice(0, lkMatch.index) + body.slice(lkMatch.index + lkMatch[0].length);
    }
    var lines = body.split('\n'), boxes = [], cur = null, before = [];
    lines.forEach(function (line) {
      var m = BOX.exec(line);
      if (m) {
        var o = {};
        try { o = JSON.parse(m[1]); } catch (e) {}
        cur = { id: o.id || shortId(), x: +o.x || 0, y: +o.y || 0, w: o.w ? +o.w : null, lines: [] };
        if (o.r) cur.r = +o.r; // turned to how it was written on a turned page
        if (o.g) cur.g = String(o.g); // in a collective with drawings
        if (o.co) cur.co = +o.co;
        if (o.ls) cur.ls = +o.ls; // (3.28) line spacing of the box
        if (o.ps != null) cur.ps = +o.ps; // (3.28) space after each paragraph, in em
        if (o.tk != null) cur.tk = +o.tk; // (3.34) letter spacing of the box, in em
        if (o.st) cur.st = String(o.st); // (3.35) paper: 'sticky' | 'card' | 'sheet' | 'kraft'
        if (o.sc) cur.sc = String(o.sc); // its colour
        if (o.h) cur.h = +o.h; // its height (paper keeps its size; plain text grows with what is in it)
        if (o.l) cur.l = String(o.l); // the drawing layer the text belongs to (hidden, locked and faded with it)
        if (o.z != null) cur.z = String(o.z); // the drawing item it sits just in front of ('' = the back of its layer)
        boxes.push(cur);
      } else if (cur) cur.lines.push(line);
      else before.push(line);
    });
    var lead = before.join('\n').trim();
    if (lead || !boxes.length) boxes.unshift({ id: 'b0', x: 0, y: 0, w: null, lines: [lead] });
    boxes.forEach(function (b) { b.md = b.lines.join('\n').replace(/^\n+|\s+$/g, ''); delete b.lines; });
    return { boxes: boxes, ink: ink, links: links };
  }
  function hasInk(n) { return !!(n && window.QNInk && window.QNInk.hasInk(n.ink)); }
  function isPlain(n) {
    var b = n.boxes || [];
    return !hasInk(n) && !(n.links && n.links.length) && b.length === 1 && !b[0].x && !b[0].y && !b[0].w && !b[0].ls && b[0].ps == null && b[0].tk == null && !b[0].st;
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
      var meta = { id: b.id, x: Math.round(b.x), y: Math.round(b.y), w: b.w ? Math.round(b.w) : null };
      if (b.l) meta.l = b.l;
      if (b.r) meta.r = Math.round(b.r * 1000) / 1000;
      if (b.g) meta.g = b.g;
      if (b.co) meta.co = Math.round(b.co * 100) / 100;
      if (b.ls) meta.ls = b.ls;
      if (b.ps != null) meta.ps = b.ps;
      if (b.tk != null) meta.tk = b.tk;
      if (b.st) { meta.st = b.st; if (b.sc) meta.sc = b.sc; if (b.h) meta.h = Math.round(b.h); }
      if (b.z != null) meta.z = b.z;
      return '<!-- qn:box ' + JSON.stringify(meta) + ' -->\n' +
        String(b.md || '').replace(/\s+$/, '');
    });
    if (n.links && n.links.length) parts.push('<!-- qn:links ' + JSON.stringify(n.links) + ' -->');
    if (hasInk(n)) parts.push('<!-- qn:ink\n' + JSON.stringify(window.QNInk.toJSON(n.ink)) + '\n-->');
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
      boxes: c.boxes, ink: c.ink, links: c.links, body: '',
      labels: parseLabels(fm.labels),
      pinned: /^\s*true\s*$/i.test(fm.pinned || ''),
      order: fm.order != null && fm.order !== '' && !isNaN(+fm.order) ? +fm.order : null, // its place in the list, once dragged there
      created: (fm.created || '').trim() || (file && file.createdTime) || new Date().toISOString(),
      updated: (fm.updated || '').trim() || fileTime || new Date().toISOString(),
      source: (fm.source || '').trim() || 'notes',
      page: (fm.page || '').trim(), // the page behind everything: 'grid', 'dots', 'lines' and a paper colour, e.g. 'grid cream'
      device: (fm.device || '').trim(),
      base: file ? text : null, // (3.36) the file as Drive had it: the shared original when two devices' changes are combined
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
    if (typeof n.inkS === 'string') { try { n.ink = JSON.parse(n.inkS); } catch (e) { n.ink = []; } delete n.inkS; }
    if (!n.boxes) { var c = parseCanvas(n.body || ''); n.boxes = c.boxes; n.ink = c.ink; n.links = c.links; }
    if (!Array.isArray(n.links)) n.links = [];
    n.ink = n.ink && n.ink.length ? window.QNInk.normalize(n.ink) : [];
    if (n.folderId === undefined) n.folderId = null;
    delete n.kind; delete n.folder;
    n.body = bodyOf(n);
    return n;
  }
  function serialize(n) {
    var out = ['---', 'id: ' + n.id, 'created: ' + n.created, 'updated: ' + n.updated,
      'labels: ' + JSON.stringify(n.labels || []), 'pinned: ' + (n.pinned ? 'true' : 'false'), 'source: ' + (n.source || 'notes'), 'device: ' + deviceName()]
      .concat(n.order != null ? ['order: ' + n.order] : [])
      .concat(n.page ? ['page: ' + n.page] : [])
      .concat(n.extra || [], ['---', '']);
    if (n.title) out.push('# ' + n.title.replace(/\n/g, ' '), '');
    out.push(canvasText(n));
    return out.join('\n').replace(/\s+$/, '') + '\n';
  }
  function plainText(md) {
    return String(md || '').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(TASK, '$2').replace(/[*_~`#>]/g, '').replace(/\\\n/g, '\n');
  }
  function firstWords(n) {
    var s = (n.title || '').trim();
    if (!s) {
      var line = plainText(n.body).split('\n').map(function (l) { return l.replace(/^[\s\-\d.]+/, '').trim(); }).filter(Boolean)[0] || '';
      s = line.split(/\s+/).slice(0, 8).join(' ');
    }
    if (!s && hasInk(n)) s = 'Drawing';
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
    return !String(n.title || '').trim() && !plainText(bodyOf(n)).trim() && !hasInk(n) && !(n.labels || []).length;
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
          var r = indexedDB.open('quick-notes', 2);
          r.onupgradeneeded = function () {
            var d = r.result;
            if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
            // Changes handed to the service worker to send while the phone sleeps, and the sign-in it sends them with.
            if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'noteId' });
            if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
          };
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }
    var inkText = new WeakMap();
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
        // (3.38) The drawing is stored as one piece of text: copying it as thousands of small objects (twice) was a
        // long pause after every stroke on a busy page.
        var copy = Object.assign({}, n), ic = inkText.get(n);
        // the same drawing as last time (only sync details changed): its text is reused
        if (!ic || ic.v !== n.v || ic.ink !== n.ink) { ic = { v: n.v, ink: n.ink, s: JSON.stringify(n.ink || []) }; inkText.set(n, ic); }
        copy.inkS = ic.s; delete copy.ink;
        copy = JSON.parse(JSON.stringify(copy));
        delete copy.isDraft;
        if (!db) { mem[n.id] = copy; return Promise.resolve(); }
        return req(tx('readwrite').put(copy)).catch(function () {});
      },
      del: function (id) {
        if (!db) { delete mem[id]; return Promise.resolve(); }
        return req(tx('readwrite').delete(id)).catch(function () {});
      },
      // ---- The outbox (real app only) ----
      outboxPeek: async function () {
        if (!db) return [];
        try { return await req(db.transaction('outbox', 'readonly').objectStore('outbox').getAll()); } catch (e) { return []; }
      },
      outboxPut: function (jobs, token) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(['outbox', 'meta'], 'readwrite');
          jobs.forEach(function (j) { t.objectStore('outbox').put(j); });
          t.objectStore('meta').put({ key: 'token', token: token.token, expiresAt: token.expiresAt, refresh: token.refresh || '', server: token.server || '' });
          t.oncomplete = function () { resolve(); }; t.onerror = function () { reject(t.error); }; t.onabort = function () { reject(t.error); };
        });
      },
      // Takes back everything the service worker hasn't started: returns what it finished, and how many it is still sending.
      outboxClaim: function () {
        if (!db) return Promise.resolve({ done: [], inflight: 0 });
        return new Promise(function (resolve) {
          var out = { done: [], inflight: 0 };
          var t = db.transaction('outbox', 'readwrite'), os = t.objectStore('outbox');
          os.getAll().onsuccess = function (e) {
            e.target.result.forEach(function (j) {
              if (j.status === 'inflight' && Date.now() - (j.started || 0) < 120000) { out.inflight++; return; }
              if (j.status === 'done') out.done.push(j);
              os.delete(j.noteId);
            });
          };
          t.oncomplete = function () { resolve(out); }; t.onerror = function () { resolve(out); };
        });
      }
    };
    return api;
  }

  // ---------------- Syncing with Google Drive ----------------
  // Push: every changed note is written to its own file (new notes go to their folder, or Notes › Inbox).
  // Pull: every Markdown file under Notes, in any folder depth, is listed; only changed files are downloaded.
  var FIELDS_COPY = ['title', 'boxes', 'ink', 'links', 'body', 'labels', 'pinned', 'order', 'created', 'updated', 'source', 'extra', 'fileId', 'md5', 'fileName', 'folderId', 'page', 'device', 'base'];
  function Sync(store, notes, hooks) {
    var state = { phase: 'idle', error: null, lastSynced: null };
    var running = false, again = false, againPull = false, againFull = false, timer = null, folders = null, tree = {}, making = {};
    var outboxMaybe = true, handedOff = false; // the outbox is checked once at start, and after every hand-off
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
      var top = await Drive.findRoot();
      f.notes = top.id; f.rootName = top.name;
      for (var i = 0; i < CFG.SUBFOLDERS.length; i++) {
        var name = CFG.SUBFOLDERS[i];
        var sub = await Drive.markedFolder(name, top.id, 'qn' + name);
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
          if (n.fileId) {
            // (3.36) Changed on another device since this one last saw it: the change wins, the note comes back.
            var now = null;
            try { now = await Drive.get(n.fileId); } catch (e) { if (e.code !== 'notfound') throw e; }
            if (now && !now.trashed && n.md5 && now.md5Checksum !== n.md5) {
              var back = parse(await Drive.readText(n.fileId), now);
              FIELDS_COPY.forEach(function (k) { n[k] = back[k]; });
              n.deleted = false; n.dirty = false; n.v++;
              await store.put(n); changed.push(n.id);
              continue;
            }
            if (now && !now.trashed) await Drive.trash(n.fileId);
          }
          if (n.deleted && n.v === v) { delete notes[n.id]; await store.del(n.id); changed.push(n.id); }
          continue;
        }
        var target = targetOf(n);
        // (3.38) Never in the middle of a pen line: writing a big drawing out takes a moment.
        for (var w = 0; w < 40 && hooks.drawing && hooks.drawing(); w++) await new Promise(function (r) { setTimeout(r, 250); });
        var text = serialize(n);
        if (!n.fileId && n.creating) {
          // (3.36) An earlier create may have reached Drive with its answer lost: use that file, don't make a second.
          var same = (await Drive.list(n.creatingIn || target)).filter(function (f) { return f.name === n.creating; });
          for (var s = 0; s < same.length && !n.fileId; s++) {
            var st = await Drive.readText(same[s].id);
            if (st.indexOf('\nid: ' + n.id + '\n') > -1) { n.fileId = same[s].id; n.md5 = same[s].md5Checksum; n.fileName = same[s].name; n.folderId = n.creatingIn || target; }
          }
          n.creating = null; n.creatingIn = null;
        }
        if (!n.fileId) {
          n.creating = fileName(n); n.creatingIn = target; await store.put(n);
          var made = await Drive.create(n.creating, target, text);
          n.creating = null; n.creatingIn = null;
          n.fileId = made.id; n.md5 = made.md5Checksum; n.fileName = made.name; n.folderId = target; n.moveFrom = null; n.base = text;
        } else {
          if (n.moveFrom && n.moveFrom !== target) { await Drive.move(n.fileId, target, n.moveFrom); }
          n.moveFrom = null; n.folderId = target;
          var r = await Drive.saveText(n.fileId, text, n.md5);
          if (r.conflict) {
            n.conflict = { md5: r.file.md5Checksum, trashed: !!r.file.trashed, modifiedTime: r.file.modifiedTime };
            await store.put(n); changed.push(n.id);
            continue;
          }
          n.md5 = r.file.md5Checksum; n.base = text;
        }
        if (n.v === v) n.dirty = false;
        await store.put(n); changed.push(n.id);
      }
      if (changed.length) hooks.changed(changed);
    }

    // (3.39, #105/#106) What changed in Drive since the last look, from Drive's own list of changes: usually one small
    // request, so another device's note shows here within seconds instead of after listing all ~5,000 notes.
    // null = do the full listing (no starting point yet, or a folder was added, renamed or moved).
    async function changedSince() {
      if (!Drive.changes || !folders || !folders.chg) return null;
      var tok = folders.chg, live = {}, gone = {}, page;
      do {
        page = await Drive.changes(tok);
        for (var i = 0; i < (page.changes || []).length; i++) {
          var c = page.changes[i], f = c.file;
          if (c.removed || !f) { if (tree[c.fileId]) return null; gone[c.fileId] = 1; delete live[c.fileId]; continue; }
          var p = f.parents && f.parents[0], inside = !!p && (p === folders.notes || !!tree[p]);
          if (f.mimeType === FOLDER) {
            var t = tree[f.id];
            if (t ? (f.trashed || !inside || t.name !== f.name || t.parentId !== p) : (inside && !f.trashed && f.name.charAt(0) !== '.')) return null;
            continue;
          }
          if (!/\.md$/i.test(f.name)) continue;
          if (f.trashed || !inside) { gone[f.id] = 1; delete live[f.id]; } else { live[f.id] = f; delete gone[f.id]; }
        }
        tok = page.nextPageToken || page.newStartPageToken;
      } while (page.nextPageToken);
      folders.chg = tok; saveFolders();
      return { remote: Object.keys(live).map(function (k) { return live[k]; }), gone: gone };
    }

    async function pull(full) {
      var remote = null, goneFiles = null;
      // A full listing at least every half hour, as a safety net; the quick way in between.
      if (!full && folders && folders.full && Date.now() - folders.full < 30 * 60000) {
        var ch = await changedSince(); if (ch) { remote = ch.remote; goneFiles = ch.gone; }
      }
      if (!remote) {
        var start = null; if (Drive.startToken) { try { start = await Drive.startToken(); } catch (e) { if (e.code === 'auth' || e.code === 'offline') throw e; } }
        remote = await listAll(); // (the starting point is taken first: anything changed while listing comes again next time)
        if (start) { folders.chg = start; folders.full = Date.now(); saveFolders(); }
      }
      var byFile = {}, byId = {};
      all().forEach(function (n) { if (n.fileId) byFile[n.fileId] = n; byId[n.id] = n; });
      var seen = {}, changed = [], remoteIds = {};
      remote.forEach(function (f) { remoteIds[f.id] = 1; });
      // Download every changed file first, many at once (each request to Drive can take seconds).
      var need = remote.filter(function (f) {
        var l = byFile[f.id];
        return !(l && (l.md5 === f.md5Checksum || l.dirty || l.conflict));
      });
      var texts = {}, q = need.slice(), got = 0;
      async function fetcher() {
        while (q.length) {
          var f = q.shift();
          try { texts[f.id] = await Drive.readText(f.id); } catch (e) { if (e.code === 'auth' || e.code === 'offline') throw e; }
          if (++got % 50 === 0 && hooks.progress) hooks.progress(got, need.length);
        }
      }
      if (need.length) await Promise.all(Array.from({ length: Math.min(16, need.length) }, fetcher));
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
        if (texts[f.id] === undefined) continue; // could not be read this time; next sync tries again
        // (3.40, #114) This device's own save coming back through Drive's change list: nothing new, so the open
        // page is not made again (that also emptied its undo).
        if (local && !local.dirty && local.base != null && texts[f.id] === local.base) { local.md5 = f.md5Checksum; await store.put(local); continue; }
        var fresh = parse(texts[f.id], f);
        var target = local || (byId[fresh.id] && !byId[fresh.id].fileId ? byId[fresh.id] : null);
        // (3.37) The same note whose old file is gone from Drive (made again elsewhere): this is its file now, not a
        // second copy of the note (the list showed "UHV Final Part 1" twice).
        var twin = !target && byId[fresh.id];
        if (twin && twin.fileId && !remoteIds[twin.fileId] && !twin.deleted) {
          if (twin.dirty || twin.conflict) { twin.fileId = f.id; twin.fileName = f.name; twin.folderId = parent; twin.conflict = { md5: f.md5Checksum, trashed: false, modifiedTime: f.modifiedTime }; }
          else { FIELDS_COPY.forEach(function (k) { twin[k] = fresh[k]; }); twin.v++; }
          await store.put(twin); changed.push(twin.id); continue;
        }
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
      var gone = all().filter(function (n) { return n.fileId && (goneFiles ? goneFiles[n.fileId] : !seen[n.fileId]) && !n.dirty && !n.conflict; });
      for (var j = 0; j < gone.length; j++) { delete notes[gone[j].id]; await store.del(gone[j].id); changed.push(gone[j].id); }
      if (changed.length) hooks.changed(changed);
    }

    // ---- While the phone sleeps: hand the unsent changes to the service worker, which sends them even with the app frozen ----
    function targetOf(n) { return n.folderId && (tree[n.folderId] || n.folderId === folders.notes) ? n.folderId : folders[CFG.SUBFOLDERS[0]]; }
    async function handoff() {
      if (Drive.demo || !store.persistent || !folders || !folders.notes || running) return false;
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller || !window.SyncManager) return false;
      var tok = Drive.token && Drive.token();
      if (!tok || (!tok.refresh && tok.expiresAt - Date.now() < 3 * 60000)) return false;
      var reg = await navigator.serviceWorker.ready;
      if (!reg.sync) return false;
      var before = await store.outboxPeek();
      if (before.some(function (j) { return j.status === 'inflight'; })) return false;
      var jobs = [];
      all().filter(function (n) { return n.dirty && !n.conflict; }).forEach(function (n) {
        if (n.deleted) { if (n.fileId) jobs.push({ noteId: n.id, v: n.v, kind: 'trash', fileId: n.fileId, md5: n.md5, status: 'pending' }); return; }
        var j = { noteId: n.id, v: n.v, text: serialize(n), parent: targetOf(n), status: 'pending' };
        if (!n.fileId) { j.kind = 'create'; j.name = fileName(n); }
        else { j.kind = 'save'; j.fileId = n.fileId; j.md5 = n.md5; if (n.moveFrom && n.moveFrom !== j.parent) j.moveFrom = n.moveFrom; }
        jobs.push(j);
      });
      if (!jobs.length) return true;
      await store.outboxPut(jobs, tok);
      outboxMaybe = true;
      await reg.sync.register('qn-push');
      handedOff = true;
      return true;
    }
    // Back in the app: take in what the service worker sent, and take back what it hasn't started.
    async function takeBack() {
      if (!outboxMaybe || Drive.demo) return true;
      for (var tries = 0; tries < 15; tries++) {
        var r = await store.outboxClaim(), changed = [];
        for (var i = 0; i < r.done.length; i++) {
          var j = r.done[i], n = notes[j.noteId], res = j.result || {};
          if (!n || res.conflict || res.error) continue;
          if (j.kind === 'trash') {
            if (n.deleted && n.v === j.v) { delete notes[n.id]; await store.del(n.id); }
            else { n.fileId = null; n.md5 = null; n.fileName = null; await store.put(n); }
          } else {
            n.fileId = res.id; n.md5 = res.md5; n.fileName = res.name || n.fileName; n.folderId = j.parent; n.moveFrom = null; n.base = j.text;
            if (n.v === j.v) n.dirty = false;
            await store.put(n);
          }
          changed.push(j.noteId);
        }
        if (changed.length) hooks.changed(changed);
        if (!r.inflight) { outboxMaybe = false; handedOff = false; return true; }
        await new Promise(function (ok) { setTimeout(ok, 1000); });
      }
      return false; // still being sent; try again in a moment
    }

    // (3.36) Changed on two devices: combined by itself, nothing asked and nothing lost (merge.js). The original both
    // devices started from is `base`, the file as this device last had it from Drive. The combined note is then
    // treated as this device's edit on top of the other device's version, and pushed like any other edit: if a third
    // device saved meanwhile, the push is refused and the next round combines again. A note deleted on another
    // device but changed here comes back with this device's version.
    function whenLabel(dev, iso) {
      var d = new Date(iso), m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return 'from ' + (dev || 'another device') + (isNaN(d) ? '' : ', ' + d.getDate() + ' ' + m[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()));
    }
    async function settle() {
      var list = all().filter(function (n) { return n.conflict; }), changed = [], pushAgain = false, later = false;
      for (var i = 0; i < list.length; i++) {
        var n = list[i], c = n.conflict;
        if (hooks.busy && hooks.busy(n.id)) { later = true; continue; } // being typed in right now: combine when the typing stops
        try {
          var f = c.trashed ? null : await Drive.get(n.fileId);
          if (!f || f.trashed) {
            // (3.37) A copy of this note already lives in another file (kept as "<id>-…"): combine into that one and
            // drop this copy, instead of making yet another file.
            var tw = all().filter(function (m) { return m !== n && m.fileId && !m.deleted && m.id.indexOf(n.id + '-') === 0; })[0];
            if (tw) {
              var mt = window.QNMerge.mergeNote(n.base ? parse(n.base) : null, n, tw, { mineNewer: String(n.updated) >= String(tw.updated), labelA: whenLabel(deviceName(), n.updated), labelB: whenLabel(tw.device, tw.updated) });
              ['title', 'boxes', 'ink', 'links', 'labels', 'pinned', 'order', 'page', 'updated'].forEach(function (k) { tw[k] = mt[k]; });
              tw.ink = window.QNInk.normalize(tw.ink); tw.body = bodyOf(tw); tw.dirty = true; tw.v++; pushAgain = true;
              await store.put(tw); changed.push(tw.id);
              delete notes[n.id]; await store.del(n.id); changed.push(n.id);
              if (hooks.merged) hooks.merged(tw.id);
              continue;
            }
            n.fileId = null; n.md5 = null; n.base = null; n.conflict = null; n.dirty = true; n.v++; pushAgain = true;
            await store.put(n); changed.push(n.id); continue;
          }
          var txt = await Drive.readText(n.fileId);
          if (hooks.busy && hooks.busy(n.id)) { later = true; continue; }
          if (hooks.flush) hooks.flush(n.id);
          var theirs = parse(txt, f), orig = n.base ? parse(n.base) : null;
          var mineT = Date.parse(n.updated) || 0, theirT = Date.parse(theirs.updated) || Date.parse(f.modifiedTime) || 0;
          var m = window.QNMerge.mergeNote(orig, n, theirs, {
            mineNewer: mineT >= theirT,
            labelA: whenLabel(deviceName(), n.updated),
            labelB: whenLabel(theirs.device, theirs.updated || f.modifiedTime)
          });
          ['title', 'boxes', 'ink', 'links', 'labels', 'pinned', 'order', 'page', 'updated'].forEach(function (k) { n[k] = m[k]; });
          n.ink = window.QNInk.normalize(n.ink); n.body = bodyOf(n);
          n.md5 = f.md5Checksum; n.base = txt; n.conflict = null; n.dirty = true; n.v++; pushAgain = true;
          if (hooks.merged) hooks.merged(n.id);
          await store.put(n); changed.push(n.id);
        } catch (e) { if (e.code === 'auth' || e.code === 'offline') throw e; later = true; }
      }
      if (changed.length) hooks.changed(changed);
      if (pushAgain) await push();
      if (later || all().some(function (n) { return n.conflict; })) api.schedule(3000);
    }
    async function run(opts) {
      opts = opts || {};
      clearTimeout(timer); timer = null;
      if (running) { again = true; againPull = againPull || !!opts.pull; againFull = againFull || !!opts.full; return; }
      if (document.visibilityState === 'hidden' && handedOff) return; // the service worker has it
      if (!online()) { state.phase = 'offline'; emit(); return; }
      if (!Drive.signedIn()) { state.phase = 'signin'; emit(); return; }
      running = true; state.phase = 'syncing'; state.error = null; emit();
      try {
        if (!(await takeBack())) { running = false; state.phase = 'idle'; emit(); api.schedule(4000); return; }
        await ensureFolders();
        // The main folder's name, fresh each full check (it may have been renamed in Drive).
        try { var nm = (await Drive.get(folders.notes)).name; if (nm && nm !== folders.rootName) { folders.rootName = nm; saveFolders(); hooks.folders(); } } catch (e) { if (e.code === 'auth' || e.code === 'offline') throw e; }
        await push();
        if (opts.pull || !state.lastSynced) { await pull(!!opts.full || !state.lastSynced); await push(); }
        if (all().some(function (n) { return n.conflict; })) await settle();
        state.phase = 'idle'; state.lastSynced = Date.now();
      } catch (e) {
        if (e.code === 'notfound') { folders = null; tree = {}; saveFolders(); }
        state.phase = e.code === 'auth' ? 'signin' : e.code === 'offline' ? 'offline' : 'error';
        state.error = e;
      }
      running = false;
      emit();
      if (again) { var p = againPull, fu = againFull; again = false; againPull = false; againFull = false; run({ pull: p, full: fu }); }
    }

    function needReady() {
      if (!online()) { var e = new Error('Folders can only be changed while online.'); e.code = 'offline'; throw e; }
      if (!Drive.signedIn()) { var e2 = new Error('Sign in to Google first (tap the sync button at the top).'); e2.code = 'auth'; throw e2; }
    }

    var api = {
      run: run,
      handoff: function () { return handoff().catch(function () { return false; }); },
      schedule: function (ms) { clearTimeout(timer); timer = setTimeout(function () { run(); }, ms); },
      status: function () {
        var waiting = all().filter(function (n) { return n.dirty || n.conflict; }); // (3.36) a note being combined is still on its way
        var conflicts = all().filter(function (n) { return n.conflict; });
        return { phase: state.phase, error: state.error, lastSynced: state.lastSynced, waiting: waiting, conflicts: conflicts };
      },
      // ---- Folders: Drive folders inside Notes. Changing them needs a connection. ----
      root: function () { return folders && folders.notes; },
      // The main folder: renamed, and (from earlier versions, where it sat inside "Readables") maybe moved to the top of My Drive.
      renameRoot: async function (name, moveOutOf) {
        needReady(); await ensureFolders();
        await Drive.rename(folders.notes, name);
        if (moveOutOf) await Drive.move(folders.notes, 'root', moveOutOf);
        folders.rootName = name; saveFolders(); hooks.folders();
      },
      rootParents: async function () { needReady(); await ensureFolders(); var f = await Drive.get(folders.notes); return f.parents || []; },
      rootName: function () { return (folders && folders.rootName) || CFG.ROOT_FOLDER_NAME || 'Serendipity'; },
      inbox: function () { return folders && folders[CFG.SUBFOLDERS[0]]; },
      tree: function () { return tree; },
      createFolder: function (name, parentId) {
        // (3.39, #99) One folder per name in a place: a second tap on Create while the first is still on its way,
        // or a folder of that name already made (here or on another device), gives that folder instead of a twin.
        var k = (parentId || '') + '/' + name.toLowerCase();
        if (making[k]) return making[k];
        return (making[k] = (async function () {
          needReady(); await ensureFolders();
          var par = parentId || folders.notes;
          var have = Object.keys(tree).filter(function (id) { return tree[id].parentId === par && String(tree[id].name).toLowerCase() === name.toLowerCase(); })[0];
          if (have) return have;
          var f = null; try { f = await Drive.findExact(name, par, FOLDER); } catch (e) { if (e.code === 'auth' || e.code === 'offline') throw e; }
          if (!f) f = await Drive.createFolder(name, par);
          tree[f.id] = { id: f.id, name: f.name || name, parentId: par };
          saveFolders(); hooks.folders();
          return f.id;
        })().finally(function () { delete making[k]; }));
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
    readingOrder: readingOrder, hasInk: hasInk, parseCanvas: parseCanvas, upgrade: upgrade, uuid: uuid, shortId: shortId, TASK: TASK, Store: Store, Sync: Sync };
})();
