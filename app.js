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
      if (N.hasInk(n)) inner += window.QNInk.thumb(n.ink, 320, 170);
    }
    var foot = (n.labels || []).map(function (l) { return '<span class="chip">' + esc(l) + '</span>'; });
    if (n.conflict) foot.push('<span class="flag">Changed elsewhere</span>');
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
          '<div class="nm" data-open="' + esc(f.id) + '">' + icon('folder') + '<span>' + esc(f.name) + '</span>' + (defaultFolder() === f.id ? '<em class="dflt">default</em>' : '') + '<small>' + countIn(f.id) + '</small></div>' +
          '<button class="more" type="button" data-fmore="' + esc(f.id) + '" aria-label="Folder options">' + icon('more') + '</button></div>';
        if (kids && open) rows(f.id, depth + 1);
      });
    }
    if (root) rows(root, 0);
    else html += '<p class="where" style="padding:8px">Folders appear after the first sync with Google Drive.</p>';
    $('tree').innerHTML = html;
    var labels = allLabels();
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
  if ($('importBtn')) $('importBtn').onclick = function () {
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
    showFmt(false); closeMenu(); closeViewMenu(); $('pop').classList.add('hidden');
    sync.run();
  }
  function showList() {
    S.view = 'list';
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
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); S.canvas.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); S.canvas.redo(); }
  });

  // ---------- Tools: type, pen (five brushes), erase, lasso, nudge, fill, move text; layers ----------
  var SWATCH = ['ink', '#5f6368', '#c0392b', '#d9822b', '#f2c94c', '#2f855a', '#00796b', '#2b6cb0', '#7e57c2', '#e91e63', '#ffffff'];
  var INKOPT = { pen: { b: 'pen', c: 'ink', s: 3, o: 1 }, erase: { m: 'stroke', s: 14 }, nudge: { m: 'nudge', r: 48, k: 0.8 }, fill: { m: 'tap', c: '#f2c94c', o: 1 } };
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
      html = G(Object.keys(window.QNInk.BRUSH).map(function (k) { return chip(window.QNInk.BRUSH[k].label, 'data-brush="' + k + '"', o.pen.b === k); }).join('')) +
        G(swatches(o.pen.c, 'pen')) + G(slider('Size', 'pen', 's', 1, 24, o.pen.s) + slider('Opacity', 'pen', 'o', 5, 100, o.pen.o, 100));
    } else if (t === 'erase') {
      html = G(chip('Whole stroke', 'data-k="erase" data-m="stroke"', o.erase.m === 'stroke') + chip('Slice', 'data-k="erase" data-m="slice"', o.erase.m === 'slice') +
        slider('Size', 'erase', 's', 3, 60, o.erase.s));
    } else if (t === 'lasso') {
      html = G(HINT('Circle strokes to select, or tap one. Drag to move, corner to resize, knob to rotate.'));
    } else if (t === 'nudge') {
      html = G(chip('Nudge', 'data-k="nudge" data-m="nudge"', o.nudge.m === 'nudge') + chip('Smooth', 'data-k="nudge" data-m="smooth"', o.nudge.m === 'smooth')) +
        G(slider('Reach', 'nudge', 'r', 10, 160, o.nudge.r) + slider('Strength', 'nudge', 'k', 5, 100, o.nudge.k, 100));
    } else if (t === 'fill') {
      html = G(chip('Tap an area', 'data-k="fill" data-m="tap"', o.fill.m === 'tap') + chip('Draw a shape', 'data-k="fill" data-m="lasso"', o.fill.m === 'lasso')) +
        G(swatches(o.fill.c, 'fill')) + G(slider('Opacity', 'fill', 'o', 5, 100, o.fill.o, 100));
    } else if (t === 'select') html = G(HINT('Drag text boxes by their dots to move them; drag the bar on the right to change the width.'));
    $('penOpts').innerHTML = html;
  }
  // The drawing tools live behind one button, so a note opens as a plain page, like Keep.
  function showTools(on) {
    PREF.showTools = !!on; savePref();
    $('tools').classList.toggle('hidden', !on);
    $('toolsBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on && PREF.tool !== 'type') setTool('type');
    if (!on) $('layersPanel').classList.add('hidden');
    if (S.canvas) requestAnimationFrame(S.canvas.relayout);
  }
  $('toolsBtn').onclick = function () { showTools(!PREF.showTools); };
  function savePref() { try { localStorage.setItem('qn-pen', JSON.stringify(PREF)); } catch (e) {} }
  setTimeout(function () { showTools(PREF.showTools); }, 0);
  $('tools').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) return setTool(b.dataset.tool);
    if (b.dataset.act === 'layers') return toggleLayers();
    if (b.dataset.brush) { INKOPT.pen.b = b.dataset.brush; if (b.dataset.brush === 'highlighter' && INKOPT.pen.c === 'ink') INKOPT.pen.c = '#f2c94c'; return setTool('pen'); }
    if (b.dataset.m) { INKOPT[b.dataset.k].m = b.dataset.m; return setTool(PREF.tool); }
    if (b.dataset.sw) { INKOPT[b.dataset.sw].c = b.dataset.c; return setTool(PREF.tool); }
  });
  $('tools').addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset.cc) { INKOPT[t.dataset.cc].c = t.value; applyInk(); savePref(); return; }
    if (t.dataset.k) { INKOPT[t.dataset.k][t.dataset.f] = +t.value / +t.dataset.scale; applyInk(); savePref(); }
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
  function toggleLayers() { var p = $('layersPanel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) renderLayers(); }
  function renderLayers() {
    var p = $('layersPanel');
    if (!S.canvas || p.classList.contains('hidden')) return;
    p.style.top = Math.round($('tools').getBoundingClientRect().bottom + 6) + 'px';
    var eng = S.canvas.ink(), list = eng.layers(), blends = window.QNInk.BLENDS;
    p.innerHTML = '<div class="lhead"><b>Layers</b><button type="button" data-lo="add">+ Add</button><button type="button" class="icon" data-lo="close" aria-label="Close">✕</button></div>' +
      list.map(function (l, i) {
        var row = '<div class="lrow' + (l.active ? ' on' : '') + '" data-id="' + l.id + '">' +
          '<button type="button" class="icon" data-lo="vis" aria-label="' + (l.vis ? 'Hide' : 'Show') + '" title="' + (l.vis ? 'Hide' : 'Show') + '">' + (l.vis ? '◉' : '○') + '</button>' +
          '<span class="lname" data-lo="active">' + esc(l.name) + ' <small>' + l.n + (l.clip ? ' · clipped' : '') + '</small></span>' +
          '<button type="button" class="icon" data-lo="lock" aria-label="' + (l.lock ? 'Unlock' : 'Lock') + '" title="' + (l.lock ? 'Unlock' : 'Lock') + '">' + (l.lock ? '🔒' : '🔓') + '</button></div>';
        if (l.active) row += '<div class="lmore" data-id="' + l.id + '">' +
          '<label class="oslider">Opacity <input type="range" min="0" max="100" value="' + Math.round(l.op * 100) + '" data-lop></label>' +
          '<label class="oslider">Blend <select data-lblend>' + blends.map(function (b) { return '<option' + (b === l.blend ? ' selected' : '') + '>' + b + '</option>'; }).join('') + '</select></label>' +
          '<label class="oslider"><input type="checkbox" data-lclip' + (l.clip ? ' checked' : '') + (i === list.length - 1 ? ' disabled' : '') + '> Mask with layer below</label>' +
          '<div class="lbtns"><button type="button" data-lo="up"' + (i === 0 ? ' disabled' : '') + '>Up</button><button type="button" data-lo="down"' + (i === list.length - 1 ? ' disabled' : '') + '>Down</button>' +
          '<button type="button" data-lo="dup">Duplicate</button><button type="button" data-lo="merge"' + (i === list.length - 1 ? ' disabled' : '') + '>Merge down</button>' +
          '<button type="button" data-lo="rename">Rename</button><button type="button" data-lo="delete" class="danger">Delete</button></div></div>';
        return row;
      }).join('') + '<p class="where" style="margin:8px 4px 2px">New drawing goes into the highlighted layer.</p>';
  }
  $('layersPanel').addEventListener('click', function (e) {
    var b = e.target.closest('[data-lo]'); if (!b || !S.canvas) return;
    var op = b.dataset.lo, row = b.closest('[data-id]'), id = row && row.dataset.id, eng = S.canvas.ink();
    if (op === 'close') { $('layersPanel').classList.add('hidden'); return; }
    if (op === 'add') { eng.layerOp('add', eng.layers().filter(function (l) { return l.active; })[0].id); return renderLayers(); }
    if (op === 'rename') {
      var cur = eng.layers().filter(function (l) { return l.id === id; })[0];
      openSheet('<form><h2>Rename layer</h2><input type="text" name="nm" value="' + esc(cur.name) + '" maxlength="40" required><div class="row"><button class="primary" type="submit">Rename</button><button type="button" data-act="close">Cancel</button></div></form>',
        null, function (ev) { eng.layerOp('name', id, ev.target.nm.value); closeSheet(); renderLayers(); });
      return;
    }
    if (op === 'delete' && eng.layers().filter(function (l) { return l.id === id; })[0].n && !confirmLayerDelete(id)) return;
    eng.layerOp(op, id); renderLayers();
  });
  function confirmLayerDelete(id) {
    var eng = S.canvas.ink();
    openSheet('<h2>Delete this layer?</h2><p>Everything drawn on it goes too. Undo brings it back.</p><div class="row"><button class="primary danger" type="button" data-act="del">Delete layer</button><button type="button" data-act="close">Cancel</button></div>',
      function (act) { if (act === 'del') { eng.layerOp('delete', id); closeSheet(); renderLayers(); } });
    return false;
  }
  $('layersPanel').addEventListener('input', function (e) {
    var row = e.target.closest('[data-id]'); if (!row || !S.canvas) return;
    if (e.target.dataset.lop != null) S.canvas.ink().layerOp('op', row.dataset.id, +e.target.value / 100);
  });
  $('layersPanel').addEventListener('change', function (e) {
    var row = e.target.closest('[data-id]'); if (!row || !S.canvas) return;
    var eng = S.canvas.ink(), id = row.dataset.id;
    if (e.target.dataset.lop != null) eng.layerOp('opdone', id, +e.target.value / 100);
    if (e.target.dataset.lblend != null) eng.layerOp('blend', id, e.target.value);
    if (e.target.dataset.lclip != null) eng.layerOp('clip', id);
    renderLayers();
  });

  // ---------- Formatting bar ----------
  function showFmt(on) {
    $('fmtBar').classList.toggle('hidden', !on);
    $('menuFab').classList.toggle('lift', on); $('noteMenu').classList.toggle('lift', on);
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
        '<p style="margin-top:12px !important">When the app opens, show:</p><div class="pick" style="margin:0">' +
        [['all', 'All notes'], ['default', 'The default folder'], ['last', 'The folder I was last in'], ['lastnote', 'The folder of the note I last edited']].map(function (o) {
          return '<button type="button" data-act="start" data-v="' + o[0] + '" aria-pressed="' + ((PREF.start || 'all') === o[0]) + '">' + (((PREF.start || 'all') === o[0]) ? '◉ ' : '○ ') + o[1] + '</button>';
        }).join('') + '</div><p style="margin-top:8px !important">Rename, move or delete a folder from its ••• in the side menu.</p></div>' +
      '<div class="set"><b>Copy notes in</b><p>A one-time copy from another app. Not a sync: the other app stays as it is.</p>' +
        '<button type="button" data-act="keep">From Google Keep</button> <button type="button" data-act="notion">From Notion</button></div>' +
      '<div class="set"><b>Bug button</b><p>A small red button you can drag anywhere. It takes a picture of the screen to draw on and describe a bug, and saves it in the “Bug reports” folder.</p>' +
        '<button type="button" data-act="bugbtn">' + (PREF.bugBtn !== false ? 'Hide the bug button' : 'Show the bug button') + '</button> <button type="button" data-act="bugnow">Report a bug now</button></div>' +
      '<div class="set"><b>About</b><p>Quick Notes ' + esc(CFG.VERSION) + '. Notes are Markdown files in your Google Drive › ' + esc(sync.rootName()) + ', readable by any notes app. Quick Notes can only see the files it makes.</p>' +
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
      if (act === 'bugbtn') { PREF.bugBtn = PREF.bugBtn === false; savePref(); if (window.QNBug) QNBug.show(PREF.bugBtn); settingsSheet(); return; }
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
    { t: 'Found a bug? Tap the bug', d: 'The small red bug button takes a picture of the screen. Draw on it to point at the problem, say what went wrong, and it is saved in your “Bug reports” folder, with the details needed to fix it. Drag the button anywhere; hide it in Settings.',
      a: art('<rect x="60" y="12" width="120" height="116" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="74" y="28" width="92" height="10" rx="5" fill="' + MUT + '" opacity=".35"/><rect x="74" y="46" width="70" height="10" rx="5" fill="' + MUT + '" opacity=".35"/>' +
        '<ellipse cx="128" cy="86" rx="30" ry="18" fill="none" stroke="#d93025" stroke-width="4"/><circle cx="54" cy="96" r="20" fill="#d93025"/><path d="M48 90h12v14a6 6 0 01-12 0zM54 90v20M46 98h-5M62 98h5" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>') },
    { t: 'An endless page', d: 'Every note is now an endless page. Pinch to zoom, move with two fingers, twist to turn it. Tap with two fingers to undo, three to redo. The zoom button has Fit everything, Zoom into an area and a Navigator map.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><g transform="rotate(-8 120 70)"><rect x="70" y="34" width="100" height="72" rx="8" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><path d="M84 84c10-14 20 6 30-4s16-10 24 0" fill="none" stroke="' + INKC + '" stroke-width="3.5" stroke-linecap="round"/></g>' +
        '<circle cx="54" cy="104" r="9" fill="' + A + '" opacity=".35"/><circle cx="186" cy="38" r="9" fill="' + A + '" opacity=".35"/><path d="M60 98l14-12M180 44l-14 12" stroke="' + A + '" stroke-width="3" stroke-linecap="round"/>') },
    { t: 'Sign in once, stay signed in', d: 'Quick Notes now keeps you signed in. The cloud at the top shows a tick when every note is in your Google Drive, and only asks for you when something needs you.',
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
        '<div class="wn-top">' + (i === 0 ? '<span class="wn-kicker">' + (first ? 'Welcome to Quick Notes' : 'What’s new in ' + esc(CFG.VERSION)) + '</span>' : '<span class="wn-kicker">' + (i + 1) + ' of ' + SLIDES.length + '</span>') +
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

  // ---------- Bug reports: saved as notes in "Bug reports", with the annotated picture and the details ----------
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
    QNBug.save = async function (r) {
      var md = r.text || '(no description)';
      var title = 'Bug: ' + md.split(/\s+/).slice(0, 7).join(' ').replace(/[\n#]/g, ' ').slice(0, 60);
      var img = '';
      if (r.png && navigator.onLine && Drive.signedIn()) {
        try {
          var name = 'bug-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + N.shortId() + '.png';
          var made = await Drive.upload(name, await attachmentsFolder(), r.png, 'image/png');
          var map = await attachments(); map[name] = made.id; imgCache[name] = URL.createObjectURL(r.png);
          img = '![](Attachments/' + encodeURIComponent(name) + ')';
        } catch (e) { img = ''; }
      }
      if (!img && r.small) img = '![](' + r.small + ')';
      var body = md + (img ? '\n\n' + img : '') + '\n\n### Details\n\n```\n' + r.details + '\n```';
      // The "Bug reports" folder (made the first time, when online).
      var folder = null, t = tree();
      Object.keys(t).forEach(function (k) { if (t[k].name === 'Bug reports' && t[k].parentId === rootId()) folder = k; });
      if (!folder && navigator.onLine && Drive.signedIn() && rootId()) { try { folder = await sync.createFolder('Bug reports', rootId()); } catch (e) {} }
      var n = newDraft(title, body);
      n.labels = ['bug']; n.folderId = folder || null;
      touchNote(n); store.put(n); sync.schedule(1500); renderStatus();
      if (S.view === 'list') renderList();
      toast('Bug report saved in “Bug reports”. Tell Claude to read it.', null, null, 4000);
    };
    QNBug.show(PREF.bugBtn !== false);
  }

  // ---------- Start: the notes grid ----------
  (async function start() {
    var saved = await store.load();
    saved.forEach(function (n) { notes[n.id] = n; });
    S.folder = startFolder();
    try { history.replaceState({ v: 'exit' }, ''); history.pushState(navState(), ''); } catch (e) {}
    showList();

    // Android "Share to Quick Notes": arrives as ?title=…&text=…&url=…
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
