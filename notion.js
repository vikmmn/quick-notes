// Quick Notes: a one-time copy of a Notion "Markdown & CSV" export into Quick Notes › Notion.
// Each page becomes a note; sub-pages go in a folder named after their parent page (the export's own layout);
// images and files go to Notion › Attachments with their links rewritten. Safe to run again: what is there is skipped.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG, Drive = window.Drive, Z = window.QNZip, FOLDER = Drive.FOLDER;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mb(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fnv(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function base(path) { return path.split('/').pop(); }
  function dirOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }

  var S = { index: null, paused: null, stop: false, driveFiles: [] };

  // ---------- Reading zips: from Drive a block at a time, or from this device ----------
  var BLOCK = 8 * 1048576, KEEP = 24;
  function DriveZip(file) {
    var blocks = new Map();
    function block(n, size) {
      if (blocks.has(n)) { var p = blocks.get(n); blocks.delete(n); blocks.set(n, p); return p; }
      var start = n * BLOCK, end = Math.min(size, start + BLOCK) - 1;
      var pr = withAuth(function () { return Drive.readRange(file.id, start, end); });
      pr.catch(function () { blocks.delete(n); });
      blocks.set(n, pr);
      while (blocks.size > KEEP) blocks.delete(blocks.keys().next().value);
      return pr;
    }
    class DriveReader extends Z.Reader {
      async init() {
        this.size = Number(file.size) || await withAuth(function () { return Drive.size(file.id); });
        if (super.init) await super.init();
      }
      async readUint8Array(index, length) {
        var size = this.size, first = Math.floor(index / BLOCK), last = Math.floor((index + length - 1) / BLOCK);
        if (last - first > 3) return withAuth(function () { return Drive.readRange(file.id, index, index + length - 1); });
        var parts = [];
        for (var n = first; n <= last; n++) parts.push(block(n, size));
        parts = await Promise.all(parts);
        var out = new Uint8Array(length), at = 0;
        for (var i = 0; i < parts.length; i++) {
          var bStart = (first + i) * BLOCK, from = Math.max(index, bStart) - bStart, to = Math.min(index + length, bStart + parts[i].length) - bStart;
          out.set(parts[i].subarray(from, to), at); at += to - from;
        }
        return out;
      }
    }
    return new DriveReader();
  }
  async function listDriveZips() {
    var box = $('driveZips');
    if (!Drive.signedIn()) { box.innerHTML = '<p class="muted">Sign in to see the Notion exports in your Drive.</p>'; return; }
    box.innerHTML = '<p class="muted">Looking for Notion exports in your Drive…</p>';
    try {
      var files = (await Drive.findZips('Export-')).sort(function (a, b) { return String(b.createdTime).localeCompare(String(a.createdTime)); });
      S.driveFiles = files;
      if (!files.length) { box.innerHTML = '<p class="muted">Choose the export zip below. It can be in Google Drive: in the file picker, open Drive and pick it there.</p>'; return; }
      box.innerHTML = files.map(function (f, i) {
        return '<label class="pick"><input type="checkbox" data-id="' + esc(f.id) + '"' + (i === 0 ? ' checked' : '') + '><span><b>' + esc(f.name) + '</b><br><small>' + mb(Number(f.size) || 0) + ' · ' + new Date(f.createdTime).toLocaleString() + '</small></span></label>';
      }).join('');
    } catch (e) { box.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
  }

  // ---------- Names: Notion adds a 32-character id to every page and folder name ----------
  var ID = /\s+([0-9a-f]{32})$/i;
  function clean(seg) { return seg.replace(/\.md$/i, '').replace(ID, '').trim(); }
  function pageId(name) { var m = ID.exec(name.replace(/\.md$/i, '')); return m ? m[1].toLowerCase() : null; }
  // Folder path of a page inside Notion, without the export's own wrapper folders.
  function cleanDir(path) {
    return path.split('/').filter(Boolean).filter(function (seg, i) {
      return !(i === 0 && /^Export-[0-9a-f-]+$/i.test(seg)) && !/^Private (&|and) Shared$/i.test(seg) && seg !== 'Teamspaces';
    }).map(clean).map(function (s) { return s.replace(/[\\:*?"<>|]/g, '-').slice(0, 80) || 'Untitled'; });
  }
  function resolve(fromDir, rel) {
    var out = fromDir ? fromDir.split('/') : [];
    rel.split('/').forEach(function (p) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); });
    return out.join('/');
  }

  // ---------- Scan ----------
  async function scan() {
    var chosen = [];
    Array.prototype.forEach.call(document.querySelectorAll('#driveZips input:checked'), function (c) {
      var f = S.driveFiles.filter(function (x) { return x.id === c.dataset.id; })[0];
      if (f) chosen.push({ name: f.name, reader: function () { return DriveZip(f); } });
    });
    Array.prototype.forEach.call($('localZips').files || [], function (f) { chosen.push({ name: f.name, reader: function () { return new Z.BlobReader(f); } }); });
    if (!chosen.length) { say('Choose the export zip first.', true); return; }
    $('scanBtn').disabled = true;
    say('Reading the list of files inside the export…');
    var pages = [], files = {}, csv = 0, bytes = 0;
    async function open(reader, label) {
      var zip = new Z.ZipReader(reader);
      var entries = await withAuth(function () { return zip.getEntries(); });
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i], name = en.filename.replace(/\\/g, '/');
        if (en.directory || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
        if (/\.zip$/i.test(name)) { // newer exports put the real export zip(s) inside the download
          say('Opening ' + base(name) + ' inside ' + label + '…');
          var blob = await withAuth(function () { return en.getData(new Z.BlobWriter('application/zip')); });
          await open(new Z.BlobReader(blob), base(name));
        } else if (/\.md$/i.test(name)) pages.push({ entry: en, path: name });
        else if (/\.csv$/i.test(name)) csv++;
        else { files[name] = { entry: en }; bytes += en.uncompressedSize; }
      }
    }
    try {
      for (var i = 0; i < chosen.length; i++) await open(chosen[i].reader(), chosen[i].name);
      say('Reading ' + pages.length + ' pages…');
      for (var j = 0; j < pages.length; j += 48) {
        await Promise.all(pages.slice(j, j + 48).map(function (p) {
          return withAuth(function () { return p.entry.getData(new Z.TextWriter()); }).then(function (t) { p.text = t; });
        }));
        say('Reading pages… ' + Math.min(j + 48, pages.length) + ' of ' + pages.length);
      }
      pages.sort(function (a, b) { return a.path.localeCompare(b.path); });
      S.index = { pages: pages, files: files, bytes: bytes, csv: csv };
      summarize();
    } catch (e) { say(e.message || String(e), true); }
    $('scanBtn').disabled = false;
  }
  function summarize() {
    var x = S.index, folders = {}, linked = {};
    x.pages.forEach(function (p) {
      var d = cleanDir(dirOf(p.path)).join(' / '); if (d) folders[d] = 1;
      convert(p, { files: true }).att.forEach(function (a) { linked[a.path] = 1; });
    });
    var nf = Object.keys(linked).length;
    $('summary').innerHTML = '<h2>What\'s in the export</h2><ul>' +
      '<li><b>' + x.pages.length + ' pages</b>' + (Object.keys(folders).length ? ', ' + Object.keys(folders).length + ' of them with sub-pages (these become folders)' : '') + '</li>' +
      '<li>' + nf + ' images and files used in pages (' + mb(x.bytes) + ' in the export)</li>' +
      (x.csv ? '<li>' + x.csv + ' database table' + (x.csv > 1 ? 's' : '') + ': each row\'s page comes in as a note; the table view itself is not copied</li>' : '') +
      '</ul><p class="muted">Everything goes to Quick Notes › Notion. Each page\'s Tags become labels.</p>';
    if (!x.pages.length) $('summary').innerHTML += '<p class="bad">No pages found. Make sure the export format was Markdown &amp; CSV.</p>';
    $('step3').classList.remove('hidden');
    say('');
  }

  // ---------- One Notion page → one Quick Notes Markdown file ----------
  var PROP = /^([A-Za-z][\w ()/-]{0,38}):\s*(.*)$/;
  function convert(p, opts) {
    var text = String(p.text || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    var lines = text.split('\n'), title = '', i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (/^# /.test(lines[i] || '')) { title = lines[i].slice(2).trim(); i++; }
    if (!title) title = clean(base(p.path)) || 'Untitled';
    // The property lines right under the title (Created, Tags, Status…): kept in the note, and read for dates and labels.
    var j = i; while (j < lines.length && !lines[j].trim()) j++;
    var props = {}, k = j;
    while (k < lines.length && PROP.test(lines[k])) { var m = PROP.exec(lines[k]); props[m[1].toLowerCase()] = m[2].trim(); k++; }
    if (k === j || (k < lines.length && lines[k].trim())) props = {};
    var created = when(props.created || props['created time'] || props['date created'] || props.date) ||
      (p.entry.lastModDate ? new Date(p.entry.lastModDate).toISOString() : new Date().toISOString());
    var updated = when(props['last edited time'] || props['last edited'] || props.updated) || created;
    var labels = String(props.tags || props.labels || props.tag || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    var body = lines.slice(i).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    // Callouts (<aside>) become quotes; links to other pages and tables become plain text; files get new links.
    body = body.replace(/<aside>\s*\n?([\s\S]*?)\n?\s*<\/aside>/g, function (_, inner) {
      return inner.trim().split('\n').map(function (l) { return '> ' + l; }).join('\n');
    });
    var dir = dirOf(p.path), att = [];
    body = body.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (all, bang, label, href) {
      if (/^[a-z][a-z0-9+.-]*:|^#/i.test(href)) return all;
      var rel; try { rel = decodeURIComponent(href); } catch (e) { rel = href; }
      var full = resolve(dir, rel);
      if (/\.(md|csv)$/i.test(full)) return label || clean(base(full));
      var hit = S.index && S.index.files[full];
      if (!hit) return bang ? '' : label || all;
      var name = fnv(full) + '-' + base(full).replace(/[\\/:*?"<>|#%]/g, '-');
      att.push({ path: full, name: name, entry: hit.entry });
      if (!opts.files) return bang ? '' : label;
      return bang + '[' + label + '](Attachments/' + encodeURIComponent(name) + ')';
    });
    var id = pageId(base(p.path)) || fnv(p.path);
    var fm = ['---', 'id: notion-' + id, 'created: ' + created, 'updated: ' + updated, 'labels: ' + JSON.stringify(labels), 'pinned: false', 'source: notion',
      'notion-file: ' + JSON.stringify(p.path), '---', '', '# ' + title.replace(/\n/g, ' '), ''];
    return { md: fm.join('\n') + '\n' + body + '\n', title: title, created: created, att: att };
  }
  function when(v) {
    if (!v) return null;
    var d = new Date(v.replace(/\s*\(GMT[^)]*\)\s*$/, '').replace(/ at /, ' '));
    return isNaN(d) ? null : d.toISOString();
  }
  function fileNameFor(c) {
    var d = new Date(c.created), s = c.title.split(/\s+/).slice(0, 8).join(' ').replace(/[\\/:*?"<>|#\[\]^]/g, '-').replace(/\s+/g, ' ').trim();
    if (s.length > 50) s = s.slice(0, 50).replace(/\s+\S*$/, '').trim() || s.slice(0, 50);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes()) + ' ' + (s || 'Notion page');
  }

  // ---------- Copy ----------
  async function folderIn(name, parent) {
    return (await Drive.findExact(name, parent, FOLDER)) || (await Drive.createFolder(name, parent));
  }
  async function existingNames(folderId) {
    var names = {};
    (await Drive.list(folderId)).forEach(function (f) { names[f.name] = f.id; });
    return names;
  }
  async function withAuth(fn) {
    for (;;) {
      if (S.paused) await S.paused.promise;
      try { return await fn(); }
      catch (e) {
        if (e.code !== 'auth' && !/401/.test(e.message || '')) throw e;
        if (!S.paused) {
          var d = {}; d.promise = new Promise(function (r) { d.resolve = r; }); S.paused = d;
          $('pause').classList.remove('hidden');
        }
      }
    }
  }
  $('continueBtn').onclick = async function () {
    try { await Drive.signIn(); } catch (e) { say(e.message, true); return; }
    $('pause').classList.add('hidden');
    var d = S.paused; S.paused = null; if (d) d.resolve();
  };

  // The screen stays on while copying; Android lets go of that when you switch away, so take it again on return.
  var lock = null, wantLock = false;
  async function holdScreen(on) {
    wantLock = on;
    try {
      if (on && navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', function () { lock = null; }); }
      if (!on && lock) { await lock.release(); lock = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && wantLock) holdScreen(true); });

  async function run() {
    var opts = { files: $('optFiles').checked };
    $('importBtn').disabled = true; $('scanBtn').disabled = true; S.stop = false;
    $('progress').classList.remove('hidden');
    await holdScreen(true);
    var todo = S.index.pages.map(function (p) { var c = convert(p, opts); c.page = p; c.dir = cleanDir(dirOf(p.path)); return c; });
    var log = [], done = 0, skipped = 0, filesDone = 0, filesSkipped = 0, bytes = 0;
    function show(now) {
      $('bar').style.width = (todo.length ? Math.round((done + skipped) / todo.length * 100) : 100) + '%';
      $('count').textContent = (done + skipped) + ' of ' + todo.length + ' pages' + (skipped ? ' (' + skipped + ' were already there)' : '') +
        ' · ' + filesDone + ' files copied, ' + mb(bytes) + (filesSkipped ? ' (' + filesSkipped + ' already there)' : '');
      if (now) $('now').textContent = now;
    }
    try {
      say('Getting the Notion folders ready…');
      var notesF = await withAuth(function () { return Drive.findRoot(); });
      var notionF = await withAuth(function () { return folderIn('Notion', notesF.id); });
      var attF = opts.files ? await withAuth(function () { return folderIn('Attachments', notionF.id); }) : null;
      var haveAtt = attF ? await withAuth(function () { return existingNames(attF.id); }) : {};
      // Folders, made one level at a time, and what each already holds.
      var dirs = { '': { id: notionF.id, have: await withAuth(function () { return existingNames(notionF.id); }) } };
      var dirLock = Promise.resolve();
      function dirFor(parts) { // one at a time, so two pages never make the same folder twice
        var p = dirLock.then(function () { return makeDir(parts); });
        dirLock = p.catch(function () {});
        return p;
      }
      async function makeDir(parts) {
        var key = '';
        for (var i = 0; i < parts.length; i++) {
          var parent = dirs[key], next = key ? key + '/' + parts[i] : parts[i];
          if (!dirs[next]) {
            var hit = parent.have[parts[i]];
            var f = hit ? { id: hit } : await withAuth(function () { return Drive.createFolder(parts[i], parent.id); });
            parent.have[parts[i]] = f.id;
            dirs[next] = { id: f.id, have: hit ? await withAuth(function () { return existingNames(f.id); }) : {} };
          }
          key = next;
        }
        return dirs[key];
      }
      // File names: the same page gets the same name every run, so a second run skips it.
      var used = {};
      for (var t = 0; t < todo.length; t++) {
        var c = todo[t], k = c.dir.join('/') + '/' + fileNameFor(c), name = k, n = 2;
        while (used[name]) name = k + ' (' + (n++) + ')';
        used[name] = 1; c.fileName = name.split('/').pop() + '.md';
      }
      say('');
      var queue = todo.slice();
      async function worker() {
        while (queue.length && !S.stop) {
          var c = queue.shift();
          try {
            var d = await dirFor(c.dir);
            var exists = !!d.have[c.fileName];
            if (opts.files) for (var a of c.att) {
              if (haveAtt[a.name]) { filesSkipped++; continue; }
              haveAtt[a.name] = 'busy';
              var blob = await withAuth(function () { return a.entry.getData(new Z.BlobWriter()); });
              await withAuth(function () { return Drive.upload(a.name, attF.id, blob, mime(a.name)); });
              filesDone++; bytes += blob.size; show();
            }
            if (exists) { skipped++; show(); continue; }
            show('Copying ' + c.title);
            await withAuth(function () { return Drive.create(c.fileName, d.id, c.md); });
            d.have[c.fileName] = 1; done++;
          } catch (e) { log.push(c.title + ': ' + (e.message || e)); done++; }
          show();
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker));
      show(S.stop ? 'Stopped. Run it again any time to carry on where it stopped.' : 'Done.');
      $('result').innerHTML = (S.stop ? '<p><b>Stopped.</b> Run the copy again to carry on; what is already there is skipped.</p>' :
        '<p><b>Copy finished.</b> Open Quick Notes and the pages appear under Notion as it syncs.</p>') +
        (log.length ? '<details open><summary>' + log.length + ' problem' + (log.length > 1 ? 's' : '') + '</summary><ul>' + log.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>' : '') +
        '<p><a class="button" href="./">Open Quick Notes</a></p>';
    } catch (e) { say(e.message || String(e), true); }
    await holdScreen(false);
    $('importBtn').disabled = false; $('scanBtn').disabled = false;
  }
  function mime(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime' }[ext] || 'application/octet-stream';
  }

  function say(t, bad) { $('status').textContent = t || ''; $('status').className = bad ? 'bad' : 'muted'; }

  // ---------- Page ----------
  async function signIn() {
    try { await Drive.signIn(); renderSignIn(); listDriveZips(); } catch (e) { say(e.message, true); }
  }
  function renderSignIn() {
    $('signedOut').classList.toggle('hidden', Drive.signedIn());
    $('demoNote').classList.toggle('hidden', !Drive.demo);
  }
  $('signInBtn').onclick = signIn;
  $('scanBtn').onclick = scan;
  $('importBtn').onclick = run;
  $('stopBtn').onclick = function () { S.stop = true; $('now').textContent = 'Stopping after the pages being copied now…'; };
  $('localZips').onchange = function () { $('localList').textContent = Array.prototype.map.call(this.files, function (f) { return f.name + ' (' + mb(f.size) + ')'; }).join(', '); };
  window.addEventListener('beforeunload', function (e) { if ($('importBtn').disabled && !S.stop) { e.preventDefault(); e.returnValue = ''; } });

  (async function () {
    if (Drive.demo) await Drive.signIn();
    renderSignIn();
    listDriveZips();
  })();
  window.QNNotion = { convert: convert, cleanDir: cleanDir, S: S };
})();
