// Quick Notes: import everything from a Google Keep export (Google Takeout) into Readables › Notes › Keep.
// The export is read straight from Drive a piece at a time (or from zips chosen on this device), so a
// 1 GB+ export never has to be downloaded whole. Safe to run again: notes and files already there are skipped.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG, Drive = window.Drive, Z = window.QNZip, FOLDER = Drive.FOLDER;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mb(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fnv(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function base(path) { return path.split('/').pop(); }
  function usec(v) { var n = Number(v); return n ? new Date(n / 1000).toISOString() : null; }

  var S = { sources: [], index: null, plan: null, paused: null, stop: false };

  // ---------- Sources: Takeout zips in Drive, or zips on this device ----------
  // Reads the zip straight from Drive in big 8 MB blocks, a few at a time, and keeps recent blocks in memory.
  // Each request to Drive takes seconds whatever its size, so a few big reads beat thousands of small ones.
  var BLOCK = 8 * 1048576, KEEP = 24;
  function DriveZip(file) {
    var blocks = new Map(); // block number -> Promise<Uint8Array>
    function block(n, size) {
      if (blocks.has(n)) { var p = blocks.get(n); blocks.delete(n); blocks.set(n, p); return p; } // most recent last
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
    if (!Drive.signedIn()) { box.innerHTML = '<p class="muted">Sign in to see the exports in your Drive.</p>'; return; }
    box.innerHTML = '<p class="muted">Looking for Takeout exports in your Drive…</p>';
    try {
      var files = (await Drive.findTakeout()).sort(function (a, b) { return String(b.createdTime).localeCompare(String(a.createdTime)); });
      if (!files.length) { box.innerHTML = '<p class="muted">No Takeout zips found in your Drive. You can choose zips from this device below.</p>'; return; }
      var newest = (files[0].name.match(/takeout-(\d{8}T\d{6}Z)/) || [])[1];
      box.innerHTML = files.map(function (f) {
        var on = newest && f.name.indexOf(newest) > -1;
        return '<label class="pick"><input type="checkbox" data-id="' + esc(f.id) + '"' + (on ? ' checked' : '') + '><span><b>' + esc(f.name) + '</b><br><small>' + mb(Number(f.size) || 0) + ' · ' + new Date(f.createdTime).toLocaleString() + '</small></span></label>';
      }).join('');
      S.driveFiles = files;
    } catch (e) { box.innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
  }

  // ---------- Scan: what is in the export ----------
  async function scan() {
    var chosen = [];
    Array.prototype.forEach.call(document.querySelectorAll('#driveZips input:checked'), function (c) {
      var f = S.driveFiles.filter(function (x) { return x.id === c.dataset.id; })[0];
      if (f) chosen.push({ name: f.name, size: Number(f.size) || 0, reader: function () { return DriveZip(f); } });
    });
    Array.prototype.forEach.call($('localZips').files || [], function (f) { chosen.push({ name: f.name, size: f.size, reader: function () { return new Z.BlobReader(f); } }); });
    if (!chosen.length) { say('Choose at least one export zip first.', true); return; }
    $('scanBtn').disabled = true;
    say('Reading the list of files inside the export…');
    var notes = [], files = {}, total = 0;
    try {
      for (var i = 0; i < chosen.length; i++) {
        var src = chosen[i];
        src.zip = new Z.ZipReader(src.reader());
        var entries = await withAuth(function () { return src.zip.getEntries(); });
        entries.forEach(function (en) {
          if (en.directory || !/(^|\/)Keep\//.test(en.filename)) return;
          if (/\.json$/i.test(en.filename)) notes.push({ entry: en, src: src });
          else if (!/\.html$/i.test(en.filename) && !/Labels\.txt$/i.test(en.filename)) { files[base(en.filename)] = { entry: en, src: src }; total += en.uncompressedSize; }
        });
      }
      S.sources = chosen;
      say('Reading ' + notes.length + ' notes…');
      var parsed = [];
      notes.sort(function (a, b) { return a.src === b.src ? a.entry.offset - b.entry.offset : 0; });
      for (var j = 0; j < notes.length; j += 48) {
        var batch = notes.slice(j, j + 48);
        var got = await Promise.all(batch.map(function (n) {
          return withAuth(function () { return n.entry.getData(new Z.TextWriter()); }).then(function (t) {
            try { return { json: JSON.parse(t), file: base(n.entry.filename) }; } catch (e) { return null; }
          });
        }));
        got.forEach(function (g) { if (g && (g.json.textContent !== undefined || g.json.listContent || g.json.title !== undefined || g.json.attachments)) parsed.push(g); });
        say('Reading notes… ' + Math.min(j + 48, notes.length) + ' of ' + notes.length);
      }
      // parsed stays in zip order: the import then reads attachments block by block, not all over the file
      S.index = { notes: parsed, files: files, bytes: total };
      summarize();
    } catch (e) { say(e.message || String(e), true); }
    $('scanBtn').disabled = false;
  }
  function summarize() {
    var n = S.index.notes, c = { pinned: 0, archived: 0, trashed: 0, lists: 0, att: 0, links: 0 }, labels = {};
    n.forEach(function (x) {
      var j = x.json;
      if (j.isPinned) c.pinned++; if (j.isArchived) c.archived++; if (j.isTrashed) c.trashed++;
      if (j.listContent) c.lists++; if (j.attachments && j.attachments.length) c.att++; if (j.annotations && j.annotations.length) c.links++;
      (j.labels || []).forEach(function (l) { labels[l.name] = (labels[l.name] || 0) + 1; });
    });
    var att = Object.keys(S.index.files).length;
    $('summary').innerHTML = '<h2>What\'s in the export</h2><ul>' +
      '<li><b>' + n.length + ' notes</b>: ' + c.pinned + ' pinned, ' + c.archived + ' archived, ' + c.trashed + ' in Keep\'s Trash, ' + c.lists + ' checklists</li>' +
      '<li>' + c.att + ' notes with attachments: <b>' + att + ' files, ' + mb(S.index.bytes) + '</b> (images, drawings, voice recordings)</li>' +
      '<li>' + c.links + ' notes with saved links</li>' +
      '<li>' + Object.keys(labels).length + ' labels' + (Object.keys(labels).length ? ': ' + Object.keys(labels).sort().map(function (l) { return esc(l) + ' (' + labels[l] + ')'; }).join(', ') : '') + '</li></ul>' +
      '<p class="muted">Everything goes to Readables › Notes › Keep. Archived notes go to Keep › Archive, notes from Keep\'s Trash to Keep › Trash, and files to Keep › Attachments, linked from their note.</p>';
    $('step3').classList.remove('hidden');
    say('');
  }

  // ---------- Turning a Keep note into a Quick Notes Markdown file ----------
  function firstWords(title, text) {
    var s = (title || '').trim() || String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
    s = s.split(/\s+/).slice(0, 8).join(' ').replace(/[\\/:*?"<>|#\[\]^]/g, '-').replace(/\s+/g, ' ').trim();
    if (s.length > 50) s = s.slice(0, 50).replace(/\s+\S*$/, '').trim() || s.slice(0, 50);
    return s || 'Keep note';
  }
  function plan(opts) {
    var used = {}, out = [];
    S.index.notes.forEach(function (x) {
      var j = x.json;
      if (j.isTrashed && !opts.trash) return;
      if (j.isArchived && !j.isTrashed && !opts.archive) return;
      var folder = j.isTrashed ? 'Trash' : j.isArchived ? 'Archive' : '';
      var created = usec(j.createdTimestampUsec) || usec(j.userEditedTimestampUsec) || new Date().toISOString();
      var updated = usec(j.userEditedTimestampUsec) || created;
      var d = new Date(created);
      var text = j.textContent || (j.listContent || []).map(function (i) { return i.text; }).join(' ');
      var name = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + pad(d.getMinutes()) + ' ' + firstWords(j.title, text);
      var key = folder + '/' + name, k = 2;
      while (used[key + '.md']) { key = folder + '/' + name + ' (' + k + ')'; k++; }
      used[key + '.md'] = 1;
      out.push({ x: x, folder: folder, fileName: key.split('/').pop() + '.md', created: created, updated: updated });
    });
    return out;
  }
  function markdown(p, opts) {
    var j = p.x.json, rel = p.folder ? '../Attachments/' : 'Attachments/';
    var fm = ['---', 'id: keep-' + fnv(p.x.file), 'created: ' + p.created, 'updated: ' + p.updated,
      'labels: ' + JSON.stringify((j.labels || []).map(function (l) { return l.name; })), 'pinned: ' + (j.isPinned ? 'true' : 'false'), 'source: keep'];
    if (j.isArchived) fm.push('archived: true');
    if (j.isTrashed) fm.push('trashed: true');
    if (j.color && j.color !== 'DEFAULT') fm.push('color: ' + String(j.color).toLowerCase());
    fm.push('keep-file: ' + JSON.stringify(p.x.file), '---', '');
    var out = fm;
    if (j.title) out.push('# ' + String(j.title).replace(/\n/g, ' '), '');
    var body = [];
    if (j.textContent) body.push(String(j.textContent).replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
    if (j.listContent && j.listContent.length) body.push(j.listContent.map(function (i) { return '- [' + (i.isChecked ? 'x' : ' ') + '] ' + String(i.text || '').replace(/\n/g, ' '); }).join('\n'));
    (j.annotations || []).forEach(function (a) {
      if (!a.url) return;
      body.push(a.title ? '[' + String(a.title).replace(/[\[\]]/g, '') + '](' + a.url + ')' : '<' + a.url + '>');
    });
    if (opts.files || opts.links) (j.attachments || []).forEach(function (a) {
      var f = base(a.filePath || ''), link = rel + encodeURIComponent(f).replace(/%2F/g, '/');
      if (!f) return;
      body.push(/^image\//.test(a.mimetype || '') || /\.(png|jpe?g|gif|webp)$/i.test(f) ? '![](' + link + ')' : '[' + (/^audio\//.test(a.mimetype || '') ? 'Voice recording' : f) + '](' + link + ')');
    });
    if ((j.sharees || []).length) body.push('Shared in Keep with: ' + j.sharees.map(function (s) { return s.email; }).filter(Boolean).join(', '));
    out.push(body.join('\n\n'));
    return out.join('\n').replace(/\s+$/, '') + '\n';
  }

  // ---------- Import ----------
  async function folderIn(name, parent) {
    return (await Drive.findExact(name, parent, FOLDER)) || (await Drive.createFolder(name, parent));
  }
  async function existingNames(folderId) {
    var names = {};
    (await Drive.list(folderId)).forEach(function (f) { names[f.name] = f.id; });
    return names;
  }
  // Drive calls pause (instead of failing) when the Google sign-in runs out, until you tap Continue.
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

  async function run() {
    var opts = { archive: $('optArchive').checked, trash: $('optTrash').checked, files: $('optFiles').checked, links: true };
    var todo = plan(opts);
    $('importBtn').disabled = true; $('scanBtn').disabled = true; S.stop = false;
    $('progress').classList.remove('hidden');
    var lock = null;
    try { if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch (e) {}
    var log = [], done = 0, skipped = 0, filesDone = 0, filesSkipped = 0, bytes = 0;
    function show(now) {
      $('bar').style.width = (todo.length ? Math.round((done + skipped) / todo.length * 100) : 100) + '%';
      $('count').textContent = (done + skipped) + ' of ' + todo.length + ' notes' + (skipped ? ' (' + skipped + ' were already there)' : '') +
        ' · ' + filesDone + ' files copied, ' + mb(bytes) + (filesSkipped ? ' (' + filesSkipped + ' already there)' : '');
      if (now) $('now').textContent = now;
    }
    try {
      say('Getting the Keep folders ready…');
      var notesF = await withAuth(function () { return folderIn(CFG.NOTES_FOLDER_NAME, CFG.READABLES_FOLDER_ID); });
      var keepF = await withAuth(function () { return folderIn('Keep', notesF.id); });
      var F = { '': keepF.id };
      for (var name of ['Archive', 'Trash', 'Attachments']) {
        if ((name === 'Archive' && !opts.archive) || (name === 'Trash' && !opts.trash) || (name === 'Attachments' && !opts.files)) continue;
        F[name] = (await withAuth(function () { return folderIn(name, keepF.id); })).id;
      }
      var have = {};
      for (var k in F) have[k] = await withAuth(function () { return existingNames(F[k]); });
      say('');
      var queue = todo.slice();
      async function worker() {
        while (queue.length && !S.stop) {
          var p = queue.shift();
          var exists = have[p.folder] && have[p.folder][p.fileName];
          var missing = opts.files && (p.x.json.attachments || []).some(function (a) { var f = base(a.filePath || ''); return f && !have.Attachments[f]; });
          if (exists && !missing) { skipped++; show(); continue; }
          show((exists ? 'Copying files for ' : 'Copying ') + p.fileName);
          try {
            if (opts.files) {
              for (var a of (p.x.json.attachments || [])) {
                var fname = base(a.filePath || ''), hit = S.index.files[fname];
                if (!fname) continue;
                if (have.Attachments[fname]) { filesSkipped++; continue; }
                if (!hit) { log.push('Missing from the export: ' + fname + ' (note “' + p.fileName + '”)'); continue; }
                var blob = await withAuth(function () { return hit.entry.getData(new Z.BlobWriter(a.mimetype || 'application/octet-stream')); });
                await withAuth(function () { return Drive.upload(fname, F.Attachments, blob, a.mimetype); });
                have.Attachments[fname] = 1; filesDone++; bytes += blob.size; show();
              }
            }
            if (!exists) {
              var md = markdown(p, opts);
              await withAuth(function () { return Drive.create(p.fileName, F[p.folder], md); });
              have[p.folder][p.fileName] = 1;
              done++;
            } else skipped++;
          } catch (e) { log.push(p.fileName + ': ' + (e.message || e)); done++; }
          show();
        }
      }
      await Promise.all(Array.from({ length: opts.files ? 8 : 16 }, worker));
      show(S.stop ? 'Stopped. Run it again any time to carry on where it stopped.' : 'Done.');
      $('result').innerHTML = (S.stop ? '<p><b>Stopped.</b> Run the import again to carry on; what is already there is skipped.</p>' :
        '<p><b>Import finished.</b> Open Quick Notes and the notes appear in Keep as it syncs. Check a few before you clear out Google Keep.</p>') +
        (log.length ? '<details open><summary>' + log.length + ' problem' + (log.length > 1 ? 's' : '') + '</summary><ul>' + log.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>' : '') +
        '<p><a class="button" href="./">Open Quick Notes</a></p>';
    } catch (e) { say(e.message || String(e), true); }
    try { if (lock) lock.release(); } catch (e) {}
    $('importBtn').disabled = false; $('scanBtn').disabled = false;
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
  $('stopBtn').onclick = function () { S.stop = true; $('now').textContent = 'Stopping after the notes being copied now…'; };
  $('localZips').onchange = function () { $('localList').textContent = Array.prototype.map.call(this.files, function (f) { return f.name + ' (' + mb(f.size) + ')'; }).join(', '); };
  window.addEventListener('beforeunload', function (e) { if ($('importBtn').disabled && !S.stop) { e.preventDefault(); e.returnValue = ''; } });

  (async function () {
    if (Drive.demo) await Drive.signIn();
    renderSignIn();
    listDriveZips();
  })();
  window.QNImport = { markdown: markdown, plan: plan, S: S };
})();
