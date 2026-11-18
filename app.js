// Serendipity: opens on the notes grid; a note is a canvas of text boxes and ink; folders are Drive folders.
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
    if ($('sheetBack').classList.contains('hidden')) S.sheetState = history.state; // the back button closes the sheet, nothing more
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
  function folderName(id) { var f = tree()[id]; return f ? f.name : id === rootId() ? sync.rootName() : ''; }

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
    progress: function (n, total) { if (S.view === 'list') $('emptyMsg').textContent = 'Getting notes from Drive… ' + n + ' of ' + total; },
    folders: function () { if (S.view === 'list') renderList(); if (!$('drawer').classList.contains('hidden')) renderTree(); renderMeta(); }
  });
  function editingNow() { return document.activeElement && $('editorView').contains(document.activeElement) && document.activeElement !== document.body; }

  // ---------- Is everything in Drive? ----------
  // A small cloud at the top answers that at a glance: a tick when every note is in Drive, an arrow while
  // changes are on their way, a struck-out cloud when offline (notes are safe on this device), and amber
  // with a banner only when something needs you.
  function health(st) {
    st = st || sync.status();
    var w = st.waiting.length, now = Date.now();
    var oldest = st.waiting.reduce(function (m, n) { var t = Date.parse(n.updated) || now; return Math.min(m, t); }, now);
    var age = now - oldest, many = function (k, one, more) { return k === 1 ? one : k + ' ' + more; };
    if (st.conflicts.length) return { s: 'attention', text: many(st.conflicts.length, 'A note was', 'notes were') + ' changed on two devices. Choose which version to keep.', act: 'review', btn: 'Review' };
    if (st.phase === 'signin') return Drive.signedInBefore() || w
      ? { s: 'attention', text: (w ? many(w, 'One change is', 'changes are') + ' only on this phone. ' : '') + 'Sign in to Google so notes reach Drive.', act: 'signin', btn: 'Sign in' }
      : { s: 'attention', text: 'Sign in to Google to keep your notes in Drive.', act: 'signin', btn: 'Sign in' };
    if (st.phase === 'offline') return w && age > 24 * 3600e3
      ? { s: 'attention', text: 'Offline for a while: ' + many(w, 'one change is', 'changes are') + ' only on this phone. They go to Drive when you\'re online.' }
      : { s: 'offline', text: w ? 'Offline. ' + many(w, 'One change is', 'changes are') + ' saved on this phone and will go to Drive when you\'re back online.' : 'Offline. Every note is in Drive; new changes wait on this phone.' };
    if (st.phase === 'error' && w) return { s: 'attention', text: 'Drive had a problem: ' + ((st.error && st.error.message) || 'unknown') + '. Your notes are safe on this phone.', act: 'sync', btn: 'Try again' };
    if (w && age > 10 * 60000 && st.phase !== 'syncing') return { s: 'attention', text: many(w, 'One change hasn\'t', 'changes haven\'t') + ' reached Drive yet.', act: 'sync', btn: 'Sync now' };
    if (st.phase === 'syncing' || w) return { s: 'busy', text: w ? 'Sending ' + many(w, 'one change', 'changes') + ' to Drive…' : 'Checking Drive…' };
    return { s: 'ok', text: 'Every note is in Google Drive › ' + sync.rootName() + '.' + (st.lastSynced ? ' Checked at ' + new Date(st.lastSynced).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.' : '') };
  }
  var CLOUD = {
    ok: '<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z"/><path d="M9.5 13.6l2 2 3.8-3.9"/>',
    busy: '<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z"/><path d="M12 16v-5M9.8 13l2.2-2.2 2.2 2.2"/>',
    offline: '<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z"/><path d="M4 4l16 16"/>',
    attention: '<path d="M7 18.5h10.5a4 4 0 00.6-7.95A6 6 0 006.6 9.1 4.75 4.75 0 007 18.5z"/><path d="M12 10.5v3.2M12 16.2v.1"/>'
  };
  function renderStatus(st) {
    st = st || sync.status();
    var h = health(st);
    ['syncPill', 'syncPill2'].forEach(function (id) {
      $(id).innerHTML = '<svg class="i" viewBox="0 0 24 24">' + CLOUD[h.s] + '</svg>';
      $(id).className = 'icon cloud ' + h.s;
      $(id).setAttribute('aria-label', h.text);
      $(id).title = h.text;
    });
    var bn = $('syncBanner');
    bn.classList.toggle('hidden', h.s !== 'attention');
    if (h.s === 'attention') {
      bn.querySelector('span').textContent = h.text;
      var btn = bn.querySelector('button');
      btn.classList.toggle('hidden', !h.btn); btn.textContent = h.btn || ''; btn.dataset.act = h.act || '';
    }
    if (S.sheet === 'sync') renderSyncSheet();
    renderMeta();
  }
  async function healthAction(act) {
    if (act === 'signin') { try { await Drive.signIn(); sync.run({ pull: true }); } catch (e) { toast(e.message); } }
    if (act === 'sync') sync.run({ pull: true });
    if (act === 'review') renderSyncSheet();
  }
  $('syncBanner').querySelector('button').onclick = function () { healthAction(this.dataset.act); };
  function renderSyncSheet() {
    var st = sync.status(), h = health(st), items = st.conflicts.concat(st.waiting);
    S.sheet = 'sync';
    openSheet('<h2>' + (h.s === 'ok' ? 'All saved in Drive' : h.s === 'offline' ? 'Offline' : h.s === 'busy' ? 'Saving to Drive' : 'Needs a look') + '</h2><p>' + esc(h.text) + '</p>' +
      (items.length ? '<ul>' + items.slice(0, 30).map(function (n) {
        return '<li data-open="' + esc(n.id) + '" style="cursor:pointer">' + esc(n.title || N.fileName(n).replace(/^\S+ \S+ |\.md$/g, '')) + (n.conflict ? ' — changed on two devices' : n.deleted ? ' — to delete' : '') + '</li>';
      }).join('') + (items.length > 30 ? '<li>…and ' + (items.length - 30) + ' more</li>' : '') + '</ul>' : '') +
      '<p style="font-size:13px">Notes are saved on this phone the moment you type, then copied to Drive. While the phone sleeps, Android keeps sending them in the background.</p>' +
      '<div class="row">' + (h.act === 'signin' ? '<button class="primary" data-act="signin" type="button">Sign in with Google</button>' : '') +
      '<button data-act="sync" type="button"' + (st.phase === 'syncing' ? ' disabled' : '') + '>Sync now</button><button data-act="close" type="button">Close</button></div>',
    function (act) { if (act === 'signin' || act === 'sync') healthAction(act); });
    $('sheet').querySelectorAll('[data-open]').forEach(function (li) {
      li.onclick = function () { var n = notes[li.dataset.open]; if (n && !n.deleted) { closeSheet(); openNote(n); } };
    });
  }
  $('syncPill').onclick = $('syncPill2').onclick = function () { renderSyncSheet(); };
  var _close = closeSheet;
  closeSheet = function () { S.sheet = null; _close(); };

  // Renew the sign-in on your first tap once it has run out (or is about to).
  var lastRenew = 0;
  document.addEventListener('click', function () {
    if (Drive.demo || Drive.persistent || !Drive.signedInBefore() || !navigator.onLine) return; // the sign-in helper renews by itself
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
    var nf = folderOf(n); if (nf && PREF.lastNoteFolder !== nf) { PREF.lastNoteFolder = nf; savePref(); }
    n.v = (n.v || 0) + 1;
    n.body = N.bodyOf(n);
    if (n === S.cur) {
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(saveNow, 600);
    } else store.put(n);
    sync.schedule(n.fileId ? 2500 : 8000); // a new note waits a little, so its file name gets more than the first letters
    renderStatus();
  }
  function saveNow() {
    clearTimeout(S.saveTimer);
    // Saving a big drawing takes a moment; never in the middle of a stroke.
    if (S.canvas && S.canvas.busy && S.canvas.busy()) { S.saveTimer = setTimeout(saveNow, 400); return; }
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
      if (N.hasInk(n)) inner += window.QNInk.thumb(n.ink, 320, 170);
    }
    var foot = (n.labels || []).map(function (l) { return '<span class="chip">' + esc(l) + '</span>'; });
    if (n.conflict) foot.push('<span class="flag">Changed elsewhere</span>');
    if (foot.length) inner += '<div class="foot">' + foot.join('') + '</div>';
    return '<article class="card' + (S.pick && S.pick.ids[n.id] ? ' picked' : '') + '" tabindex="0" data-id="' + esc(n.id) + '">' + (inner || '<p class="where">Empty note</p>') + '</article>';
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
      $('scopeChips').innerHTML = '<button type="button" class="clear" data-lclear="1" aria-label="Show all notes">✕ ' + esc(S.label) + '</button>' +
        '<button type="button" data-lf="" aria-pressed="' + !S.labelFolders.length + '">All folders · ' + pool.length + '</button>' +
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
    shown.sort(function (a, b) { return listKey(b) - listKey(a); });
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
    if (S.label === b.dataset.label) history.back(); else goLabel(b.dataset.label);
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
    if (e.target.closest('[data-lclear]')) { if (history.state && history.state.l) history.back(); else nav(null, null, 'replace'); }
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
      if (S.label === old) { S.label = nl; try { history.replaceState(navState(), ''); } catch (x) {} }
      closeSheet(); renderList(); renderStatus(); sync.schedule(2500);
      if (!$('drawer').classList.contains('hidden')) renderTree();
      toast('Renamed on ' + changedN + ' note' + (changedN === 1 ? '' : 's'));
    });
  }
  $('subfolders').addEventListener('click', function (e) {
    var f = e.target.closest('[data-folder]');
    if (f) return goFolder(f.dataset.folder);
    if (e.target.closest('[data-newfolder]')) newFolderSheet(S.folder || rootId());
  });
  // ---------- Moving around: every step is a step in the back button's history ----------
  function navState() { return { v: 'list', f: S.folder || null, l: S.label || null }; }
  function nav(f, l, how) { // how: 'push' (a new step), 'replace' (this step), or nothing (the back button already moved)
    S.limit = 200; S.folder = f || null; S.label = l || null; S.labelFolders = []; $('q').value = ''; S.q = '';
    if (!S.label) { PREF.lastFolder = S.folder || ''; savePref(); }
    try { if (how === 'push') history.pushState(navState(), ''); else if (how === 'replace') history.replaceState(navState(), ''); } catch (e) {}
    renderList(); window.scrollTo(0, 0);
  }
  function goFolder(id) { if ((id || null) === S.folder && !S.label) return renderList(); nav(id, null, 'push'); }
  function goLabel(l) { if (l === S.label) return; nav(null, l, 'push'); }
  function validFolder(id) { return id && (tree()[id] || id === rootId()) ? id : null; }
  function defaultFolder() { return validFolder(PREF.defaultFolder); }
  function startFolder() {
    if (PREF.start === 'default') return defaultFolder();
    if (PREF.start === 'last') return validFolder(PREF.lastFolder);
    if (PREF.start === 'lastnote') return validFolder(PREF.lastNoteFolder);
    return null;
  }

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
    if (Date.now() - (S.heldAt || 0) < 600) return; // the end of a hold
    if (S.pick) { e.preventDefault(); togglePick(c); return; }
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
  // A note's place in the list: where it was dragged to, or else when it was last changed (newest first).
  function listKey(n) { return n.order != null ? n.order : (Date.parse(n.updated) || 0); }
  // A change to a note that is not open (pin, place, labels…): kept and sent to Drive, without changing its date.
  function touchQuiet(n) { n.dirty = true; n.v = (n.v || 0) + 1; n.body = N.bodyOf(n); store.put(n); sync.schedule(6000); renderStatus(); }

  // ---------- Several notes at once (like Keep): hold a note to pick it, tap others; hold and drag to move it ----------
  function togglePick(c) {
    var id = c.dataset.id, P = S.pick || (S.pick = { ids: {}, order: [] });
    if (P.ids[id]) { delete P.ids[id]; P.order = P.order.filter(function (x) { return x !== id; }); }
    else { P.ids[id] = 1; P.order.push(id); }
    c.classList.toggle('picked', !!P.ids[id]);
    showPickBar();
  }
  function showPickBar() {
    var n = S.pick ? S.pick.order.length : 0;
    if (S.pick && !n) S.pick = null;
    $('pickBar').classList.toggle('hidden', !S.pick); $('newFab').classList.toggle('hidden', !!S.pick);
    $('listView').classList.toggle('picking', !!S.pick);
    if (!S.pick) { Array.prototype.forEach.call(document.querySelectorAll('.card.picked'), function (c) { c.classList.remove('picked'); }); return; }
    $('pickCount').textContent = n + (n === 1 ? ' note' : ' notes');
    $('pickBar').querySelector('[data-pk=combine]').disabled = n < 2;
    $('pickBar').querySelector('[data-pk=labels]').disabled = n !== 1;
    var allPinned = S.pick.order.every(function (id) { return notes[id] && notes[id].pinned; });
    $('pickBar').querySelector('[data-pk=pin]').title = allPinned ? 'Unpin' : 'Pin';
    $('pickBar').querySelector('[data-pk=pin]').setAttribute('aria-pressed', allPinned);
  }
  function endPick() { S.pick = null; showPickBar(); }
  (function () {
    var hold = null, drag = null;
    ['pinned', 'others', 'results'].forEach(function (id) {
      $(id).addEventListener('pointerdown', function (e) {
        var c = e.target.closest('.card'); if (!c || e.button > 0 || e.target.closest('input, a')) return;
        hold = { c: c, x: e.clientX, y: e.clientY, held: false, t: setTimeout(function () {
          if (!hold) return;
          hold.held = true; S.heldAt = Date.now();
          if (!(S.pick && S.pick.ids[hold.c.dataset.id])) togglePick(hold.c);
          if (navigator.vibrate) navigator.vibrate(12);
        }, 480) };
      });
      $(id).addEventListener('contextmenu', function (e) { if (e.target.closest('.card')) e.preventDefault(); });
    });
    // After the hold, moving drags the note to a new place (in the list it is in: pinned, or the others).
    function startDrag(e) {
      var c = hold.c, r = c.getBoundingClientRect(), list = c.parentNode;
      if (list.id === 'results') return false; // search results keep their own order
      var ghost = c.cloneNode(true);
      ghost.classList.add('card-ghost');
      ghost.style.width = r.width + 'px'; ghost.style.left = r.left + 'px'; ghost.style.top = r.top + 'px';
      document.body.appendChild(ghost);
      c.classList.add('card-hole');
      drag = { c: c, ghost: ghost, list: list, dx: e.clientX - r.left, dy: e.clientY - r.top };
      return true;
    }
    function moveDrag(e) {
      var d = drag;
      d.ghost.style.left = (e.clientX - d.dx) + 'px'; d.ghost.style.top = (e.clientY - d.dy) + 'px';
      var under = document.elementFromPoint(e.clientX, e.clientY), t = under && under.closest('.card');
      if (t && t !== d.c && t.parentNode === d.list) {
        var tr = t.getBoundingClientRect(), after = e.clientY > tr.top + tr.height / 2;
        if (after) { if (t.nextSibling !== d.c) d.list.insertBefore(d.c, t.nextSibling); }
        else if (t.previousSibling !== d.c) d.list.insertBefore(d.c, t);
      }
      // near the top or bottom of the screen: scroll the list
      var sc = $('listView').querySelector('main') || document.scrollingElement, H = window.innerHeight;
      if (e.clientY < 90) sc.scrollTop -= 12; else if (e.clientY > H - 90) sc.scrollTop += 12;
    }
    function endDrag() {
      var d = drag; drag = null;
      d.ghost.remove(); d.c.classList.remove('card-hole');
      var n = notes[d.c.dataset.id]; if (!n) return;
      var prev = d.c.previousElementSibling, next = d.c.nextElementSibling;
      var kp = prev && prev.classList.contains('card') && notes[prev.dataset.id] ? listKey(notes[prev.dataset.id]) : null;
      var kn = next && next.classList.contains('card') && notes[next.dataset.id] ? listKey(notes[next.dataset.id]) : null;
      var k = kp != null && kn != null ? (kp + kn) / 2 : kp != null ? kp - 60000 : kn != null ? kn + 60000 : listKey(n);
      if (k !== listKey(n)) { n.order = Math.round(k * 1000) / 1000; touchQuiet(n); }
      S.heldAt = Date.now(); endPick(); renderList();
    }
    document.addEventListener('pointermove', function (e) {
      if (drag) { e.preventDefault(); moveDrag(e); return; }
      if (!hold) return;
      var far = Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10;
      if (!far) return;
      if (hold.held && startDrag(e)) { clearTimeout(hold.t); hold = null; moveDrag(e); return; }
      clearTimeout(hold.t); hold = null; // it was a scroll
    }, { passive: false });
    // Once a note is held, a finger moving it must not scroll the page.
    document.addEventListener('touchmove', function (e) { if (drag || (hold && hold.held)) e.preventDefault(); }, { passive: false });
    var up = function () { if (drag) endDrag(); if (hold) { clearTimeout(hold.t); hold = null; } };
    document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  })();
  $('pickBar').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var picked = S.pick ? S.pick.order.map(function (id) { return notes[id]; }).filter(Boolean) : [];
    if (b.dataset.pk === 'cancel') return endPick();
    if (b.dataset.pk === 'pin') {
      var pinAll = !picked.every(function (n) { return n.pinned; });
      picked.forEach(function (n) { if (!!n.pinned !== pinAll) { n.pinned = pinAll; touchQuiet(n); } });
      endPick(); renderList(); toast(pinAll ? (picked.length === 1 ? 'Pinned' : picked.length + ' notes pinned') : 'Unpinned'); return;
    }
    if (b.dataset.pk === 'labels') { endPick(); if (picked[0]) { labelsSheet(picked[0]); } return; }
    if (b.dataset.pk === 'move') {
      endPick();
      return pickFolder(picked.length === 1 ? 'Move note to…' : 'Move ' + picked.length + ' notes to…', folderOf(picked[0]), function (target) {
        picked.forEach(function (n) {
          if (target === folderOf(n)) return;
          if (n.fileId && !n.moveFrom) n.moveFrom = n.folderId;
          n.folderId = target; touchQuiet(n);
        });
        closeSheet(); renderList(); toast('Moved to ' + folderName(target));
      }, null, true);
    }
    if (b.dataset.pk === 'delete') {
      endPick(); picked.forEach(trashNote); renderList();
      toast(picked.length === 1 ? 'Note deleted' : picked.length + ' notes deleted', 'Undo', function () { picked.forEach(function (n) { untrash(n); }); renderList(); }, 7000);
      return;
    }
    if (b.dataset.pk === 'dup') { picked.forEach(function (n) { saveNew(copyOf(n, (n.title || 'Note') + ' (copy)')); }); endPick(); renderList(); toast(picked.length === 1 ? 'Copy made' : picked.length + ' copies made'); return; }
    if (b.dataset.pk === 'combine' && picked.length > 1) { endPick(); combineNotes(picked); }
  });

  // A note's copy, with its own id and no Drive file yet.
  function copyOf(n, title) {
    var c = JSON.parse(JSON.stringify(n));
    c.id = N.uuid(); c.title = title; c.fileId = null; c.md5 = null; c.fileName = null; c.moveFrom = null; c.conflict = null;
    c.created = c.updated = new Date().toISOString(); c.v = 0; c.deleted = false; c.isDraft = true;
    return c;
  }
  // A note made here (not typed): it is kept and goes to Drive like any other.
  function saveNew(c) {
    delete c.isDraft;
    c.updated = new Date().toISOString(); c.dirty = true; c.v = (c.v || 0) + 1; c.body = N.bodyOf(c);
    notes[c.id] = c; store.put(c); sync.schedule(8000); renderStatus();
    return c;
  }
  function trashNote(n) { // like Delete, without leaving the screen; Undo brings it back
    if (!n.fileId) { delete notes[n.id]; store.del(n.id); return; }
    n.deleted = true; n.dirty = true; n.v++; store.put(n); sync.schedule(7000);
  }
  function untrash(n) { n.deleted = false; n.dirty = true; n.v++; notes[n.id] = n; store.put(n); }
  // How far right a note's content reaches (text boxes without a set width count as a usual column).
  function rightEdge(n) {
    var r = 0;
    (n.boxes || []).forEach(function (b) { if (b.md && b.md.trim() || b !== n.boxes[0]) r = Math.max(r, b.x + (b.w || 720)); });
    var ib = n.ink && window.QNInk.hasInk(n.ink) ? window.QNInk.boundsOf(n.ink) : null;
    if (ib) r = Math.max(r, ib.x + ib.w);
    return r;
  }
  // Put another note's text and drawings into `into`, moved by dx, dy; its layers come along on top, under its own name.
  function mergeInto(into, src, dx, dy, label) {
    var ink = JSON.parse(JSON.stringify(window.QNInk.hasInk(src.ink) ? src.ink : []));
    var ids = window.QNInk.freshIds(ink);
    window.QNInk.shiftAll(ink, dx, dy);
    ink.forEach(function (l, i) { if (label) l.name = label + ' · ' + l.name; if (i === 0) l.clip = false; if (l.gid) l.gname = (label ? label + ' · ' : '') + (l.gname || 'Group'); });
    var srcBottom = src.ink && src.ink[0] ? src.ink[0].id : null;
    if (!into.ink || !window.QNInk.hasInk(into.ink)) {
      into.ink = ink.length ? ink : into.ink;
    } else into.ink = into.ink.concat(ink);
    var intoBottom = into.ink && into.ink[0] ? into.ink[0].id : null;
    (src.boxes || []).forEach(function (b, i) {
      if (!b.md || !b.md.trim()) return;
      var c = JSON.parse(JSON.stringify(b));
      c.id = 'b' + N.shortId(); c.x = Math.max(0, b.x + dx); c.y = Math.max(0, b.y + dy);
      if (i === 0 && !c.w) c.w = 720;
      var lid = b.l ? ids.layers[b.l] : srcBottom ? ids.layers[srcBottom] : null;
      if (lid && lid !== intoBottom) c.l = lid; else delete c.l;
      if (c.g) c.g = ids.groups[c.g] || c.g;
      into.boxes.push(c);
    });
  }
  function combineNotes(list) {
    if (S.canvas) S.canvas.flush();
    var first = list[0], c = copyOf(first, first.title || 'Combined note');
    c.labels = []; list.forEach(function (n) { (n.labels || []).forEach(function (l) { if (c.labels.indexOf(l) < 0) c.labels.push(l); }); });
    c.ink = JSON.parse(JSON.stringify(first.ink || [])); c.boxes = JSON.parse(JSON.stringify(first.boxes || []));
    if (window.QNInk.hasInk(c.ink)) window.QNInk.freshIds(c.ink).layers && (function () {
      // the first note's boxes point at its layers by id: keep them pointing at the renamed ones
      var old = (first.ink || []).map(function (l) { return l.id; });
      c.boxes.forEach(function (b) { if (b.l) { var i = old.indexOf(b.l); b.l = i > -1 && c.ink[i] ? c.ink[i].id : undefined; if (!b.l) delete b.l; } });
    })();
    list.slice(1).forEach(function (n) {
      var dx = rightEdge(c) + 160;
      if (n.title) { // its title comes along as a heading at the top of its text
        n = JSON.parse(JSON.stringify(n));
        var b0 = n.boxes[0]; b0.md = '## ' + n.title + (b0.md && b0.md.trim() ? '\n\n' + b0.md : '');
      }
      mergeInto(c, n, dx, 0, n.title || 'Note');
    });
    saveNew(c);
    list.forEach(trashNote);
    renderList();
    toast('Combined ' + list.length + ' notes into one', 'Undo', function () {
      list.forEach(untrash); trashNote(c); renderList();
    }, 8000);
  }
  // From a selection in a note: a new note with a copy of it (or with it, when it is extracted).
  function toNewNote(d, move) {
    if (!S.cur) return false;
    var c = newDraft('', '');
    c.folderId = S.cur.folderId; c.labels = (S.cur.labels || []).slice();
    c.title = (S.cur.title ? S.cur.title + ' (part)' : '');
    var dx = -(d.box ? d.box.x : 0), dy = -(d.box ? d.box.y : 0) + 56;
    var src = { ink: d.ink, boxes: [{ id: 'bX', x: 0, y: 0, md: '' }].concat(d.boxes.map(function (b) { b = JSON.parse(JSON.stringify(b)); if (!b.w) b.w = 720; return b; })) };
    mergeInto(c, src, dx, dy, '');
    saveNew(c); renderStatus();
    toast(move ? 'Moved into a new note' : 'Copied into a new note', 'Open', function () { if (S.canvas) S.canvas.flush(); openNote(notes[c.id]); }, 7000);
    return true;
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
        if (parent === root && f.name === 'Attachments') return; // where the app keeps pictures; not a notes folder
        var kids = childrenOf(f.id).length, open = !!S.expanded[f.id];
        html += '<div class="tree-row' + (S.folder === f.id ? ' on' : '') + '" style="padding-left:' + depth * 16 + 'px">' +
          (kids ? '<button class="tw" type="button" data-tw="' + esc(f.id) + '" aria-label="' + (open ? 'Collapse' : 'Expand') + '">' + icon(open ? 'chevd' : 'chev') + '</button>' : '<span class="tw"></span>') +
          '<div class="nm" data-open="' + esc(f.id) + '">' + icon('folder') + '<span>' + esc(f.name) + '</span>' + (defaultFolder() === f.id ? '<em class="dflt">default</em>' : '') + '<small>' + countIn(f.id) + '</small></div>' +
          '<button class="more" type="button" data-fmore="' + esc(f.id) + '" aria-label="Folder options">' + icon('more') + '</button></div>';
        if (kids && open) rows(f.id, depth + 1);
      });
    }
    if (root) rows(root, 0);
    // Feedback saved before 3.5.1 went to a folder called "Bug reports": give it its new name, once.
    if (root && !S.fbRenamed && navigator.onLine && Drive.signedIn()) {
      var kidsOfRoot = childrenOf(root), oldF = kidsOfRoot.filter(function (f) { return f.name === 'Bug reports'; })[0];
      if (oldF && !kidsOfRoot.some(function (f) { return f.name === 'Feedback'; })) {
        S.fbRenamed = true;
        sync.renameFolder(oldF.id, 'Feedback').then(function () { renderTree(); }, function () { S.fbRenamed = false; });
      } else S.fbRenamed = true;
    }
    else html += '<p class="where" style="padding:8px">Folders appear after the first sync with Google Drive.</p>';
    $('tree').innerHTML = html;
    var labels = allLabels(), lopen = !!PREF.labelsOpen;
    $('labelsHead').innerHTML = icon(lopen ? 'chevd' : 'chev') + '<span>Labels</span><small>' + labels.length + '</small>';
    $('labelsHead').setAttribute('aria-expanded', lopen);
    $('labelTree').classList.toggle('hidden', !lopen);
    $('labelTree').innerHTML = labels.length ? labels.map(function (l) {
      var n = live().filter(function (x) { return (x.labels || []).some(function (y) { return y.toLowerCase() === l.toLowerCase(); }); }).length;
      return '<div class="tree-row' + (S.label === l ? ' on' : '') + '"><span class="tw"></span><div class="nm" data-label="' + esc(l) + '">' + icon('label') + '<span>' + esc(l) + '</span><small>' + n + '</small></div>' +
        '<button class="more" type="button" data-lmore="' + esc(l) + '" aria-label="Rename label">' + icon('more') + '</button></div>';
    }).join('') : '<p class="where" style="padding:2px 12px">Add labels to a note from its ••• menu.</p>';
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
    if (o) leaveDrawer(o.dataset.open || null, null);
  });
  $('labelTree').addEventListener('click', function (e) {
    var m = e.target.closest('[data-lmore]');
    if (m) { renameLabelSheet(m.dataset.lmore); return; }
    var l = e.target.closest('[data-label]');
    if (l) leaveDrawer(null, l.dataset.label);
  });
  // Picking a place in the drawer: the drawer's back step becomes the new place, so back returns to where you were.
  function leaveDrawer(f, l) {
    var same = (f || null) === S.folder && (l || null) === S.label;
    closeDrawer(!same);
    if (!same) nav(f, l, 'replace');
  }
  $('addRootFolder').onclick = function () { newFolderSheet(rootId()); };
  $('labelsHead').onclick = function () { PREF.labelsOpen = !PREF.labelsOpen; savePref(); renderTree(); };
  if ($('importBtn')) $('importBtn').onclick = function () {
    closeDrawer();
    setTimeout(importSheet, 250); // after the drawer's history step is undone
  };
  function importSheet() {
    openSheet('<h2>Copy notes in</h2><p>A one-time copy into Serendipity. It is not a sync: Keep and Notion stay as they are, and edits made here stay here. Running a copy again only adds notes that are not here yet.</p>' +
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
      '<div class="pick"><button type="button" data-act="default">' + (defaultFolder() === id ? 'Default folder ✓ (tap to undo)' : 'Make this the default folder') + '</button>' +
      '<button type="button" data-act="rename">Rename</button><button type="button" data-act="sub">New folder inside</button>' +
      '<button type="button" data-act="move">Move to…</button><button type="button" data-act="del" class="danger">Delete folder</button></div>' +
      '<div class="err"></div><div class="row"><button type="button" data-act="close">Close</button></div>',
    async function (act) {
      if (act === 'default') {
        PREF.defaultFolder = defaultFolder() === id ? '' : id; savePref(); closeSheet(); renderTree();
        toast(PREF.defaultFolder ? '“' + f.name + '” is the default folder: new notes go here' : 'No default folder: new notes go to Inbox');
        return;
      }
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
        try { await sync.deleteFolder(id); closeSheet(); if (S.folder === id) nav(f.parentId === rootId() ? null : f.parentId, null, 'replace'); renderTree(); renderList(); toast('Folder deleted (it is in Drive’s trash)'); }
        catch (err) { sheetError(err.message); }
      }
    });
  }
  // A list of every folder to pick from. `skip` hides a folder and everything inside it.
  function pickFolder(title, current, onPick, skip, allowRoot) {
    var html = '<h2>' + esc(title) + '</h2><div class="pick">';
    if (allowRoot) html += '<button type="button" data-act="pick" data-id="' + esc(rootId()) + '"' + (current === rootId() ? ' aria-pressed="true"' : '') + '>' + icon('folder') + esc(sync.rootName()) + ' (top level)</button>';
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
      fileId: null, md5: null, fileName: null, folderId: S.folder && S.folder !== rootId() ? S.folder : defaultFolder(), moveFrom: null,
      dirty: false, deleted: false, conflict: null, v: 0, isDraft: true };
  }
  var canvasHooks = {
    toNewNote: toNewNote,
    change: function (kind) { if (kind === 'typing') return; if (S.cur) touchNote(S.cur); if (kind === 'ink' || kind === 'restore') renderLayers(); },
    notice: function (t) { toast(t, null, null, 3500); },
    view: function (v) {
      $('zoomBtn').textContent = Math.round(v.z * 100) + '%';
      var turned = Math.abs(Math.atan2(Math.sin(v.r), Math.cos(v.r))) > 0.01;
      $('compass').classList.toggle('hidden', !turned);
      $('compass').firstChild.style.transform = 'rotate(' + v.r + 'rad)';
    },
    gesture: function (g) { toast(g === 'undo' ? 'Undone' : 'Redone', null, null, 900); },
    history: function (u, r) { $('undoBtn').disabled = !u; $('redoBtn').disabled = !r; },
    focus: function () { showFmt(true); },
    blur: function () { setTimeout(function () { if (!S.canvas || !S.canvas.active() || !document.activeElement.closest || !document.activeElement.closest('.ProseMirror')) showFmt(false); }, 120); },
    selection: function (ed) { updateFmt(ed); },
    penSeen: function () {
      PREF.penSeen = true; savePref(); updatePenQuick();
      if (S.penToast || PREF.finger) return; S.penToast = true;
      toast('Pen found: the pen writes, your finger moves the page. To draw with a finger too, choose Pen › Finger › Draws.', null, null, 5000);
    },
    penKnown: function () { return !!PREF.penSeen; },
    finger: function () { return PREF.finger || 'auto'; },
    head: function () { return $('noteHead'); },
    autoTool: function (t) { setTool(t); },
    imageUrl: function (src) { return isLocalRef(src) ? attachmentUrl(refName(src)) : Promise.resolve(src); },
    textLook: function (t) { Object.assign(INKOPT.text, t); savePref(); if (PREF.tool === 'text') setTool('text'); } // tapped text: the card shows its look
  };
  function openNote(n, isNew) {
    if (S.cur) closeNote();
    S.cur = n; S.lastOpened = n.id;
    S.view = 'note'; dockFeedback();
    $('listView').classList.add('hidden'); $('editorView').classList.remove('hidden');
    closeMenu();
    try { history.pushState({ v: 'note' }, ''); } catch (e) {}
    $('noteTitle').value = n.title || '';
    setPin(n.pinned);
    renderLabelsRow(); renderConflict(); renderMeta();
    $('canvasWrap').scrollTo(0, 0);
    S.canvas = new window.QNCanvas.NoteCanvas($('canvasHost'), $('canvasWrap'), n, canvasHooks);
    applyViewPrefs();
    setTool(isNew || !PREF.showTools ? 'type' : (PREF.tool === 'erase' || PREF.tool === 'select' || PREF.tool === 'lasso' ? 'type' : PREF.tool));
    renderLayers();
    $('undoBtn').disabled = true; $('redoBtn').disabled = true;
    if (isNew) setTimeout(function () { S.canvas.focusStart(); }, 50);
  }
  function reopen() { var n = S.cur, top = $('canvasWrap').scrollTop; S.canvas.destroy(); S.canvas = new window.QNCanvas.NoteCanvas($('canvasHost'), $('canvasWrap'), n, canvasHooks); applyViewPrefs(); applyInk(); S.canvas.setTool(PREF.tool); renderLayers(); $('noteTitle').value = n.title || ''; setPin(n.pinned); renderLabelsRow(); renderConflict(); renderMeta(); $('canvasWrap').scrollTop = top; }
  function closeNote() {
    var n = S.cur;
    if (!n) return;
    if (S.canvas) { S.canvas.flush(); S.canvas.destroy(); S.canvas = null; }
    saveNow();
    if (!n.isDraft && N.isEmpty(n) && !n.fileId) { delete notes[n.id]; store.del(n.id); }
    S.cur = null;
    updatePenQuick();
    showFmt(false); closeMenu(); closeViewMenu(); $('pop').classList.add('hidden');
    sync.run();
  }
  function showList() {
    S.view = 'list'; dockFeedback(); if (S.pick) endPick();
    $('editorView').classList.add('hidden'); $('listView').classList.remove('hidden');
    renderList();
  }
  window.addEventListener('popstate', function (e) {
    var st = e.state || {};
    var wn = !$('whatsNew').classList.contains('hidden');
    if (wn || !$('sheetBack').classList.contains('hidden')) { // back closes the sheet and stays where you are
      if (wn) S.closeWhatsNew(); else closeSheet();
      try { history.pushState(S.sheetState || navState(), ''); } catch (x) {}
      return;
    }
    if (!$('drawer').classList.contains('hidden')) { closeDrawer(true); if (st.v !== 'exit') return; }
    if (S.view === 'note') { closeNote(); showList(); }
    if (st.v === 'list') { if ((st.f || null) !== S.folder || (st.l || null) !== S.label) nav(st.f, st.l); return; }
    if (st.v === 'exit') { // at the start screen: back once more to leave
      if (Date.now() - (S.exitTry || 0) < 2500) { hideToast(); history.back(); return; }
      S.exitTry = Date.now();
      toast('Press back again to exit', null, null, 2500);
      try { history.pushState(navState(), ''); } catch (x) {}
    }
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
    if (document.activeElement && document.activeElement.classList.contains('ink-textedit')) return; // its own undo while writing
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); S.canvas.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); S.canvas.redo(); }
  });

  // ---------- Tools: type, pen (five brushes), erase, lasso, nudge, fill, move text; layers ----------
  // ---------- Home-made pen tips, line styles and fill patterns ("my styles"), kept on this device ----------
  var MYSTYLES = [];
  try { MYSTYLES = JSON.parse(localStorage.getItem('qn-styles') || '[]') || []; } catch (e) { MYSTYLES = []; }
  window.QNInk.addDefs(MYSTYLES);
  var GONE = {}; // styles deleted here (id → when), so Drive does not bring them back
  try { GONE = JSON.parse(localStorage.getItem('qn-styles-gone') || '{}') || {}; } catch (e) {}
  function saveStyles(noSync) {
    try { localStorage.setItem('qn-styles', JSON.stringify(MYSTYLES)); localStorage.setItem('qn-styles-gone', JSON.stringify(GONE)); } catch (e) { toast('Could not keep that style on this device.'); }
    if (!noSync) { clearTimeout(saveStyles.t); saveStyles.t = setTimeout(syncStyles, 3000); }
  }
  // Your styles also live in Drive (Serendipity's main folder › .serendipity › styles.json), so every device has them.
  // Each style carries u (when it was last saved): the newer one wins; deleted ones stay deleted.
  async function syncStyles() {
    if (Drive.demo || !Drive.signedIn() || !navigator.onLine || !sync.root()) return;
    try {
      var dir = await Drive.markedFolder('.serendipity', sync.root(), 'qnSettings');
      var f = await Drive.findExact('styles.json', dir.id), remote = { styles: [], gone: {} };
      if (f) { try { remote = JSON.parse(await Drive.readText(f.id)) || remote; } catch (e) {} }
      var by = {}, changed = false, gone = Object.assign({}, remote.gone || {}, GONE);
      Object.keys(GONE).forEach(function (k) { if ((remote.gone || {})[k] > gone[k]) gone[k] = remote.gone[k]; });
      (remote.styles || []).concat(MYSTYLES).forEach(function (d) { if (!d || !d.id) return; var o = by[d.id]; if (!o || (d.u || 0) > (o.u || 0)) by[d.id] = d; });
      var merged = Object.keys(by).map(function (k) { return by[k]; }).filter(function (d) { return !(gone[d.id] && gone[d.id] >= (d.u || 0)); });
      var mine = JSON.stringify(MYSTYLES), theirs = JSON.stringify(remote.styles || []), now = JSON.stringify(merged);
      if (now !== mine || JSON.stringify(gone) !== JSON.stringify(GONE)) { MYSTYLES = merged; GONE = gone; window.QNInk.addDefs(MYSTYLES); saveStyles(true); changed = true; }
      if (now !== theirs || JSON.stringify(gone) !== JSON.stringify(remote.gone || {})) {
        var text = JSON.stringify({ v: 1, styles: merged, gone: gone });
        if (f) await Drive.saveText(f.id, text); else await Drive.create('styles.json', dir.id, text);
      }
      if (changed && S.canvas) S.canvas.ink().redraw();
    } catch (e) { /* tried again at the next change or start */ }
  }
  setTimeout(syncStyles, 8000);
  var DEFKIND = { tip: 'Pen tip', line: 'Line style', pat: 'Fill pattern' };
  function defPreview(d, big) { // a little picture of a style, for the cards
    var I = window.QNInk, inner = d.items.map(function (p) { return I.itemSvg(d.k === 'pat' ? p : Object.assign({}, p, { c: 'currentColor' })); }).join('');
    if (d.k === 'tip') return '<svg viewBox="-60 -60 120 120" width="22" height="22" style="color:var(--ink)">' + inner + '</svg>';
    if (d.k === 'line') return '<svg viewBox="-10 -60 420 120" width="46" height="14" style="color:var(--ink)">' + inner + '</svg>';
    var pid = 'pp-' + d.id + (big ? 'b' : '');
    return '<svg viewBox="0 0 30 30" width="22" height="22"><defs>' + I.patternDef(Object.assign({}, d, { sz: 12 }), pid) + '</defs><rect width="30" height="30" rx="5" fill="url(#' + pid + ')" stroke="var(--rule)"/></svg>';
  }
  function styleChips(kind, cur, attr) { // the row in a tool's card: Plain, each style, and + new / Edit
    var kinds = kind === 'pen' ? ['tip', 'line'] : ['pat'];
    var mine = MYSTYLES.filter(function (d) { return kinds.indexOf(d.k) > -1; });
    var curDef = cur && mine.filter(function (d) { return d.id === cur; })[0];
    return chip('Plain', attr + '=""', !curDef) +
      mine.map(function (d) { return chip(defPreview(d), attr + '="' + esc(d.id) + '" title="' + esc(d.name || DEFKIND[d.k]) + '"', d.id === cur); }).join('') +
      (curDef ? chip('Edit', 'data-editdef="' + esc(curDef.id) + '"') : '') +
      kinds.map(function (k) { return chip('+ ' + (k === 'tip' ? 'Tip' : k === 'line' ? 'Line' : 'Pattern'), 'data-newdef="' + k + '" title="Make your own ' + DEFKIND[k].toLowerCase() + '"'); }).join('');
  }
  // The style maker: a round box (tip), a long box (line: one repeat) or a square (pattern: one tile).
  function editStyle(kind, def) {
    var B = window.QNInk.BRUSH, I = window.QNInk;
    var st = def ? JSON.parse(JSON.stringify(def)) : { id: 'd' + Math.random().toString(36).slice(2, 9), k: kind, name: '', items: [], rot: kind === 'tip' ? 0 : undefined, sp: kind === 'tip' ? 0.25 : undefined, sz: kind === 'pat' ? 48 : undefined };
    kind = st.k;
    var vb = kind === 'tip' ? [-50, -50, 100, 100] : kind === 'line' ? [0, -50, 400, 100] : [0, 0, 100, 100];
    var pen = { b: INKOPT.pen.b === 'highlighter' ? 'pen' : INKOPT.pen.b, s: kind === 'tip' ? 14 : kind === 'line' ? 8 : 6, c: kind === 'pat' ? (INKOPT.pen.c || 'ink') : 'ink', erase: false };
    var undo = [];
    var guide = kind === 'tip' ? '<circle r="50" fill="none" stroke="var(--rule)" stroke-width="0.4" stroke-dasharray="2 2"/><path d="M-50 0H50M0 -50V50" stroke="var(--rule)" stroke-width="0.2"/>'
      : kind === 'line' ? '<path d="M0 0H400" stroke="var(--rule)" stroke-width="0.8" stroke-dasharray="5 5"/><path d="M0 -50V50M400 -50V50" stroke="var(--accent)" stroke-width="1"/>'
      : '<rect width="100" height="100" fill="none" stroke="var(--rule)" stroke-width="0.4" stroke-dasharray="2 2"/>';
    var html = '<h2>' + (def ? 'Edit ' : 'New ') + DEFKIND[kind].toLowerCase() + '</h2>' +
      '<p>' + (kind === 'tip' ? 'Draw the shape of the tip in the circle. It is stamped along every line, in the pen’s colour.'
        : kind === 'line' ? 'Draw one stretch of the line between the two marks. It repeats along every line you draw, bending with it, in the pen’s colour.'
        : 'Draw one tile. It repeats in every direction (lines running off one edge come back on the other).') + '</p>' +
      '<div class="de-wrap"><svg id="deBox" class="de-box de-' + kind + '" viewBox="' + vb.join(' ') + '">' + guide + '<g id="deInk"></g></svg>' +
      (kind === 'pat' ? '<svg id="dePrev" class="de-prev" viewBox="0 0 120 120"></svg>' : '') + '</div>' +
      '<div class="de-tools">' + Object.keys(B).filter(function (k) { return k !== 'highlighter'; }).map(function (k) { return chip(B[k].label, 'data-act="brush" data-v="' + k + '"', pen.b === k); }).join('') +
      chip('Rub out', 'data-act="rub"', false) + '<button type="button" class="ochip" data-act="undo">Undo</button><button type="button" class="ochip" data-act="clear">Clear</button></div>' +
      '<label class="de-sl">Line size <input type="range" min="1" max="40" step="0.5" value="' + pen.s + '" id="deSize"></label>' +
      (kind === 'pat' ? '<div class="de-tools">' + SWATCH.map(function (c) { return '<button type="button" class="sw" data-act="col" data-v="' + c + '" style="background:' + (c === 'ink' ? 'var(--ink)' : c) + '" aria-label="Colour"' + (pen.c === c ? ' aria-pressed="true"' : '') + '></button>'; }).join('') + '</div>' +
        '<label class="de-sl">Tile size on the page <input type="range" min="12" max="200" value="' + st.sz + '" id="deTile"></label>' : '') +
      (kind === 'tip' ? '<div class="de-tools">' + chip('Turns with the line', 'data-act="rot"', !!st.rot) + '</div>' +
        '<div class="de-tools"><span class="where">Pressing harder</span>' + chip('Makes it bigger', 'data-act="pm" data-v="size"', (st.pm || 'size') === 'size') +
          chip('Shows more of it', 'data-act="pm" data-v="reveal" title="The tip stays the same size; light pressure shows only its middle"', st.pm === 'reveal') +
          chip('Both', 'data-act="pm" data-v="both"', st.pm === 'both') + '</div>' +
        '<label class="de-sl">Spacing <input type="range" min="5" max="150" value="' + Math.round((st.sp || 0.25) * 100) + '" id="deSp"></label>' : '') +
      '<label class="de-sl">Name <input type="text" id="deName" maxlength="40" value="' + esc(st.name || '') + '" placeholder="' + DEFKIND[kind] + '"></label>' +
      '<div class="row"><button class="primary" type="button" data-act="save">Save</button>' + (def ? '<button type="button" data-act="saveas">Save as new</button>' : '') +
      '<button type="button" data-act="close">Cancel</button>' + (def ? '<button type="button" class="danger" data-act="del">Delete</button>' : '') + '</div>';
    openSheet(html, function (act, b) {
      if (act === 'brush') { pen.b = b.dataset.v; mark(b); return; }
      if (act === 'col') { pen.c = b.dataset.v; mark(b); return; }
      if (act === 'rub') { pen.erase = !pen.erase; b.setAttribute('aria-pressed', pen.erase); return; }
      if (act === 'pm') { st.pm = b.dataset.v; mark(b); return; }
      if (act === 'rot') { st.rot = st.rot ? 0 : 1; b.setAttribute('aria-pressed', !!st.rot); return; }
      if (act === 'undo') { if (undo.length) { st.items = undo.pop(); draw(); } return; }
      if (act === 'clear') { if (st.items.length) { undo.push(st.items.slice()); st.items = []; draw(); } return; }
      if (act === 'del') {
        MYSTYLES = MYSTYLES.filter(function (d) { return d.id !== st.id; }); GONE[st.id] = Date.now(); saveStyles();
        if (INKOPT.pen.cs === st.id) delete INKOPT.pen.cs; if (INKOPT.fill.pt === st.id) delete INKOPT.fill.pt;
        applyInk(); savePref(); closeSheet(); setTool(PREF.tool);
        toast('Deleted. Drawings that use it keep their own copy.'); return;
      }
      if (act === 'save' || act === 'saveas') {
        if (!st.items.length) { toast('Draw something first.'); return; }
        st.name = $('deName').value.trim();
        if (act === 'saveas') { st = JSON.parse(JSON.stringify(st)); st.id = 'd' + Math.random().toString(36).slice(2, 9); if (st.name && def && st.name === def.name) st.name += ' 2'; }
        st.u = Date.now();
        var i = MYSTYLES.findIndex(function (d) { return d.id === st.id; });
        if (i > -1) MYSTYLES[i] = st; else MYSTYLES.push(st);
        saveStyles(); I.addDefs([st]);
        if (kind === 'pat') INKOPT.fill.pt = st.id; else INKOPT.pen.cs = st.id;
        applyInk(); savePref(); closeSheet();
        if (S.canvas) S.canvas.ink().redraw();
        setTool(kind === 'pat' ? 'fill' : 'pen');
        toast(act === 'saveas' ? 'Saved as a new ' + DEFKIND[kind].toLowerCase() : 'Saved'); return;
      }
    });
    function mark(b) { Array.prototype.forEach.call(b.parentNode.querySelectorAll('[data-act="' + b.dataset.act + '"]'), function (x) { x.setAttribute('aria-pressed', x === b); }); }
    var box = $('deBox'), ink = $('deInk'), prev = $('dePrev');
    function draw() {
      ink.innerHTML = st.items.map(function (p) { return I.itemSvg(p); }).join('');
      if (prev) prev.innerHTML = '<defs>' + I.patternDef(Object.assign({}, st, { sz: 40 }), 'dep-' + st.id) + '</defs><rect width="120" height="120" rx="8" fill="url(#dep-' + st.id + ')" stroke="var(--rule)"/>';
    }
    draw();
    var tileIn = $('deTile'); if (tileIn) tileIn.oninput = function () { st.sz = +tileIn.value; };
    var spIn = $('deSp'); if (spIn) spIn.oninput = function () { st.sp = +spIn.value / 100; };
    $('deSize').oninput = function () { pen.s = +this.value; };
    var cur = null;
    function at(e) { var m = box.getScreenCTM().inverse(), pt = box.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; pt = pt.matrixTransform(m); return [pt.x, pt.y]; }
    function perUnit() { return box.getBoundingClientRect().width / vb[2]; }
    function rubAt(p) {
      var r = 12 / perUnit(), before = st.items.length;
      var keep = st.items.filter(function (it) { return !it.p.some(function (q) { return Math.hypot(q[0] - p[0], q[1] - p[1]) < r + I.widthOf(it) / 2; }); });
      if (keep.length !== before) { undo.push(st.items); st.items = keep; draw(); }
    }
    box.addEventListener('pointerdown', function (e) {
      e.preventDefault(); box.setPointerCapture(e.pointerId);
      var p = at(e);
      if (pen.erase) { cur = { rub: true }; rubAt(p); return; }
      var isPen = e.pointerType === 'pen';
      cur = { id: 's' + Math.random().toString(36).slice(2, 8), t: 's', b: pen.b, c: pen.c, s: pen.s / perUnit(), o: 1, p: [[p[0], p[1], isPen ? e.pressure || 0.5 : 0.5]] };
      if (isPen) cur.f = 1;
      undo.push(st.items.slice()); st.items = st.items.concat([cur]); draw();
    });
    box.addEventListener('pointermove', function (e) {
      if (!cur) return;
      var p = at(e);
      if (cur.rub) { rubAt(p); return; }
      cur.p.push([p[0], p[1], cur.f ? e.pressure || 0.5 : 0.5]); draw();
    });
    var end = function () { cur = null; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  }

  var SWATCH = ['ink', '#5f6368', '#c0392b', '#d9822b', '#f2c94c', '#2f855a', '#00796b', '#2b6cb0', '#7e57c2', '#e91e63', '#ffffff'];
  var INKOPT = { pen: { b: 'pen', c: 'ink', s: 3, o: 1 }, erase: { m: 'stroke', s: 14 }, nudge: { m: 'nudge', r: 48, k: 0.8 }, fill: { m: 'lasso', c: '#f2c94c', o: 1 },
    lasso: { m: 'most', how: 'loop', sc: 'all' }, text: { font: '"Google Sans", Roboto, system-ui, sans-serif', fs: 32, c: 'ink', o: 1 } };
  (function migrate() { // settings saved by earlier versions
    if (PREF.ink) { Object.keys(INKOPT).forEach(function (k) { Object.assign(INKOPT[k], PREF.ink[k] || {}); }); }
    else if (PREF.pen) { INKOPT.pen.c = PREF.pen.c || 'ink'; INKOPT.pen.s = PREF.pen.s || 3; }
    if (PREF.tool === 'highlighter') { PREF.tool = 'pen'; INKOPT.pen.b = 'highlighter'; INKOPT.pen.c = PREF.hl || '#f2c94c'; INKOPT.pen.o = 1; }
    if (PREF.tool === 'eraser') PREF.tool = 'erase';
    PREF.ink = INKOPT;
  })();
  function applyInk() { if (S.canvas) Object.keys(INKOPT).forEach(function (k) { S.canvas.ink().opts(k, INKOPT[k]); }); }
  function chip(label, attr, on) { return '<button type="button" class="ochip" ' + attr + ' aria-pressed="' + !!on + '">' + label + '</button>'; }
  function swatches(cur, key) {
    var known = SWATCH.indexOf(cur) > -1;
    return SWATCH.map(function (c) {
      return '<button class="swatch" type="button" data-sw="' + key + '" data-c="' + c + '" style="background:' + (c === 'ink' ? 'var(--ink)' : c) + '" aria-label="Colour ' + c + '" aria-pressed="' + (cur === c) + '"></button>';
    }).join('') + '<label class="swatch custom" aria-label="Any colour" style="background:' + (known ? 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)' : cur) + '"><input type="color" data-cc="' + key + '" value="' + (/^#/.test(cur) ? cur : '#222222') + '"></label>';
  }
  function slider(label, key, field, min, max, val, scale) {
    return '<label class="oslider">' + label + '<input type="range" data-k="' + key + '" data-f="' + field + '" data-scale="' + (scale || 1) + '" min="' + min + '" max="' + max + '" value="' + Math.round(val * (scale || 1)) + '"></label>';
  }
  var HINT = function (t) { return '<span class="where" style="padding:0 8px;white-space:nowrap">' + t + '</span>'; };
  function setTool(t) {
    if (t === 'highlighter') { INKOPT.pen.b = 'highlighter'; t = 'pen'; }
    PREF.tool = t; savePref();
    if (S.canvas) { applyInk(); S.canvas.setTool(t); }
    Array.prototype.forEach.call($('tools').querySelectorAll('[data-tool]'), function (b) { b.setAttribute('aria-pressed', b.dataset.tool === t ? 'true' : 'false'); });
    var o = INKOPT, html = '', G = function (x, half) { return '<div class="grp' + (half ? ' half' : '') + '">' + x + '</div>'; };
    if (t === 'pen') {
      var fm = PREF.finger || 'auto';
      html = G(Object.keys(window.QNInk.BRUSH).map(function (k) { return chip(window.QNInk.BRUSH[k].label, 'data-brush="' + k + '"', o.pen.b === k); }).join('')) +
        G(swatches(o.pen.c, 'pen')) + '<div class="osec">My tips &amp; lines</div>' + G(styleChips('pen', o.pen.cs, 'data-cs')) +
        G(slider('Size', 'pen', 's', 1, 24, o.pen.s) + slider('Opacity', 'pen', 'o', 5, 100, o.pen.o, 100) +
          slider('Smoothing', 'pen', 'st', 0, 95, o.pen.st != null ? o.pen.st : window.QNInk.BRUSH[o.pen.b].stream, 100)) +
        G(chip('Hold to make shapes', 'data-snap title="Draw a rough circle, box, triangle, star, line… and keep the pen still at the end: it becomes a clean shape. Keep holding and move to size or turn it."', o.pen.snap !== false)) +
        G(HINT('Finger') + chip('Auto', 'data-finger="auto" title="Draws until a pen is used, then moves the page"', fm === 'auto') +
          chip('Draws', 'data-finger="draw"', fm === 'draw') + chip('Moves the page', 'data-finger="scroll"', fm === 'scroll')) +
        // How the pen's pressure and tilt shape the line (from the next stroke on; like Affinity's pressure and tilt).
        '<div class="osec">Pressure</div>' +
        G(slider('Thickness', 'pen', 'th', 0, 95, o.pen.th != null ? o.pen.th : Math.min(0.7, window.QNInk.BRUSH[o.pen.b].thin + 0.1), 100) +
          slider('Opacity', 'pen', 'po', 0, 100, o.pen.po || 0, 100)) +
        G(HINT('Curve') + chip('Soft', 'data-pc="soft" title="Light pressure already gives a full line"', o.pen.pc === 'soft') +
          chip('Normal', 'data-pc="normal"', !o.pen.pc || o.pen.pc === 'normal') + chip('Firm', 'data-pc="firm" title="You have to press harder for a full line"', o.pen.pc === 'firm')) +
        '<div class="osec">Tilt <small>(if your pen reports it)</small></div>' +
        G(slider('Thickness', 'pen', 'tw', 0, 100, o.pen.tw || 0, 100) + slider('Opacity', 'pen', 'to', 0, 100, o.pen.to || 0, 100)) +
        G('<button type="button" class="ochip" data-act="pencheck">Check my pen</button>');
    } else if (t === 'erase') {
      html = G(chip('Whole stroke', 'data-k="erase" data-m="stroke"', o.erase.m === 'stroke') + chip('Slice', 'data-k="erase" data-m="slice"', o.erase.m === 'slice') +
        slider('Size', 'erase', 's', 3, 60, o.erase.s));
    } else if (t === 'lasso') {
      var lm = (o.lasso && o.lasso.m) || 'most', how = o.lasso.how || 'loop', sc = o.lasso.sc || 'all';
      html = G(chip('Lasso', 'data-set="lasso.how" data-v="loop" title="Draw a loop round things"', how === 'loop') +
          chip('Tap to pick', 'data-set="lasso.how" data-v="tap" title="Tap things to add them; tap again to take them out"', how === 'tap')) +
        G(HINT('From') + chip('All layers', 'data-set="lasso.sc" data-v="all"', sc === 'all') + chip('This layer', 'data-set="lasso.sc" data-v="layer"', sc === 'layer') +
          chip('This group', 'data-set="lasso.sc" data-v="group" title="The layer group the current layer is in"', sc === 'group')) +
        G(HINT('Picks what is') + chip('Partly in', 'data-k="lasso" data-m="part" title="Anything the loop touches"', lm === 'part') +
          chip('Mostly in', 'data-k="lasso" data-m="most" title="At least half inside the loop"', lm === 'most') +
          chip('Fully in', 'data-k="lasso" data-m="full" title="Only what is completely inside"', lm === 'full')) +
        G(HINT(how === 'tap' ? 'Tap to add or take out. Drag to move, corner to resize, knob to rotate.' : 'Circle to select, or tap one. Drag to move, corner to resize, knob to rotate.'));
    } else if (t === 'nudge') {
      html = G(chip('Nudge', 'data-k="nudge" data-m="nudge"', o.nudge.m === 'nudge') + chip('Smooth', 'data-k="nudge" data-m="smooth"', o.nudge.m === 'smooth')) +
        G(slider('Reach', 'nudge', 'r', 10, 160, o.nudge.r) + slider('Strength', 'nudge', 'k', 5, 100, o.nudge.k, 100));
    } else if (t === 'fill') {
      html = G(chip('Draw a shape', 'data-k="fill" data-m="lasso"', o.fill.m === 'lasso') + chip('Tap an area', 'data-k="fill" data-m="tap"', o.fill.m === 'tap')) +
        G(swatches(o.fill.c, 'fill')) + '<div class="osec">Pattern</div>' + G(styleChips('fill', o.fill.pt, 'data-pt')) +
        G(slider('Opacity', 'fill', 'o', 5, 100, o.fill.o, 100));
    } else if (t === 'text') {
      // Artistic text: part of the drawing, in the current layer. (Double-tap still makes a normal text box.)
      var TF = [['"Google Sans", Roboto, system-ui, sans-serif', 'Sans'], ['Lora, serif', 'Serif'], ['"JetBrains Mono", monospace', 'Mono'],
        ['Caveat, cursive', 'Handwriting'], ['"Permanent Marker", cursive', 'Marker'], ['"Playfair Display", serif', 'Display']];
      html = G(TF.map(function (f) { return chip('<span style="font-family:' + esc(f[0]) + '">' + f[1] + '</span>', 'data-tfont="' + esc(f[0]) + '"', o.text.font === f[0]); }).join('')) +
        G(swatches(o.text.c, 'text')) + G(slider('Size', 'text', 'fs', 10, 200, o.text.fs) + slider('Opacity', 'text', 'o', 5, 100, o.text.o, 100)) +
        G(HINT('Tap the page to write; tap text to change it. It is part of the drawing: Lasso it to move, turn or recolour it.'));
    } else if (t === 'type') html = G(HINT('Your finger moves the page; tap text to edit it, double-tap anywhere to start new text.')) +
        G(HINT('Writing with the pen switches to Pen by itself.'));
    else if (t === 'select') html = G(HINT('Drag text boxes by their dots to move them; drag the bar on the right to change the width.'));
    var NAMES = { type: 'Hand', text: 'Text art', pen: 'Pen', erase: 'Erase', lasso: 'Select', nudge: 'Nudge / Smooth', fill: 'Fill', select: 'Move' };
    if (html) html = '<div class="ohead"><b>' + NAMES[t] + '</b><button type="button" data-act="side" title="Move the tools to the other side" aria-label="Move the tools to the other side">⇄</button>' +
      '<button type="button" data-act="closeopts" aria-label="Close">×</button></div>' + html;
    $('penOpts').innerHTML = html;
    var pd = $('tools').querySelector('.pdot'); if (pd) pd.style.background = INKOPT.pen.c === 'ink' ? 'var(--ink)' : INKOPT.pen.c;
    placeOpts();
    updatePenQuick();
  }
  // The pen size control on the page: shown while the pen tool is on, or in Type mode once a pen has been used
  // (the pen writes there too).
  // The feedback button has a fixed place in the top bar of the list and of a note.
  function dockFeedback() { if (window.QNBug && QNBug.dock) QNBug.dock($(S.view === 'note' ? 'fbSlotNote' : 'fbSlotList')); }
  // ---- The quick corner (bottom left): the one or two things each tool changes most; the rest is in its card ----
  var TFONTS = ['"Google Sans", Roboto, system-ui, sans-serif', 'Lora, serif', '"JetBrains Mono", monospace', 'Caveat, cursive', '"Permanent Marker", cursive', '"Playfair Display", serif'];
  var QUICK = { // tool: [option group, field, [value, label]…]
    erase: ['erase', 'm', [['stroke', 'Whole'], ['slice', 'Slice']]],
    lasso: ['lasso', 'how', [['loop', 'Lasso'], ['tap', 'Tap']]],
    nudge: ['nudge', 'm', [['nudge', 'Nudge'], ['smooth', 'Smooth']]],
    fill: ['fill', 'm', [['lasso', 'Shape'], ['tap', 'Tap area']]]
  };
  function updatePenQuick() {
    var on = S.view === 'note' && !!S.cur && !!PREF.showTools, t = PREF.tool;
    var q = $('penQuick'), sized = on && (t === 'pen' || t === 'text');
    q.classList.toggle('hidden', !sized);
    var tq = $('toolQuick'), Q = on && QUICK[t];
    tq.classList.toggle('hidden', !Q);
    if (Q) {
      var cur = INKOPT[Q[0]][Q[1]];
      tq.innerHTML = Q[2].map(function (v) { return '<button type="button" data-q="' + v[0] + '" aria-pressed="' + (cur === v[0]) + '">' + v[1] + '</button>'; }).join('');
    }
    if (!sized) return;
    var inp = q.querySelector('input'), dot = q.querySelector('.pq-dot');
    q.dataset.mode = t;
    if (t === 'text') { // Text art: its size, and the font (tap to go to the next)
      var tx = INKOPT.text;
      inp.min = 10; inp.max = 200; inp.step = 1; inp.setAttribute('aria-label', 'Text size'); q.title = 'Text size; tap Aa for the next font';
      if (document.activeElement !== inp) inp.value = tx.fs;
      dot.className = 'pq-dot aa'; dot.innerHTML = '<span style="font-family:' + esc(tx.font) + '">Aa</span>';
      return;
    }
    var pen = INKOPT.pen, wpx = Math.max(2, Math.min(22, pen.s * ((window.QNInk.BRUSH[pen.b] || {}).size || 1.6)));
    inp.min = 1; inp.max = 24; inp.step = 0.5; inp.setAttribute('aria-label', 'Pen size'); q.title = 'Pen size';
    if (document.activeElement !== inp) inp.value = pen.s;
    dot.className = 'pq-dot';
    dot.innerHTML = '<i style="width:' + wpx + 'px;height:' + wpx + 'px;background:' + (pen.c === 'ink' ? 'var(--ink)' : pen.c) + '"></i>';
  }
  $('penQuick').addEventListener('input', function (e) {
    if ($('penQuick').dataset.mode === 'text') {
      INKOPT.text.fs = +e.target.value; applyInk(); savePref();
      var ts = $('penOpts').querySelector('[data-k=text][data-f=fs]'); if (ts) ts.value = INKOPT.text.fs;
      return;
    }
    INKOPT.pen.s = +e.target.value; applyInk(); savePref(); updatePenQuick();
    var s = $('penOpts').querySelector('[data-k=pen][data-f=s]'); if (s) s.value = Math.round(INKOPT.pen.s);
  });
  $('penQuick').addEventListener('click', function (e) {
    if ($('penQuick').dataset.mode !== 'text' || !e.target.closest('.pq-dot')) return;
    var i = TFONTS.indexOf(INKOPT.text.font);
    INKOPT.text.font = TFONTS[(i + 1) % TFONTS.length]; applyInk(); savePref(); updatePenQuick();
    if (!$('penOpts').classList.contains('hidden')) setTool('text');
  });
  $('toolQuick').addEventListener('pointerdown', function (e) { e.stopPropagation(); if (e.target.closest('button')) e.preventDefault(); });
  $('toolQuick').addEventListener('click', function (e) {
    var b = e.target.closest('[data-q]'), Q = QUICK[PREF.tool]; if (!b || !Q) return;
    INKOPT[Q[0]][Q[1]] = b.dataset.q; applyInk(); savePref();
    if (!$('penOpts').classList.contains('hidden')) setTool(PREF.tool); else updatePenQuick();
  });
  $('penQuick').addEventListener('pointerdown', function (e) { e.stopPropagation(); if (e.target.closest('.pq-dot')) e.preventDefault(); });
  // The drawing tools live behind one button, so a note opens as a plain page, like Keep.
  function showTools(on) {
    PREF.showTools = !!on; savePref();
    $('tools').classList.toggle('hidden', !on);
    $('toolsBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on && PREF.tool !== 'type') setTool('type');
    if (!on) { $('layersPanel').classList.add('hidden'); layersBtn(); showOpts(false); }
    updatePenQuick();
    if (S.canvas) requestAnimationFrame(S.canvas.relayout);
  }
  $('toolsBtn').onclick = function () { showTools(!PREF.showTools); };
  function savePref() { try { localStorage.setItem('qn-pen', JSON.stringify(PREF)); } catch (e) {} }
  setTimeout(function () { showTools(PREF.showTools); }, 0);
  // What the pen tells the app: write on the square to see pressure and tilt.
  function penCheck() {
    showOpts(false);
    openSheet('<h2>Check my pen</h2><p>Write or press on the square with your pen.</p>' +
      '<div id="pcPad" style="height:180px;border-radius:14px;background:var(--field);touch-action:none;display:grid;place-items:center;color:var(--muted);font-size:14px">Write here</div>' +
      '<p id="pcOut" style="font-size:14px;line-height:1.6;margin-top:10px">Pressure: –<br>Tilt: –</p><div class="row"><button type="button" data-act="close">Done</button></div>');
    var seen = { pr: false, tilt: false }, pad = $('pcPad');
    function show(e) {
      if (e.pointerType !== 'pen') { $('pcOut').innerHTML = 'That was a ' + (e.pointerType === 'touch' ? 'finger' : e.pointerType) + '; use the pen.'; return; }
      var pr = e.pressure, alt = e.altitudeAngle, tx = e.tiltX || 0, ty = e.tiltY || 0;
      if (pr > 0 && pr !== 0.5) seen.pr = true;
      if (tx || ty || (alt != null && alt < Math.PI / 2 - 0.01)) seen.tilt = true;
      $('pcOut').innerHTML = 'Pressure: ' + (seen.pr ? 'yes, ' + Math.round(pr * 100) + '%' : 'not reported (or still testing)') +
        '<br>Tilt: ' + (seen.tilt ? 'yes, ' + Math.round(alt != null ? 90 - alt * 180 / Math.PI : Math.max(Math.abs(tx), Math.abs(ty))) + '° from upright' : 'not reported by this pen (tilt settings will do nothing)');
    }
    pad.addEventListener('pointerdown', function (e) { pad.setPointerCapture(e.pointerId); show(e); });
    pad.addEventListener('pointermove', function (e) { if (e.buttons || e.pressure) show(e); });
  }
  // The settings card opens beside the tool, when the chosen tool is tapped again.
  function placeOpts() {
    var on = $('tools').querySelector('.tool[aria-pressed="true"]'), card = $('penOpts');
    card.style.top = on ? Math.max(0, on.offsetTop - $('tools').querySelector('.tool-row').scrollTop - 8) + 'px' : '0px';
  }
  function showOpts(on) {
    $('tools').classList.toggle('opts', !!on);
    if (on) { placeOpts(); if (!$('layersPanel').classList.contains('hidden')) { $('layersPanel').classList.add('hidden'); layersBtn(); } }
  }
  function setSide(left) { PREF.toolsLeft = !!left; savePref(); $('tools').classList.toggle('left', !!left); if (!$('layersPanel').classList.contains('hidden')) renderLayers(); }
  setSide(PREF.toolsLeft);
  document.addEventListener('pointerdown', function (e) {
    if ($('tools').classList.contains('opts') && !e.target.closest('#tools')) showOpts(false);
  }, true);
  $('tools').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'closeopts') return showOpts(false);
    if (b.dataset.pc) { INKOPT.pen.pc = b.dataset.pc; applyInk(); savePref(); return setTool('pen'); }
    if (b.dataset.act === 'pencheck') return penCheck();
    if (b.dataset.act === 'side') return setSide(!PREF.toolsLeft);
    if (b.dataset.tool) {
      if (b.dataset.tool === PREF.tool) return showOpts(!$('tools').classList.contains('opts'));
      setTool(b.dataset.tool); showOpts(false);
      if (!PREF.optsHint && $('penOpts').innerHTML) { PREF.optsHint = true; savePref(); toast('Tap the tool again for its settings.', null, null, 3000); }
      return;
    }
    if (b.dataset.finger) {
      PREF.finger = b.dataset.finger === 'auto' ? '' : b.dataset.finger; savePref();
      toast(b.dataset.finger === 'draw' ? 'Your finger draws. Two fingers still move and zoom the page.' : b.dataset.finger === 'scroll' ? 'Your finger moves the page; only the pen draws.' : 'Your finger draws until you use a pen.', null, null, 3000);
      return setTool(PREF.tool);
    }
    if (b.dataset.act === 'layers') return toggleLayers();
    if (b.dataset.act === 'image') { imgWhere = 'page'; imgInput.value = ''; imgInput.click(); return; } // straight onto the page
    if (b.dataset.snap != null) { INKOPT.pen.snap = INKOPT.pen.snap === false; applyInk(); savePref(); return setTool('pen'); }
    if (b.dataset.cs != null) { if (b.dataset.cs) INKOPT.pen.cs = b.dataset.cs; else delete INKOPT.pen.cs; applyInk(); savePref(); return setTool('pen'); }
    if (b.dataset.pt != null) { if (b.dataset.pt) INKOPT.fill.pt = b.dataset.pt; else delete INKOPT.fill.pt; applyInk(); savePref(); return setTool('fill'); }
    if (b.dataset.newdef) return editStyle(b.dataset.newdef, null);
    if (b.dataset.editdef) { var dd = MYSTYLES.filter(function (d) { return d.id === b.dataset.editdef; })[0]; if (dd) editStyle(dd.k, dd); return; }
    if (b.dataset.brush) { INKOPT.pen.b = b.dataset.brush; if (b.dataset.brush === 'highlighter' && INKOPT.pen.c === 'ink') INKOPT.pen.c = '#f2c94c'; return setTool('pen'); }
    if (b.dataset.m) { INKOPT[b.dataset.k].m = b.dataset.m; return setTool(PREF.tool); }
    if (b.dataset.set) { var kv = b.dataset.set.split('.'); INKOPT[kv[0]][kv[1]] = b.dataset.v; return setTool(PREF.tool); }
    if (b.dataset.sw) { INKOPT[b.dataset.sw].c = b.dataset.c; applyInk(); savePref(); return setTool(PREF.tool); }
    if (b.dataset.tfont != null) { INKOPT.text.font = b.dataset.tfont; applyInk(); savePref(); return setTool('text'); }
  });
  // While artistic text is being written, tapping the Text card's buttons keeps the keyboard and the writing going.
  $('tools').addEventListener('pointerdown', function (e) {
    if (S.canvas && S.canvas.ink().editingText() && e.target.closest('button') && !e.target.closest('[data-act=closeopts]')) e.preventDefault();
  });
  $('tools').addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset.cc) { INKOPT[t.dataset.cc].c = t.value; applyInk(); savePref(); return; }
    if (t.dataset.k) { INKOPT[t.dataset.k][t.dataset.f] = +t.value / +t.dataset.scale; applyInk(); savePref(); updatePenQuick(); }
  });
  $('tools').addEventListener('change', function (e) { if (e.target.dataset.cc) setTool(PREF.tool); });

  // ---------- Zoom, navigator and turning ----------
  function applyViewPrefs() {
    if (!S.canvas) return;
    S.canvas.viewOps.navigator(!!PREF.nav); S.canvas.viewOps.rotate(PREF.rotate !== false);
    $('navState').textContent = PREF.nav ? 'On' : 'Off'; $('rotState').textContent = PREF.rotate !== false ? 'On' : 'Off';
  }
  function closeViewMenu() { $('viewMenu').classList.add('hidden'); $('zoomBtn').setAttribute('aria-expanded', 'false'); }
  $('zoomBtn').onclick = function () {
    var open = $('viewMenu').classList.contains('hidden');
    $('viewMenu').classList.toggle('hidden', !open); $('zoomBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  $('compass').onclick = function () { if (S.canvas) S.canvas.viewOps.straighten(); };
  $('viewMenu').addEventListener('click', function (e) {
    var b = e.target.closest('[data-v]'); if (!b || !S.canvas) return;
    var v = b.dataset.v, ops = S.canvas.viewOps;
    if (v === 'nav') { PREF.nav = !PREF.nav; savePref(); applyViewPrefs(); return; }
    if (v === 'rot') { PREF.rotate = PREF.rotate === false; savePref(); applyViewPrefs(); return; }
    if (v === 'area') { closeViewMenu(); ops.area(); toast('Drag across the part you want to zoom into', null, null, 2500); return; }
    ops[v]();
    if (v !== 'zoomIn' && v !== 'zoomOut') closeViewMenu();
  });
  document.addEventListener('pointerdown', function (e) {
    if (!$('viewMenu').classList.contains('hidden') && !e.target.closest('#viewMenu, #zoomBtn')) closeViewMenu();
  }, true);

  // ---------- Layers panel ----------
  function layersBtn() { var b = $('tools').querySelector('[data-act="layers"]'); if (b) b.setAttribute('aria-pressed', !$('layersPanel').classList.contains('hidden')); }
  function toggleLayers() { var p = $('layersPanel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) renderLayers(); layersBtn(); }
  var LIC = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6A17 17 0 002 12s3.6 7 10 7a9.8 9.8 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.7-1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    dup: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
    merge: '<path d="M7 4v5a5 5 0 005 5h0a5 5 0 015 5v1M17 4v5a5 5 0 01-5 5M12 20v-6"/>',
    rename: '<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/>', del: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'
  };
  function lic(name, attrs, label, cls) { return '<button type="button" class="lic' + (cls ? ' ' + cls : '') + '" ' + attrs + ' aria-label="' + label + '" title="' + label + '"><svg viewBox="0 0 24 24">' + LIC[name] + '</svg></button>'; }
  // Layers, like Affinity: tap a layer to draw on it, tap it again for its controls; tap and hold to pick several
  // (then group, hide, merge or delete them); hold and drag to move a layer, into a group or out of one.
  S.lsel = null; S.lopen = null; S.gclosed = {};
  function renderLayers() {
    var p = $('layersPanel');
    if (!S.canvas || p.classList.contains('hidden')) return;
    var rail = $('tools').querySelector('.tool-row').getBoundingClientRect();
    p.style.top = Math.round(rail.top) + 'px';
    if (PREF.toolsLeft) { p.style.left = Math.round(rail.right + 8) + 'px'; p.style.right = 'auto'; }
    else { p.style.right = Math.round(innerWidth - rail.left + 8) + 'px'; p.style.left = 'auto'; }
    showOpts(false);
    var eng = S.canvas.ink(), list = eng.layers(), blends = window.QNInk.BLENDS, th = eng.layerThumbs(64, 44), tc = S.canvas.textCounts ? S.canvas.textCounts() : {};
    var sel = S.lsel, html = '';
    if (sel) {
      var ids = Object.keys(sel), anyG = list.some(function (l) { return sel[l.id] && l.gid; });
      html += '<div class="lhead lselbar"><b>' + ids.length + ' selected</b>' + lic('close', 'data-lo="selcancel"', 'Done') + '</div>' +
        '<div class="lselacts">' +
        '<button type="button" data-lo="sgroup">Group</button>' +
        (anyG ? '<button type="button" data-lo="sungroup">Ungroup</button>' : '') +
        '<button type="button" data-lo="svis">Show/hide</button>' +
        '<button type="button" data-lo="smerge"' + (ids.length < 2 ? ' disabled' : '') + '>Merge</button>' +
        '<button type="button" data-lo="sdelete" class="danger">Delete</button></div>';
    } else html += '<div class="lhead"><b>Layers</b>' + lic('plus', 'data-lo="add"', 'Add a layer', 'ladd') + lic('close', 'data-lo="close"', 'Close') + '</div>';
    function card(l, i, inGroup) {
      var parts = [];
      if (l.n) parts.push(l.n + (l.n === 1 ? ' drawing' : ' drawings'));
      if (tc[l.id]) parts.push(tc[l.id] + ' text');
      if (!parts.length) parts.push('empty');
      if (l.op < 1) parts.push(Math.round(l.op * 100) + '%');
      if (l.blend !== 'normal') parts.push(l.blend);
      if (l.clip) parts.push('masked');
      var s = '<div class="lcard' + (l.active ? ' on' : '') + (l.vis ? '' : ' hid') + (inGroup ? ' ing' : '') + (sel && sel[l.id] ? ' picked' : '') + '" data-id="' + l.id + '" data-gid="' + (l.gid || '') + '">' +
        (sel ? '<span class="lpick">' + (sel[l.id] ? '✓' : '') + '</span>' : '') +
        '<div class="lthumb">' + (th[l.id] || '') + '</div>' +
        '<div class="lmeta"><b>' + esc(l.name) + '</b><small>' + parts.join(' · ') + '</small></div>' +
        (sel ? '' : lic(l.vis ? 'eye' : 'eyeOff', 'data-lo="vis"', l.vis ? 'Hide' : 'Show', l.vis ? '' : 'off') +
          lic(l.lock ? 'lock' : 'unlock', 'data-lo="lock"', l.lock ? 'Unlock' : 'Lock', l.lock ? '' : 'off')) + '</div>';
      if (!sel && l.active && S.lopen === l.id) s += '<div class="ltools" data-id="' + l.id + '">' +
        '<label class="lop">Opacity<input type="range" min="0" max="100" value="' + Math.round(l.op * 100) + '" data-lop><output>' + Math.round(l.op * 100) + '%</output></label>' +
        '<div class="lrow2"><select data-lblend aria-label="Blend">' + blends.map(function (b) { return '<option value="' + b + '"' + (b === l.blend ? ' selected' : '') + '>' + b.replace('-', ' ') + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="lmask" data-lo="clip" aria-pressed="' + !!l.clip + '"' + (i === list.length - 1 ? ' disabled' : '') + ' title="Only show this layer where the layer below has paint">Mask</button></div>' +
        '<div class="lacts">' + lic('up', 'data-lo="up"' + (i === 0 ? ' disabled' : ''), 'Move up') + lic('down', 'data-lo="down"' + (i === list.length - 1 ? ' disabled' : ''), 'Move down') +
        lic('dup', 'data-lo="dup"', 'Duplicate') + lic('merge', 'data-lo="merge"' + (i === list.length - 1 ? ' disabled' : ''), 'Merge down') +
        lic('rename', 'data-lo="rename"', 'Rename') + lic('del', 'data-lo="delete"', 'Delete', 'danger') + '</div></div>';
      return s;
    }
    html += '<div class="llist">';
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      if (l.gid) {
        var gid = l.gid, members = [], j = i;
        while (j < list.length && list[j].gid === gid) { members.push(j); j++; }
        var allHid = members.every(function (k) { return !list[k].vis; }), allLock = members.every(function (k) { return list[k].lock; }), closed = !!S.gclosed[gid];
        html += '<div class="lgroup" data-gid="' + gid + '"><button type="button" class="lgtw" data-lo="gtoggle" aria-label="' + (closed ? 'Open group' : 'Close group') + '">' + (closed ? '▸' : '▾') + '</button>' +
          '<b data-lo="grename" title="Rename group">' + esc(l.gname || 'Group') + '</b><small>' + members.length + '</small>' +
          (sel ? '' : lic(allHid ? 'eyeOff' : 'eye', 'data-lo="gvis"', allHid ? 'Show group' : 'Hide group', allHid ? 'off' : '') + lic(allLock ? 'lock' : 'unlock', 'data-lo="glock"', allLock ? 'Unlock group' : 'Lock group', allLock ? '' : 'off')) + '</div>';
        if (!closed) members.forEach(function (k) { html += card(list[k], k, true); });
        i = j - 1;
      } else html += card(l, i, false);
    }
    html += '</div>' + (sel ? '' : '<p class="lhint">Tap a layer again for its settings. Hold to pick several; hold and drag to move it.</p>');
    p.innerHTML = html;
  }
  $('layersPanel').addEventListener('click', function (e) {
    if (Date.now() - (S.lheldAt || 0) < 400) return; // the end of a hold, not a tap
    var b = e.target.closest('[data-lo]'), eng = S.canvas && S.canvas.ink(); if (!eng) return;
    var cardEl = e.target.closest('.lcard');
    if (!b && cardEl) { // a tap on a layer
      var cid = cardEl.dataset.id;
      if (S.lsel) { if (S.lsel[cid]) delete S.lsel[cid]; else S.lsel[cid] = true; if (!Object.keys(S.lsel).length) S.lsel = null; return renderLayers(); }
      var isActive = eng.layers().some(function (l) { return l.id === cid && l.active; });
      if (isActive) S.lopen = S.lopen === cid ? null : cid; else { eng.layerOp('active', cid); S.lopen = null; }
      return renderLayers();
    }
    if (!b) return;
    var op = b.dataset.lo, row = b.closest('[data-id]'), id = row && row.dataset.id, grp = b.closest('[data-gid]'), gid = grp && grp.dataset.gid;
    var members = function () { return eng.layers().filter(function (l) { return l.gid === gid; }).map(function (l) { return l.id; }); };
    if (op === 'close') { $('layersPanel').classList.add('hidden'); layersBtn(); return; }
    if (op === 'add') { eng.layerOp('add', eng.layers().filter(function (l) { return l.active; })[0].id); return renderLayers(); }
    if (op === 'selcancel') { S.lsel = null; return renderLayers(); }
    if (op === 'gtoggle') { S.gclosed[gid] = !S.gclosed[gid]; return renderLayers(); }
    if (op === 'gvis') { eng.layersOp('vis', members()); return renderLayers(); }
    if (op === 'glock') { eng.layersOp('lock', members()); return renderLayers(); }
    if (op === 'grename' || op === 'sgroup') {
      var ids = op === 'sgroup' ? Object.keys(S.lsel || {}) : members();
      var ngroups = {}; eng.layers().forEach(function (l) { if (l.gid) ngroups[l.gid] = 1; });
      var cur = op === 'sgroup' ? 'Group ' + (Object.keys(ngroups).length + 1) : (eng.layers().filter(function (l) { return l.gid === gid; })[0] || {}).gname;
      openSheet('<form><h2>' + (op === 'sgroup' ? 'Group these layers' : 'Rename group') + '</h2><input type="text" name="nm" value="' + esc(cur || 'Group') + '" maxlength="40" required><div class="row"><button class="primary" type="submit">' + (op === 'sgroup' ? 'Group' : 'Rename') + '</button><button type="button" data-act="close">Cancel</button></div></form>',
        null, function (ev) { eng.layersOp(op === 'sgroup' ? 'group' : 'gname', ids, ev.target.nm.value); if (op === 'sgroup') S.lsel = null; closeSheet(); renderLayers(); });
      return;
    }
    if (op === 'sungroup') { eng.layersOp('ungroup', Object.keys(S.lsel)); S.lsel = null; return renderLayers(); }
    if (op === 'svis') { eng.layersOp('vis', Object.keys(S.lsel)); return renderLayers(); }
    if (op === 'smerge') { eng.layersOp('merge', Object.keys(S.lsel)); S.lsel = null; return renderLayers(); }
    if (op === 'sdelete') {
      var del = Object.keys(S.lsel);
      openSheet('<h2>Delete ' + del.length + (del.length === 1 ? ' layer' : ' layers') + '?</h2><p>Everything drawn on them goes too; their text moves to the bottom layer. Undo brings it back.</p><div class="row"><button class="primary danger" type="button" data-act="del">Delete</button><button type="button" data-act="close">Cancel</button></div>',
        function (act) { if (act === 'del') { eng.layersOp('delete', del); S.lsel = null; closeSheet(); renderLayers(); } });
      return;
    }
    if (op === 'rename') {
      var curL = eng.layers().filter(function (l) { return l.id === id; })[0];
      openSheet('<form><h2>Rename layer</h2><input type="text" name="nm" value="' + esc(curL.name) + '" maxlength="40" required><div class="row"><button class="primary" type="submit">Rename</button><button type="button" data-act="close">Cancel</button></div></form>',
        null, function (ev) { eng.layerOp('name', id, ev.target.nm.value); closeSheet(); renderLayers(); });
      return;
    }
    if (op === 'delete' && eng.layers().filter(function (l) { return l.id === id; })[0].n && !confirmLayerDelete(id)) return;
    eng.layerOp(op, id); renderLayers();
  });
  // Hold a layer: pick it (and then others with a tap); hold and drag: move it, into or out of a group.
  (function () {
    var hold = null, P = $('layersPanel');
    P.addEventListener('pointerdown', function (e) {
      var c = e.target.closest('.lcard'); if (!c || e.target.closest('[data-lo]') || S.lsel) return;
      hold = { id: c.dataset.id, el: c, x: e.clientX, y: e.clientY, pid: e.pointerId, on: false, drag: false };
      hold.timer = setTimeout(function () {
        if (!hold) return;
        hold.on = true; c.classList.add('held');
        try { P.setPointerCapture(hold.pid); } catch (x) {}
        if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {}
      }, 420);
    });
    P.addEventListener('pointermove', function (e) {
      if (!hold || e.pointerId !== hold.pid) return;
      var dx = e.clientX - hold.x, dy = e.clientY - hold.y;
      if (!hold.on) { if (Math.abs(dx) + Math.abs(dy) > 10) { clearTimeout(hold.timer); hold = null; } return; } // a scroll, not a hold
      e.preventDefault();
      if (!hold.drag && Math.abs(dy) > 6) { hold.drag = true; dragEl = hold.el; hold.el.classList.add('dragging'); }
      if (hold.drag) { hold.el.style.transform = 'translateY(' + dy + 'px)'; markDrop(e.clientY); }
    });
    var dragEl = null;
    function rows() { return Array.prototype.slice.call(P.querySelectorAll('.llist > .lcard, .llist > .lgroup')).filter(function (r) { return r !== dragEl; }); }
    function target(y) { // where it would land: before which row, and in which group
      var rs = rows(), before = null;
      for (var i = 0; i < rs.length; i++) { var r = rs[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { before = rs[i]; break; } }
      var gid = before && before.classList.contains('lcard') ? before.dataset.gid : '';
      return { before: before, gid: gid };
    }
    function markDrop(y) {
      P.querySelectorAll('.dropline').forEach(function (d) { d.classList.remove('dropline', 'after'); });
      var t = target(y);
      if (t.before) t.before.classList.add('dropline'); else { var rs = rows(); if (rs.length) rs[rs.length - 1].classList.add('dropline', 'after'); }
    }
    function end(e) {
      if (!hold || e.pointerId !== hold.pid) return;
      clearTimeout(hold.timer);
      var h = hold; hold = null;
      if (!h.on) return;
      S.lheldAt = Date.now();
      h.el.classList.remove('held', 'dragging'); h.el.style.transform = '';
      var eng = S.canvas && S.canvas.ink(); if (!eng) return;
      if (!h.drag) { S.lsel = {}; S.lsel[h.id] = true; S.lopen = null; return renderLayers(); } // picking
      var t = target(e.clientY); dragEl = null;
      var list = eng.layers(), order = list.map(function (l) { return l.id; }).filter(function (x) { return x !== h.id; });
      // Visual order is top first: count the layers above the drop point, then turn it into a place counted from the bottom.
      var above;
      if (!t.before) above = order.length;
      else if (t.before.classList.contains('lgroup')) { var fm = list.filter(function (l) { return l.gid === t.before.dataset.gid && l.id !== h.id; })[0]; above = fm ? order.indexOf(fm.id) : order.length; }
      else above = order.indexOf(t.before.dataset.id);
      var gname = t.gid ? (list.filter(function (l) { return l.gid === t.gid; })[0] || {}).gname : null;
      eng.moveLayer(h.id, order.length - above, t.gid || null, gname);
      renderLayers();
    }
    P.addEventListener('pointerup', end);
    P.addEventListener('pointercancel', end);
  })();
  function confirmLayerDelete(id) {
    var eng = S.canvas.ink();
    openSheet('<h2>Delete this layer?</h2><p>Everything drawn on it goes too. Undo brings it back.</p><div class="row"><button class="primary danger" type="button" data-act="del">Delete layer</button><button type="button" data-act="close">Cancel</button></div>',
      function (act) { if (act === 'del') { eng.layerOp('delete', id); closeSheet(); renderLayers(); } });
    return false;
  }
  $('layersPanel').addEventListener('input', function (e) {
    var row = e.target.closest('[data-id]'); if (!row || !S.canvas) return;
    if (e.target.dataset.lop != null) { S.canvas.ink().layerOp('op', row.dataset.id, +e.target.value / 100); var out = e.target.parentNode.querySelector('output'); if (out) out.textContent = e.target.value + '%'; }
  });
  $('layersPanel').addEventListener('change', function (e) {
    var row = e.target.closest('[data-id]'); if (!row || !S.canvas) return;
    var eng = S.canvas.ink(), id = row.dataset.id;
    if (e.target.dataset.lop != null) eng.layerOp('opdone', id, +e.target.value / 100);
    if (e.target.dataset.lblend != null) eng.layerOp('blend', id, e.target.value);
    renderLayers();
  });

  // ---------- Formatting bar ----------
  function showFmt(on) {
    $('fmtBar').classList.toggle('hidden', !on);
    $('menuFab').classList.toggle('lift', on); $('noteMenu').classList.toggle('lift', on); $('penQuick').classList.toggle('lift', on); $('toolQuick').classList.toggle('lift', on);
    $('viewCtl').classList.toggle('lift', on); $('viewMenu').classList.toggle('lift', on);
    if (!on) $('pop').classList.add('hidden');
    placeFmt();
  }
  function placeFmt() { // keep the bar just above the on-screen keyboard
    var vv = window.visualViewport;
    var off = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    $('fmtBar').style.bottom = off + 'px';
  }
  // On a phone, the formatting bar belongs to the keyboard: when the keyboard is put away (the back button or the
  // keyboard's own button), the bar goes too instead of staying as a strip at the bottom of the screen.
  var kbOpen = false, coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  function watchKeyboard() {
    var vv = window.visualViewport; if (!vv || !coarse) return;
    // The page may shrink with the keyboard, so compare with the tallest the screen has been at this width.
    if (vv.width !== S.kbW) { S.kbW = vv.width; S.kbH = 0; }
    S.kbH = Math.max(S.kbH || 0, vv.height);
    var off = S.kbH - vv.height;
    if (off > 120) kbOpen = true;
    else if (kbOpen) {
      kbOpen = false;
      if (!$('fmtBar').classList.contains('hidden')) { showFmt(false); if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.ProseMirror')) document.activeElement.blur(); }
    }
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', function () { placeFmt(); watchKeyboard(); });
    visualViewport.addEventListener('scroll', placeFmt);
  }
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
      case 'font':
        // With nothing selected, the font goes on the whole text box.
        var FONTS = [['', 'Sans (standard)', 'var(--font)'], ['Lora, serif', 'Serif', 'Lora, serif'], ['"JetBrains Mono", monospace', 'Mono', '"JetBrains Mono", monospace'],
          ['Caveat, cursive', 'Handwriting', 'Caveat, cursive'], ['"Permanent Marker", cursive', 'Marker', '"Permanent Marker", cursive'], ['"Playfair Display", serif', 'Display', '"Playfair Display", serif']];
        popAt(b, FONTS.map(function (f) { return '<button data-v="' + esc(f[0]) + '" style="font-family:' + esc(f[2]) + ';font-size:16px">' + f[1] + '</button>'; }).join(''), function (p) {
          var chain = ed.chain().focus();
          if (ed.state.selection.empty) chain = chain.selectAll();
          if (p.dataset.v) chain.setFontFamily(p.dataset.v).run(); else chain.unsetFontFamily().run();
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
    openSheet('<h2>Add an image</h2><p>Where should it go?</p><div class="pick">' +
      '<button type="button" data-act="page"><b>On the page</b>: move, resize and turn it freely, in front of or behind drawings</button>' +
      (hasCaret ? '<button type="button" data-act="caret">At the cursor</button>' : '') +
      '<button type="button" data-act="beside">Beside the text (side by side)</button>' +
      '<button type="button" data-act="below">Below everything</button></div><div class="row"><button type="button" data-act="close">Cancel</button></div>',
    function (act) {
      if (act !== 'caret' && act !== 'beside' && act !== 'below' && act !== 'page') return;
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
      if (imgWhere === 'page') {
        var dims = await new Promise(function (res) { var im = new Image(); im.onload = function () { res([im.naturalWidth || 400, im.naturalHeight || 300]); }; im.onerror = function () { res([400, 300]); }; im.src = imgCache[name]; });
        S.canvas.placeImage('Attachments/' + encodeURIComponent(name), dims[0], dims[1]);
      } else S.canvas.insertImage('Attachments/' + encodeURIComponent(name), imgWhere);
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
      var c = copyOf(n, (n.title || 'Note') + ' (copy)');
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
    S.cur = null; updatePenQuick();
    if (history.state && history.state.v === 'note') history.back(); else showList();
    S.view = 'list'; dockFeedback(); $('editorView').classList.add('hidden'); $('listView').classList.remove('hidden'); renderList();
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
        '<div class="vprev">' + taskify(body) + (N.hasInk(old) ? window.QNInk.thumb(old.ink, 480, 240) : '') + '</div>' +
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
  if (/(^|[#&])nosw\b/.test(location.hash)) window.__qnState = S; // for testing the app in a browser
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
  async function checkUpdate() {
    if (!registration) { toast(Drive.demo ? 'Updates work in the installed app, not in the demo.' : 'Updates work once the app is installed from its web address.'); return; }
    toast('Checking for update…');
    try { await registration.update(); } catch (e) {}
    setTimeout(function () {
      if (registration.waiting || registration.installing) { hideToast(); offerUpdate(); }
      else toast('You have the latest version.');
    }, 1500);
  }

  // ---------- Settings (in the Folders menu) ----------
  async function renameRootSheet() {
    if (!Drive.signedIn() || !navigator.onLine) { toast('Connect and sign in to Google first.'); return; }
    var parents = [];
    try { parents = await sync.rootParents(); } catch (e) { toast('Could not reach Drive just now.'); return; }
    var inReadables = CFG.READABLES_FOLDER_ID && parents.indexOf(CFG.READABLES_FOLDER_ID) > -1;
    openSheet('<form><h2>Main folder</h2><p>Serendipity finds this folder by a hidden mark, so renaming or moving it is safe on every device.</p>' +
      '<input id="rootName" type="text" maxlength="80" value="' + esc(sync.rootName() === 'Notes' ? 'Serendipity' : sync.rootName()) + '" autofocus>' +
      (inReadables ? '<label class="chk" style="display:flex;gap:10px;align-items:center;margin:12px 0"><input type="checkbox" id="rootOut" checked> Move it out of “Readables”, to the top of My Drive</label>' : '') +
      '<div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="close">Cancel</button></div></form>', null, async function () {
      var name = $('rootName').value.trim(), out = $('rootOut') && $('rootOut').checked;
      if (!name) return;
      try { await sync.renameRoot(name, out ? CFG.READABLES_FOLDER_ID : null); closeSheet(); toast('Main folder is now “' + name + '”' + (out ? ', at the top of My Drive' : '')); }
      catch (e) { toast('Could not change it: ' + (e.message || e)); }
    });
  }
  function settingsSheet() {
    var st = sync.status(), h = health(st), who = Drive.account ? Drive.account() : '';
    var signin = Drive.demo ? 'Demo mode: a pretend Drive that resets when the page reloads.' :
      !Drive.signedIn() ? 'Not signed in. Notes are kept on this phone until you sign in.' :
      Drive.lasting && Drive.lasting() ? 'Signed in' + (who ? ' as ' + who : '') + '. You stay signed in on this phone.' :
      'Signed in' + (who ? ' as ' + who : '') + ' for about an hour at a time' + (Drive.persistent ? '. Sign in once more to stay signed in.' : '.');
    openSheet('<h2>Settings</h2>' +
      '<div class="set"><b>Google account</b><p>' + esc(signin) + '</p>' +
        (!Drive.demo && (!Drive.signedIn() || (Drive.persistent && !Drive.lasting())) ? '<button class="primary" type="button" data-act="signin">Sign in with Google</button>' : '') + '</div>' +
      '<div class="set"><b>Sync</b><p>' + esc(h.text) + '</p><button type="button" data-act="sync">Sync now</button></div>' +
      '<div class="set"><b>Folders</b><p>Default folder: <b style="display:inline;font-weight:500">' + esc(defaultFolder() ? folderName(defaultFolder()) : 'Inbox') + '</b>. New notes go here unless you are inside another folder.</p>' +
        '<button type="button" data-act="pickdefault">Choose default folder</button>' +
        '<p style="margin-top:12px !important">Main folder in Drive: <b style="display:inline;font-weight:500">' + esc(sync.rootName()) + '</b> (your notes, and your pen tips, lines and patterns in its hidden .serendipity folder).</p>' +
        (Drive.demo ? '' : '<button type="button" data-act="renameroot">Rename or move the main folder</button>') +
        '<p style="margin-top:12px !important">When the app opens, show:</p><div class="pick" style="margin:0">' +
        [['all', 'All notes'], ['default', 'The default folder'], ['last', 'The folder I was last in'], ['lastnote', 'The folder of the note I last edited']].map(function (o) {
          return '<button type="button" data-act="start" data-v="' + o[0] + '" aria-pressed="' + ((PREF.start || 'all') === o[0]) + '">' + (((PREF.start || 'all') === o[0]) ? '◉ ' : '○ ') + o[1] + '</button>';
        }).join('') + '</div><p style="margin-top:8px !important">Rename, move or delete a folder from its ••• in the side menu.</p></div>' +
      '<div class="set"><b>Copy notes in</b><p>A one-time copy from another app. Not a sync: the other app stays as it is.</p>' +
        '<button type="button" data-act="keep">From Google Keep</button> <button type="button" data-act="notion">From Notion</button></div>' +
      '<div class="set"><b>Feedback button</b><p>The small round button in the top bar. Touching it takes a picture of the app; draw on it, write notes on it, and tap the button again to send. It goes to the developer, with the picture and app details; replies show up here.</p>' +
        '<button type="button" data-act="bugbtn">' + (PREF.bugBtn !== false ? 'Hide the feedback button' : 'Show the feedback button') + '</button> <button type="button" data-act="bugnow">Send feedback now</button> <button type="button" data-act="fbinbox">Your feedback and replies</button></div>' +
      '<div class="set"><b>About</b><p>Serendipity ' + esc(CFG.VERSION) + '. Notes are Markdown files in your Google Drive › ' + esc(sync.rootName()) + ', readable by any notes app. Serendipity can only see the files it makes.</p>' +
        '<button type="button" data-act="update">Check for update</button> <button type="button" data-act="whatsnew">What’s new</button></div>' +
      (Drive.demo ? '<div class="set"><b>Demo tools</b><p>Try the offline queue and the changed-elsewhere warning.</p>' +
        '<button type="button" data-act="demoOffline">' + (Drive.isOffline() ? 'Back online' : 'Pretend offline') + '</button> <button type="button" data-act="demoElsewhere">Pretend the laptop edited the last note</button></div>' : '') +
      '<div class="row"><button type="button" data-act="close">Close</button></div>',
    function (act, b) {
      if (act === 'start') { PREF.start = b.dataset.v; savePref(); settingsSheet(); return; }
      if (act === 'pickdefault') return pickFolder('Default folder', defaultFolder() || sync.inbox(), function (id) {
        PREF.defaultFolder = id === sync.inbox() ? '' : id; savePref(); settingsSheet();
      });
      if (act === 'whatsnew') { closeSheet(); return whatsNew(true); }
      if (act === 'renameroot') return renameRootSheet();
      if (act === 'bugbtn') { PREF.bugBtn = PREF.bugBtn === false; savePref(); if (window.QNBug) QNBug.show(PREF.bugBtn); settingsSheet(); return; }
      if (act === 'fbinbox') { if (S.repliesSheet) S.repliesSheet(); return; }
      if (act === 'bugnow') { closeSheet(); if (window.QNBug) setTimeout(function () { QNBug.open(); }, 350); return; }
      if (act === 'signin') healthAction('signin');
      if (act === 'sync') { sync.run({ pull: true }); closeSheet(); }
      if (act === 'keep') location.href = 'import.html';
      if (act === 'notion') location.href = 'notion.html';
      if (act === 'update') { closeSheet(); checkUpdate(); }
      if (act === 'demoOffline') { Drive.setOffline(!Drive.isOffline()); sync.run({ pull: true }); settingsSheet(); }
      if (act === 'demoElsewhere') {
        closeSheet();
        var n = S.lastOpened && notes[S.lastOpened];
        if (!n || !n.fileId) { toast('Open a note that is already in Drive first.'); return; }
        Drive.editElsewhere(n.fileId);
        toast('“' + (n.title || 'That note') + '” was changed on the pretend laptop. Edit it here before syncing to see the warning.', null, null, 7000);
      }
    });
  }
  $('settingsBtn').onclick = function () { closeDrawer(); setTimeout(settingsSheet, 250); };
  Drive.beforeLeave = function () { if (S.canvas) S.canvas.flush(); saveNow(); };

  // ---------- What's new: a few illustrated slides, once after each update (and a short tour on first use) ----------
  var A = 'var(--accent)', Y = '#f2c94c', INKC = 'var(--ink)', MUT = 'var(--muted)', SOFT = 'var(--accent-soft)', SURF = 'var(--surface)', RULE = 'var(--rule)';
  function art(inner) { return '<svg viewBox="0 0 240 140" class="wn-art" aria-hidden="true">' + inner + '</svg>'; }
  var SLIDES = [
    { t: 'A brighter look', d: 'Warm paper, a coral accent and a sunny new-note button, in the colours of Motley, the studio behind Serendipity. The icon is now just the petals, with a pen nib at the centre.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><g transform="rotate(0 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#e8553d"/></g><g transform="rotate(45 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#f2b134"/></g><g transform="rotate(90 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#2a9d8f"/></g><g transform="rotate(135 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#3d5a98"/></g><g transform="rotate(180 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#ef8fa0"/></g><g transform="rotate(225 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#f2b134"/></g><g transform="rotate(270 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#2a9d8f"/></g><g transform="rotate(315 120 70)"><path d="M120 70 C 113 50, 113 35, 120 22 C 127 35, 127 50, 120 70 Z" fill="#3d5a98"/></g><circle cx="120" cy="70" r="15" fill="#1b1b1f"/><path d="M120 84 L112 70 C 112 64, 115 59, 120 57 C 125 59, 128 64, 128 70 Z" fill="#f4efe6"/><circle cx="120" cy="68" r="2" fill="#1b1b1f"/>') },
    { t: 'Hold a note, like in Keep', d: 'In the notes list, hold a note: it is picked, and a bar offers Pin, Labels, Move to folder, Make a copy, Combine and Delete. Tap other notes to pick them too. Hold a note and, without lifting, drag it to put it somewhere else in the list; it stays there on every device.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="36" y="28" width="70" height="40" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="36" y="76" width="70" height="36" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="114" y="28" width="70" height="40" rx="6" fill="none" stroke="' + RULE + '" stroke-dasharray="4 3"/>' +
        '<g transform="rotate(-4 160 90)"><rect x="124" y="66" width="74" height="44" rx="6" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/></g><circle cx="190" cy="68" r="7" fill="' + A + '"/>') },
    { t: 'Now called Serendipity', d: 'The delight of finding connections you were not looking for, as quick notes spread out, link up and become ideas. New icon too. Your notes stay exactly where they are; you can rename the Drive folder in Settings › Folders.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M80 82l30-28 32 15-17 36z M110 54l15 51" fill="none" stroke="' + A + '" stroke-width="3" stroke-linejoin="round"/>' +
        '<circle cx="80" cy="82" r="7" fill="' + A + '"/><circle cx="110" cy="54" r="7" fill="' + A + '"/><circle cx="125" cy="105" r="7" fill="' + A + '"/><circle cx="142" cy="69" r="10" fill="' + Y + '"/>' +
        '<circle cx="50" cy="40" r="3" fill="' + INKC + '" opacity=".4"/><circle cx="185" cy="38" r="3" fill="' + INKC + '" opacity=".4"/><circle cx="190" cy="104" r="3" fill="' + INKC + '" opacity=".4"/>') },
    { t: 'Shapes by holding, Distort, and styles everywhere', d: 'Draw a rough circle, box, triangle, star or line and keep the pen still at the end: it becomes a clean shape; keep holding and move to size or turn it. Select something and tap Distort: drag corners for perspective, the dots on the sides to skew. Lines now look right while you draw them (pencil, your own tips and lines). A tip can grow, or show more of itself, as you press harder. Your tips, lines and patterns are kept in Drive, so every device has them; rename or move the main folder in Settings.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><circle cx="62" cy="70" r="26" fill="none" stroke="' + INKC + '" stroke-width="3"/><path d="M110 46l40 6-6 52-44-10z" fill="none" stroke="' + A + '" stroke-width="3"/>' +
        '<path d="M190 44l7 15 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2z" fill="none" stroke="' + Y + '" stroke-width="2.5" stroke-linejoin="round"/>') },
    { t: 'Make your own pen tips, lines and patterns', d: 'Tap Pen again, then + Tip or + Line: draw a tip shape in the circle, or one stretch of a line between the marks, and every line you draw uses it. Tap Fill again, then + Pattern: draw one tile with any pen and colour, and fills use it, repeating seamlessly. Pick Edit to change one (Save changes it everywhere, Save as new keeps both). Notes carry a copy of the styles they use.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><defs><pattern id="wnp" patternUnits="userSpaceOnUse" width="12" height="12"><circle cx="4" cy="4" r="2" fill="' + A + '"/><circle cx="10" cy="9" r="1.3" fill="#c0392b"/></pattern></defs>' +
        '<circle cx="160" cy="70" r="36" fill="url(#wnp)"/><path d="M40 90l8-12 8 12 8-12 8 12 8-12 8 12" fill="none" stroke="' + INKC + '" stroke-width="2.5" stroke-linejoin="round"/><g fill="' + Y + '"><circle cx="44" cy="52" r="5"/><circle cx="60" cy="48" r="5"/><circle cx="76" cy="46" r="5"/><circle cx="92" cy="48" r="5"/><circle cx="108" cy="52" r="5"/></g>') },
    { t: 'Quick choices, and text you can draw on', d: 'Each tool now keeps its most-used choice in the bottom-left corner: pen size, Text art size and font (tap Aa), Whole or Slice for the eraser, Lasso or Tap for Select, Nudge or Smooth, Shape or Tap area for Fill. Tap a tool again for everything else. Select Text art and tap To outlines: each letter becomes pen lines you can erase, nudge, fill or redraw. Move is gone: Select and the Hand do it.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="30" y="56" width="28" height="60" rx="14" fill="' + SOFT + '" stroke="' + RULE + '"/><circle cx="44" cy="70" r="6" fill="' + INKC + '"/>' +
        '<text x="80" y="90" font-family="Lora, serif" font-size="44" fill="none" stroke="' + A + '" stroke-width="1.6">Abc</text>') },
    { t: 'Shapes, and notes that join and split', d: 'Select two or more things and tap Combine shapes: Join, Cut out, Overlap or Exclude. The parts stay whole: switch between them any time, or Release to get the parts back. In the notes list, hold a note to pick it, tap others, then Duplicate or Combine them into one note (side by side; Undo is there). In a note, select something and tap To new note to copy it, or extract it, into a note of its own.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><circle cx="80" cy="70" r="34" fill="' + A + '"/><circle cx="114" cy="70" r="34" fill="' + SURF + '"/>' +
        '<rect x="150" y="34" width="46" height="34" rx="5" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><rect x="160" y="74" width="46" height="34" rx="5" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/>') },
    { t: 'Serendipity, and images on the page', d: 'Quick Notes is now Serendipity: an endless page where ideas branch off. Your notes and Drive folder stay as they are. Images can now sit anywhere on the page: use the new Image button in the tools, move, resize and turn them with Select, and put them in front of or behind drawings. Select a text box holding images (Keep notes, for example) and tap Take images out to free them.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><g transform="rotate(-6 120 70)"><rect x="96" y="34" width="96" height="64" rx="6" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><path d="M102 92l24-24 18 18 12-12 30 18" fill="none" stroke="' + A + '" stroke-width="3"/></g>' +
        '<path d="M50 112c6-30 14-50 22-70" stroke="' + INKC + '" stroke-width="6" stroke-linecap="round" fill="none"/><path d="M62 74c12-8 22-8 32-18" stroke="' + INKC + '" stroke-width="5" stroke-linecap="round" fill="none"/><circle cx="94" cy="56" r="7" fill="' + Y + '"/>') },
    { t: 'Select, line up, and collectives', d: 'The Lasso is now Select. In its card you can choose Lasso or Tap to pick (tap things to add them, tap again to take them out), and whether it picks from all layers, this layer or this group. Arrange lines things up, spreads them evenly, and brings them forward or sends them back. Collective ties things from different layers together, text included, so they move, turn and fade as one. To Text art and To text box switch text between the two kinds.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="50" y="30" width="140" height="70" rx="6" fill="none" stroke="' + A + '" stroke-width="2" stroke-dasharray="6 4"/>' +
        '<path d="M60 40v50" stroke="' + A + '" stroke-width="3"/><rect x="62" y="42" width="60" height="12" rx="3" fill="' + INKC + '" opacity=".7"/><rect x="62" y="60" width="96" height="12" rx="3" fill="#c0392b" opacity=".7"/><rect x="62" y="78" width="40" height="12" rx="3" fill="' + Y + '" opacity=".8"/>') },
    { t: 'Text art, and text that stays straight', d: 'The new Text art tool (A in the tools) writes text that is part of your drawing: in a layer, in front of or behind drawings, with fonts, size, colour and opacity, and you can lasso it to move, turn or recolour. On a turned page, new text starts straight to you, then turns with the page. Lasso it and tap Straighten to line it up with the page again. The Lasso now picks what is partly, mostly or fully inside its loop.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M36 92c30-30 60 10 90-6s50-20 80 0" fill="none" stroke="' + A + '" stroke-width="10" stroke-linecap="round" stroke-opacity=".45"/>' +
        '<text x="48" y="84" font-family="Permanent Marker, cursive" font-size="34" fill="#c0392b" transform="rotate(-6 120 70)">Art!</text><text x="140" y="56" font-family="Lora, serif" font-size="20" fill="' + INKC + '">Aa</text>') },
    { t: 'Fonts, pressure and a smarter lasso', d: 'Text now comes in six fonts (the F button while typing). The Lasso picks up text along with drawings. Under Pen: how pressure and tilt change thickness and opacity, a pressure curve, and Check my pen to see what your pen reports.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><text x="40" y="58" font-family="Caveat, cursive" font-size="30" fill="' + INKC + '">Aa</text><text x="96" y="58" font-family="Lora, serif" font-size="26" fill="' + INKC + '">Aa</text><text x="150" y="58" font-family="Permanent Marker, cursive" font-size="24" fill="' + INKC + '">Aa</text>' +
        '<path d="M40 96c30-14 60 14 90 0s40-10 60 0" fill="none" stroke="' + A + '" stroke-width="6" stroke-linecap="round" stroke-opacity=".55"/>') },
    { t: 'Tools at the side', d: 'The drawing tools are now a slim floating column at the side of the page. Tap a tool to use it; tap it again for its settings, in a small card beside it. ⇄ in the card moves the tools to the other side.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="184" y="24" width="24" height="92" rx="12" fill="' + SOFT + '" stroke="' + RULE + '"/>' +
        '<circle cx="196" cy="40" r="7" fill="' + A + '"/><circle cx="196" cy="60" r="4" fill="' + MUT + '"/><circle cx="196" cy="78" r="4" fill="' + MUT + '"/><circle cx="196" cy="96" r="4" fill="' + MUT + '"/>' +
        '<rect x="104" y="28" width="72" height="50" rx="10" fill="' + SURF + '" stroke="' + A + '"/><path d="M114 44h40M114 56h52M114 68h30" stroke="' + MUT + '" stroke-width="4" stroke-linecap="round"/>') },
    { t: 'Drawing keeps up with your pen', d: 'Strokes now appear as fast as you write, and erasing no longer stalls on big drawings. A new Smoothing slider under Pen steadies shaky lines.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M44 92c18-40 34-46 50-20s30 22 46-6 32-30 56 0" fill="none" stroke="' + INKC + '" stroke-width="4" stroke-linecap="round"/>' +
        '<path d="M190 60l12-12 6 6-12 12z" fill="' + A + '"/><path d="M48 108h60" stroke="' + A + '" stroke-width="4" stroke-linecap="round"/><circle cx="84" cy="108" r="7" fill="' + SURF + '" stroke="' + A + '" stroke-width="3"/>') },
    { t: 'Layers, like Affinity', d: 'Tap a layer to draw on it; tap it again for its settings. Hold a layer to pick several, then group, hide, merge or delete them. Hold and drag to move a layer, into a group or out of one. Text belongs to a layer too: it hides, locks and fades with it.',
      a: art('<rect x="60" y="14" width="120" height="112" rx="16" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="72" y="28" width="96" height="30" rx="8" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><rect x="72" y="66" width="96" height="30" rx="8" fill="' + SURF + '" stroke="' + RULE + '"/>' +
        '<rect x="78" y="33" width="30" height="20" rx="4" fill="' + SURF + '"/><path d="M82 48c6-8 10 2 16-6" stroke="' + INKC + '" stroke-width="2" fill="none"/><rect x="78" y="71" width="30" height="20" rx="4" fill="' + SOFT + '"/>') },
    { t: 'Double-tap to write, pen size at hand', d: 'Double-tap anywhere on the page with a finger to start typing there; the pen just writes. The pen size slider now sits on the page while you write. Under Pen › Finger, choose whether your finger draws or moves the page.',
      a: art('<rect x="40" y="18" width="160" height="104" rx="16" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M70 90c14-26 30-26 44-6" fill="none" stroke="' + INKC + '" stroke-width="4" stroke-linecap="round"/><circle cx="150" cy="70" r="16" fill="' + A + '" opacity=".3"/><circle cx="150" cy="70" r="7" fill="' + A + '"/>') },
    { t: 'Send feedback', d: 'The round button now sits in the top bar. Touch it and it takes a picture of the app that instant, menus and all. Draw on it with pen or finger, add notes with Text, and tap the button again to send. Two fingers tap to undo, three to redo.',
      a: art('<rect x="60" y="12" width="120" height="116" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="74" y="28" width="92" height="10" rx="5" fill="' + MUT + '" opacity=".35"/><rect x="74" y="46" width="70" height="10" rx="5" fill="' + MUT + '" opacity=".35"/>' +
        '<ellipse cx="128" cy="86" rx="30" ry="18" fill="none" stroke="#d93025" stroke-width="4"/><circle cx="54" cy="96" r="18" fill="' + A + '"/><path d="M45 89h18v11h-11l-5 4z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>') },
    { t: 'An endless page', d: 'Every note is now an endless page. Pinch to zoom, move with two fingers, twist to turn it. Tap with two fingers to undo, three to redo. The zoom button has Fit everything, Zoom into an area and a Navigator map.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><g transform="rotate(-8 120 70)"><rect x="70" y="34" width="100" height="72" rx="8" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><path d="M84 84c10-14 20 6 30-4s16-10 24 0" fill="none" stroke="' + INKC + '" stroke-width="3.5" stroke-linecap="round"/></g>' +
        '<circle cx="54" cy="104" r="9" fill="' + A + '" opacity=".35"/><circle cx="186" cy="38" r="9" fill="' + A + '" opacity=".35"/><path d="M60 98l14-12M180 44l-14 12" stroke="' + A + '" stroke-width="3" stroke-linecap="round"/>') },
    { t: 'Sign in once, stay signed in', d: 'Serendipity now keeps you signed in. The cloud at the top shows a tick when every note is in your Google Drive, and only asks for you when something needs you.',
      a: art('<rect x="40" y="18" width="160" height="104" rx="16" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M92 86h52a16 16 0 002.4-31.8A24 24 0 0099 48.6 19 19 0 0092 86z" fill="' + SOFT + '" stroke="' + A + '" stroke-width="3"/><path d="M105 67l9 9 17-18" fill="none" stroke="' + A + '" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>') },
    { t: 'A real sketchbook', d: 'Tap the pen at the top of a note. Pick a tool in the first row; its settings appear right under it: five pens, any colour, size and opacity.',
      a: art('<rect x="20" y="16" width="200" height="30" rx="10" fill="' + SURF + '" stroke="' + RULE + '"/>' + [0, 1, 2, 3, 4, 5].map(function (i) { return '<circle cx="' + (42 + i * 31) + '" cy="31" r="7" fill="' + (i === 1 ? A : MUT) + '" opacity="' + (i === 1 ? 1 : .35) + '"/>'; }).join('') +
        '<rect x="20" y="52" width="200" height="24" rx="8" fill="' + SOFT + '"/>' + ['ink', '#c0392b', Y, '#2f855a', '#2b6cb0', '#7e57c2'].map(function (c, i) { return '<circle cx="' + (38 + i * 22) + '" cy="64" r="7" fill="' + (c === 'ink' ? INKC : c) + '"/>'; }).join('') +
        '<path d="M30 110c20-22 34 8 52-6s26-18 40 0 30 12 44-4 26-10 44 2" fill="none" stroke="' + INKC + '" stroke-width="4" stroke-linecap="round"/><path d="M34 124h170" stroke="' + Y + '" stroke-width="10" stroke-linecap="round" opacity=".55"/>') },
    { t: 'Erase, lasso, nudge', d: 'Erase whole strokes or slice through them. Circle strokes with the lasso to move, resize, rotate, duplicate or group them. Nudge and Smooth reshape lines within a reach you choose.',
      a: art('<path d="M30 60c30-30 60 20 90 0s60-20 90 10" fill="none" stroke="' + INKC + '" stroke-width="5" stroke-linecap="round"/><circle cx="118" cy="59" r="16" fill="none" stroke="' + MUT + '" stroke-dasharray="4 4"/>' +
        '<ellipse cx="120" cy="104" rx="70" ry="24" fill="none" stroke="' + A + '" stroke-width="2.5" stroke-dasharray="7 5"/><path d="M80 104c12-12 26 8 40-2s22-8 34 2" fill="none" stroke="' + INKC + '" stroke-width="4" stroke-linecap="round"/>') },
    { t: 'Fill and layers', d: 'Tap inside a closed shape to fill it; the colour tucks under your lines. Work in layers with opacity, blend modes, hiding, locking and masking.',
      a: art('<rect x="44" y="40" width="100" height="78" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="62" y="28" width="100" height="78" rx="6" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="80" y="16" width="100" height="78" rx="6" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/>' +
        '<path d="M100 40h60l-8 40h-46z" fill="' + Y + '" stroke="' + INKC + '" stroke-width="3" stroke-linejoin="round"/>') },
    { t: 'Folders and labels in the menu', d: 'Tap ☰ for your folders and labels. Choose a default folder for new notes, and pick what the app opens to in Settings: all notes, the default folder, or where you left off.',
      a: art('<rect x="30" y="14" width="96" height="112" rx="12" fill="' + SURF + '" stroke="' + RULE + '"/>' + [0, 1, 2, 3].map(function (i) { return '<rect x="42" y="' + (30 + i * 22) + '" width="14" height="11" rx="3" fill="' + A + '" opacity="' + (i === 1 ? 1 : .45) + '"/><rect x="62" y="' + (32 + i * 22) + '" width="' + [48, 38, 52, 30][i] + '" height="7" rx="3.5" fill="' + MUT + '" opacity=".5"/>'; }).join('') +
        '<rect x="136" y="30" width="76" height="40" rx="10" fill="' + SOFT + '"/><rect x="136" y="78" width="76" height="40" rx="10" fill="' + SOFT + '"/>') },
    { t: 'Back works like an app', d: 'The back button steps back through the folders and labels you visited. On the first screen, press back twice to leave.',
      a: art('<rect x="70" y="14" width="100" height="112" rx="16" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M128 56l-18 14 18 14" fill="none" stroke="' + A + '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><rect x="88" y="100" width="64" height="12" rx="6" fill="' + MUT + '" opacity=".35"/>') }
  ];
  function whatsNew(force) {
    var seen = PREF.seenVersion;
    if (!force && seen === CFG.VERSION) return;
    var first = !seen && !Drive.signedInBefore() && !live().length;
    var i = 0, el = $('whatsNew');
    function draw(dir) {
      var sl = SLIDES[i];
      el.innerHTML = '<div class="wn-card" role="dialog" aria-modal="true" aria-label="What’s new">' +
        '<div class="wn-top">' + (i === 0 ? '<span class="wn-kicker">' + (first ? 'Welcome to Serendipity' : 'What’s new in ' + esc(CFG.VERSION)) + '</span>' : '<span class="wn-kicker">' + (i + 1) + ' of ' + SLIDES.length + '</span>') +
        '<button type="button" class="wn-skip" data-wn="done">Skip</button></div>' +
        '<div class="wn-slide ' + (dir || '') + '">' + sl.a + '<h2>' + esc(sl.t) + '</h2><p>' + esc(sl.d) + '</p></div>' +
        '<div class="wn-foot"><div class="wn-dots">' + SLIDES.map(function (x, k) { return '<i' + (k === i ? ' class="on"' : '') + '></i>'; }).join('') + '</div>' +
        (i > 0 ? '<button type="button" data-wn="prev">Back</button>' : '') +
        '<button type="button" class="primary" data-wn="' + (i === SLIDES.length - 1 ? 'done' : 'next') + '">' + (i === SLIDES.length - 1 ? 'Start writing' : 'Next') + '</button></div></div>';
    }
    function close() { el.classList.add('hidden'); el.innerHTML = ''; PREF.seenVersion = CFG.VERSION; savePref(); }
    S.closeWhatsNew = close; S.sheetState = history.state;
    el.onclick = function (e) {
      var b = e.target.closest('[data-wn]');
      if (!b) { if (e.target === el) close(); return; }
      if (b.dataset.wn === 'done') return close();
      if (b.dataset.wn === 'next' && i < SLIDES.length - 1) { i++; draw('from-right'); }
      if (b.dataset.wn === 'prev' && i > 0) { i--; draw('from-left'); }
    };
    var sx = null;
    el.onpointerdown = function (e) { sx = e.clientX; };
    el.onpointerup = function (e) {
      if (sx == null) return; var dx = e.clientX - sx; sx = null;
      if (dx < -50 && i < SLIDES.length - 1) { i++; draw('from-right'); }
      if (dx > 50 && i > 0) { i--; draw('from-left'); }
    };
    draw(); el.classList.remove('hidden');
  }

  // ---------- Feedback: saved as notes in "Feedback" (or an older "Bug reports"), with the annotated picture and the details ----------
  if (window.QNBug) {
    QNBug.context = function () {
      var v = S.canvas && S.canvas.viewOps ? S.canvas.viewOps.info() : null, st = sync.status();
      return {
        'On screen': S.view === 'note' ? 'a note' + (S.cur && S.cur.title ? ' (“' + S.cur.title + '”)' : '') : 'notes list',
        'Folder': S.folder ? pathOf(S.folder).map(function (f) { return f.name; }).join(' / ') : 'All notes',
        'Label': S.label || '', 'Search': S.q || '',
        'Tool': S.view === 'note' ? PREF.tool + (PREF.tool === 'pen' ? ' (' + INKOPT.pen.b + ')' : '') + (PREF.showTools ? '' : ', tools hidden') : '',
        'View': v ? Math.round(v.z * 100) + '% zoom, turned ' + Math.round(v.r * 180 / Math.PI) + '°' : '',
        'Note': S.cur ? S.cur.id + ', ' + (S.cur.boxes || []).length + ' text boxes, ' + (N.hasInk(S.cur) ? 'has drawing' : 'no drawing') : '',
        'Sync': health(st).text,
        'Sign-in': Drive.demo ? 'demo' : Drive.lasting && Drive.lasting() ? 'lasting' : Drive.signedIn() ? 'one hour' : 'signed out',
        'Notes on phone': live().length + (st.waiting.length ? ', ' + st.waiting.length + ' waiting' : '')
      };
    };
    async function saveFeedbackInDrive(r) {
      var md = r.text || '(no description)';
      var kindName = { problem: 'Problem', idea: 'Idea', question: 'Question' }[r.kind] || 'Feedback';
      var title = kindName + ': ' + md.split(/\s+/).slice(0, 7).join(' ').replace(/[\n#]/g, ' ').slice(0, 60);
      var img = '';
      if (r.png && navigator.onLine && Drive.signedIn()) {
        try {
          var name = 'feedback-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + N.shortId() + '.png';
          var made = await Drive.upload(name, await attachmentsFolder(), r.png, 'image/png');
          var map = await attachments(); map[name] = made.id; imgCache[name] = URL.createObjectURL(r.png);
          img = '![](Attachments/' + encodeURIComponent(name) + ')';
        } catch (e) { img = ''; }
      }
      if (!img && r.small) img = '![](' + r.small + ')';
      var body = md + (img ? '\n\n' + img : '') + '\n\n### Details\n\n```\n' + r.details + '\n```';
      // The "Feedback" folder (made the first time, when online). Feedback saved before 3.4 went to "Bug reports"; keep using it.
      var folder = null, fname = 'Feedback', t = tree();
      ['Bug reports', 'Feedback'].forEach(function (nm) { Object.keys(t).forEach(function (k) { if (t[k].name === nm && t[k].parentId === rootId()) { folder = k; fname = nm; } }); });
      if (!folder && navigator.onLine && Drive.signedIn() && rootId()) { try { folder = await sync.createFolder('Feedback', rootId()); } catch (e) {} }
      var n = newDraft(title, body);
      n.labels = ['feedback']; n.folderId = folder || null;
      touchNote(n); store.put(n); sync.schedule(1500); renderStatus();
      if (S.view === 'list') renderList();
      return fname;
    }

    // ---- Feedback to the developer: sent through the sign-in helper into a private GitHub repository, and the
    // developer's replies shown here. Each install has a random ID it keeps to itself. ----
    function feedbackId() {
      var id = null; try { id = localStorage.getItem('qn-iid'); } catch (e) {}
      if (!id) {
        var a = crypto.getRandomValues(new Uint8Array(16));
        id = Array.from(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        try { localStorage.setItem('qn-iid', id); } catch (e) {}
      }
      return id;
    }
    function fbGet(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } }
    function fbPut(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
    async function fbPost(path, data) {
      if (!CFG.TOKEN_SERVER || Drive.demo) { var e0 = new Error('no_server'); e0.code = 'no_server'; throw e0; }
      var res = await fetch(CFG.TOKEN_SERVER + '/feedback/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ iid: feedbackId() }, data)) });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) { var e = new Error(j.error_description || j.error || ('HTTP ' + res.status)); e.code = res.status === 404 || res.status === 501 ? 'no_server' : j.error; throw e; }
      return j;
    }
    function blobB64(blob) {
      return new Promise(function (ok, bad) { var fr = new FileReader(); fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); }; fr.onerror = bad; fr.readAsDataURL(blob); });
    }
    function fbTitle(r) {
      var md = String(r.text || '').trim();
      return md ? md.split(/\s+/).slice(0, 9).join(' ').replace(/[\n#]/g, ' ').slice(0, 80) : 'Feedback (a drawing)';
    }
    async function sendFeedback(item) {
      var res = await fbPost('send', item);
      var list = fbGet('qn-fb'); list.push({ issue: res.issue, title: item.title, at: new Date().toISOString(), seen: 0 }); fbPut('qn-fb', list);
      return res.issue;
    }
    // Feedback that couldn't go out (offline) waits here, with a smaller picture, and goes with the next chance.
    async function flushFeedback() {
      var out = fbGet('qn-fb-out'); if (!out.length || !navigator.onLine) return;
      var left = [];
      for (var i = 0; i < out.length; i++) { try { await sendFeedback(out[i]); } catch (e) { if (e.code !== 'no_server') left.push(out[i]); } }
      fbPut('qn-fb-out', left);
    }
    QNBug.save = async function (r) {
      var item = { title: fbTitle(r), text: r.text || '', details: r.details };
      try {
        if (r.png && r.png.size < 4000000) { item.image = await blobB64(r.png); item.imageType = 'png'; }
        else if (r.small) { item.image = r.small.split(',')[1]; item.imageType = 'jpeg'; }
        await sendFeedback(item); fbChecked = 0;
        toast('Sent to the developer. Replies will show up here.', null, null, 4000);
        return;
      } catch (e) {
        if (e.code !== 'no_server') { // offline or a hiccup: send it later, and keep a copy in Drive meanwhile
          if (r.small) item.image = r.small.split(',')[1], item.imageType = 'jpeg'; else delete item.image;
          var out = fbGet('qn-fb-out'); out.push(item); fbPut('qn-fb-out', out.slice(-5));
        }
        var fname = await saveFeedbackInDrive(r);
        toast(e.code === 'no_server' ? 'Saved in your “' + fname + '” folder.' : 'Couldn’t send it yet; it will go when you’re online. A copy is in “' + fname + '”.', null, null, 4500);
      }
    };
    // Replies: checked when the app opens and comes back to the front (at most every few minutes).
    var fbChecked = 0;
    async function checkReplies(force) {
      var list = fbGet('qn-fb'); if (!list.length || !navigator.onLine || Drive.demo) return null;
      if (!force && Date.now() - fbChecked < 4 * 60 * 1000) return S.fbConvos || null;
      fbChecked = Date.now();
      var res; try { res = await fbPost('inbox', { issues: list.map(function (x) { return x.issue; }) }); } catch (e) { return null; }
      var unread = 0;
      (res.conversations || []).forEach(function (c) {
        var rec = list.filter(function (x) { return x.issue === c.issue; })[0] || {};
        var dev = c.messages.filter(function (m) { return m.from === 'dev'; }).length;
        c.unread = Math.max(0, dev - (rec.seen || 0)) + (c.state === 'closed' && !rec.closedSeen ? 1 : 0);
        unread += c.unread;
      });
      S.fbConvos = res.conversations || [];
      QNBug.badge(unread > 0);
      if (unread && !force) toast(unread === 1 ? 'The developer answered your feedback' : 'The developer answered your feedback (' + unread + ')', 'Read', function () { repliesSheet(); }, 9000);
      return S.fbConvos;
    }
    function msgHtml(m) { return '<div class="fbm ' + (m.from === 'me' ? 'me' : 'dev') + '">' + esc(m.text).replace(/\n/g, '<br>') + '<small>' + (m.from === 'me' ? 'You' : 'Developer') + ' · ' + new Date(m.at).toLocaleDateString() + '</small></div>'; }
    async function repliesSheet() {
      openSheet('<h2>Your feedback</h2><p class="where">Loading…</p><div class="row"><button type="button" data-act="close">Close</button></div>');
      var convos = await checkReplies(true);
      var list = fbGet('qn-fb');
      if (!list.length) { openSheet('<h2>Your feedback</h2><p>Nothing sent yet. Touch the round feedback button at the side of the screen to point at a problem or an idea.</p><div class="row"><button type="button" data-act="close">Close</button></div>'); return; }
      if (!convos) { openSheet('<h2>Your feedback</h2><p>Couldn’t reach the developer’s inbox. Try again when you’re online.</p><div class="row"><button type="button" data-act="close">Close</button></div>'); return; }
      var html = '<h2>Your feedback</h2>' + convos.slice().reverse().map(function (c) {
        return '<div class="fbc' + (c.unread ? ' new' : '') + '"><div class="fbh"><b>' + esc(c.title) + '</b><small>' + new Date(c.at).toLocaleDateString() + ' · ' + (c.state === 'closed' ? 'Resolved' : 'Open') + '</small></div>' +
          (c.messages.length ? c.messages.map(msgHtml).join('') : '<p class="where" style="margin:6px 0">No reply yet.</p>') +
          '<div class="fbr"><textarea data-fbr="' + c.issue + '" rows="1" placeholder="Reply"></textarea><button type="button" data-act="fbsend" data-i="' + c.issue + '">Send</button></div></div>';
      }).join('') + '<div class="row"><button type="button" data-act="close">Close</button></div>';
      openSheet(html, async function (act, b) {
        if (act !== 'fbsend') return;
        var ta = $('sheet').querySelector('[data-fbr="' + b.dataset.i + '"]'), text = ta.value.trim(); if (!text) return ta.focus();
        b.disabled = true; b.textContent = 'Sending…';
        try { await fbPost('reply', { issue: +b.dataset.i, text: text }); repliesSheet(); }
        catch (e) { b.disabled = false; b.textContent = 'Send'; toast('Couldn’t send: ' + e.message, null, null, 4000); }
      });
      // Everything shown counts as read.
      list.forEach(function (rec) {
        var c = convos.filter(function (x) { return x.issue === rec.issue; })[0]; if (!c) return;
        rec.seen = c.messages.filter(function (m) { return m.from === 'dev'; }).length; if (c.state === 'closed') rec.closedSeen = true;
      });
      fbPut('qn-fb', list); QNBug.badge(false);
    }
    S.repliesSheet = repliesSheet;
    setTimeout(function () { flushFeedback().then(function () { checkReplies(); }); }, 6000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkReplies(); });
    window.addEventListener('online', function () { flushFeedback().then(function () { checkReplies(); }); });
    QNBug.show(PREF.bugBtn !== false); dockFeedback();
  }

  // ---------- Start: the notes grid ----------
  (async function start() {
    var saved = await store.load();
    saved.forEach(function (n) { notes[n.id] = n; });
    S.folder = startFolder();
    try { history.replaceState({ v: 'exit' }, ''); history.pushState(navState(), ''); } catch (e) {}
    showList();

    // Android "Share to Serendipity": arrives as ?title=…&text=…&url=…
    var p = new URLSearchParams(location.search);
    if (p.has('text') || p.has('url') || p.has('title')) {
      var url = p.get('url') || '', text = p.get('text') || '';
      if (url && text.indexOf(url) < 0) text = (text ? text + '\n\n' : '') + url;
      try { history.replaceState(navState(), '', location.pathname); } catch (e) {}
      var shared = newDraft(p.get('title') || '', text);
      openNote(shared); touchNote(shared);
    }

    if (Drive.demo) await Drive.signIn();
    await Drive.ready; // back from Google's sign-in page: finish signing in first
    var err = Drive.takeSignInError && Drive.takeSignInError();
    if (err) toast(err);
    // Ask the phone to keep this app's data even when storage runs low.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    renderStatus();
    sync.run({ pull: true });
    setTimeout(function () { if (S.view === 'list') whatsNew(false); }, 700);
  })();
})();
