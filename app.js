// Quick Notes: opens on the notes grid; a note is a canvas of text boxes and ink; folders are Drive folders.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG;
  var Drive = window.Drive;
  var N = window.Notes;
  var TASK = N.TASK;
  var LIB = window.QNLib;

  var notes = {};
  var store = N.Store();
  var S = { view: 'list', cur: null, canvas: null, folder: null, label: null, q: '', scopeAll: false, expanded: {}, saveTimer: null, lastOpened: null };
  try { S.expanded = JSON.parse(localStorage.getItem('qn-expanded') || '{}'); } catch (e) {}
  var PREF = { tool: 'type', pen: { c: 'ink', s: 3 }, hl: '#f2c94c' };
  try { Object.assign(PREF, JSON.parse(localStorage.getItem('qn-pen') || '{}')); } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function icon(name) { return '<svg class="i"><use href="#i-' + name + '"/></svg>'; }
  function live() { return Object.keys(notes).map(function (k) { return notes[k]; }).filter(function (n) { return !n.deleted; }); }
  function allLabels() {
    var seen = {};
    live().forEach(function (n) { (n.labels || []).forEach(function (l) { seen[l.toLowerCase()] = seen[l.toLowerCase()] || l; }); });
    return Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return a.localeCompare(b); });
  }
  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function toast(text, btn, fn, ms) {
    $('toastText').textContent = text;
    $('toastBtn').textContent = btn || '';
    $('toastBtn').classList.toggle('hidden', !btn);
    $('toastBtn').onclick = function () { hideToast(); if (fn) fn(); };
    $('toast').classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(hideToast, ms || 4500);
  }
  function hideToast() { $('toast').classList.add('hidden'); }

  // ---------- Sheets (our own dialogs) ----------
  function openSheet(html, onClick, onSubmit) {
    $('sheet').innerHTML = html;
    $('sheetBack').classList.remove('hidden');
    $('sheet').onclick = function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'close') return closeSheet();
      if (onClick) onClick(b.dataset.act, b, e);
    };
    $('sheet').onsubmit = function (e) { e.preventDefault(); if (onSubmit) onSubmit(e); };
    var f = $('sheet').querySelector('input[autofocus]');
    if (f) setTimeout(function () { f.focus(); f.select(); }, 60);
  }
  function closeSheet() { $('sheetBack').classList.add('hidden'); $('sheet').innerHTML = ''; }
  function sheetError(msg) { var e = $('sheet').querySelector('.err'); if (e) e.textContent = msg; }
  $('sheetBack').addEventListener('click', function (e) { if (e.target === $('sheetBack')) closeSheet(); });

  // ---------- Folders ----------
  function tree() { return sync.tree(); }
  function rootId() { return sync.root(); }
  function folderOf(n) { return n.folderId || sync.inbox() || null; }
  function childrenOf(id) {
    var t = tree();
    return Object.keys(t).map(function (k) { return t[k]; }).filter(function (f) { return f.parentId === id; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  }
  function pathOf(id) {
    var t = tree(), out = [];
    for (var f = t[id]; f; f = t[f.parentId]) out.unshift(f);
    return out;
  }
  function inSubtree(fid, top) { for (var t = tree(), f = fid; f; f = t[f] && t[f].parentId) if (f === top) return true; return false; }
  function countIn(id) { return live().filter(function (n) { return inSubtree(folderOf(n), id); }).length; }
  function folderName(id) { var f = tree()[id]; return f ? f.name : id === rootId() ? CFG.NOTES_FOLDER_NAME : ''; }

  // ---------- Files linked from notes (Keep images, recordings) live in an Attachments folder in Drive ----------
  var imgCache = {}, attIndex = null;
  function attachments() {
    if (!attIndex) attIndex = (async function () {
      var t = tree(), map = {};
      var ids = Object.keys(t).filter(function (k) { return t[k].name === 'Attachments'; });
      for (var i = 0; i < ids.length; i++) (await Drive.list(ids[i])).forEach(function (f) { map[f.name] = f.id; });
      return map;
    })().catch(function () { attIndex = null; return {}; });
    return attIndex;
  }
  async function attachmentUrl(name) {
    if (imgCache[name]) return imgCache[name];
    var map = await attachments(), id = map[name];
    if (!id) { attIndex = null; return null; }
    imgCache[name] = URL.createObjectURL(await Drive.readBlob(id));
    return imgCache[name];
  }
  function isLocalRef(src) { return src && !/^(https?:|data:|blob:|mailto:|#)/i.test(src); }
  function refName(src) { try { return decodeURIComponent(String(src).split('/').pop()); } catch (e) { return String(src).split('/').pop(); } }
  window.QNResolveImg = function (src, img) {
    if (!isLocalRef(src)) { img.src = src; return; }
    var name = refName(src);
    img.title = name; img.classList.add('pending');
    attachmentUrl(name).then(function (u) { if (u) { img.src = u; img.classList.remove('pending'); } }).catch(function () {});
  };
  function resolveImagesIn(root) {
    Array.prototype.forEach.call(root.querySelectorAll('img[data-src]'), function (img) {
      var src = img.getAttribute('data-src'); img.removeAttribute('data-src'); window.QNResolveImg(src, img);
    });
  }

  // ---------- Sync ----------
  var sync = N.Sync(store, notes, {
    status: renderStatus,
    changed: function (ids) {
      if (S.view === 'list') renderList();
      else if (S.cur && ids.indexOf(S.cur.id) > -1) {
        if (!notes[S.cur.id] && !S.cur.isDraft) { closeNote(); showList(); return; }
        if (!S.cur.dirty && !editingNow()) reopen();
        else { renderConflict(); renderMeta(); }
      }
    },
    progress: function (n, total) { if (S.view === 'list') $('emptyMsg').textContent = 'Getting notes from Drive… ' + n + ' of ' + total; $('syncPill').textContent = 'Syncing ' + n + '/' + total; },
    folders: function () { if (S.view === 'list') renderList(); if (!$('drawer').classList.contains('hidden')) renderTree(); renderMeta(); }
  });
  function editingNow() { return document.activeElement && $('editorView').contains(document.activeElement) && document.activeElement !== document.body; }

  function renderStatus(st) {
    st = st || sync.status();
    var n = st.waiting.length, c = st.conflicts.length, text, cls = '';
    if (st.phase === 'syncing') text = 'Syncing…';
    else if (c) { text = c === 1 ? '1 needs a look' : c + ' need a look'; cls = 'waiting'; }
    else if (st.phase === 'offline') { text = n ? 'Offline · ' + n : 'Offline'; cls = n ? 'waiting' : ''; }
    else if (st.phase === 'signin') { text = n ? 'Sign in · ' + n : 'Sign in to sync'; cls = 'waiting'; }
    else if (st.phase === 'error') { text = 'Sync problem'; cls = 'bad'; }
    else if (n) { text = n + ' waiting'; cls = 'waiting'; }
    else text = 'Saved';
    ['syncPill', 'syncPill2'].forEach(function (id) {
      $(id).innerHTML = (cls ? '<span class="dot"></span>' : '') + esc(text);
      $(id).className = 'pill ' + cls;
    });
    $('syncPill2').classList.toggle('hidden', !cls && st.phase !== 'syncing');
    if (S.sheet === 'sync') renderSyncSheet();
    renderMeta();
  }
  function renderSyncSheet() {
    var st = sync.status(), text, items = st.conflicts.concat(st.waiting);
    if (st.phase === 'signin') text = 'Notes are saved on this device. Sign in with Google to send them to Drive › Readables › Notes. A sign-in lasts about an hour and renews when you tap.';
    else if (st.phase === 'offline') text = "You're offline. Notes are saved on this device and go to Drive when you're back online.";
    else if (st.phase === 'error') text = 'Drive said: ' + ((st.error && st.error.message) || 'something went wrong') + '. Notes are safe on this device.';
    else if (st.phase === 'syncing') text = 'Sending changes to Drive…';
    else text = items.length ? 'These go to Drive in a moment.' : 'Everything is in Drive › Readables › Notes.' +
      (st.lastSynced ? ' Last checked ' + new Date(st.lastSynced).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.' : '');
    S.sheet = 'sync';
    openSheet('<h2>Sync</h2><p>' + esc(text) + '</p>' + (items.length ? '<ul>' + items.map(function (n) {
      return '<li>' + esc(n.title || N.fileName(n).replace(/^\S+ \S+ |\.md$/g, '')) + (n.conflict ? ' — changed on another device' : n.deleted ? ' — to delete' : '') + '</li>';
    }).join('') + '</ul>' : '') + '<div class="row">' +
      (st.phase === 'signin' ? '<button class="primary" data-act="signin" type="button">Sign in with Google</button>' : '') +
      '<button data-act="sync" type="button"' + (st.phase === 'syncing' ? ' disabled' : '') + '>Sync now</button><button data-act="close" type="button">Close</button></div>',
    async function (act) {
      if (act === 'signin') { try { await Drive.signIn(); sync.run({ pull: true }); } catch (e) { toast(e.message); } }
      if (act === 'sync') sync.run({ pull: true });
    });
  }
  $('syncPill').onclick = $('syncPill2').onclick = function () { renderSyncSheet(); };
  var _close = closeSheet;
  closeSheet = function () { S.sheet = null; _close(); };

  // Renew the sign-in on your first tap once it has run out (or is about to).
  var lastRenew = 0;
  document.addEventListener('click', function () {
    if (Drive.demo || !Drive.signedInBefore() || !navigator.onLine) return;
    if (Drive.signedIn() && Drive.minutesLeft() > 6) return;
    if (Date.now() - lastRenew < 60000) return;
    lastRenew = Date.now();
    var wasOut = !Drive.signedIn();
    Drive.signIn().then(function () { if (wasOut) sync.run({ pull: true }); }).catch(function () {});
  }, true);

  // ---------- Saving ----------
  function touchNote(n) {
    if (n.isDraft) {
      if (N.isEmpty(n)) return;
      delete n.isDraft;
      notes[n.id] = n;
    }
    n.updated = new Date().toISOString();
    n.dirty = true;
    n.v = (n.v || 0) + 1;
    n.body = N.bodyOf(n);
    if (n === S.cur) {
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(saveNow, 300);
    } else store.put(n);
    sync.schedule(n.fileId ? 2500 : 8000); // a new note waits a little, so its file name gets more than the first letters
    renderStatus();
  }
  function saveNow() {
    clearTimeout(S.saveTimer);
    if (S.cur && !S.cur.isDraft && notes[S.cur.id]) store.put(S.cur);
  }

  // ---------- Home: the notes grid ----------
  function taskify(html) {
    var i = 0;
    return html.replace(/<li>(\s*<p>)?\[( |x|X)\]\s?/g, function (_, p, x) {
      var done = x !== ' ';
      return '<li class="task' + (done ? ' done' : '') + '"><input type="checkbox" data-tick="' + (i++) + '"' + (done ? ' checked' : '') + ' aria-label="Tick">' + (p || '');
    });
  }
  function preview(n) {
    var md = String(n.body || '').replace(/<\/?(u|mark|span|s|sub|sup)[^>]*>/gi, '');
    if (md.length > 1600) md = md.slice(0, 1600);
    var html = taskify(LIB.md.render(md)).replace(/<img src="(?!https?:|data:|blob:)([^"]*)"/g, '<img class="qn-img" data-src="$1"');
    return '<div class="prev' + (n.body.length > 500 || n.body.split('\n').length > 12 ? ' long' : '') + '">' + html + '</div>';
  }
  function card(n, extra, where) {
    var inner = '';
    if (n.pinned) inner += '<span class="pin">' + icon('pin-fill') + '</span>';
    if (n.title) inner += '<h3>' + esc(n.title) + '</h3>';
    if (where) inner += '<div class="where">' + esc(where) + '</div>';
    if (extra) inner += extra;
    else {
      if (n.body) inner += preview(n);
      if (n.ink && n.ink.length) inner += window.QNCanvas.inkSvg(n.ink, 320, 170);
    }
    var foot = (n.labels || []).map(function (l) { return '<span class="chip">' + esc(l) + '</span>'; });
    if (n.conflict) foot.push('<span class="flag">Changed elsewhere</span>');
    else if (n.dirty) foot.push('<span class="flag">Waiting</span>');
    if (foot.length) inner += '<div class="foot">' + foot.join('') + '</div>';
    return '<article class="card" tabindex="0" data-id="' + esc(n.id) + '">' + (inner || '<p class="where">Empty note</p>') + '</article>';
  }
  function renderList() {
    var words = S.q.trim();
    $('folderTitle').textContent = S.folder ? folderName(S.folder) : 'All notes';
    // breadcrumbs
    $('crumbs').innerHTML = S.folder ? '<a data-go="">All notes</a>' + pathOf(S.folder).slice(0, -1).map(function (f) {
      return ' / <a data-go="' + esc(f.id) + '">' + esc(f.name) + '</a>';
    }).join('') : '';
    // labels
    var labels = allLabels();
    if (S.label && labels.indexOf(S.label) < 0) labels.unshift(S.label);
    $('labelChips').innerHTML = labels.length ? labels.map(function (l) {
      return '<button type="button" data-label="' + esc(l) + '" aria-pressed="' + (S.label === l) + '">' + esc(l) + '</button>';
    }).join('') : '';

    var pool = live().filter(function (n) {
      if (S.label && !(n.labels || []).some(function (l) { return l.toLowerCase() === S.label.toLowerCase(); })) return false;
      return true;
    });

    // A label shows its notes from every folder; folder chips (with counts) narrow it down, several at once if you like.
    var labelView = !!S.label && !words;
    if (labelView) {
      var counts = {};
      pool.forEach(function (n) { var f = folderOf(n) || ''; counts[f] = (counts[f] || 0) + 1; });
      S.labelFolders = (S.labelFolders || []).filter(function (id) { return counts[id]; });
      var fids = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || folderName(a).localeCompare(folderName(b)); });
      $('scopeChips').innerHTML = '<button type="button" data-lf="" aria-pressed="' + !S.labelFolders.length + '">All folders · ' + pool.length + '</button>' +
        fids.map(function (id) {
          var name = pathOf(id).slice(-2).map(function (f) { return f.name; }).join(' / ') || folderName(id) || 'Notes';
          return '<button type="button" data-lf="' + esc(id) + '" aria-pressed="' + (S.labelFolders.indexOf(id) > -1) + '">' + icon('folder').replace('class="i"', 'class="i" style="width:15px;height:15px;display:inline-block;vertical-align:-2px;margin-right:4px"') + esc(name) + ' · ' + counts[id] + '</button>';
        }).join('') + '<button type="button" data-lrename="1" style="color:var(--accent)">' + icon('label').replace('class="i"', 'class="i" style="width:15px;height:15px;display:inline-block;vertical-align:-2px;margin-right:4px"') + 'Rename label</button>';
      if (S.labelFolders.length) pool = pool.filter(function (n) { return S.labelFolders.indexOf(folderOf(n) || '') > -1; });
    } else $('scopeChips').innerHTML = words && S.folder ? '<button type="button" data-scope="here" aria-pressed="' + !S.scopeAll + '">In ' + esc(folderName(S.folder)) + '</button>' +
      '<button type="button" data-scope="all" aria-pressed="' + S.scopeAll + '">All folders</button>' : '';
    $('folderTitle').textContent = labelView ? S.label : S.folder ? folderName(S.folder) : 'All notes';
    $('results').classList.toggle('hidden', !words);
    $('browse').classList.toggle('hidden', !!words);
    if (words) {
      if (S.folder && !S.scopeAll) pool = pool.filter(function (n) { return inSubtree(folderOf(n), S.folder); });
      var res = window.QNSearch.run(pool, words);
      $('results').innerHTML = res.length ? res.slice(0, 100).map(function (r) {
        var where = pathOf(folderOf(r.note)).map(function (f) { return f.name; }).join(' / ');
        return card(r.note, (where ? '<div class="where">' + esc(where) + '</div>' : '') + '<div class="snip">' + r.snippet + '</div>');
      }).join('') : '<p class="empty">No notes match “' + esc(words) + '”.' + (S.folder && !S.scopeAll ? ' Try All folders.' : '') + '</p>';
      return;
    }
    var shown = S.folder && !labelView ? pool.filter(function (n) { return folderOf(n) === S.folder; }) : pool;
    var whereOf = function (n) { return labelView ? pathOf(folderOf(n)).map(function (f) { return f.name; }).join(' / ') : ''; };
    shown.sort(function (a, b) { return String(b.updated).localeCompare(String(a.updated)); });
    var pinned = shown.filter(function (n) { return n.pinned; }), others = shown.filter(function (n) { return !n.pinned; });
    var subs = rootId() ? childrenOf(S.folder || rootId()) : [];
    $('subfolders').innerHTML = S.label ? '' : subs.map(function (f) {
      return '<div class="folder" data-folder="' + esc(f.id) + '">' + icon('folder') + '<span>' + esc(f.name) + '</span><small>' + countIn(f.id) + '</small></div>';
    }).join('') + (rootId() ? '<div class="folder" data-newfolder="1" style="color:var(--muted)">' + icon('plus') + '<span>New folder</span></div>' : '');
    var plimit = S.plimit || 100;
    $('pinned').innerHTML = pinned.slice(0, plimit).map(function (n) { return card(n, null, whereOf(n)); }).join('') +
      (pinned.length > plimit ? '<div style="column-span:all;text-align:center;padding:12px"><button type="button" id="morePinned">Show more pinned (' + (pinned.length - plimit) + ' left)</button></div>' : '');
    var mp = $('morePinned'); if (mp) mp.onclick = function (e) { e.stopPropagation(); S.plimit = plimit + 100; renderList(); };
    // Big folders (thousands of Keep notes) show 200 at a time.
    var limit = S.limit || 200;
    $('others').innerHTML = others.slice(0, limit).map(function (n) { return card(n, null, whereOf(n)); }).join('') +
      (others.length > limit ? '<div style="column-span:all;text-align:center;padding:12px"><button type="button" id="moreBtn">Show more (' + (others.length - limit) + ' left)</button></div>' : '');
    var mb = $('moreBtn'); if (mb) mb.onclick = function (e) { e.stopPropagation(); S.limit = limit + 200; renderList(); };
    $('pinnedHead').classList.toggle('hidden', !pinned.length);
    $('othersHead').classList.toggle('hidden', !pinned.length || !others.length);
    $('emptyMsg').classList.toggle('hidden', !!shown.length);
    resolveImagesIn($('browse'));
    $('emptyMsg').textContent = S.label ? 'No notes with this label here.' : S.folder ? 'No notes in this folder yet. Tap + to write one here.' : 'No notes yet. Tap + to write one.';
  }
  $('crumbs').addEventListener('click', function (e) { var a = e.target.closest('[data-go]'); if (a) goFolder(a.dataset.go || null); });
  $('labelChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-label]'); if (!b) return;
    S.label = S.label === b.dataset.label ? null : b.dataset.label; S.labelFolders = []; S.limit = 200; renderList(); window.scrollTo(0, 0);
  });
  $('scopeChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-scope]'); if (b) { S.scopeAll = b.dataset.scope === 'all'; renderList(); return; }
    var lf = e.target.closest('[data-lf]');
    if (lf) {
      var id = lf.dataset.lf, sel = S.labelFolders || [];
      if (!id) S.labelFolders = [];
      else S.labelFolders = sel.indexOf(id) > -1 ? sel.filter(function (x) { return x !== id; }) : sel.concat([id]);
      renderList(); return;
    }
    if (e.target.closest('[data-lrename]')) renameLabelSheet(S.label);
  });
  // Renaming a label changes it on every note that has it (and merges it into another label of that name).
  function renameLabelSheet(old) {
    var count = live().filter(function (n) { return (n.labels || []).some(function (l) { return l.toLowerCase() === old.toLowerCase(); }); }).length;
    openSheet('<form><h2>Rename label</h2><p>Changes “' + esc(old) + '” on ' + count + ' note' + (count === 1 ? '' : 's') + '. Using the name of another label merges the two.</p>' +
      '<input type="text" name="nl" value="' + esc(old) + '" autocapitalize="none" required maxlength="60"><div class="err"></div>' +
      '<div class="row"><button class="primary" type="submit">Rename</button><button type="button" data-act="close">Cancel</button></div></form>', null, function (e) {
      var nl = e.target.nl.value.replace(/[,#]/g, ' ').trim().replace(/\s+/g, ' ');
      if (!nl) return sheetError('Type a name.');
      if (nl === old) return closeSheet();
      var existing = allLabels().filter(function (x) { return x.toLowerCase() === nl.toLowerCase() && x.toLowerCase() !== old.toLowerCase(); })[0];
      if (existing) nl = existing;
      var changedN = 0;
      Object.keys(notes).forEach(function (k) {
        var n = notes[k];
        if (n.deleted || !(n.labels || []).some(function (l) { return l.toLowerCase() === old.toLowerCase(); })) return;
        var out = [];
        n.labels.forEach(function (l) { var v = l.toLowerCase() === old.toLowerCase() ? nl : l; if (!out.some(function (x) { return x.toLowerCase() === v.toLowerCase(); })) out.push(v); });
        n.labels = out; n.dirty = true; n.v = (n.v || 0) + 1; store.put(n); changedN++; // the note's date stays as it was
      });
      if (S.label === old) S.label = nl;
      closeSheet(); renderList(); renderStatus(); sync.schedule(2500);
      toast('Renamed on ' + changedN + ' note' + (changedN === 1 ? '' : 's'));
    });
  }
  $('subfolders').addEventListener('click', function (e) {
    var f = e.target.closest('[data-folder]');
    if (f) return goFolder(f.dataset.folder);
    if (e.target.closest('[data-newfolder]')) newFolderSheet(S.folder || rootId());
  });
  function goFolder(id) { S.limit = 200; S.folder = id || null; S.label = null; $('q').value = ''; S.q = ''; renderList(); window.scrollTo(0, 0); }

  function tickTask(n, idx) {
    var count = 0;
    N.readingOrder(n.boxes).some(function (b) {
      var lines = b.md.split('\n'), hit = false;
      for (var i = 0; i < lines.length; i++) {
        var m = TASK.exec(lines[i]);
        if (!m) continue;
        if (count++ === idx) { lines[i] = lines[i].replace(/\[( |x|X)\]/, m[1] === ' ' ? '[x]' : '[ ]'); hit = true; break; }
      }
      if (hit) b.md = lines.join('\n');
      return hit;
    });
    touchNote(n);
  }
  function onCards(e) {
    var c = e.target.closest('.card');
    if (!c) return;
    var n = notes[c.dataset.id];
    if (!n) return;
    var tick = e.target.closest('input[data-tick]');
    if (tick) { tickTask(n, +tick.dataset.tick); setTimeout(renderList, 200); return; }
    var link = e.target.closest('a');
    if (link && isLocalRef(link.getAttribute('href'))) { // a file from Drive, e.g. a Keep voice recording
      e.preventDefault();
      var w = window.open('', '_blank');
      attachmentUrl(refName(link.getAttribute('href'))).then(function (u) { if (u && w) w.location = u; else { if (w) w.close(); toast('That file isn\'t in Drive yet, or you are offline.'); } });
      return;
    }
    if (e.target.closest('input, a')) return;
    if (S.q.trim()) window.QNSearch.remember(S.q);
    openNote(n);
  }
  ['pinned', 'others', 'results'].forEach(function (id) {
    $(id).addEventListener('click', onCards);
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList.contains('card')) e.target.click(); });
  });

  // ---------- Search box ----------
  function renderRecent() {
    var list = window.QNSearch.recent();
    var show = !$('q').value && document.activeElement === $('q') && list.length;
    $('recent').classList.toggle('hidden', !show);
    $('recent').innerHTML = show ? list.map(function (r) {
      return '<div data-r="' + esc(r) + '">' + icon('search') + '<span>' + esc(r) + '</span><button type="button" data-forget="' + esc(r) + '" aria-label="Remove">×</button></div>';
    }).join('') : '';
  }
  $('q').addEventListener('input', function () { S.q = this.value; renderList(); renderRecent(); });
  $('q').addEventListener('focus', renderRecent);
  $('q').addEventListener('blur', function () { setTimeout(function () { $('recent').classList.add('hidden'); }, 200); if (S.q.trim()) window.QNSearch.remember(S.q); });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { window.QNSearch.remember(S.q); this.blur(); } });
  $('recent').addEventListener('pointerdown', function (e) { e.preventDefault(); });
  $('recent').addEventListener('click', function (e) {
    var f = e.target.closest('[data-forget]');
    if (f) { window.QNSearch.forget(f.dataset.forget); renderRecent(); return; }
    var r = e.target.closest('[data-r]');
    if (r) { $('q').value = S.q = r.dataset.r; renderList(); $('q').blur(); }
  });

  // ---------- Folders drawer ----------
  function renderTree() {
    var root = rootId();
    var html = '<div class="tree-row' + (!S.folder ? ' on' : '') + '"><span class="tw"></span><div class="nm" data-open="">' + icon('notes') + '<span>All notes</span><small>' + live().length + '</small></div></div>';
    function rows(parent, depth) {
      childrenOf(parent).forEach(function (f) {
        var kids = childrenOf(f.id).length, open = !!S.expanded[f.id];
        html += '<div class="tree-row' + (S.folder === f.id ? ' on' : '') + '" style="padding-left:' + depth * 16 + 'px">' +
          (kids ? '<button class="tw" type="button" data-tw="' + esc(f.id) + '" aria-label="' + (open ? 'Collapse' : 'Expand') + '">' + icon(open ? 'chevd' : 'chev') + '</button>' : '<span class="tw"></span>') +
          '<div class="nm" data-open="' + esc(f.id) + '">' + icon('folder') + '<span>' + esc(f.name) + '</span><small>' + countIn(f.id) + '</small></div>' +
          '<button class="more" type="button" data-fmore="' + esc(f.id) + '" aria-label="Folder options">' + icon('more') + '</button></div>';
        if (kids && open) rows(f.id, depth + 1);
      });
    }
    if (root) rows(root, 0);
    else html += '<p class="where" style="padding:8px">Folders appear after the first sync with Google Drive.</p>';
    $('tree').innerHTML = html;
    $('addRootFolder').classList.toggle('hidden', !root);
  }
  function openDrawer() {
    renderTree();
    $('drawer').classList.remove('hidden'); $('drawerBack').classList.remove('hidden');
    try { history.pushState({ v: 'drawer' }, ''); } catch (e) {}
  }
  function closeDrawer(fromPop) {
    if ($('drawer').classList.contains('hidden')) return;
    $('drawer').classList.add('hidden'); $('drawerBack').classList.add('hidden');
    if (!fromPop && history.state && history.state.v === 'drawer') history.back();
  }
  $('drawerBtn').onclick = openDrawer;
  $('drawerBack').onclick = function () { closeDrawer(); };
  $('tree').addEventListener('click', function (e) {
    var tw = e.target.closest('[data-tw]');
    if (tw) { S.expanded[tw.dataset.tw] = !S.expanded[tw.dataset.tw]; try { localStorage.setItem('qn-expanded', JSON.stringify(S.expanded)); } catch (x) {} renderTree(); return; }
    var more = e.target.closest('[data-fmore]');
    if (more) { folderSheet(more.dataset.fmore); return; }
    var o = e.target.closest('[data-open]');
    if (o) { closeDrawer(); goFolder(o.dataset.open || null); }
  });
  $('addRootFolder').onclick = function () { newFolderSheet(rootId()); };
  $('importBtn').onclick = function () {
    closeDrawer();
    setTimeout(importSheet, 250); // after the drawer's history step is undone
  };
  function importSheet() {
    openSheet('<h2>Copy notes in</h2><p>A one-time copy into Quick Notes. It is not a sync: Keep and Notion stay as they are, and edits made here stay here. Running a copy again only adds notes that are not here yet.</p>' +
      '<div class="pick"><button type="button" data-act="keep">' + icon('notes') + 'From Google Keep (Takeout export)</button>' +
      '<button type="button" data-act="notion">' + icon('notes') + 'From Notion (Markdown export)</button></div>' +
      '<div class="row"><button type="button" data-act="close">Close</button></div>',
    function (act) { if (act === 'keep') location.href = 'import.html'; if (act === 'notion') location.href = 'notion.html'; });
  }

  function newFolderSheet(parent) {
    var where = parent && parent !== rootId() ? ' inside ' + folderName(parent) : '';
    openSheet('<form><h2>New folder' + esc(where) + '</h2><input type="text" name="name" placeholder="Folder name" autofocus required maxlength="80">' +
      '<div class="err"></div><div class="row"><button class="primary" type="submit">Create</button><button type="button" data-act="close">Cancel</button></div></form>',
    null, async function (e) {
      var name = e.target.name.value.trim().replace(/[\\/]/g, '-');
      if (!name) return;
      try {
        var id = await sync.createFolder(name, parent);
        closeSheet(); S.expanded[parent] = true; renderTree();
        if (S.view === 'list') { if (!$('drawer').classList.contains('hidden')) renderTree(); renderList(); }
        toast('Folder “' + name + '” created');
        return id;
      } catch (err) { sheetError(err.message); }
    });
  }
  function folderSheet(id) {
    var f = tree()[id];
    if (!f) return;
    openSheet('<h2>' + esc(f.name) + '</h2><p>' + esc(pathOf(id).map(function (x) { return x.name; }).join(' / ')) + '</p>' +
      '<div class="pick"><button type="button" data-act="rename">Rename</button><button type="button" data-act="sub">New folder inside</button>' +
      '<button type="button" data-act="move">Move to…</button><button type="button" data-act="del" class="danger">Delete folder</button></div>' +
      '<div class="err"></div><div class="row"><button type="button" data-act="close">Close</button></div>',
    async function (act) {
      if (act === 'sub') return newFolderSheet(id);
      if (act === 'rename') {
        return openSheet('<form><h2>Rename folder</h2><input type="text" name="name" value="' + esc(f.name) + '" autofocus required maxlength="80">' +
          '<div class="err"></div><div class="row"><button class="primary" type="submit">Rename</button><button type="button" data-act="close">Cancel</button></div></form>',
        null, async function (e) {
          var name = e.target.name.value.trim().replace(/[\\/]/g, '-');
          try { await sync.renameFolder(id, name); closeSheet(); renderTree(); renderList(); } catch (err) { sheetError(err.message); }
        });
      }
      if (act === 'move') {
        return pickFolder('Move “' + f.name + '” to…', f.parentId, async function (target) {
          try { await sync.moveFolder(id, target); closeSheet(); renderTree(); renderList(); toast('Folder moved'); } catch (err) { sheetError(err.message); }
        }, id, true);
      }
      if (act === 'del') {
        try { await sync.deleteFolder(id); closeSheet(); if (S.folder === id) goFolder(f.parentId === rootId() ? null : f.parentId); renderTree(); renderList(); toast('Folder deleted (it is in Drive’s trash)'); }
        catch (err) { sheetError(err.message); }
      }
    });
  }
  // A list of every folder to pick from. `skip` hides a folder and everything inside it.
  function pickFolder(title, current, onPick, skip, allowRoot) {
    var html = '<h2>' + esc(title) + '</h2><div class="pick">';
    if (allowRoot) html += '<button type="button" data-act="pick" data-id="' + esc(rootId()) + '"' + (current === rootId() ? ' aria-pressed="true"' : '') + '>' + icon('folder') + 'Notes (top level)</button>';
    function rows(parent, depth) {
      childrenOf(parent).forEach(function (f) {
        if (f.id === skip) return;
        html += '<button type="button" data-act="pick" data-id="' + esc(f.id) + '" style="padding-left:' + (12 + depth * 18) + 'px"' + (current === f.id ? ' aria-pressed="true"' : '') + '>' + icon('folder') + esc(f.name) + '</button>';
        rows(f.id, depth + 1);
      });
    }
    if (rootId()) rows(rootId(), 0);
    html += '</div><div class="err"></div><div class="row"><button type="button" data-act="newhere">+ New folder</button><button type="button" data-act="close">Cancel</button></div>';
    if (!rootId()) html = '<h2>' + esc(title) + '</h2><p>Folders appear after the first sync with Google Drive. Sign in, then try again.</p><div class="row"><button type="button" data-act="close">Close</button></div>';
    openSheet(html, function (act, b) {
      if (act === 'pick') onPick(b.dataset.id);
      if (act === 'newhere') newFolderSheet(rootId());
    });
  }

  // ---------- A note ----------
  function newDraft(title, md) {
    var now = new Date().toISOString();
    return { id: N.uuid(), title: title || '', boxes: [{ id: 'b0', x: 0, y: 0, w: null, md: md || '' }], ink: [], body: md || '',
      labels: S.label ? [S.label] : [], pinned: false, created: now, updated: now, source: 'notes', extra: [],
      fileId: null, md5: null, fileName: null, folderId: S.folder && S.folder !== rootId() ? S.folder : null, moveFrom: null,
      dirty: false, deleted: false, conflict: null, v: 0, isDraft: true };
  }
  var canvasHooks = {
    change: function (kind) { if (kind === 'typing') return; if (S.cur) touchNote(S.cur); },
    history: function (u, r) { $('undoBtn').disabled = !u; $('redoBtn').disabled = !r; },
    focus: function () { showFmt(true); },
    blur: function () { setTimeout(function () { if (!S.canvas || !S.canvas.active() || !document.activeElement.closest || !document.activeElement.closest('.ProseMirror')) showFmt(false); }, 120); },
    selection: function (ed) { updateFmt(ed); },
    penSeen: function () {
      if (S.penToast) return; S.penToast = true;
      toast('Pen found: the pen writes, your finger scrolls.', null, null, 4000);
    }
  };
  function openNote(n, isNew) {
    if (S.cur) closeNote();
    S.cur = n; S.lastOpened = n.id;
    S.view = 'note';
    $('listView').classList.add('hidden'); $('editorView').classList.remove('hidden');
    closeMenu();
    try { history.pushState({ v: 'note' }, ''); } catch (e) {}
    $('noteTitle').value = n.title || '';
    setPin(n.pinned);
    renderLabelsRow(); renderConflict(); renderMeta();
    $('canvasWrap').scrollTo(0, 0);
    S.canvas = new window.QNCanvas.NoteCanvas($('canvasHost'), $('canvasWrap'), n, canvasHooks);
    setTool(isNew ? 'type' : (PREF.tool === 'eraser' || PREF.tool === 'select' ? 'type' : PREF.tool));
    $('undoBtn').disabled = true; $('redoBtn').disabled = true;
    if (isNew) setTimeout(function () { S.canvas.focusStart(); }, 50);
  }
  function reopen() { var n = S.cur, top = $('canvasWrap').scrollTop; S.canvas.destroy(); S.canvas = new window.QNCanvas.NoteCanvas($('canvasHost'), $('canvasWrap'), n, canvasHooks); S.canvas.setTool(PREF.tool); $('noteTitle').value = n.title || ''; setPin(n.pinned); renderLabelsRow(); renderConflict(); renderMeta(); $('canvasWrap').scrollTop = top; }
  function closeNote() {
    var n = S.cur;
    if (!n) return;
    if (S.canvas) { S.canvas.flush(); S.canvas.destroy(); S.canvas = null; }
    saveNow();
    if (!n.isDraft && N.isEmpty(n) && !n.fileId) { delete notes[n.id]; store.del(n.id); }
    S.cur = null;
    showFmt(false); closeMenu(); $('pop').classList.add('hidden');
    sync.run();
  }
  function showList() {
    S.view = 'list';
    $('editorView').classList.add('hidden'); $('listView').classList.remove('hidden');
    renderList();
  }
  window.addEventListener('popstate', function () {
    if (!$('sheetBack').classList.contains('hidden')) { closeSheet(); }
    if (!$('drawer').classList.contains('hidden')) { closeDrawer(true); return; }
    if (S.view === 'note') { closeNote(); showList(); }
  });
  $('backBtn').onclick = function () {
    if (history.state && history.state.v === 'note') history.back();
    else { closeNote(); showList(); }
  };
  $('newFab').onclick = function () { openNote(newDraft(), true); };

  function setPin(on) {
    $('pinBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('pinBtn').setAttribute('aria-label', on ? 'Unpin note' : 'Pin note');
    $('pinBtn').innerHTML = icon(on ? 'pin-fill' : 'pin');
  }
  $('pinBtn').onclick = function () { S.cur.pinned = !S.cur.pinned; setPin(S.cur.pinned); touchNote(S.cur); };
  $('noteTitle').addEventListener('input', function () { S.cur.title = this.value; touchNote(S.cur); });
  $('noteTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); S.canvas.focusStart(); } });

  function renderMeta() {
    var n = S.cur;
    if (!n || S.view !== 'note') return;
    var folder = pathOf(folderOf(n)).map(function (f) { return f.name; }).join(' / ');
    var state = n.isDraft ? '' : !n.fileId ? (n.dirty ? 'on this device, going to Drive' : '') : n.dirty ? 'waiting to sync' : 'saved in Drive';
    $('noteMeta').textContent = n.isDraft ? (folder ? 'New note in ' + folder : 'New note') : ['Edited ' + fmtWhen(n.updated), folder, state].filter(Boolean).join(' · ');
  }
  function renderLabelsRow() {
    $('noteLabels').innerHTML = (S.cur.labels || []).map(function (l) { return '<span class="chip">' + esc(l) + '</span>'; }).join('');
  }
  function renderConflict() {
    var n = S.cur, c = n && n.conflict;
    $('conflict').classList.toggle('hidden', !c);
    if (!c) return;
    $('conflictText').textContent = c.trashed ? 'It was deleted on another device. Your version is still here.'
      : 'Your version is kept here and hasn\'t been saved over the other one' + (c.modifiedTime ? ' (changed ' + fmtWhen(c.modifiedTime) + ')' : '') + '.';
    $('keepBoth').textContent = c.trashed ? 'Keep mine' : 'Keep both';
    $('useTheirs').textContent = c.trashed ? 'Delete it here too' : 'Use the other version';
    $('useMine').classList.toggle('hidden', !!c.trashed);
  }
  async function resolve(fn) {
    ['keepBoth', 'useTheirs', 'useMine'].forEach(function (id) { $(id).disabled = true; });
    try {
      S.canvas.flush();
      var n = await fn(S.cur);
      if (n) { S.cur = n; reopen(); } else { closeNote(); showList(); }
    } catch (e) {
      $('conflictText').textContent = (e.code === 'offline' ? "You're offline. " : e.code === 'auth' ? 'Sign in first (tap the sync button at the top). ' : '') + 'Nothing has been changed.';
    }
    ['keepBoth', 'useTheirs', 'useMine'].forEach(function (id) { $(id).disabled = false; });
  }
  $('keepBoth').onclick = function () { resolve(sync.keepBoth); };
  $('useTheirs').onclick = function () { resolve(sync.useTheirs); };
  $('useMine').onclick = function () { resolve(sync.useMine); };

  // Undo / redo (buttons, and Ctrl+Z / Ctrl+Y on a keyboard)
  $('undoBtn').onclick = function () { S.canvas.undo(); };
  $('redoBtn').onclick = function () { S.canvas.redo(); };
  document.addEventListener('keydown', function (e) {
    if (S.view !== 'note' || !(e.ctrlKey || e.metaKey) || document.activeElement === $('noteTitle')) return;
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); S.canvas.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); S.canvas.redo(); }
  });

  // ---------- Tools: type, pen, highlighter, eraser, move ----------
  var PEN_COLORS = ['ink', '#2b6cb0', '#c0392b', '#2f855a', '#b7791f', '#7e57c2'];
  var HL_COLORS = ['#f2c94c', '#86efac', '#93c5fd', '#f9a8d4'];
  function setTool(t) {
    PREF.tool = t; savePref();
    if (S.canvas) S.canvas.setTool(t);
    Array.prototype.forEach.call($('tools').querySelectorAll('[data-tool]'), function (b) { b.setAttribute('aria-pressed', b.dataset.tool === t ? 'true' : 'false'); });
    var html = '';
    if (t === 'pen') {
      html = '<span class="sep"></span>' + PEN_COLORS.map(function (c) {
        return '<button class="swatch" type="button" data-pc="' + c + '" style="background:' + (c === 'ink' ? 'var(--ink)' : c) + '" aria-label="Pen colour" aria-pressed="' + (PREF.pen.c === c) + '"></button>';
      }).join('') + '<span class="sep"></span>' + [2, 3.5, 6].map(function (s) {
        return '<button class="size" type="button" data-ps="' + s + '" aria-label="Pen size" aria-pressed="' + (PREF.pen.s === s) + '"><i style="width:' + (s * 2 + 2) + 'px;height:' + (s * 2 + 2) + 'px"></i></button>';
      }).join('');
    } else if (t === 'highlighter') {
      html = '<span class="sep"></span>' + HL_COLORS.map(function (c) {
        return '<button class="swatch" type="button" data-hc="' + c + '" style="background:' + c + '" aria-label="Highlighter colour" aria-pressed="' + (PREF.hl === c) + '"></button>';
      }).join('');
    } else if (t === 'type') {
      html = '<span class="where" style="padding:0 8px;white-space:nowrap">Double-tap anywhere for a new text box</span>';
    } else if (t === 'select') {
      html = '<span class="where" style="padding:0 8px;white-space:nowrap">Drag text or drawings to move them</span>';
    }
    $('penOpts').innerHTML = html;
    if (S.canvas) S.canvas.setPen({ c: PREF.pen.c, s: PREF.pen.s, hc: PREF.hl });
  }
  function savePref() { try { localStorage.setItem('qn-pen', JSON.stringify(PREF)); } catch (e) {} }
  $('tools').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) return setTool(b.dataset.tool);
    if (b.dataset.pc) { PREF.pen.c = b.dataset.pc; setTool('pen'); }
    if (b.dataset.ps) { PREF.pen.s = +b.dataset.ps; setTool('pen'); }
    if (b.dataset.hc) { PREF.hl = b.dataset.hc; setTool('highlighter'); }
  });

  // ---------- Formatting bar ----------
  function showFmt(on) {
    $('fmtBar').classList.toggle('hidden', !on);
    $('menuFab').classList.toggle('lift', on); $('noteMenu').classList.toggle('lift', on);
    if (!on) $('pop').classList.add('hidden');
    placeFmt();
  }
  function placeFmt() { // keep the bar just above the on-screen keyboard
    var vv = window.visualViewport;
    var off = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    $('fmtBar').style.bottom = off + 'px';
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', placeFmt); visualViewport.addEventListener('scroll', placeFmt); }
  var FMT_STATE = {
    bold: function (ed) { return ed.isActive('bold'); }, italic: function (ed) { return ed.isActive('italic'); },
    underline: function (ed) { return ed.isActive('underline'); }, strike: function (ed) { return ed.isActive('strike'); },
    highlight: function (ed) { return ed.isActive('highlight'); }, h1: function (ed) { return ed.isActive('heading', { level: 1 }); },
    h2: function (ed) { return ed.isActive('heading', { level: 2 }); }, bullet: function (ed) { return ed.isActive('bulletList'); },
    ordered: function (ed) { return ed.isActive('orderedList'); }, task: function (ed) { return ed.isActive('taskList'); },
    quote: function (ed) { return ed.isActive('blockquote'); }, center: function (ed) { return ed.isActive({ textAlign: 'center' }); },
    right: function (ed) { return ed.isActive({ textAlign: 'right' }); }, link: function (ed) { return ed.isActive('link'); }
  };
  function updateFmt(ed) {
    if (!ed) return;
    Array.prototype.forEach.call($('fmtBar').querySelectorAll('[data-f]'), function (b) {
      var f = FMT_STATE[b.dataset.f];
      if (f) b.setAttribute('aria-pressed', f(ed) ? 'true' : 'false');
    });
  }
  $('fmtBar').addEventListener('pointerdown', function (e) { if (e.target.closest('button')) e.preventDefault(); }); // keep the caret where it is
  function popAt(btn, html, onClick) {
    var r = btn.getBoundingClientRect(), pop = $('pop');
    pop.innerHTML = html;
    pop.classList.remove('hidden');
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
    pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
    pop.onclick = function (e) { var b = e.target.closest('button'); if (b) onClick(b); };
  }
  $('pop').addEventListener('pointerdown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
  $('fmtBar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-f]');
    if (b && b.dataset.f === 'image') { pickImage(); return; }
    var ed = S.canvas && S.canvas.active();
    if (!b || !ed) return;
    var c = ed.chain().focus();
    switch (b.dataset.f) {
      case 'bold': c.toggleBold().run(); break;
      case 'italic': c.toggleItalic().run(); break;
      case 'underline': c.toggleUnderline().run(); break;
      case 'strike': c.toggleStrike().run(); break;
      case 'h1': c.toggleHeading({ level: 1 }).run(); break;
      case 'h2': c.toggleHeading({ level: 2 }).run(); break;
      case 'bullet': c.toggleBulletList().run(); break;
      case 'ordered': c.toggleOrderedList().run(); break;
      case 'task': c.toggleTaskList().run(); break;
      case 'quote': c.toggleBlockquote().run(); break;
      case 'left': c.setTextAlign('left').run(); break;
      case 'center': c.setTextAlign('center').run(); break;
      case 'right': c.setTextAlign('right').run(); break;
      case 'clear': c.unsetAllMarks().clearNodes().run(); break;
      case 'highlight':
        popAt(b, ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8'].map(function (x) { return '<button class="swatch" data-v="' + x + '" style="background:' + x + '" aria-label="Highlight colour"></button>'; }).join('') +
          '<button data-v="">None</button>', function (p) {
          if (p.dataset.v) ed.chain().focus().setHighlight({ color: p.dataset.v }).run(); else ed.chain().focus().unsetHighlight().run();
          $('pop').classList.add('hidden');
        });
        return;
      case 'color':
        popAt(b, ['#c0392b', '#d9822b', '#2f855a', '#2b6cb0', '#7e57c2', '#8a8a8a'].map(function (x) { return '<button class="swatch" data-v="' + x + '" style="background:' + x + '" aria-label="Text colour"></button>'; }).join('') +
          '<button data-v="">Default</button>', function (p) {
          if (p.dataset.v) ed.chain().focus().setColor(p.dataset.v).run(); else ed.chain().focus().unsetColor().run();
          $('pop').classList.add('hidden');
        });
        return;
      case 'size':
        popAt(b, '<button data-v="14px" style="font-size:13px">Small</button><button data-v="">Normal</button><button data-v="21px" style="font-size:18px">Large</button><button data-v="28px" style="font-size:22px">Huge</button>', function (p) {
          if (p.dataset.v) ed.chain().focus().setFontSize(p.dataset.v).run(); else ed.chain().focus().unsetFontSize().run();
          $('pop').classList.add('hidden');
        });
        return;
      case 'link':
        var prev = ed.getAttributes('link').href || '';
        popAt(b, '<input type="text" id="linkIn" placeholder="https://…" value="' + esc(prev) + '" style="width:200px"><button data-v="set" class="primary">Set</button>' + (prev ? '<button data-v="rm">Remove</button>' : ''), function (p) {
          var url = $('linkIn').value.trim();
          if (p.dataset.v === 'rm' || !url) ed.chain().focus().extendMarkRange('link').unsetLink().run();
          else ed.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(url) ? url : 'https://' + url }).run();
          $('pop').classList.add('hidden');
        });
        $('pop').onpointerdown = null;
        setTimeout(function () { $('linkIn').focus(); }, 30);
        return;
    }
    updateFmt(ed);
  });

  // ---------- Images: saved to Notes › Attachments in Drive, shown in the note ----------
  var imgInput = document.createElement('input');
  imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.className = 'hidden';
  document.body.appendChild(imgInput);
  var imgWhere = 'below';
  function pickImage() {
    if (!S.canvas) return;
    var hasCaret = !!S.canvas.active();
    openSheet('<h2>Add an image</h2><p>Where should it go? You can drag the bar on the right of a text box to change its width.</p><div class="pick">' +
      (hasCaret ? '<button type="button" data-act="caret">At the cursor</button>' : '') +
      '<button type="button" data-act="beside">Beside the text (side by side)</button>' +
      '<button type="button" data-act="below">Below everything</button></div><div class="row"><button type="button" data-act="close">Cancel</button></div>',
    function (act) {
      if (act !== 'caret' && act !== 'beside' && act !== 'below') return;
      imgWhere = act; closeSheet();
      imgInput.value = ''; imgInput.click();
    });
  }
  imgInput.onchange = async function () {
    var f = imgInput.files && imgInput.files[0];
    if (!f || !S.canvas) return;
    if (!navigator.onLine || (Drive.isOffline && Drive.isOffline())) { toast('Images can be added while online (they are saved in Drive).'); return; }
    if (!Drive.signedIn()) { toast('Sign in to Google first (tap the sync button at the top).'); return; }
    toast('Adding the image…', null, null, 60000);
    try {
      var blob = await shrinkImage(f);
      var ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/gif' ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var name = 'image-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + N.shortId() + '.' + ext;
      var folder = await attachmentsFolder();
      var made = await Drive.upload(name, folder, blob, blob.type);
      var map = await attachments(); map[name] = made.id;
      imgCache[name] = URL.createObjectURL(blob);
      S.canvas.insertImage('Attachments/' + encodeURIComponent(name), imgWhere);
      hideToast();
    } catch (e) { toast(e.code === 'auth' ? 'Your Google sign-in ran out. Tap the sync button, then try again.' : 'The image could not be added: ' + (e.message || e)); }
  };
  async function attachmentsFolder() {
    var t = tree(), root = rootId();
    if (!root) { await sync.run(); root = rootId(); }
    var hit = Object.keys(t).filter(function (k) { return t[k].name === 'Attachments' && t[k].parentId === root; })[0];
    if (hit) return hit;
    attIndex = null;
    return sync.createFolder('Attachments', root);
  }
  // Photos from a phone camera are huge: keep them sharp on screen but small in Drive (longest side 2000 px).
  async function shrinkImage(file) {
    if (/gif|svg/.test(file.type) || !window.createImageBitmap) return file;
    try {
      var bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      var MAX = 2000, k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 1500000) return file;
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      var png = file.type === 'image/png';
      var out = await new Promise(function (r) { c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.85); });
      return out && out.size < file.size ? out : file;
    } catch (e) { return file; }
  }

  // ---------- The note menu (bottom-left) ----------
  function closeMenu() { $('noteMenu').classList.add('hidden'); $('menuFab').setAttribute('aria-expanded', 'false'); }
  $('menuFab').onclick = function () {
    var open = $('noteMenu').classList.contains('hidden');
    $('noteMenu').classList.toggle('hidden', !open);
    $('menuFab').setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  document.addEventListener('pointerdown', function (e) {
    if (!$('noteMenu').classList.contains('hidden') && !e.target.closest('#noteMenu, #menuFab')) closeMenu();
    if (!$('pop').classList.contains('hidden') && !e.target.closest('#pop, #fmtBar')) $('pop').classList.add('hidden');
  }, true);
  $('noteMenu').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var n = S.cur;
    if (b.dataset.space) { S.canvas.addSpace(b.dataset.space); return; }
    closeMenu();
    if (b.dataset.m === 'labels') labelsSheet(n);
    if (b.dataset.m === 'image') pickImage();
    if (b.dataset.m === 'move') pickFolder('Move note to…', folderOf(n), function (target) {
      if (target !== folderOf(n)) {
        if (n.fileId && !n.moveFrom) n.moveFrom = n.folderId;
        n.folderId = target; touchNote(n); renderMeta();
        toast('Moved to ' + folderName(target));
      }
      closeSheet();
    }, null, true);
    if (b.dataset.m === 'copy') {
      S.canvas.flush();
      var c = JSON.parse(JSON.stringify(n));
      c.id = N.uuid(); c.title = (n.title || 'Note') + ' (copy)'; c.fileId = null; c.md5 = null; c.fileName = null; c.moveFrom = null; c.conflict = null;
      c.created = c.updated = new Date().toISOString(); c.v = 0; c.isDraft = true;
      openNote(c); touchNote(c); toast('Copy made');
    }
    if (b.dataset.m === 'history') historySheet(n);
    if (b.dataset.m === 'delete') deleteNote(n);
  });
  function deleteNote(n) {
    if (n.isDraft) { closeNote(); showList(); return; }
    clearTimeout(S.saveTimer);
    var neverSynced = !n.fileId;
    if (S.canvas) S.canvas.flush();
    if (neverSynced) { delete notes[n.id]; store.del(n.id); }
    else { n.deleted = true; n.dirty = true; n.v++; store.put(n); sync.schedule(7000); }
    if (S.canvas) { S.canvas.destroy(); S.canvas = null; }
    S.cur = null;
    if (history.state && history.state.v === 'note') history.back(); else showList();
    S.view = 'list'; $('editorView').classList.add('hidden'); $('listView').classList.remove('hidden'); renderList();
    toast('Note deleted', 'Undo', function () {
      n.deleted = false; n.v++;
      if (neverSynced || !n.md5) n.dirty = true;
      notes[n.id] = n; store.put(n); renderList();
    }, 6500);
  }
  // Version history: Drive keeps earlier versions of each note's file (about 30 days, up to 100 versions).
  function historySheet(n) {
    if (!n.fileId) { openSheet('<h2>Version history</h2><p>This note hasn\'t reached Drive yet, so there are no earlier versions.</p><div class="row"><button type="button" data-act="close">Close</button></div>'); return; }
    if (S.canvas) S.canvas.flush();
    openSheet('<h2>Version history</h2><p>Getting the versions from Drive…</p>');
    Drive.revisions(n.fileId).then(function (revs) {
      revs = revs.slice().reverse();
      openSheet('<h2>Version history</h2><p>Drive keeps earlier versions for about 30 days. Tap one to look at it; restoring saves it as the newest version, so nothing is lost.</p><div class="pick">' +
        revs.map(function (r, i) {
          var d = new Date(r.modifiedTime);
          return '<button type="button" data-act="v" data-id="' + esc(r.id) + '">' + icon('history') + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' +
            d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + (i === 0 ? ' · current' : '') + '</button>';
        }).join('') + '</div><div class="row"><button type="button" data-act="close">Close</button></div>',
      function (act, b) { if (act === 'v') showVersion(n, b.dataset.id, b.textContent); });
    }).catch(function (e) {
      openSheet('<h2>Version history</h2><p>' + esc(e.code === 'offline' ? "You're offline." : e.code === 'auth' ? 'Sign in to Google first (tap the sync button at the top).' : e.message) + '</p><div class="row"><button type="button" data-act="close">Close</button></div>');
    });
  }
  function showVersion(n, revId, label) {
    openSheet('<h2>' + esc(label) + '</h2><p>Loading…</p>');
    Drive.readRevision(n.fileId, revId).then(function (text) {
      var old = N.parse(text, null);
      var body = LIB.md.render(String(old.body || '').replace(/<\/?(u|mark|span|s|sub|sup)[^>]*>/gi, '').slice(0, 5000));
      openSheet('<h2>' + esc(label) + '</h2>' + (old.title ? '<p><b>' + esc(old.title) + '</b></p>' : '') +
        '<div class="vprev">' + taskify(body) + (old.ink && old.ink.length ? window.QNCanvas.inkSvg(old.ink, 480, 240) : '') + '</div>' +
        '<div class="row"><button class="primary" type="button" data-act="restore">Restore this version</button><button type="button" data-act="back">Back</button></div>',
      function (act) {
        if (act === 'back') return historySheet(n);
        if (act !== 'restore') return;
        ['title', 'boxes', 'ink', 'labels', 'pinned', 'extra'].forEach(function (k) { n[k] = old[k]; });
        closeSheet();
        touchNote(n);
        if (S.cur === n) reopen();
        toast('Version restored');
      });
    }).catch(function (e) { openSheet('<h2>Version history</h2><p>' + esc(e.message) + '</p><div class="row"><button type="button" data-act="close">Close</button></div>'); });
  }

  function labelsSheet(n) {
    function render() {
      var all = allLabels();
      (n.labels || []).forEach(function (l) { if (all.indexOf(l) < 0) all.push(l); });
      openSheet('<form><h2>Labels</h2><p>Labels cut across folders: a note lives in one folder but can have many labels.</p><div class="labels">' + all.map(function (l) {
        var on = n.labels.some(function (x) { return x.toLowerCase() === l.toLowerCase(); });
        return '<button type="button" data-act="toggle" data-l="' + esc(l) + '" aria-pressed="' + on + '">' + esc(l) + '</button>';
      }).join('') + '</div><input type="text" name="nl" placeholder="New label" autocapitalize="none">' +
        '<div class="row"><button class="primary" type="submit">Add</button><button type="button" data-act="close">Done</button></div></form>',
      function (act, b) {
        if (act !== 'toggle') return;
        var l = b.dataset.l, i = n.labels.findIndex(function (x) { return x.toLowerCase() === l.toLowerCase(); });
        if (i > -1) n.labels.splice(i, 1); else n.labels.push(l);
        touchNote(n); renderLabelsRow(); render();
      }, function (e) {
        var l = e.target.nl.value.replace(/[,#]/g, ' ').trim().replace(/\s+/g, ' ');
        if (!l) return;
        var existing = allLabels().filter(function (x) { return x.toLowerCase() === l.toLowerCase(); })[0];
        l = existing || l;
        if (!n.labels.some(function (x) { return x.toLowerCase() === l.toLowerCase(); })) { n.labels.push(l); touchNote(n); renderLabelsRow(); }
        render();
      });
    }
    render();
  }

  // ---------- Coming and going ----------
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (S.canvas) S.canvas.flush(); saveNow();
      // Phones freeze a web app soon after it goes to the background. The service worker can keep sending
      // (Android Chrome, the installed app included); where it can't, the app sends what it can before it freezes.
      sync.handoff().then(function (ok) { if (!ok) sync.run(); });
    }
    else sync.run({ pull: true });
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data === 'qn-sent' && document.visibilityState === 'visible') sync.run();
  });
  window.addEventListener('pagehide', function () { if (S.canvas) S.canvas.flush(); saveNow(); });
  window.addEventListener('online', function () { sync.run({ pull: true }); });
  window.addEventListener('offline', function () { renderStatus(); sync.run(); });
  setInterval(function () { if (document.visibilityState === 'visible') sync.run({ pull: true }); }, 3 * 60 * 1000);

  // ---------- Updates: only applied when you tap "Update now" ----------
  var registration = null;
  function offerUpdate() { $('updateBar').classList.remove('hidden'); }
  if ('serviceWorker' in navigator && !Drive.demo && !/(^|[#&])nosw\b/.test(location.hash)) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate();
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () { if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(); });
      });
    }).catch(function () {});
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (!reloading) { reloading = true; location.reload(); } });
  }
  $('applyUpdateBtn').onclick = function () {
    if (S.canvas) S.canvas.flush();
    saveNow();
    $('applyUpdateBtn').textContent = 'Updating…';
    if (registration && registration.waiting) registration.waiting.postMessage('skipWaiting');
    else location.reload();
  };
  $('checkUpdateBtn').onclick = async function () {
    if (!registration) { toast(Drive.demo ? 'Updates work in the installed app, not in the demo.' : 'Updates work once the app is installed from its web address.'); return; }
    toast('Checking for update…');
    try { await registration.update(); } catch (e) {}
    setTimeout(function () {
      if (registration.waiting || registration.installing) { hideToast(); offerUpdate(); }
      else toast('You have the latest version.');
    }, 1500);
  };
  $('versionLabel').textContent = 'Quick Notes ' + CFG.VERSION + (Drive.demo ? ' · demo: pretend Drive, resets on reload' : '');

  // ---------- Demo switches ----------
  if (Drive.demo) {
    $('demoTools').classList.remove('hidden');
    $('demoOffline').onclick = function () {
      var off = !Drive.isOffline();
      Drive.setOffline(off);
      this.setAttribute('aria-pressed', off ? 'true' : 'false');
      sync.run({ pull: true });
    };
    $('demoElsewhere').onclick = function () {
      var n = S.lastOpened && notes[S.lastOpened];
      if (!n || !n.fileId) { toast('Open a note that is already in Drive first.'); return; }
      Drive.editElsewhere(n.fileId);
      toast('“' + (n.title || 'That note') + '” was changed on the pretend laptop. Edit it here before syncing to see the warning.', null, null, 7000);
    };
  }

  // ---------- Start: the notes grid ----------
  (async function start() {
    var saved = await store.load();
    saved.forEach(function (n) { notes[n.id] = n; });
    try { history.replaceState({ v: 'list' }, ''); } catch (e) {}
    showList();

    // Android "Share to Quick Notes": arrives as ?title=…&text=…&url=…
    var p = new URLSearchParams(location.search);
    if (p.has('text') || p.has('url') || p.has('title')) {
      var url = p.get('url') || '', text = p.get('text') || '';
      if (url && text.indexOf(url) < 0) text = (text ? text + '\n\n' : '') + url;
      try { history.replaceState({ v: 'list' }, '', location.pathname); } catch (e) {}
      var shared = newDraft(p.get('title') || '', text);
      openNote(shared); touchNote(shared);
    }

    if (Drive.demo) await Drive.signIn();
    renderStatus();
    sync.run({ pull: true });
  })();
})();
