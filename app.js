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
  var PREF = { tool: 'hand', pen: { c: 'ink', s: 3 }, hl: '#f2c94c' };
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
    $('sheet').oninput = null;
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
    // (3.36) Combining a note changed on two devices: not while it is being typed in; then show the combined note.
    busy: function (id) { return !!(S.cur && S.cur.id === id && editingNow()); },
    flush: function (id) { if (S.cur && S.cur.id === id && S.canvas && S.canvas.flush) S.canvas.flush(); },
    merged: function (id) { if (S.view !== 'list' && S.cur && notes[id] === S.cur && !editingNow()) reopen(); },
    progress: function (n, total) { if (S.view === 'list') $('emptyMsg').textContent = 'Getting notes from Drive… ' + n + ' of ' + total; },
    folders: function () { if (S.view === 'list') renderList(); if (!$('drawer').classList.contains('hidden')) renderTree(); renderMeta(); }
  });
  // (3.27) Also while typing waits to carry on after coming back from another app: the caret was only taken away.
  function editingNow() { return !!(S.canvas && S.canvas.resuming && S.canvas.resuming()) || document.activeElement && $('editorView').contains(document.activeElement) && document.activeElement !== document.body; }

  // ---------- Is everything in Drive? ----------
  // A small cloud at the top answers that at a glance: a tick when every note is in Drive, an arrow while
  // changes are on their way, a struck-out cloud when offline (notes are safe on this device), and amber
  // with a banner only when something needs you.
  function health(st) {
    st = st || sync.status();
    var w = st.waiting.length, now = Date.now();
    var oldest = st.waiting.reduce(function (m, n) { var t = Date.parse(n.updated) || now; return Math.min(m, t); }, now);
    var age = now - oldest, many = function (k, one, more) { return k === 1 ? one : k + ' ' + more; };
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
    var st = sync.status(), h = health(st), items = st.waiting;
    S.sheet = 'sync';
    openSheet('<h2>' + (h.s === 'ok' ? 'All saved in Drive' : h.s === 'offline' ? 'Offline' : h.s === 'busy' ? 'Saving to Drive' : 'Needs a look') + '</h2><p>' + esc(h.text) + '</p>' +
      (items.length ? '<ul>' + items.slice(0, 30).map(function (n) {
        return '<li data-open="' + esc(n.id) + '" style="cursor:pointer">' + esc(n.title || N.fileName(n).replace(/^\S+ \S+ |\.md$/g, '')) + (n.conflict ? ' — combining changes from two devices' : n.deleted ? ' — to delete' : '') + '</li>';
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
  // A note with drawings shows a small picture of its page (text where it sits, drawings over it), so it can be
  // recognised while scrolling (3.18; before, the text came first and a little drawing under it).
  function pagePreview(n, region) {
    var I = window.QNInk, layers = I.normalize(n.ink), ib = I.boundsOf(layers.filter(function (l) { return l.vis; })), parts = [];
    var bx = (n.boxes || []).filter(function (b) { return b.md && b.md.trim(); }).map(function (b) {
      var w = b.w || 560, per = Math.max(10, w / 8.6), h = 8;
      String(b.md).split('\n').forEach(function (l) { h += Math.max(1, Math.ceil(l.length / per)) * (/^#/.test(l) ? 30 : 24); });
      return { b: b, x: b.x, y: b.y, w: w, h: Math.min(h, 1400) };
    });
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    bx.concat(ib ? [ib] : []).forEach(function (r) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); });
    if (x0 === Infinity) return '';
    var pad = 12; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    var W = x1 - x0, H = y1 - y0; // the whole page; two fingers zoom into it and move it (3.19)
    if (region) { x0 = region.x; y0 = region.y; W = Math.max(1, region.w); H = Math.max(1, region.h); } // a part of it (a link)
    bx.forEach(function (r) {
      parts.push('<foreignObject x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '"><div xmlns="http://www.w3.org/1999/xhtml" class="mp-box">' +
        LIB.md.render(String(r.b.md).slice(0, 1500).replace(/<\/?(u|mark|span|s|sub|sup)[^>]*>/gi, '')).replace(/<img[^>]*>/g, '') + '</div></foreignObject>');
    });
    return '<svg class="mini-page" viewBox="' + x0 + ' ' + y0 + ' ' + W + ' ' + H + '" preserveAspectRatio="xMidYMin meet">' + parts.join('') +
      I.svgFor(layers, 'mp' + (++pagePreview.n) + '-', 0, 0, true) + '</svg>';
  }
  pagePreview.n = 0;
  // ---- Links between notes (3.21): a note, or a part of one, shown live inside another; tap Open to go there ----
  // The link is plain text (qn://note/<id>#x,y,w,h), so it travels by copy and paste like any link.
  function noteLinkOf(src) {
    var m = /^qn:\/\/note\/([^#\s]+)(?:#(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+))?/.exec(src || '');
    if (!m) return null;
    return { id: decodeURIComponent(m[1]), r: m[2] != null ? { x: +m[2], y: +m[3], w: +m[4], h: +m[5] } : null };
  }
  function noteById(id) { return live().filter(function (x) { return x.id === id; })[0] || null; }
  function copyNoteLink(n, b) {
    if (!n) return;
    var t = 'qn://note/' + encodeURIComponent(n.id) + (b ? '#' + [b.x, b.y, b.w, b.h].map(function (v) { return Math.round(v); }).join(',') : '');
    var done = function () { toast((b ? 'Link to this part' : 'Link to this note') + ' copied. In another note, hold the Add button to put it there.', null, null, 4000); };
    S.copiedLink = t;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, done); else done();
  }
  async function placeNoteLink(t, kind) {
    var L = noteLinkOf(t), n = L && noteById(L.id);
    if (!n) { toast('That note isn\'t here (deleted, or not synced yet).'); return; }
    if (S.cur && n.id === S.cur.id && !L.r) { toast('That is a link to this same note.'); return; }
    if (kind === 'card') { S.canvas.placeMedia({ src: t, mk: 'notecard', ttl: n.title || 'Untitled' }, 320, 76); return; }
    var r = L.r || { w: 520, h: 360 }, k = Math.min(1, 560 / Math.max(r.w, r.h * 1.2));
    S.canvas.placeMedia({ src: t, mk: 'note', ttl: n.title || 'Untitled' }, Math.max(220, r.w * k), Math.max(140, r.h * k + 34));
  }
  window.QNInk.noteView = function (src) {
    var L = noteLinkOf(src), n = L && noteById(L.id);
    if (!n) return '<div class="emb-bar"><span>A note that isn\'t here (deleted, or not synced yet)</span></div>';
    var pic = pagePreview(n, L.r) || '<div class="emb-empty">' + esc(n.title || 'Untitled') + '</div>';
    return '<div class="emb-bar"><span>' + esc(n.title || 'Untitled') + (L.r ? ' · part' : '') + '</span><a class="emb-live emb-open" data-qn="' + esc(src) + '">Open ↗</a></div>' +
      pic.replace('class="mini-page"', 'class="mini-page emb-mini"');
  };
  document.addEventListener('click', function (e) { // Open ↗ on a linked note: go there, to that part
    var a = e.target.closest && e.target.closest('.emb-open'); if (!a) return;
    e.preventDefault(); e.stopPropagation();
    var L = noteLinkOf(a.dataset.qn), n = L && noteById(L.id); if (!n) return;
    if (S.canvas) S.canvas.flush();
    openNote(n, false, 'tab'); // in a new tab, so the note you came from stays open (#53)
    if (L.r) setTimeout(function () { if (S.canvas && S.cur === n) S.canvas.showRect(L.r); }, 350);
  }, true);
  // Links in a note's text (3.26): a note link (qn://note/…, as the Obsidian copy makes from [[links]]) opens that
  // note; a link to a file in Attachments opens the file. A tap while the text is being written still just places the
  // cursor, so the link's words can be changed.
  var writingAtDown = false;
  document.addEventListener('pointerdown', function (e) {
    var ed = e.target.closest && e.target.closest('[contenteditable="true"]');
    writingAtDown = !!(ed && document.activeElement === ed);
  }, true);
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]'); if (!a || a.closest('.emb, .card, #sheet')) return;
    var href = a.getAttribute('href') || '', ed = a.closest('[contenteditable]');
    var L = noteLinkOf(href), local = !L && isLocalRef(href) && /^Attachments\//.test(href);
    if (!L && !local) return;
    e.preventDefault();
    if (ed && writingAtDown && !e.ctrlKey && !e.metaKey) { // writing: the tap places the cursor; a second tap on it opens
      if (S.linkTap === a && Date.now() - S.linkTapAt < 2500) { S.linkTap = null; }
      else { S.linkTap = a; S.linkTapAt = Date.now(); toast('Tap the link again to open it.', null, null, 2000); return; }
    }
    e.stopPropagation();
    if (local) {
      var w = window.open('', '_blank');
      attachmentUrl(refName(href)).then(function (u) { if (u && w) w.location = u; else { if (w) w.close(); toast('That file isn\'t in Drive yet, or you are offline.'); } });
      return;
    }
    var n = noteById(L.id);
    if (!n) { toast('That note isn\'t here (deleted, or not synced yet).'); return; }
    if (S.cur && S.canvas) S.canvas.flush();
    openNote(n, false, 'tab');
    if (L.r) setTimeout(function () { if (S.canvas && S.cur === n) S.canvas.showRect(L.r); }, 350);
  }, true);
  // Notes that link to this one (3.26): in their text, or as a linked note on their page.
  function linkedFrom(n) {
    var key = 'qn://note/' + encodeURIComponent(n.id);
    return live().filter(function (x) {
      if (x.id === n.id) return false;
      if (String(x.body || '').indexOf(key) >= 0) return true;
      return (x.ink || []).some(function (l) { return (l.items || []).some(function (it) { return it.t === 'i' && String(it.src || '').indexOf(key) === 0; }); });
    }).sort(function (a, b) { return String(b.updated).localeCompare(String(a.updated)); });
  }
  function linkedFromSheet(n) {
    var list = linkedFrom(n);
    openSheet('<h2>Linked from</h2>' + (list.length ? '<p>' + list.length + ' note' + (list.length > 1 ? 's link' : ' links') + ' here.</p><ul class="linked">' + list.slice(0, 200).map(function (x) {
      return '<li data-open="' + esc(x.id) + '" style="cursor:pointer;padding:6px 0"><b>' + esc(x.title || 'Untitled') + '</b></li>';
    }).join('') + '</ul>' : '<p>No other note links here yet. Copy a link to this note (in the ••• menu) and add it to another note.</p>') +
      '<div class="row"><button type="button" data-act="close">Close</button></div>');
    $('sheet').querySelectorAll('[data-open]').forEach(function (li) {
      li.onclick = function () { var x = notes[li.dataset.open]; if (x && !x.deleted) { closeSheet(); if (S.canvas) S.canvas.flush(); openNote(x); } };
    });
  }
  // How a note's preview was enlarged in the list stays that way (3.24.1): the part of a page picture, or the size of a text preview.
  var PZ = {};
  try { PZ = JSON.parse(localStorage.getItem('qn-pz') || '{}') || {}; } catch (e) {}
  function pzGet(id) { return PZ[id] || {}; }
  function pzSet(id, v) { if (v && (v.vb || v.fs)) PZ[id] = v; else delete PZ[id]; try { localStorage.setItem('qn-pz', JSON.stringify(PZ)); } catch (e) {} }
  // Two fingers on a page picture: pinch to zoom, move to look around (one finger still scrolls the list). On a text
  // preview, pinch makes the text bigger or smaller. Double tap puts it back.
  (function () {
    var pz = null, swallowTap = 0, tz = null;
    function cardId(el) { var c = el.closest && el.closest('.card'); return c && c.dataset.id; }
    function vb(svg) { return svg.getAttribute('viewBox').split(/\s+/).map(Number); }
    function mid(t) { return [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2]; }
    function dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }
    document.addEventListener('touchstart', function (e) {
      var tx = e.touches.length === 2 && e.target.closest && e.target.closest('.card .prev');
      if (tx) {
        if (!tx.dataset.fs0) tx.dataset.fs0 = parseFloat(getComputedStyle(tx).fontSize) || 15;
        tz = { el: tx, fs: parseFloat(getComputedStyle(tx).fontSize) || 15, d: dist(e.touches) };
        e.preventDefault(); return;
      }
      var svg = e.target.closest && e.target.closest('.mini-page');
      if (!svg || e.touches.length !== 2) return;
      if (!svg.dataset.vb0) svg.dataset.vb0 = svg.getAttribute('viewBox');
      pz = { svg: svg, v: vb(svg), m: mid(e.touches), d: dist(e.touches), r: svg.getBoundingClientRect() };
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchmove', function (e) {
      if (tz && e.touches.length === 2) { e.preventDefault(); tz.el.style.fontSize = Math.max(9, Math.min(60, tz.fs * dist(e.touches) / tz.d)) + 'px'; tz.el.dataset.fs = parseFloat(tz.el.style.fontSize); swallowTap = Date.now(); return; }
      if (!pz || e.touches.length !== 2) return;
      e.preventDefault();
      var v = pz.v, r = pz.r, k = v[2] / r.width; // page units per screen pixel (the picture keeps its proportions)
      var s = Math.max(0.05, Math.min(20, dist(e.touches) / pz.d)), m = mid(e.touches);
      var px = v[0] + (pz.m[0] - r.left) * k, py = v[1] + (pz.m[1] - r.top) * (v[3] / r.height); // the page point under the fingers
      var w = v[2] / s, h = v[3] / s;
      var nx = px - (m[0] - r.left) * (w / r.width), ny = py - (m[1] - r.top) * (h / r.height);
      pz.svg.setAttribute('viewBox', nx + ' ' + ny + ' ' + w + ' ' + h);
      swallowTap = Date.now();
    }, { passive: false });
    document.addEventListener('touchend', function (e) {
      if (e.touches.length >= 2) return;
      if (tz) { var ti = cardId(tz.el); if (ti) pzSet(ti, Object.assign({}, pzGet(ti), { fs: Math.round(parseFloat(tz.el.style.fontSize) * 10) / 10 })); tz = null; }
      if (pz) { var pi = cardId(pz.svg); if (pi && pz.svg.closest('#listView')) pzSet(pi, Object.assign({}, pzGet(pi), { vb: pz.svg.getAttribute('viewBox') })); pz = null; }
    });
    // The page picture just pinched: don't open the note when the fingers lift; a double tap puts it back.
    document.addEventListener('click', function (e) {
      if (Date.now() - swallowTap < 450 && e.target.closest && e.target.closest('.mini-page, .card .prev')) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    document.addEventListener('dblclick', function (e) {
      var svg = e.target.closest && e.target.closest('.mini-page'); if (svg && svg.dataset.vb0) { svg.setAttribute('viewBox', svg.dataset.vb0); var di = cardId(svg); if (di) pzSet(di, Object.assign({}, pzGet(di), { vb: null })); e.stopPropagation(); }
      var tp = e.target.closest && e.target.closest('.card .prev'); if (tp && tp.dataset.fs) { tp.style.fontSize = ''; delete tp.dataset.fs; var dj = cardId(tp); if (dj) pzSet(dj, Object.assign({}, pzGet(dj), { fs: null })); e.stopPropagation(); }
    }, true);
  })();
  function card(n, extra, where) {
    var inner = '';
    if (n.pinned) inner += '<span class="pin">' + icon('pin-fill') + '</span>';
    if (n.title) inner += '<h3>' + esc(n.title) + '</h3>';
    if (where) inner += '<div class="where">' + esc(where) + '</div>';
    if (extra) inner += extra;
    else {
      var mini = N.hasInk(n) ? pagePreview(n) : '', zs = pzGet(n.id);
      if (mini && zs.vb) mini = mini.replace(/viewBox="([^"]*)"/, function (m0, v0) { return 'data-vb0="' + v0 + '" viewBox="' + zs.vb + '"'; }); // kept as you enlarged it (3.24.1)
      if (mini) inner += mini;
      else if (n.body) { var pv = preview(n); if (zs.fs) pv = pv.replace('<div class="prev', '<div data-fs="' + zs.fs + '" style="font-size:' + zs.fs + 'px" class="prev'); inner += pv; }
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
        if (parent === root && (f.name === 'Attachments' || f.name === 'Fonts')) return; // where the app keeps pictures and fonts; not notes folders
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
    openSheet('<h2>Copy notes in</h2><p>A one-time copy into Serendipity. It is not a sync: Keep, Notion and Obsidian stay as they are, and edits made here stay here. Running a copy again only adds notes that are not here yet.</p>' +
      '<div class="pick"><button type="button" data-act="keep">' + icon('notes') + 'From Google Keep (Takeout export)</button>' +
      '<button type="button" data-act="notion">' + icon('notes') + 'From Notion (Markdown export)</button>' +
      '<button type="button" data-act="vault">' + icon('notes') + 'From Obsidian (a vault folder on this computer)</button></div>' +
      '<div class="row"><button type="button" data-act="close">Close</button></div>',
    function (act) { if (act === 'keep') location.href = 'import.html'; if (act === 'notion') location.href = 'notion.html'; if (act === 'vault') location.href = 'vault.html'; });
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
    copyLink: function (b) { copyNoteLink(S.cur, b); },
    newPattern: function () { editStyle('pat', null); }, // (3.37) Select › a picked fill › + New
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
    linkStyle: function () { return { e: PREF.linkE == null ? '>' : PREF.linkE, k: PREF.linkK || 'curve' }; },
    // (3.33, #90) The top buttons and tabs float over the page; the page keeps its title clear of them.
    topInset: function () { var b = document.querySelector('#topChrome .bar'), t = $('tabBar'); return (b ? b.offsetHeight : 0) + (t && t.offsetHeight ? t.offsetHeight : 38) + 6; },
    dodge: uiDodge,
    autoTool: function (t) { setTool(t); },
    imageUrl: function (src) { return isLocalRef(src) ? attachmentUrl(refName(src)) : Promise.resolve(src); },
    textLook: function (t) { Object.assign(INKOPT.text, t); savePref(); if (PREF.tool === 'text') setTool('text'); } // tapped text: the card shows its look
  };
  // (3.33, #90) While a pen line or a moved thing passes under a button, a tab, the tool rail or another floating
  // control, that control fades out; it comes back a moment after the pen or finger lifts.
  var DODGE = '#topChrome .bar > :not(.spacer), #tabBar, #tools .tool-row, #tools .tool-opts, #menuFab, #viewCtl, #toolQuick, #penQuick, .qn-nav, .qn-modebtn, .qn-dir, .tl-wheel, .tl-puck, .tl-corner, .tl-pal, #fbSlotNote';
  var dodged = [], dodgeT = 0, dodgeLast = 0;
  function uiDodge(x, y) {
    if (x == null) {
      clearTimeout(dodgeT);
      if (dodged.length) dodgeT = setTimeout(function () { dodged.forEach(function (e) { e.classList.remove('qn-dodge'); e.classList.add('qn-undodge'); }); dodged = []; }, 500);
      return;
    }
    var now = performance.now(); if (now - dodgeLast < 40) return; dodgeLast = now;
    clearTimeout(dodgeT);
    var pad = 18;
    document.querySelectorAll(DODGE).forEach(function (e) {
      if (dodged.indexOf(e) >= 0) return;
      var r = e.getBoundingClientRect(); if (!r.width) return;
      if (x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad) { e.classList.remove('qn-undodge'); e.classList.add('qn-dodge'); dodged.push(e); }
    });
  }
  function openNote(n, isNew) {
    if (typeof hideOverview === 'function') hideOverview();
    if (S.cur) closeNote();
    S.cur = n; S.lastOpened = n.id;
    S.view = 'note'; dockFeedback();
    $('listView').classList.add('hidden'); $('editorView').classList.remove('hidden');
    closeMenu();
    try { if (S.tabSwitch) history.replaceState({ v: 'note' }, ''); else history.pushState({ v: 'note' }, ''); } catch (e) {}
    $('noteTitle').value = n.title || '';
    setPin(n.pinned);
    renderLabelsRow(); renderConflict(); renderMeta();
    $('canvasWrap').scrollTo(0, 0);
    S.canvas = new window.QNCanvas.NoteCanvas($('canvasHost'), $('canvasWrap'), n, canvasHooks);
    applyViewPrefs();
    // A new note types straight away; others open with the tool last picked on the rail (the Hand at first).
    var pk = PREF.picked || 'hand';
    setTool(isNew || !PREF.showTools ? 'type' : (pk === 'erase' || pk === 'select' || pk === 'lasso' ? 'hand' : pk));
    renderLayers();
    $('undoBtn').disabled = true; $('redoBtn').disabled = true;
    if (isNew) setTimeout(function () { S.canvas.focusStart(); }, 50);
  }
  function reopen() { var n = S.cur, top = $('canvasWrap').scrollTop; S.canvas.destroy(); S.canvas = new window.QNCanvas.NoteCanvas($('canvasHost'), $('canvasWrap'), n, canvasHooks); applyViewPrefs(); applyInk(); S.canvas.setTool(PREF.tool); renderLayers(); $('noteTitle').value = n.title || ''; setPin(n.pinned); renderLabelsRow(); renderConflict(); renderMeta(); $('canvasWrap').scrollTop = top; }
  var openNote0 = openNote, showList0 = null;
  openNote = function () { var r = openNote0.apply(this, arguments); renderImportBar(); return r; };
  // ---------- Tabs (3.29, #53): several notes open at once ----------
  // A note opened from the list goes in the tab in use; a note link (in text, or Open ↗ on a linked note) opens in a
  // new tab next to it, and so does ••• › Open another note in a new tab. The strip shows from two tabs on. The tabs
  // (and the note you were in) come back when the app opens again.
  var TABS = { ids: [], cur: null, inNote: false, newNext: false };
  try { var tj = JSON.parse(localStorage.getItem('qn-tabs') || '{}'); TABS.ids = (tj.ids || []).map(String); TABS.cur = tj.cur || null; TABS.inNote = !!tj.inNote; } catch (e) {}
  function saveTabs() { try { localStorage.setItem('qn-tabs', JSON.stringify({ ids: TABS.ids, cur: TABS.cur, inNote: S.view === 'note' })); } catch (e) {} }
  function tabName(n) {
    var t = (n.title || '').trim();
    if (!t) {
      // (3.32) No title: use the first line of the text, without HTML tags or Markdown marks (a tab once showed "<u Driti</u").
      var src = String((n.boxes && n.boxes[0] && n.boxes[0].md) || n.body || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
      t = src.split('\n').map(function (l) { return l.replace(/^[#>\s*_`\-]+|[*_`\[\]()]/g, ' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean)[0] || '';
    }
    return (t || 'Untitled').slice(0, 40);
  }
  function renderTabs() {
    var bar = $('tabBar'); if (!bar) return;
    // Only a deleted note leaves the tabs; one not loaded yet (before the first sync) keeps its place.
    TABS.ids = TABS.ids.filter(function (id, i, all) { return all.indexOf(id) === i && !(notes[id] && notes[id].deleted); });
    var shown = TABS.ids.filter(function (id) { return noteById(id) || (S.cur && S.cur.id === id); });
    var show = S.view === 'note' && shown.length > 0;
    bar.classList.toggle('hidden', !show);
    document.body.classList.toggle('has-tabs', show);
    if (show) {
      bar.innerHTML = shown.map(function (id) {
        var n = (S.cur && S.cur.id === id) ? S.cur : noteById(id), on = S.cur && S.cur.id === id;
        return '<button type="button" class="tab' + (on ? ' on' : '') + '" role="tab" aria-selected="' + !!on + '" data-tab="' + esc(id) + '"><span>' + esc(tabName(n)) + '</span><i data-tclose="' + esc(id) + '" role="button" aria-label="Close this tab" title="Close this tab">×</i></button>';
      }).join('') + '<button type="button" class="tab-add" data-tadd aria-label="Open another note in a new tab" title="Open another note in a new tab">+</button>';
      var on = bar.querySelector('.tab.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    var pill = $('tabsPill');
    if (pill) { var others = shown.length; pill.classList.toggle('hidden', S.view === 'note' || others < 1); pill.textContent = 'Open tabs (' + others + ')'; }
    saveTabs();
  }
  // (3.34) Drag a tab to change its place: hold a tab (a mouse: just drag) and slide it along the strip.
  (function () {
    var bar = $('tabBar'), dg = null;
    function clear() { if (!dg) return; clearTimeout(dg.t); if (dg.on) { dg.el.classList.remove('dragging'); dg.el.style.transform = ''; bar.style.touchAction = ''; } dg = null; }
    bar.addEventListener('pointerdown', function (e) {
      var t = e.target.closest('.tab[data-tab]'); if (!t || e.target.closest('[data-tclose]')) return;
      dg = { el: t, id: t.dataset.tab, x0: e.clientX, id2: e.pointerId, on: false, mouse: e.pointerType === 'mouse' };
      if (!dg.mouse) dg.t = setTimeout(function () { if (dg) { dg.on = true; t.classList.add('dragging'); bar.style.touchAction = 'none'; try { bar.setPointerCapture(dg.id2); } catch (x) {} if (navigator.vibrate) navigator.vibrate(8); } }, 350);
    });
    bar.addEventListener('pointermove', function (e) {
      if (!dg || e.pointerId !== dg.id2) return;
      var dx = e.clientX - dg.x0;
      if (!dg.on) { if (dg.mouse && Math.abs(dx) > 6) { dg.on = true; dg.el.classList.add('dragging'); try { bar.setPointerCapture(dg.id2); } catch (x) {} } else { if (!dg.mouse && Math.abs(dx) > 8) { clearTimeout(dg.t); dg = null; } return; } }
      dg.el.style.transform = 'translateX(' + dx + 'px)';
      // Passing the middle of a neighbour swaps places with it.
      var tabs = [].slice.call(bar.querySelectorAll('.tab[data-tab]')), me = dg.el.getBoundingClientRect(), mid = me.left + me.width / 2, i = tabs.indexOf(dg.el);
      var j = tabs.findIndex(function (o) { if (o === dg.el) return false; var r = o.getBoundingClientRect(); return mid > r.left && mid < r.right; });
      if (j >= 0 && j !== i) {
        var ids = TABS.ids, a = ids.indexOf(dg.id), b = ids.indexOf(tabs[j].dataset.tab);
        if (a >= 0 && b >= 0) {
          var before = dg.el.getBoundingClientRect().left;
          ids.splice(b, 0, ids.splice(a, 1)[0]);
          if (j > i) bar.insertBefore(dg.el, tabs[j].nextSibling); else bar.insertBefore(dg.el, tabs[j]);
          dg.x0 += dg.el.getBoundingClientRect().left - before; // the tab stays under the finger
          dg.el.style.transform = 'translateX(' + (e.clientX - dg.x0) + 'px)'; dg.moved = true; saveTabs();
        }
      }
    });
    function up(e) { if (!dg) return; var was = dg.on; clear(); if (was) { bar._noClick = Date.now(); renderTabs(); } }
    bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
    bar.addEventListener('click', function (e) { if (bar._noClick && Date.now() - bar._noClick < 400) { e.stopPropagation(); e.preventDefault(); } }, true);
  })();
  var openNote2 = openNote;
  openNote = function (n, isNew, how) {
    if (!n) return;
    var i = TABS.ids.indexOf(n.id), curI = S.cur ? TABS.ids.indexOf(S.cur.id) : TABS.ids.indexOf(TABS.cur);
    if (i < 0) {
      // (3.30) Every note opened gets its own tab, next to the one in use (the user's wish: tabs are the normal way).
      if (how === 'replace' && curI >= 0) TABS.ids[curI] = n.id;
      else TABS.ids.splice(curI < 0 ? TABS.ids.length : curI + 1, 0, n.id);
      if (TABS.ids.length > 12) { var drop = TABS.ids.filter(function (id) { return id !== n.id; })[0]; TABS.ids.splice(TABS.ids.indexOf(drop), 1); }
    }
    TABS.newNext = false; TABS.cur = n.id;
    S.tabSwitch = S.view === 'note' && !!S.cur; // from one note to another: no extra step for the back button
    try { return openNote2.apply(this, [n, isNew]); } finally { S.tabSwitch = false; renderTabs(); }
  };
  function closeTab(id) {
    var i = TABS.ids.indexOf(id); if (i < 0) return;
    TABS.ids.splice(i, 1);
    if (S.cur && S.cur.id === id) {
      var next = TABS.ids[Math.min(i, TABS.ids.length - 1)], n = next && noteById(next);
      if (n) { if (S.canvas) S.canvas.flush(); openNote(n); return; }
      TABS.cur = null;
      if (history.state && history.state.v === 'note') history.back(); else { closeNote(); showList(); }
      return;
    }
    renderTabs();
  }
  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('#tabBar [data-tclose]');
    if (c) { e.stopPropagation(); closeTab(c.dataset.tclose); return; }
    var t = e.target.closest && e.target.closest('#tabBar [data-tab]');
    if (t) { var n = noteById(t.dataset.tab); if (n && (!S.cur || S.cur.id !== n.id)) { if (S.canvas) S.canvas.flush(); openNote(n); } return; }
    if (e.target.closest && e.target.closest('#tabBar [data-tadd]')) { newTabPick(); return; }
    if (e.target.closest && e.target.closest('#tabsPill')) { tabsOverview(); return; }
    var tc = e.target.closest && e.target.closest('#tabsOver [data-toclose]');
    if (tc) { e.stopPropagation(); closeTab(tc.dataset.toclose); if (TABS.ids.length) tabsOverview(true); else hideOverview(); return; }
    var to = e.target.closest && e.target.closest('#tabsOver [data-topen]');
    if (to) { var tn = noteById(to.dataset.topen); hideOverview(); if (tn) openNote(tn); return; }
    if (e.target.closest && e.target.closest('#tabsOver') && !e.target.closest('.to-row')) hideOverview();
  });
  // (3.37) "Open tabs": the tabs spread out as pictures of their pages; tap one to go to it, × to close it.
  function tabsOverview(stay) {
    var ov = $('tabsOver');
    if (!ov) { ov = document.createElement('div'); ov.id = 'tabsOver'; document.body.appendChild(ov); }
    var ids = TABS.ids.filter(function (id) { return noteById(id); });
    ov.innerHTML = '<div class="to-row">' + ids.map(function (id, i) {
      var n = noteById(id), mini = N.hasInk(n) ? pagePreview(n) : (n.body ? preview(n) : '<p class="where">Empty note</p>');
      return '<div class="to-card' + (id === TABS.cur ? ' on' : '') + '" data-topen="' + esc(id) + '" style="--i:' + i + '"><div class="to-head"><b>' + esc(tabName(n)) + '</b><i data-toclose="' + esc(id) + '" role="button" aria-label="Close this tab">×</i></div><div class="to-pic">' + mini + '</div></div>';
    }).join('') + '</div>';
    ov.classList.remove('hidden');
    if (!stay) { ov.classList.remove('open'); void ov.offsetWidth; } ov.classList.add('open');
    var on = ov.querySelector('.to-card.on'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  function hideOverview() { var ov = $('tabsOver'); if (ov) { ov.classList.remove('open'); ov.classList.add('hidden'); } }
  function newTabPick() { // back to the list; the next note opened (or made) goes in a new tab
    TABS.newNext = true;
    if (history.state && history.state.v === 'note') history.back(); else { closeNote(); showList(); }
    toast('Pick a note (or make a new one): it opens in a new tab.', null, null, 3500);
  }
  S.newTabPick = newTabPick;
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
    setTimeout(function () { if (typeof renderTabs === 'function') renderTabs(); }, 0);
    S.view = 'list'; dockFeedback(); if (S.pick) endPick(); setTimeout(renderImportBar, 0);
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
  $('noteTitle').addEventListener('input', function () {
    S.cur.title = this.value; touchNote(S.cur);
    // (3.32) The tab shows the title as it is typed (it used to stay "Untitled" until the note was reopened).
    var tb = $('tabBar') && $('tabBar').querySelector('.tab.on span'); if (tb) tb.textContent = tabName(S.cur);
  });
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
    $('conflict').classList.add('hidden'); return; // (3.36) changes from two devices are combined by themselves; nothing to choose
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
  // (3.37, #91) A home-made tip's spacing, right in the pen card, and spacing that follows the pen's pressure.
  function tipDef(id) { return id ? MYSTYLES.filter(function (d) { return d.id === id && d.k === 'tip'; })[0] : null; }
  function tipSpacing(id) {
    var d = tipDef(id); if (!d) return '';
    return '<div class="grp"><label class="oslider">Spacing<input type="range" min="5" max="150" value="' + Math.round((d.sp || 0.25) * 100) + '" data-tipsp></label>' +
      chip('Spacing follows pressure', 'data-tipspp title="Press lightly for gaps, harder for a close, dense line"', !!d.spp) + '</div>';
  }
  document.addEventListener('input', function (e) {
    if (e.target.dataset.tipsp == null) return;
    var d = tipDef(INKOPT.pen.cs); if (!d) return;
    d.sp = +e.target.value / 100; window.QNInk.addDefs([d]);
    if (S.canvas && S.canvas.ink) S.canvas.ink().redraw();
  });
  document.addEventListener('change', function (e) { if (e.target.dataset.tipsp != null) saveStyles(); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-tipspp]'); if (!b) return;
    var d = tipDef(INKOPT.pen.cs); if (!d) return;
    d.spp = !d.spp; if (!d.spp) delete d.spp; b.setAttribute('aria-pressed', d.spp ? 'true' : 'false');
    window.QNInk.addDefs([d]); saveStyles(); if (S.canvas && S.canvas.ink) S.canvas.ink().redraw();
  });
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
      if (act === 'brush') { pen.b = b.dataset.v; mark(b); pen.erase = false; var rb = $('sheet').querySelector('[data-act="rub"]'); if (rb) rb.setAttribute('aria-pressed', 'false'); return; } // a pen: back to drawing
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
      e.preventDefault(); try { box.setPointerCapture(e.pointerId); } catch (er) {}
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
      // A fresh copy each move: the drawing code keeps each line's outline, so the same line growing kept its first dot.
      var nx = Object.assign({}, cur, { p: cur.p.concat([[p[0], p[1], cur.f ? e.pressure || 0.5 : 0.5]]) }), ix = st.items.indexOf(cur);
      if (ix > -1) st.items[ix] = nx; cur = nx; draw();
    });
    var end = function () { cur = null; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  }

  var SWATCH = ['ink', '#5f6368', '#c0392b', '#d9822b', '#f2c94c', '#2f855a', '#00796b', '#2b6cb0', '#7e57c2', '#e91e63', '#ffffff'];
  var INKOPT = { guide: { snap: true }, pen: { b: 'pen', c: 'ink', s: 3, o: 1 }, erase: { m: 'stroke', s: 14 }, nudge: { m: 'nudge', r: 48, k: 0.8 }, fill: { m: 'lasso', c: '#f2c94c', o: 1 },
    lasso: { m: 'most', how: 'loop', sc: 'all' }, text: { font: '"Google Sans", Roboto, system-ui, sans-serif', fs: 32, c: 'ink', o: 1 } };
  (function migrate() { // settings saved by earlier versions
    if (PREF.ink) { Object.keys(INKOPT).forEach(function (k) { Object.assign(INKOPT[k], PREF.ink[k] || {}); }); }
    else if (PREF.pen) { INKOPT.pen.c = PREF.pen.c || 'ink'; INKOPT.pen.s = PREF.pen.s || 3; }
    if (PREF.tool === 'highlighter') { PREF.tool = 'pen'; INKOPT.pen.b = 'highlighter'; INKOPT.pen.c = PREF.hl || '#f2c94c'; INKOPT.pen.o = 1; }
    if (PREF.tool === 'eraser') PREF.tool = 'erase';
    // 3.27: the Hand and Text are two tools now ('hand' moves around, 'type' types). The old Hand was 'type'.
    if (!PREF.hand2) {
      PREF.hand2 = 1;
      if (PREF.tool === 'type') PREF.tool = 'hand';
      if (PREF.toolOrder && PREF.toolOrder.indexOf('hand') < 0) { var ti = PREF.toolOrder.indexOf('type'); PREF.toolOrder.splice(ti < 0 ? 0 : ti, 0, 'hand'); }
    }
    PREF.ink = INKOPT;
  })();
  // (3.38) Sliders: the new value reaches the pen once per frame and is stored when the slider is let go.
  var inkRaf = 0, inkQuick = false, prefT = 0;
  function inkSoon(quick) {
    inkQuick = inkQuick || !!quick;
    if (!inkRaf) inkRaf = requestAnimationFrame(function () { inkRaf = 0; applyInk(); if (inkQuick) updatePenQuick(); inkQuick = false; });
    clearTimeout(prefT); prefT = setTimeout(savePref, 400);
  }
  function applyInk() { if (S.canvas) Object.keys(INKOPT).forEach(function (k) { S.canvas.ink().opts(k, INKOPT[k]); }); }
  // (3.28, #80) The Text tool's card: a short set of text tools in three parts, Letters, Paragraph and Spacing (like
  // Affinity's Character and Paragraph panels, kept small). It works on the box being typed in, or the one typed in last.
  // (3.35) Paper: sticky notes, index cards, sheets and cardboard on the page; the Text card adds them and turns the
  // text box in use into one (or back into plain text).
  var PAPERS = [['sticky', 'Sticky'], ['card', 'Card'], ['sheet', 'Sheet'], ['kraft', 'Cardboard']];
  var STICKY_C = ['#ffe680', '#ffc2d1', '#bfe3ff', '#c8efb0', '#ffd3a0', '#ddd0ff'];
  function paperCard() {
    var G = function (x) { return '<div class="grp">' + x + '</div>'; };
    var cur = S.canvas && S.canvas.paperOf ? S.canvas.paperOf() : null;
    var h = '<div class="olabel">Paper</div>' + G('<span class="olab2">Add</span>' + PAPERS.map(function (p) { return '<button type="button" class="ochip" data-pnew="' + p[0] + '">' + p[1] + '</button>'; }).join(''));
    if (cur) h += G('<span class="olab2">This one</span><button type="button" class="ochip" data-pset="" aria-pressed="' + !cur.st + '">Plain</button>' + PAPERS.map(function (p) { return '<button type="button" class="ochip" data-pset="' + p[0] + '" aria-pressed="' + (cur.st === p[0]) + '">' + p[1] + '</button>'; }).join(''));
    var col = cur && cur.st === 'sticky' ? (cur.sc || STICKY_C[0]) : (PREF.stickyC || STICKY_C[0]);
    h += G('<span class="olab2">Sticky</span>' + STICKY_C.map(function (c) { return '<button type="button" class="ochip sw-paper" data-pcol="' + c + '" aria-pressed="' + (col === c) + '" aria-label="Sticky colour" style="background:' + c + ';width:30px;min-width:30px;padding:0"></button>'; }).join(''));
    return h;
  }
  function textCard() {
    var G = function (x) { return '<div class="grp">' + x + '</div>'; };
    var tt = S.canvas && S.canvas.textTarget && S.canvas.textTarget();
    if (!tt) return G(HINT('Double tap a text box (or empty space for new text). These text tools then change it: letters, paragraphs and spacing.'));
    var ed = tt.ed;
    function on(f) { try { return FMT_STATE[f] ? FMT_STATE[f](ed) : false; } catch (e) { return false; } }
    function tc(f, label, name, pressed) { return '<button type="button" class="ochip" data-tf="' + f + '" aria-label="' + name + '" title="' + name + '" aria-pressed="' + !!pressed + '">' + label + '</button>'; }
    var ff = ed.getAttributes('textStyle').fontFamily || '', fn = (allFonts().filter(function (x) { return x[0] === ff; })[0] || ['', 'Sans'])[1].replace(' (standard)', '');
    var fs = parseInt(ed.getAttributes('textStyle').fontSize, 10) || 17, ls = tt.ls || 1.55, ps = tt.ps == null ? 0.35 : tt.ps, tk = tt.tk || 0;
    var para = !on('h1') && !on('h2') && !ed.isActive('heading', { level: 3 }) && !on('quote') && !ed.isActive('codeBlock');
    return '<div class="olabel">Letters</div>' + G(tc('bold', '<b>B</b>', 'Bold', on('bold')) + tc('italic', '<i style="font-family:Georgia,serif">I</i>', 'Italic', on('italic')) + tc('underline', '<u>U</u>', 'Underline', on('underline')) + tc('strike', '<s>S</s>', 'Strikethrough', on('strike'))) +
      G(tc('font', '<span style="font-family:' + esc(ff || 'var(--font)') + '">' + esc(fn) + '</span> ▾', 'Font') + tc('size', fs + ' ▾', 'Size') + tc('color', '<span style="font-weight:700;border-bottom:3px solid #c0392b">A</span>', 'Text colour') + tc('highlight', '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#fde68a;vertical-align:middle"></span>', 'Highlight', on('highlight'))) +
      '<div class="olabel">Paragraph</div>' + G(tc('para', 'Body', 'Body text', para) + tc('h1', 'H1', 'Heading', on('h1')) + tc('h2', 'H2', 'Subheading', on('h2')) + tc('h3', 'H3', 'Small heading', ed.isActive('heading', { level: 3 })) + tc('quote', '❝', 'Quote', on('quote')) + tc('code', '{ }', 'Code', ed.isActive('codeBlock'))) +
      G(tc('bullet', '•≡', 'Bulleted list', on('bullet')) + tc('ordered', '1.', 'Numbered list', on('ordered')) + tc('task', '☑', 'Checklist', on('task')) + tc('outdent', '⇠', 'Less indent') + tc('indent', '⇢', 'More indent')) +
      G(tc('left', '⇤', 'Align left', !on('center') && !on('right') && !ed.isActive({ textAlign: 'justify' })) + tc('center', '↔', 'Centre', on('center')) + tc('right', '⇥', 'Align right', on('right')) + tc('justify', '☰', 'Justify', ed.isActive({ textAlign: 'justify' }))) +
      '<div class="olabel">Spacing (this box)</div>' + G('<span class="olab2">Lines</span>' + [[1.2, 'Tight'], [1.55, 'Normal'], [1.9, 'Airy'], [2.3, 'Double']].map(function (o) { return '<button type="button" class="ochip" data-tls="' + o[0] + '" aria-pressed="' + (Math.abs(ls - o[0]) < 0.01) + '">' + o[1] + '</button>'; }).join('')) +
      G('<span class="olab2">Gaps</span>' + [[0, 'None'], [0.35, 'Small'], [0.8, 'Medium'], [1.4, 'Big']].map(function (o) { return '<button type="button" class="ochip" data-tps="' + o[0] + '" aria-pressed="' + (Math.abs(ps - o[0]) < 0.01) + '">' + o[1] + '</button>'; }).join('')) +
      G('<span class="olab2">Letters</span>' + [[-0.02, 'Tight'], [0, 'Normal'], [0.05, 'Wide'], [0.12, 'Wider']].map(function (o) { return '<button type="button" class="ochip" data-ttk="' + o[0] + '" aria-pressed="' + (Math.abs(tk - o[0]) < 0.001) + '">' + o[1] + '</button>'; }).join('')) +
      G(tc('clear', 'Clear', 'Clear formatting') ) +
      G(HINT(tt.typing ? 'Changes the words picked, or the line you are on.' : 'Not typing now: letter changes go on the whole box; paragraph changes on the line typed in last.'));
  }
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
  // Each kind of pen (Pen, Pencil, Marker…) and each home-made tip remembers its own size, colour and opacity.
  function penKey() { return INKOPT.pen.cs ? 'cs:' + INKOPT.pen.cs : INKOPT.pen.b; }
  function switchPen(change) {
    var P = INKOPT.pen, m = P.mem || (P.mem = {});
    m[penKey()] = { s: P.s, c: P.c, o: P.o };
    change();
    var r = m[penKey()];
    if (r) { P.s = r.s; P.c = r.c; P.o = r.o == null ? 1 : r.o; }
    else if (P.b === 'highlighter' && !P.cs && P.c === 'ink') P.c = '#f2c94c';
    applyInk(); savePref();
  }
  var SIZE_MAX = function () { return PREF.bigSize || INKOPT.pen.s > 24 ? 120 : 24; };
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
        tipSpacing(o.pen.cs) +
        G(slider('Size', 'pen', 's', 1, SIZE_MAX(), o.pen.s) + chip('Bigger sizes', 'data-big title="Sizes up to 120 (or double-tap the size slider on the page)"', SIZE_MAX() > 24) + slider('Opacity', 'pen', 'o', 5, 100, o.pen.o, 100) +
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
          chip('Tap to pick', 'data-set="lasso.how" data-v="tap" title="A quick tap picks just that (empty space: nothing); tap and hold adds it, or takes it out if already picked"', how === 'tap')) +
        G(HINT('From') + chip('All layers', 'data-set="lasso.sc" data-v="all"', sc === 'all') + chip('This layer', 'data-set="lasso.sc" data-v="layer"', sc === 'layer') +
          chip('This group', 'data-set="lasso.sc" data-v="group" title="The layer group the current layer is in"', sc === 'group')) +
        G(HINT('Picks what is') + chip('Partly in', 'data-k="lasso" data-m="part" title="Anything the loop touches"', lm === 'part') +
          chip('Mostly in', 'data-k="lasso" data-m="most" title="At least half inside the loop"', lm === 'most') +
          chip('Fully in', 'data-k="lasso" data-m="full" title="Only what is completely inside"', lm === 'full')) +
        (how === 'tap' ? '' : G(HINT('A new loop') + chip('Picks new', 'data-set="lasso.op" data-v="new" title="A new selection"', (o.lasso.op || 'new') === 'new') + chip('+ Adds', 'data-set="lasso.op" data-v="add" title="Add to what is picked"', o.lasso.op === 'add') +
          chip('− Takes out', 'data-set="lasso.op" data-v="sub" title="Take away from what is picked"', o.lasso.op === 'sub'))) +
        G(HINT(how === 'tap' ? 'Tap picks one. Tap and hold adds it, or takes it out. Tap empty space to clear. Drag to move, corner to resize, knob to rotate.' : 'Circle to select, or tap one. Tap empty space to clear. Drag to move, corner to resize, knob to rotate.'));
    } else if (t === 'nudge') {
      html = G(chip('Nudge', 'data-k="nudge" data-m="nudge"', o.nudge.m === 'nudge') + chip('Smooth', 'data-k="nudge" data-m="smooth"', o.nudge.m === 'smooth')) +
        G(slider('Reach', 'nudge', 'r', 10, 160, o.nudge.r) + slider('Strength', 'nudge', 'k', 5, 100, o.nudge.k, 100));
    } else if (t === 'fill') {
      html = G(chip('Draw a shape', 'data-k="fill" data-m="lasso"', o.fill.m === 'lasso') + chip('Tap an area', 'data-k="fill" data-m="tap"', o.fill.m === 'tap')) +
        G(swatches(o.fill.c, 'fill')) + '<div class="osec">Pattern</div>' + G(styleChips('fill', o.fill.pt, 'data-pt')) +
        (o.fill.pt ? G(slider('Pattern size', 'fill', 'ps', 20, 400, o.fill.ps || 1, 100) + slider('Spacing', 'fill', 'pd', 100, 400, o.fill.pd || 1, 100)) +
          G(HINT('Hold the pen still at the end of a shape for a clean circle, box, star…')) : G(HINT('Hold the pen still at the end of a shape for a clean circle, box, star…'))) +
        G(slider('Opacity', 'fill', 'o', 5, 100, o.fill.o, 100));
    } else if (t === 'text') {
      // Artistic text: part of the drawing, in the current layer. (Double-tap still makes a normal text box.)
      var TF = [['"Google Sans", Roboto, system-ui, sans-serif', 'Sans'], ['Lora, serif', 'Serif'], ['"JetBrains Mono", monospace', 'Mono'],
        ['Caveat, cursive', 'Handwriting'], ['"Permanent Marker", cursive', 'Marker'], ['"Playfair Display", serif', 'Display']];
      userFonts.forEach(function (f) { TF.push([fontCss(f), f.family]); });
      html = G(TF.map(function (f) { return chip('<span style="font-family:' + esc(f[0]) + '">' + f[1] + '</span>', 'data-tfont="' + esc(f[0]) + '"', o.text.font === f[0]); }).join('')) +
        G(swatches(o.text.c, 'text')) + G(slider('Size', 'text', 'fs', 10, 200, o.text.fs) + slider('Opacity', 'text', 'o', 5, 100, o.text.o, 100)) +
        G(HINT('Tap the page to write; tap text to change it. It is part of the drawing: Lasso it to move, turn or recolour it.'));
    } else if (t === 'type') html = paperCard() + textCard() +
        G(HINT('One tap picks a text box or paper (drag it to move it); double tap to type in it; double tap empty space for new text. One finger moves the page.'));
    else if (t === 'link') {
      var le = PREF.linkE == null ? '>' : PREF.linkE, lk = PREF.linkK || 'curve';
      html = G(HINT('Drag from one note or paper to another to join them. Drag out to empty space: a new one there, already joined. Tap a line to change or delete it.')) +
        '<div class="olabel">New lines</div>' + G(chip('→', 'data-lnke=">" title="Arrow at the end"', le === '>') + chip('↔', 'data-lnke="<>" title="Arrows at both ends"', le === '<>') + chip('—', 'data-lnke="" title="No arrows"', le === '')) +
        G(chip('Curved', 'data-lnkk="curve"', lk === 'curve') + chip('Straight', 'data-lnkk="line"', lk === 'line'));
    }
    else if (t === 'hand') html = G(HINT('One finger moves the page; a tap does nothing. Double tap a thing to pick it (Select). Triple tap to type: in the text you tap, or new text on empty space.')) +
        G(HINT('Two fingers move, zoom and turn the page with every tool. Writing with the pen switches to Pen by itself.'));
    else if (t === 'guide') {
      var CI = S.canvas && S.canvas.ink();
      html = G(HINT('Tap to put one on the page; tap again to take it away.')) +
        G((CI ? CI.guideKinds() : []).map(function (k) { return chip(k[1], 'data-guide="' + k[0] + '"', CI.guideHas(k[0])); }).join('')) +
        '<div class="olabel">Perspective and grids</div>' +
        G((CI && CI.guideDirKinds ? CI.guideDirKinds() : []).map(function (k) { return chip(k[1], 'data-guide="' + k[0] + '"', CI.guideHas(k[0])); }).join('')) +
        G(chip('Lines follow the guides', 'data-gsnap title="A Pen line started at an edge follows it; with perspective or a grid on, a line takes the nearest direction"', o.guide.snap !== false)) +
        G(HINT('Drag a guide to move it, the knob to turn it (it catches every 15°), the square to size it. Then draw with the Pen along an edge.')) +
        G(HINT('Perspective: drag the round points (vanishing points); the horizon stays level. A Pen line heads for the nearest point (or goes level or upright); a curve that starts off every direction stays free. Isometric and square grids work the same way. Guides are not saved with the note.')) +
        G(chip('Clear all', 'data-gclear'));
    }
    else if (t === 'select') html = G(HINT('Drag text boxes by their dots to move them; drag the bar on the right to change the width.'));
    var NAMES = { hand: 'Hand', type: 'Text', text: 'Text art', pen: 'Pen', erase: 'Erase', lasso: 'Select', nudge: 'Nudge / Smooth', fill: 'Fill', guide: 'Guides', select: 'Move' };
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
  var QUICK2 = { // a second choice under the first: for the Lasso, what it picks (3.24.1; New / Add / Remove moved into its card)
    lasso: ['lasso', 'm', [['part', 'Partly', 'Anything the loop touches'], ['most', 'Mostly', 'At least half inside the loop'], ['full', 'Fully', 'Only what is completely inside']]]
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
      var Q2 = QUICK2[t];
      if (t === 'lasso' && INKOPT.lasso.how === 'tap') { Q2 = null; tq.innerHTML += '<hr><span class="qhint">Tap picks one.<br>Hold adds it or takes it out.<br>Tap empty space: clear.</span>'; }
      if (Q2) { var c2 = INKOPT[Q2[0]][Q2[1]] || Q2[2][0][0]; tq.innerHTML += '<hr>' + Q2[2].map(function (v) { return '<button type="button" data-q2="' + v[0] + '" aria-label="' + v[2] + '" aria-pressed="' + (c2 === v[0]) + '">' + v[1] + '</button>'; }).join(''); }
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
    inp.min = 1; inp.max = SIZE_MAX(); inp.step = 0.5; inp.setAttribute('aria-label', 'Pen size'); q.title = 'Pen size and colour: tap the dot for colours, double-tap the slider for bigger sizes';
    if (document.activeElement !== inp) inp.value = pen.s;
    dot.className = 'pq-dot';
    dot.innerHTML = '<i style="width:' + wpx + 'px;height:' + wpx + 'px;background:' + (pen.c === 'ink' ? 'var(--ink)' : pen.c) + '"></i>';
  }
  $('penQuick').addEventListener('input', function (e) {
    if ($('penQuick').dataset.mode === 'text') {
      INKOPT.text.fs = +e.target.value; inkSoon();
      var ts = $('penOpts').querySelector('[data-k=text][data-f=fs]'); if (ts) ts.value = INKOPT.text.fs;
      return;
    }
    INKOPT.pen.s = +e.target.value; inkSoon(true);
    var s = $('penOpts').querySelector('[data-k=pen][data-f=s]'); if (s) s.value = Math.round(INKOPT.pen.s);
  });
  // Tap the pen's dot for its colours (3.18): a small card beside it.
  function penColours() {
    var pop = $('penColPop');
    if (!pop) { pop = document.createElement('div'); pop.id = 'penColPop'; pop.className = 'pop hidden'; pop.setAttribute('data-keeps-text', ''); document.body.appendChild(pop);
      pop.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      pop.addEventListener('click', function (e) {
        var b = e.target.closest('[data-sw]'); if (!b) return;
        INKOPT.pen.c = b.dataset.c; applyInk(); savePref(); updatePenQuick(); pop.classList.add('hidden');
        if (!$('penOpts').classList.contains('hidden') && PREF.tool === 'pen') setTool('pen');
      });
      pop.addEventListener('input', function (e) { if (e.target.dataset.cc) { INKOPT.pen.c = e.target.value; applyInk(); savePref(); updatePenQuick(); } });
      document.addEventListener('pointerdown', function (e) { if (!pop.classList.contains('hidden') && !e.target.closest('#penColPop, #penQuick')) pop.classList.add('hidden'); }, true);
    }
    if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
    pop.innerHTML = swatches(INKOPT.pen.c, 'pen');
    var r = $('penQuick').getBoundingClientRect();
    pop.style.left = (r.right + 10) + 'px'; pop.style.top = ''; pop.style.bottom = (innerHeight - r.bottom) + 'px';
    pop.classList.remove('hidden');
  }
  var pqTap = 0;
  $('penQuick').querySelector('input').addEventListener('pointerdown', function () { // double-tap: sizes up to 120, or back to 24
    if ($('penQuick').dataset.mode === 'text') return;
    var now = Date.now();
    if (now - pqTap < 330) {
      PREF.bigSize = SIZE_MAX() <= 24; if (!PREF.bigSize && INKOPT.pen.s > 24) INKOPT.pen.s = 24;
      applyInk(); savePref(); updatePenQuick(); pqTap = 0;
      toast(PREF.bigSize ? 'Bigger sizes: up to 120' : 'Sizes up to 24', null, null, 1800); return;
    }
    pqTap = now;
  });
  $('penQuick').addEventListener('click', function (e) {
    if ($('penQuick').dataset.mode !== 'text' && e.target.closest('.pq-dot')) { penColours(); return; }
    if ($('penQuick').dataset.mode !== 'text' || !e.target.closest('.pq-dot')) return;
    var TF2 = TFONTS.concat(userFonts.map(fontCss)), i = TF2.indexOf(INKOPT.text.font);
    INKOPT.text.font = TF2[(i + 1) % TF2.length]; applyInk(); savePref(); updatePenQuick();
    if (!$('penOpts').classList.contains('hidden')) setTool('text');
  });
  $('toolQuick').addEventListener('pointerdown', function (e) { e.stopPropagation(); if (e.target.closest('button')) e.preventDefault(); });
  $('toolQuick').addEventListener('click', function (e) {
    var b2 = e.target.closest('[data-q2]'), Q2 = QUICK2[PREF.tool];
    if (b2 && Q2) { INKOPT[Q2[0]][Q2[1]] = b2.dataset.q2; applyInk(); savePref(); updatePenQuick(); return; }
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
  // ---------- Smoothness meter (3.38) ----------
  // Counts screen frames: frames a second, the longest gap between frames, and how many frames were late (over 50 ms)
  // in the last 5 seconds, plus what was happening (tool, note size). Always measured lightly; shown when turned on.
  var Meter = (function () {
    var gaps = [], last = 0, el = null, on = false, worst = { ms: 0, at: '' }, longT = 0;
    function what() {
      var t = (PREF && PREF.tool) || '', n = S.cur, items = 0;
      try { if (S.canvas && S.canvas.ink) S.canvas.ink().layers().forEach(function (l) { items += l.n; }); } catch (e) {}
      return t + (n ? ', ' + items + ' things on the page' : ', list');
    }
    function tick(t) {
      if (last) { var g = t - last; gaps.push([t, g]); if (g > worst.ms && !document.hidden) worst = { ms: Math.round(g), at: what() }; }
      last = t; while (gaps.length && gaps[0][0] < t - 5000) gaps.shift();
      if (on && el && (!tick.n || t - tick.n > 500)) { tick.n = t; el.innerHTML = line(); }
      requestAnimationFrame(tick);
    }
    function stats() {
      if (gaps.length < 2) return null;
      var span = gaps[gaps.length - 1][0] - gaps[0][0] + gaps[0][1], mx = 0, late = 0;
      gaps.forEach(function (g) { mx = Math.max(mx, g[1]); if (g[1] > 50) late++; });
      return { fps: Math.round(gaps.length * 1000 / Math.max(1, span)), max: Math.round(mx), late: late };
    }
    function line() { var x = stats(); if (!x) return '…'; var c = x.fps >= 50 && x.max < 50 ? 'ok' : x.fps >= 30 ? 'meh' : 'bad'; return '<i class="' + c + '"></i>' + x.fps + ' fps · longest ' + x.max + ' ms' + (x.late ? ' · ' + x.late + ' late' : ''); }
    try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { longT++; }); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
    document.addEventListener('visibilitychange', function () { last = 0; });
    requestAnimationFrame(tick);
    return {
      show: function (v) {
        on = !!v;
        if (on && !el) { el = document.createElement('div'); el.id = 'qnMeter'; el.setAttribute('aria-live', 'off'); document.body.appendChild(el); }
        if (el) el.classList.toggle('hidden', !on);
      },
      summary: function () {
        var x = stats();
        return (x ? x.fps + ' fps now, longest ' + x.max + ' ms, ' + x.late + ' late in 5 s' : 'not measured') +
          (worst.ms ? '; worst since opening ' + worst.ms + ' ms (' + worst.at + ')' : '') + (longT ? '; ' + longT + ' long tasks' : '') +
          '; ' + (navigator.hardwareConcurrency || '?') + ' cores, ' + (navigator.deviceMemory || '?') + ' GB';
      }
    };
  })();
  if (PREF.meter) Meter.show(true);
  function savePref() { try { localStorage.setItem('qn-pen', JSON.stringify(PREF)); } catch (e) {} }
  applyToolOrder();
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
    var card0 = $('penOpts');
    if ((PREF.tl || 'rail') !== 'rail' && typeof tlAnchor === 'function') {
      var an = tlAnchor() || ($('tools').querySelector('.tlx') || card0).getBoundingClientRect();
      return placeFloat(an);
    }
    ['position', 'width', 'left', 'right', 'bottom', 'maxHeight'].forEach(function (k) { card0.style[k] = ''; });
    var on = $('tools').querySelector('.tool[aria-pressed="true"]'), card = $('penOpts');
    card.style.top = on ? Math.max(0, on.offsetTop - $('tools').querySelector('.tool-row').scrollTop - 8) + 'px' : '0px';
  }
  function showOpts(on) {
    if (on && PREF.tool === 'type' && !$('tools').classList.contains('opts')) setTool('type'); // the Text card: for the box in use now (3.28)
    $('tools').classList.toggle('opts', !!on);
    if (on) { placeOpts(); if (!$('layersPanel').classList.contains('hidden')) { $('layersPanel').classList.add('hidden'); layersBtn(); } }
  }
  // ---------- Tool layouts (3.31): Rail, Wheel, Pucks, Pen first ----------
  // The same tools and settings cards, laid out four ways (Settings › Look › Tool layout), and each fitted to the
  // screen: phone upright / sideways, tablet upright / sideways, computer. Everything lives inside #tools, so the
  // rail's own click handling (tap a tool; tap it again for its card) works for every layout.
  var TL = { dev: '', els: [], radial: null, hold: null, wpos: null };
  function devClass() {
    var w = innerWidth, h = innerHeight, phone = Math.min(w, h) < 600;
    var desk = !phone && matchMedia('(hover: hover) and (pointer: fine)').matches;
    return phone ? (w > h ? 'phone-l' : 'phone-p') : desk ? 'desk' : (w > h ? 'tab-l' : 'tab-p');
  }
  function tlItems() { // the rail's buttons, in the user's order
    return [].slice.call($('tools').querySelectorAll('.tool-row > button.tool')).filter(function (b) { return b.dataset.tool || b.dataset.act; }).map(function (b) {
      return { tool: b.dataset.tool, act: b.dataset.act, label: b.getAttribute('aria-label') || b.title || '', icon: (b.querySelector('svg') || {}).outerHTML || '' };
    });
  }
  function tlBtn(it, cls, style) {
    var attr = it.tool ? 'data-tool="' + it.tool + '" aria-pressed="' + (it.tool === PREF.tool) + '"' : 'data-act="' + it.act + '"';
    return '<button type="button" class="tlb ' + (cls || '') + '" ' + attr + ' aria-label="' + esc(it.label) + '" title="' + esc(it.label) + '" style="' + (style || '') + '">' + it.icon + '</button>';
  }
  function tlKey() { var t = PREF.tool; return INKOPT[t] && ('s' in INKOPT[t] || 'c' in INKOPT[t]) ? t : 'pen'; }
  function tlColour() { var k = tlKey(), c = INKOPT[k] && INKOPT[k].c; return !c || c === 'ink' ? 'var(--ink)' : c; }
  function setQuickColour(c) { var k = INKOPT[PREF.tool] && 'c' in INKOPT[PREF.tool] ? PREF.tool : 'pen'; INKOPT[k].c = c; applyInk(); savePref(); setTool(PREF.tool); }
  function tlRange(k, f) { // what a puck or an arc changes, and its range
    if (f === 'o') return [0.05, 1];
    if (k === 'erase') return [4, 80];
    if (k === 'text') return [10, 160];
    return [1, SIZE_MAX()];
  }
  function tlSet(f, frac) {
    var k = tlKey(), r = tlRange(k, f), o = INKOPT[k]; if (!o) return;
    var v = r[0] + (r[1] - r[0]) * Math.max(0, Math.min(1, frac));
    if (k === 'text' && f === 's') o.fs = Math.round(v); else o[f] = f === 'o' ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10;
    applyInk(); savePref(); tlRefresh();
  }
  function tlGet(f) { var k = tlKey(), r = tlRange(k, f), o = INKOPT[k] || {}, v = k === 'text' && f === 's' ? o.fs : o[f]; if (v == null) v = f === 'o' ? 1 : r[0]; return (v - r[0]) / (r[1] - r[0]); }
  function tlClear() { TL.els.forEach(function (e) { e.remove(); }); TL.els = []; closeRadial(); }
  function tlAdd(html, cls) { var d = document.createElement('div'); d.className = 'tlx ' + cls; d.innerHTML = html; $('tools').appendChild(d); TL.els.push(d); return d; }
  function applyLayout() {
    var tl = PREF.tl || 'rail', dev = devClass(), r = document.documentElement;
    r.dataset.tl = tl; r.dataset.dev = dev; TL.dev = dev;
    tlClear();
    if (tl === 'wheel') buildWheel(); else if (tl === 'pucks') buildPucks(); else if (tl === 'pen1') buildPal();
    if ($('tools').classList.contains('opts')) placeOpts();
  }
  function tlRefresh() { // after a tool, colour or size change: the parts that show them
    var c = tlColour();
    Array.prototype.forEach.call($('tools').querySelectorAll('.tl-colour'), function (e) { e.style.background = c; });
    var w = $('tools').querySelector('.tl-wheel'); if (w) drawWheelArcs(w);
    var pk = $('tools').querySelector('.tl-sizepuck i'); if (pk) { var d = 8 + 26 * tlGet('s'); pk.style.width = pk.style.height = d + 'px'; pk.style.opacity = 0.25 + 0.75 * tlGet('o'); pk.style.background = c; }
    var cen = $('tools').querySelector('.tl-centre'), it = tlItems().filter(function (x) { return x.tool === PREF.tool; })[0];
    if (cen && it) cen.innerHTML = it.icon + '<span>' + esc(it.label.split(':')[0]) + '</span>';
  }
  // Where the settings card goes when it isn't beside the rail: next to what opened it, on the side with room,
  // tall and narrow on an upright phone, wide and short on a sideways one.
  function placeFloat(a) {
    var c = $('penOpts'), W = innerWidth, H = innerHeight, dev = TL.dev;
    var w = dev === 'phone-p' ? Math.min(250, W - 24) : dev === 'phone-l' ? Math.min(560, Math.round(W * 0.62)) : Math.min(340, W - 24);
    c.style.position = 'fixed'; c.style.width = w + 'px'; c.style.right = 'auto'; c.style.bottom = 'auto';
    var top, left, wide = a.width > W * 0.45, mx = (a.left + a.right) / 2;
    if (wide) { // a bar: below it, or above it when it sits low
      left = Math.max(8, Math.min(W - w - 8, mx - w / 2));
      if (a.top > H / 2) { c.style.top = 'auto'; c.style.bottom = (H - a.top + 8) + 'px'; c.style.maxHeight = (a.top - 70) + 'px'; c.style.left = left + 'px'; return; }
      top = a.bottom + 8;
    } else {
      left = mx > W / 2 ? a.left - w - 10 : a.right + 10;
      if (left < 8 || left + w > W - 8) left = mx > W / 2 ? 8 : W - w - 8; // no room beside it: the far side
      top = dev === 'phone-p' ? 64 : Math.max(dev === 'phone-l' ? 6 : 64, Math.min(a.top, H - 320));
    }
    c.style.left = Math.round(left) + 'px'; c.style.top = Math.round(top) + 'px'; c.style.maxHeight = Math.max(160, H - top - 10) + 'px';
  }
  function tlAnchor() { var a = $('tools').querySelector('.tlx.anchor'); return a && a.getBoundingClientRect(); }

  // --- Wheel (like Concepts): tools round a ring, colours on the rim, size and opacity on two arcs ---
  function wheelSize() { return { 'phone-p': 214, 'phone-l': 196, 'tab-p': 280, 'tab-l': 280, 'desk': 270 }[TL.dev] || 260; }
  function wheelHome(D) { // where it sits first on each kind of screen (the thumb or the free hand)
    var W = innerWidth, H = innerHeight, m = 34 + D / 2, top = document.body.classList.contains('has-tabs') ? 150 : 110;
    if (TL.dev === 'phone-p' || TL.dev === 'tab-p') return [W - m + 8, H - m - 70];
    if (TL.dev === 'phone-l') return [W - m + 6, H / 2 + 10];
    return [W - m + 8, Math.max(top + D / 2 - 20, H / 2 + 20)]; // the right side, where the rail was
  }
  function buildWheel() {
    var D = wheelSize(), R = D / 2, items = tlItems(), n = items.length, bs = D < 240 ? 32 : 40, rt = R * 0.64;
    var saved = PREF.wheelAt && PREF.wheelAt[TL.dev], at = saved ? [saved[0] * innerWidth, saved[1] * innerHeight] : wheelHome(D);
    var h = '<svg class="tl-wsvg" width="' + (D + 70) + '" height="' + (D + 70) + '" viewBox="' + (-35) + ' ' + (-35) + ' ' + (D + 70) + ' ' + (D + 70) + '" aria-hidden="true">' +
      '<circle cx="' + R + '" cy="' + R + '" r="' + R + '" class="tl-disc"/><g class="tl-arcs"></g></svg>';
    items.forEach(function (it, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / n, x = R + rt * Math.cos(a) - bs / 2 + 35, y = R + rt * Math.sin(a) - bs / 2 + 35;
      h += tlBtn(it, 'tl-ring', 'left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;width:' + bs + 'px;height:' + bs + 'px');
    });
    SWATCH.slice(0, 12).forEach(function (c, i, all) {
      var a = -Math.PI / 2 + (i + 0.5) * 2 * Math.PI / all.length, rr = R - (D < 240 ? 9 : 11), s = D < 240 ? 14 : 17;
      h += '<button type="button" class="tl-sw" data-qc="' + c + '" aria-label="Colour ' + c + '" style="left:' + (R + rr * Math.cos(a) - s / 2 + 35).toFixed(1) + 'px;top:' + (R + rr * Math.sin(a) - s / 2 + 35).toFixed(1) + 'px;width:' + s + 'px;height:' + s + 'px;background:' + (c === 'ink' ? 'var(--ink)' : c) + '"></button>';
    });
    var cr = R * 0.38;
    h += '<button type="button" class="tl-centre" data-wc aria-label="This tool’s settings" title="Tap: this tool’s settings. Drag the ring to move the wheel." style="left:' + (R - cr + 35) + 'px;top:' + (R - cr + 35) + 'px;width:' + 2 * cr + 'px;height:' + 2 * cr + 'px"></button>';
    var w = tlAdd(h, 'tl-wheel anchor');
    w.style.width = w.style.height = (D + 70) + 'px';
    TL.wpos = at; placeWheel(w);
    tlRefresh();
    wheelDrag(w);
  }
  function placeWheel(w) {
    var D = wheelSize(), S = D + 70, W = innerWidth, H = innerHeight, x = Math.max(D / 2 - 20, Math.min(W - D / 2 + 20, TL.wpos[0])), y = Math.max(D / 2 + 30, Math.min(H - D / 2 + 20, TL.wpos[1]));
    TL.wpos = [x, y]; w.style.left = Math.round(x - S / 2) + 'px'; w.style.top = Math.round(y - S / 2) + 'px';
    drawWheelArcs(w);
  }
  function arcPath(cx, cy, r, a0, a1) { var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1); return 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + 'A' + r + ' ' + r + ' 0 0 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1); }
  function wheelArcs() { // the two arcs face the middle of the screen, where there is room
    var D = wheelSize(), R = D / 2, toMid = Math.atan2(innerHeight / 2 - TL.wpos[1], innerWidth / 2 - TL.wpos[0]);
    return [{ f: 's', label: 'Size', a0: toMid - 1.05, a1: toMid - 0.12 }, { f: 'o', label: 'Opacity', a0: toMid + 0.12, a1: toMid + 1.05 }].map(function (x) { x.r = R + 16; x.cx = R; x.cy = R; return x; });
  }
  function drawWheelArcs(w) {
    var g = w.querySelector('.tl-arcs'); if (!g) return;
    g.innerHTML = wheelArcs().map(function (x) {
      var v = tlGet(x.f), am = x.a0 + (x.a1 - x.a0) * v, kx = x.cx + x.r * Math.cos(am), ky = x.cy + x.r * Math.sin(am), lm = (x.a0 + x.a1) / 2;
      return '<path d="' + arcPath(x.cx, x.cy, x.r, x.a0, x.a1) + '" class="tl-track"/><path d="' + arcPath(x.cx, x.cy, x.r, x.a0, Math.max(x.a0 + 0.001, am)) + '" class="tl-fill"/>' +
        '<path d="' + arcPath(x.cx, x.cy, x.r, x.a0, x.a1) + '" class="tl-hit" data-arc="' + x.f + '"/>' +
        '<circle cx="' + kx.toFixed(1) + '" cy="' + ky.toFixed(1) + '" r="9" class="tl-knob"/>' +
        '<text x="' + (x.cx + (x.r + 20) * Math.cos(lm)).toFixed(1) + '" y="' + (x.cy + (x.r + 20) * Math.sin(lm) + 4).toFixed(1) + '" text-anchor="middle" class="tl-lab">' + x.label + '</text>';
    }).join('');
  }
  function wheelDrag(w) {
    var st = null;
    w.addEventListener('pointerdown', function (e) {
      var arc = e.target.closest && e.target.closest('[data-arc]');
      if (w.classList.contains('mini')) return;
      if (arc) { e.preventDefault(); st = { arc: arc.dataset.arc }; w.setPointerCapture(e.pointerId); return; }
      if (e.target.closest('button')) return;
      st = { x: e.clientX, y: e.clientY, at: TL.wpos.slice(), moved: false }; w.setPointerCapture(e.pointerId);
    });
    w.addEventListener('pointermove', function (e) {
      if (!st) return;
      if (st.arc) {
        var x = wheelArcs().filter(function (q) { return q.f === st.arc; })[0], r = w.getBoundingClientRect();
        var a = Math.atan2(e.clientY - (r.top + 35 + x.cy), e.clientX - (r.left + 35 + x.cx)), d = a - x.a0;
        while (d < -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
        tlSet(st.arc, d / (x.a1 - x.a0)); return;
      }
      var dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.moved && Math.hypot(dx, dy) < 6) return;
      st.moved = true; TL.wpos = [st.at[0] + dx, st.at[1] + dy]; placeWheel(w); if ($('tools').classList.contains('opts')) placeOpts();
    });
    function up() {
      if (st && st.moved) { PREF.wheelAt = PREF.wheelAt || {}; PREF.wheelAt[TL.dev] = [TL.wpos[0] / innerWidth, TL.wpos[1] / innerHeight]; savePref(); }
      if (st && st.arc) setTool(PREF.tool);
      st = null;
    }
    w.addEventListener('pointerup', up); w.addEventListener('pointercancel', up);
  }

  // --- Pucks and corner menu (like Sketchbook) ---
  function buildPucks() {
    var dev = TL.dev;
    tlAdd('<button type="button" class="tl-puck tl-sizepuck" data-puck aria-label="Pen puck: drag up or down for size, sideways for opacity; tap for settings" title="Drag ↕ size · ↔ opacity · tap: settings"><i></i></button><span class="tl-bubble hidden"></span>', 'tl-pucks-l');
    tlAdd('<button type="button" class="tl-puck tl-colpuck" data-colpop aria-label="Colours" title="Colours"><i class="tl-colour"></i></button>', 'tl-pucks-r');
    if (dev !== 'phone-p') {
      var it = [['undo', '#i-undo', 'Undo'], ['opts', '#i-tools', 'This tool’s settings'], ['colpop', '', 'Colours'], ['act:layers', '#i-layers', 'Layers'], ['redo', '#i-redo', 'Redo']];
      var Rr = dev === 'phone-l' ? 92 : 118, s = dev === 'phone-l' ? 38 : 44, h = '';
      // A quarter disc in the corner with its five buttons on an arc.
      it.forEach(function (x, i) {
        var a = (i + 0.5) * (Math.PI / 2) / it.length, bx = Math.round(Rr * Math.cos(a) - s / 2), by = Math.round(Rr * Math.sin(a) - s / 2);
        var attr = x[0].indexOf('act:') === 0 ? 'data-act="' + x[0].slice(4) + '"' : x[0] === 'colpop' ? 'data-colpop' : 'data-cm="' + x[0] + '"';
        h += '<button type="button" class="tl-cm" ' + attr + ' aria-label="' + x[2] + '" title="' + x[2] + '" style="left:' + bx + 'px;bottom:' + by + 'px;width:' + s + 'px;height:' + s + 'px">' + (x[1] ? '<svg class="i"><use href="' + x[1] + '"/></svg>' : '<i class="tl-colour"></i>') + '</button>';
      });
      var cm = tlAdd(h, 'tl-corner'); cm.style.width = cm.style.height = (Rr + s / 2 + 14) + 'px';
    }
    tlRefresh();
    var pk = $('tools').querySelector('.tl-sizepuck'), bub = $('tools').querySelector('.tl-bubble'), ps = null;
    pk.addEventListener('pointerdown', function (e) { e.preventDefault(); pk.setPointerCapture(e.pointerId); ps = { x: e.clientX, y: e.clientY, s: tlGet('s'), o: tlGet('o'), moved: false, ax: null }; });
    pk.addEventListener('pointermove', function (e) {
      if (!ps) return; var dx = e.clientX - ps.x, dy = e.clientY - ps.y;
      if (!ps.moved && Math.hypot(dx, dy) < 6) return;
      ps.moved = true; if (!ps.ax) ps.ax = Math.abs(dy) >= Math.abs(dx) ? 's' : 'o';
      if (ps.ax === 's') tlSet('s', ps.s - dy / 220); else tlSet('o', ps.o + dx / 220);
      var k = tlKey(), o = INKOPT[k] || {};
      bub.classList.remove('hidden'); bub.textContent = ps.ax === 's' ? 'Size ' + (k === 'text' ? o.fs : o.s) : 'Opacity ' + Math.round((o.o == null ? 1 : o.o) * 100) + '%';
    });
    function pup() { if (ps && !ps.moved) showOpts(!$('tools').classList.contains('opts')); else if (ps) setTool(PREF.tool); ps = null; bub.classList.add('hidden'); }
    pk.addEventListener('pointerup', pup); pk.addEventListener('pointercancel', pup);
    pk.addEventListener('click', function (e) { e.stopPropagation(); }, true);
  }
  function colourPop(anchor) {
    var old = $('tools').querySelector('.tl-colpop'); if (old) { old.remove(); return; }
    var k = INKOPT[PREF.tool] && 'c' in INKOPT[PREF.tool] ? PREF.tool : 'pen', cur = INKOPT[k].c;
    var p = tlAdd(SWATCH.map(function (c) { return '<button type="button" class="tl-sw2" data-qc="' + c + '" aria-pressed="' + (c === cur) + '" aria-label="Colour ' + c + '" style="background:' + (c === 'ink' ? 'var(--ink)' : c) + '"></button>'; }).join('') +
      '<button type="button" class="tl-more" data-wc>More…</button>', 'tl-colpop');
    var a = anchor.getBoundingClientRect(), W = innerWidth, pw = Math.min(232, W - 16);
    p.style.width = pw + 'px';
    p.style.left = Math.round(a.left + a.width / 2 > W / 2 ? Math.max(8, a.left - pw - 10) : Math.min(W - pw - 8, a.right + 10)) + 'px';
    p.style.top = Math.round(Math.max(60, Math.min(innerHeight - 200, a.top - 40))) + 'px';
  }

  // --- Pen first: a small palette of the last tools, and the tools come to your finger ---
  function recentTools() {
    var r = (PREF.recent || ['pen', 'erase', 'lasso', 'hand']).filter(function (t) { return $('tools').querySelector('.tool-row [data-tool="' + t + '"]'); });
    return r.slice(0, TL.dev === 'phone-l' ? 3 : 4);
  }
  function buildPal() {
    var all = tlItems(), h = recentTools().map(function (t) { return tlBtn(all.filter(function (x) { return x.tool === t; })[0]); }).join('');
    h += '<button type="button" class="tlb" data-colpop aria-label="Colours" title="Colours"><i class="tl-colour"></i></button>' +
      '<button type="button" class="tlb" data-radial aria-label="All tools (or hold a finger on the page)" title="All tools (or hold a finger on the page; right-click with a mouse)"><svg class="i"><use href="#i-tools"/></svg></button>';
    tlAdd(h, 'tl-pal anchor'); tlRefresh();
  }
  function openRadial(x, y, touchId) {
    closeRadial();
    var all = tlItems(), want = ['hand', 'type', 'pen', 'erase', 'lasso', 'fill', 'guide'], items = want.map(function (t) { return all.filter(function (z) { return z.tool === t; })[0]; }).filter(Boolean);
    items.push(all.filter(function (z) { return z.act === 'layers'; })[0]); items = items.filter(Boolean);
    var R = TL.dev.indexOf('phone') === 0 ? 74 : 90, s = TL.dev.indexOf('phone') === 0 ? 44 : 50, W = innerWidth, H = innerHeight;
    x = Math.max(R + s / 2 + 6, Math.min(W - R - s / 2 - 6, x)); y = Math.max(R + s / 2 + 6, Math.min(H - R - s / 2 - 6, y));
    var h = items.map(function (it, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / items.length;
      return tlBtn(it, 'tl-rb', 'left:' + Math.round(R + R * Math.cos(a) - s / 2 + s / 2) + 'px;top:' + Math.round(R + R * Math.sin(a) - s / 2 + s / 2) + 'px;width:' + s + 'px;height:' + s + 'px');
    }).join('') + '<button type="button" class="tl-rc" data-wc aria-label="This tool’s settings" style="left:' + (R + s / 2 - 22) + 'px;top:' + (R + s / 2 - 22) + 'px"><svg class="i"><use href="#i-tools"/></svg></button>';
    var r = tlAdd(h, 'tl-radial'); var S = 2 * R + s;
    r.style.width = r.style.height = S + 'px'; r.style.left = Math.round(x - S / 2) + 'px'; r.style.top = Math.round(y - S / 2) + 'px';
    TL.radial = { el: r, id: touchId };
  }
  function closeRadial() { if (TL.radial) { TL.radial.el.remove(); TL.els = TL.els.filter(function (e) { return e !== TL.radial.el; }); TL.radial = null; } }
  // Hold one finger still on the page (half a second): the tools come round it. Slide onto one and lift to pick
  // it, or lift and tap. Not while picking or typing (holding means something there). Right-click with a mouse.
  document.addEventListener('pointerdown', function (e) {
    if ((PREF.tl || 'rail') !== 'pen1' || S.view !== 'note' || !e.target.closest || !e.target.closest('#canvasWrap')) return;
    if (TL.radial && !e.target.closest('.tl-radial')) { closeRadial(); return; }
    if (e.pointerType !== 'touch' || PREF.tool === 'lasso' || PREF.tool === 'type' || e.target.closest('.box, .ProseMirror')) return;
    if (TL.hold) { clearTimeout(TL.hold.t); TL.hold = null; return; } // a second finger: a gesture, not a hold
    var h = TL.hold = { x: e.clientX, y: e.clientY, id: e.pointerId, target: e.target };
    h.t = setTimeout(function () {
      if (TL.hold !== h) return; TL.hold = null;
      try { h.target.dispatchEvent(new PointerEvent('pointercancel', { pointerId: h.id, pointerType: 'touch', bubbles: true })); } catch (x) {}
      openRadial(h.x, h.y, h.id); TL.dragging = h.id;
      if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {}
    }, 480);
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (TL.hold && e.pointerId === TL.hold.id && Math.hypot(e.clientX - TL.hold.x, e.clientY - TL.hold.y) > 10) { clearTimeout(TL.hold.t); TL.hold = null; }
    if (TL.radial && TL.dragging === e.pointerId) {
      var on = document.elementFromPoint(e.clientX, e.clientY), b = on && on.closest && on.closest('.tl-radial button');
      Array.prototype.forEach.call(TL.radial.el.querySelectorAll('button'), function (x) { x.classList.toggle('hot', x === b); });
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
  document.addEventListener('pointerup', function (e) {
    if (TL.hold && e.pointerId === TL.hold.id) { clearTimeout(TL.hold.t); TL.hold = null; }
    if (TL.radial && TL.dragging === e.pointerId) {
      TL.dragging = null; var hot = TL.radial.el.querySelector('.hot');
      e.preventDefault(); e.stopPropagation();
      if (hot) { hot.click(); closeRadial(); }
    }
  }, true);
  document.addEventListener('contextmenu', function (e) {
    if ((PREF.tl || 'rail') !== 'pen1' || S.view !== 'note' || !e.target.closest || !e.target.closest('#canvasWrap') || e.target.closest('.box, .ProseMirror')) return;
    e.preventDefault(); openRadial(e.clientX, e.clientY, null);
  });
  // The wheel shrinks to a small dot while you draw; tap the dot to bring it back.
  document.addEventListener('pointerdown', function (e) {
    var w = $('tools').querySelector('.tl-wheel'); if (!w || !e.target.closest) return;
    if (e.target.closest('#canvasWrap') && !e.target.closest('#tools')) { if (!w.classList.contains('mini')) { w.classList.add('mini'); } }
  }, true);
  $('tools').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button'); if (!b) return;
    var w = b.closest('.tl-wheel');
    if (w && w.classList.contains('mini')) { e.stopPropagation(); e.preventDefault(); w.classList.remove('mini'); return; }
    if (b.dataset.qc) { e.stopPropagation(); setQuickColour(b.dataset.qc); var p = $('tools').querySelector('.tl-colpop'); if (p) p.remove(); return; }
    if (b.hasAttribute('data-wc')) { e.stopPropagation(); var p2 = $('tools').querySelector('.tl-colpop'); if (p2) p2.remove(); closeRadial(); showOpts(!$('tools').classList.contains('opts')); return; }
    if (b.hasAttribute('data-colpop')) { e.stopPropagation(); showOpts(false); colourPop(b); return; }
    if (b.hasAttribute('data-radial')) { e.stopPropagation(); var r = b.getBoundingClientRect(); if (TL.dev === 'phone-l') openRadial(r.left + r.width / 2, r.top - 110, null); else openRadial(r.left - 120, r.top + r.height / 2, null); return; }
    if (b.dataset.cm === 'undo') { e.stopPropagation(); $('undoBtn').click(); return; }
    if (b.dataset.cm === 'redo') { e.stopPropagation(); $('redoBtn').click(); return; }
    if (b.dataset.cm === 'opts') { e.stopPropagation(); showOpts(!$('tools').classList.contains('opts')); return; }
    if (b.closest('.tl-radial') && (b.dataset.tool || b.dataset.act)) setTimeout(closeRadial, 0);
  }, true);
  var tlResize = null;
  addEventListener('resize', function () { clearTimeout(tlResize); tlResize = setTimeout(function () { if (devClass() !== TL.dev || (PREF.tl || 'rail') !== 'rail') applyLayout(); }, 150); });
  var setTool1 = setTool;
  setTool = function (t) {
    setTool1(t);
    if (t && $('tools').querySelector('.tool-row [data-tool="' + t + '"]')) { var r = (PREF.recent || ['pen', 'erase', 'lasso', 'hand']).filter(function (x) { return x !== t; }); r.unshift(t); PREF.recent = r.slice(0, 6); }
    if ((PREF.tl || 'rail') === 'pen1' && $('tools').querySelector('.tl-pal')) { applyLayout(); return; }
    tlRefresh();
  };
  function setSide(left) { PREF.toolsLeft = !!left; savePref(); $('tools').classList.toggle('left', !!left); if (!$('layersPanel').classList.contains('hidden')) renderLayers(); }
  setSide(PREF.toolsLeft);
  applyLayout();
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
      PREF.picked = b.dataset.tool; setTool(b.dataset.tool); showOpts(false);
      if (!PREF.optsHint && $('penOpts').innerHTML) { PREF.optsHint = true; savePref(); toast('Tap the tool again for its settings.', null, null, 3000); }
      return;
    }
    if (b.dataset.finger) {
      PREF.finger = b.dataset.finger === 'auto' ? '' : b.dataset.finger; savePref();
      toast(b.dataset.finger === 'draw' ? 'Your finger draws. Two fingers still move and zoom the page.' : b.dataset.finger === 'scroll' ? 'Your finger moves the page; only the pen draws.' : 'Your finger draws until you use a pen.', null, null, 3000);
      return setTool(PREF.tool);
    }
    if (b.dataset.act === 'layers') return toggleLayers();
    if (b.dataset.act === 'image') { if (addHeld) { addHeld = false; return; } addToPage(); return; } // any files onto the page
    if (b.dataset.guide) { if (S.canvas) S.canvas.ink().guideToggle(b.dataset.guide); return setTool('guide'); }
    if (b.dataset.gsnap != null) { INKOPT.guide.snap = INKOPT.guide.snap === false; applyInk(); savePref(); return setTool('guide'); }
    if (b.dataset.gclear != null) { if (S.canvas) S.canvas.ink().guideClear(); return setTool('guide'); }
    if (b.dataset.snap != null) { INKOPT.pen.snap = INKOPT.pen.snap === false; applyInk(); savePref(); return setTool('pen'); }
    if (b.dataset.cs != null) { switchPen(function () { if (b.dataset.cs) INKOPT.pen.cs = b.dataset.cs; else delete INKOPT.pen.cs; }); return setTool('pen'); }
    if (b.dataset.big != null) { PREF.bigSize = SIZE_MAX() <= 24; if (!PREF.bigSize && INKOPT.pen.s > 24) INKOPT.pen.s = 24; applyInk(); savePref(); return setTool('pen'); }
    if (b.dataset.pt != null) { if (b.dataset.pt) INKOPT.fill.pt = b.dataset.pt; else delete INKOPT.fill.pt; applyInk(); savePref(); return setTool('fill'); }
    if (b.dataset.newdef) return editStyle(b.dataset.newdef, null);
    if (b.dataset.editdef) { var dd = MYSTYLES.filter(function (d) { return d.id === b.dataset.editdef; })[0]; if (dd) editStyle(dd.k, dd); return; }
    if (b.dataset.brush) { switchPen(function () { INKOPT.pen.b = b.dataset.brush; }); return setTool('pen'); }
    if (b.dataset.m) { INKOPT[b.dataset.k].m = b.dataset.m; return setTool(PREF.tool); }
    if (b.dataset.set) { var kv = b.dataset.set.split('.'); INKOPT[kv[0]][kv[1]] = b.dataset.v; return setTool(PREF.tool); }
    if (b.dataset.sw) { INKOPT[b.dataset.sw].c = b.dataset.c; applyInk(); savePref(); return setTool(PREF.tool); }
    if (b.dataset.pnew) { S.canvas.addPaper(b.dataset.pnew, b.dataset.pnew === 'sticky' ? (PREF.stickyC || STICKY_C[0]) : null); return setTool('type'); }
    if (b.dataset.pset != null) { if (!S.canvas.paper(b.dataset.pset, b.dataset.pset === 'sticky' ? (PREF.stickyC || STICKY_C[0]) : null)) toast('Pick or type in a text box first.'); return setTool('type'); }
    if (b.dataset.pcol) { PREF.stickyC = b.dataset.pcol; savePref(); var pc = S.canvas.paperOf && S.canvas.paperOf(); if (pc && pc.st === 'sticky') S.canvas.paper('sticky', b.dataset.pcol); return setTool('type'); }
    if (b.dataset.lnke != null) { PREF.linkE = b.dataset.lnke; savePref(); return setTool('link'); }
    if (b.dataset.lnkk) { PREF.linkK = b.dataset.lnkk; savePref(); return setTool('link'); }
    if (b.dataset.tf || b.dataset.tls || b.dataset.tps || b.dataset.ttk) {
      var tt = S.canvas && S.canvas.textTarget && S.canvas.textTarget(); if (!tt) return;
      if (b.dataset.tls) { S.canvas.boxSpacing('ls', +b.dataset.tls === 1.55 ? null : b.dataset.tls); return setTool('type'); }
      if (b.dataset.ttk) { S.canvas.boxSpacing('tk', +b.dataset.ttk === 0 ? null : b.dataset.ttk); return setTool('type'); }
      if (b.dataset.tps) { S.canvas.boxSpacing('ps', +b.dataset.tps === 0.35 ? null : b.dataset.tps); return setTool('type'); }
      return fmtDo(b.dataset.tf, b, tt.ed, !tt.typing);
    }
    if (b.dataset.tfont != null) { INKOPT.text.font = b.dataset.tfont; applyInk(); savePref(); return setTool('text'); }
  });
  // While artistic text is being written, tapping the Text card's buttons keeps the keyboard and the writing going.
  $('tools').addEventListener('pointerdown', function (e) {
    if (S.canvas && S.canvas.ink().editingText() && e.target.closest('button') && !e.target.closest('[data-act=closeopts]')) e.preventDefault();
    if (S.canvas && S.canvas.active() && e.target.closest('[data-tf], [data-tls], [data-tps], [data-ttk]')) e.preventDefault(); // keep typing (3.28)
  });
  $('tools').addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset.cc) { INKOPT[t.dataset.cc].c = t.value; applyInk(); savePref(); return; }
    if (t.dataset.k) { INKOPT[t.dataset.k][t.dataset.f] = +t.value / +t.dataset.scale; inkSoon(true); }
  });
  $('tools').addEventListener('change', function (e) { if (e.target.dataset.cc) setTool(PREF.tool); });

  // ---------- Zoom, navigator and turning ----------
  function applyViewPrefs() {
    if (!S.canvas) return;
    S.canvas.viewOps.navigator(!!PREF.nav); S.canvas.viewOps.rotate(PREF.rotate !== false);
    $('navState').textContent = PREF.nav ? 'On' : 'Off'; $('rotState').textContent = PREF.rotate !== false ? 'On' : 'Off';
    window.QNPageMode = PREF.pageMode || 'auto';
    $('pageState').textContent = { auto: 'Phone upright', on: 'Always', off: 'Never (free canvas)' }[window.QNPageMode];
    $('lockState').textContent = S.canvas.viewOps.locked() ? 'On' : 'Off';
  }
  window.QNPageMode = PREF.pageMode || 'auto';
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
    if (v === 'page') { var nx = { auto: 'off', off: 'on', on: 'auto' }; PREF.pageMode = nx[PREF.pageMode || 'auto']; savePref(); applyViewPrefs(); ops.followPref(); ops.actual(); return; }
    if (v === 'lock') { var lk = ops.lock(); applyViewPrefs(); closeViewMenu(); toast(lk ? 'Zoom and turn locked for this note: fingers only scroll.' : 'Zoom and turn unlocked.', null, null, 2500); return; }
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
    if (!rail.width) { var an = $('tools').querySelector('.tlx.anchor, .tl-pucks-r'); rail = an ? an.getBoundingClientRect() : { top: 70, left: innerWidth - 12, right: innerWidth - 12 }; if (rail.top > innerHeight - 300) rail = { top: 70, left: rail.left, right: rail.right }; }
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
    // The background (3.23): two special layers under all the others, a grid and a texture. Tap one to choose.
    if (!sel && window.QNBg) {
      var B = window.QNBg.parse(S.cur && S.cur.page), GN = B.g && window.QNBg.GRIDS.filter(function (g) { return g[0] === B.g; })[0], TN = B.t && window.QNBg.TEXTURES.filter(function (t) { return t[0] === B.t; })[0];
      var bgCard = function (kind, name, sub, on, thumb) {
        return '<div class="lcard lbg' + (on ? '' : ' hid') + '" data-bg="' + kind + '"><div class="lthumb">' + thumb + '</div><div class="lmeta"><b>' + name + '</b><small>' + sub + '</small></div>' +
          lic(on ? 'eye' : 'eyeOff', 'data-lo="bgvis" data-k="' + kind + '"', on ? 'Hide' : 'Show', on ? '' : 'off') + '</div>';
      };
      html += '<div class="lbgs"><small class="lbgh">Background</small>' +
        bgCard('g', 'Grid', GN ? GN[1] : 'None (tap to choose)', B.gv !== false && !!GN, GN ? bgThumb(B, 'g') : '') +
        bgCard('t', 'Texture', TN ? TN[1] : 'None (tap to choose)', B.tv !== false && !!TN, TN ? bgThumb(B, 't') : '') + '</div>';
    }
    html += '</div>' + (sel ? '' : '<p class="lhint">Tap a layer again for its settings. Hold to pick several; hold and drag to move it.</p>');
    p.innerHTML = html;
  }
  function bgThumb(B, kind) { // a little square of the grid (on the texture's colour) or of the texture
    var Q = window.QNBg, surf = Q.surfaceColour(B) || getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    if (kind === 't') return '<span class="bgsw" style="background:' + surf + (B.t !== 'plain' ? ' url(' + Q.textureUrl(B.t, B.tc) + ') 0 0/96px' : '') + '"></span>';
    var C = Q.css(JSON.stringify({ g: B.g, gs: 0.6, go: B.go, gc: B.gc, t: B.t, tc: B.tc }), false);
    return '<span class="bgsw" style="background-color:' + (C.color || surf) + ';background-image:' + C.image + ';background-size:' + C.size + '"></span>';
  }
  function setBg(change) { // change the note's background and show it
    var n = S.cur; if (!n || !S.canvas) return;
    var B = window.QNBg.parse(n.page); change(B);
    n.page = window.QNBg.stringify(B); S.canvas.setPage(n.page); touchNote(n);
    renderLayers();
  }
  function bgSheet(kind) {
    var Q = window.QNBg, B = Q.parse(S.cur && S.cur.page);
    var surf = Q.surfaceColour(B) || getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    var sw = function (attr, list, cur, first) { return (first || '') + list.map(function (c) { return '<button type="button" class="swatch' + (cur === c ? ' on' : '') + '" ' + attr + '="' + c + '" style="background:' + c + '" aria-label="Colour ' + c + '"></button>'; }).join('') +
      '<label class="swatch custom" aria-label="Any colour"><input type="color" ' + attr + '-any value="' + (/^#[0-9a-f]{6}$/i.test(cur || '') ? cur : '#888888') + '"></label>'; };
    var html;
    if (kind === 'g') {
      html = '<h2>Grid</h2><div class="bgpick">' + '<button type="button" class="bgt' + (!B.g ? ' on' : '') + '" data-bgg=""><span class="bgsw" style="background:' + surf + '"></span><small>None</small></button>' +
        Q.GRIDS.map(function (g) { var C = Q.css(JSON.stringify({ g: g[0], gs: 0.6, go: B.go, gc: B.gc, t: B.t, tc: B.tc }), Q.isDark(surf)); return '<button type="button" class="bgt' + (B.g === g[0] ? ' on' : '') + '" data-bgg="' + g[0] + '"><span class="bgsw" style="background-color:' + (C.color || surf) + ';background-image:' + C.image + ';background-size:' + C.size + '"></span><small>' + g[1] + '</small></button>'; }).join('') + '</div>' +
        '<div class="osec">Line colour</div><div class="swatches">' + sw('data-bgc', ['#000000', '#5f6368', '#c0392b', '#d9822b', '#2b6cb0', '#2f855a', '#7e57c2', '#e91e63', '#00796b', '#ffffff'], B.gc, '<button type="button" class="ochip' + (!B.gc ? ' on' : '') + '" data-bgc="">Auto</button>') + '</div>' +
        '<label class="op">Size <input type="range" min="25" max="400" value="' + Math.round((B.gs || 1) * 100) + '" data-bgs></label>' +
        '<label class="op">Strength <input type="range" min="4" max="60" value="' + Math.round((B.go == null ? 0.18 : B.go) * 100) + '" data-bgo></label>';
    } else {
      html = '<h2>Texture</h2><div class="bgpick">' + '<button type="button" class="bgt' + (!B.t ? ' on' : '') + '" data-bgt=""><span class="bgsw" style="background:var(--paper)"></span><small>None (theme)</small></button>' +
        Q.TEXTURES.map(function (t) { return '<button type="button" class="bgt' + (B.t === t[0] ? ' on' : '') + '" data-bgt="' + t[0] + '"><span class="bgsw" style="background:' + (t[0] === B.t && B.tc ? B.tc : t[2]) + (t[0] !== 'plain' ? ' url(' + Q.textureUrl(t[0], t[0] === B.t ? B.tc : '') + ') 0 0/96px' : '') + '"></span><small>' + t[1] + '</small></button>'; }).join('') + '</div>' +
        '<div class="osec">Colour</div><div class="swatches">' + sw('data-bgtc', Q.COLOURS, B.tc, '<button type="button" class="ochip' + (!B.tc ? ' on' : '') + '" data-bgtc="">Its own</button>') + '</div>' +
        '<label class="op">Size <input type="range" min="25" max="400" value="' + Math.round((B.ts || 1) * 100) + '" data-bgts></label>';
    }
    openSheet(html + '<div class="row"><button type="button" class="primary" data-act="close">Done</button></div>', function (act, b) {});
    var sh = $('sheet');
    sh.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'close') return closeSheet();
      var d = b.dataset;
      if (d.bgg != null) setBg(function (B) { if (d.bgg) { B.g = d.bgg; delete B.gv; } else delete B.g; });
      else if (d.bgc != null) setBg(function (B) { if (d.bgc) B.gc = d.bgc; else delete B.gc; });
      else if (d.bgt != null) setBg(function (B) { if (d.bgt) { B.t = d.bgt; delete B.tv; } else { delete B.t; delete B.tc; } if (d.bgt === 'plain' && !B.tc) B.tc = '#f6f3ea'; });
      else if (d.bgtc != null) setBg(function (B) { if (d.bgtc) { B.tc = d.bgtc; if (!B.t) B.t = 'plain'; } else delete B.tc; });
      else return;
      var grp = b.closest('.bgpick, .swatches'); if (grp) grp.querySelectorAll('.on').forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on');
    };
    sh.oninput = function (e) {
      var t = e.target, v = +t.value / 100;
      if (t.hasAttribute('data-bgs')) setBg(function (B) { B.gs = v; });
      if (t.hasAttribute('data-bgo')) setBg(function (B) { B.go = v; });
      if (t.hasAttribute('data-bgts')) setBg(function (B) { B.ts = v; });
      if (t.hasAttribute('data-bgc-any')) setBg(function (B) { B.gc = t.value; });
      if (t.hasAttribute('data-bgtc-any')) setBg(function (B) { B.tc = t.value; if (!B.t) B.t = 'plain'; });
    };
  }
  $('layersPanel').addEventListener('click', function (e) {
    if (Date.now() - (S.lheldAt || 0) < 400) return; // the end of a hold, not a tap
    var b = e.target.closest('[data-lo]'), eng = S.canvas && S.canvas.ink(); if (!eng) return;
    var cardEl = e.target.closest('.lcard');
    if (b && b.dataset.lo === 'bgvis') { var k = b.dataset.k; setBg(function (B) { var key = k + 'v'; if (B[key] === false) delete B[key]; else B[key] = false; }); return; }
    if (cardEl && cardEl.dataset.bg) { bgSheet(cardEl.dataset.bg); return; }
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
    if (btn.closest('#tools')) { // from the tool rail: beside it, on the side with room, never over it (3.24.1)
      var onLeft = r.left < window.innerWidth / 2;
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, onLeft ? r.right + 10 : r.left - pop.offsetWidth - 10)) + 'px';
      pop.style.top = Math.max(8, Math.min(window.innerHeight - pop.offsetHeight - 8, r.top + r.height / 2 - pop.offsetHeight / 2)) + 'px';
    } else {
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
      pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
    }
    pop.onclick = function (e) { var b = e.target.closest('button'); if (b) onClick(b); };
  }
  $('pop').addEventListener('pointerdown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
  $('fmtBar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-f]');
    if (b && b.dataset.f === 'image') { pickImage(); return; }
    var ed = S.canvas && S.canvas.active();
    if (!b || !ed) return;
    fmtDo(b.dataset.f, b, ed, false);
  });
  // (3.28, #80) The formatting, shared by the bar above the keyboard and the Text tool's card. quiet = not typing:
  // no caret and no keyboard; letter changes (bold, font, size, colour…) then go on the whole box.
  var CHAR_F = { bold: 1, italic: 1, underline: 1, strike: 1, highlight: 1, color: 1, font: 1, size: 1, left: 1, center: 1, right: 1, justify: 1, clear: 1 };
  function fmtDo(f, b, ed, quiet) {
    function chain() {
      var x = quiet ? ed.chain() : ed.chain().focus();
      if (!(quiet && CHAR_F[f])) return x;
      // The whole box, then back to where the caret was, so a paragraph change next still goes on that line only.
      var sl = ed.state.selection, from = sl.from, to = sl.to;
      setTimeout(function () { try { var n = ed.state.doc.content.size; ed.commands.setTextSelection({ from: Math.min(from, n), to: Math.min(to, n) }); } catch (e) {} }, 0);
      return x.selectAll();
    }
    var c = chain();
    switch (f) {
      case 'justify': c.setTextAlign('justify').run(); break;
      case 'para': c.setParagraph().run(); break;
      case 'h3': c.toggleHeading({ level: 3 }).run(); break;
      case 'code': c.toggleCodeBlock().run(); break;
      case 'indent': c.sinkListItem(ed.isActive('taskList') ? 'taskItem' : 'listItem').run(); break;
      case 'outdent': c.liftListItem(ed.isActive('taskList') ? 'taskItem' : 'listItem').run(); break;
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
          if (p.dataset.v) chain().setHighlight({ color: p.dataset.v }).run(); else chain().unsetHighlight().run();
          $('pop').classList.add('hidden');
        });
        return;
      case 'color':
        popAt(b, ['#c0392b', '#d9822b', '#2f855a', '#2b6cb0', '#7e57c2', '#8a8a8a'].map(function (x) { return '<button class="swatch" data-v="' + x + '" style="background:' + x + '" aria-label="Text colour"></button>'; }).join('') +
          '<button data-v="">Default</button>', function (p) {
          if (p.dataset.v) chain().setColor(p.dataset.v).run(); else chain().unsetColor().run();
          $('pop').classList.add('hidden');
        });
        return;
      case 'font':
        // With nothing selected, the font goes on the whole text box.
        var FONTS = allFonts();
        popAt(b, FONTS.map(function (f) { return '<button data-v="' + esc(f[0]) + '" style="font-family:' + esc(f[2]) + ';font-size:16px">' + f[1] + '</button>'; }).join(''), function (p) {
          var chain = chain();
          if (ed.state.selection.empty) chain = chain.selectAll();
          if (p.dataset.v) chain.setFontFamily(p.dataset.v).run(); else chain.unsetFontFamily().run();
          $('pop').classList.add('hidden');
        });
        return;
      case 'size':
        // Any size too (3.18): type a number and Set. With nothing selected, the size goes on the whole text box.
        var curFs = parseInt(ed.getAttributes('textStyle').fontSize, 10) || 16;
        popAt(b, '<button data-v="14px" style="font-size:13px">Small</button><button data-v="">Normal</button><button data-v="21px" style="font-size:18px">Large</button><button data-v="28px" style="font-size:22px">Huge</button>' +
          '<span style="display:inline-flex;align-items:center;gap:6px;width:100%"><button data-v="dn" aria-label="Smaller">−</button><input type="number" id="fsIn" min="6" max="400" value="' + curFs + '" style="width:64px" aria-label="Text size">' +
          '<button data-v="up" aria-label="Bigger">+</button><button data-v="set" class="primary">Set</button></span>', function (p) {
          var v = p.dataset.v, inp = $('fsIn');
          if (v === 'up' || v === 'dn') { inp.value = Math.max(6, Math.min(400, (+inp.value || 16) + (v === 'up' ? 2 : -2))); v = 'set'; }
          var chain = chain();
          if (v === 'set') {
            if (ed.state.selection.empty) chain = chain.selectAll();
            chain.setFontSize(Math.max(6, Math.min(400, +inp.value || 16)) + 'px').run();
            if (p.dataset.v === 'set') $('pop').classList.add('hidden');
            return;
          }
          if (v) chain.setFontSize(v).run(); else chain.unsetFontSize().run();
          $('pop').classList.add('hidden');
        });
        $('pop').onpointerdown = null;
        return;
      case 'link':
        var prev = ed.getAttributes('link').href || '';
        popAt(b, '<input type="text" id="linkIn" placeholder="https://…" value="' + esc(prev) + '" style="width:200px"><button data-v="set" class="primary">Set</button>' + (prev ? '<button data-v="rm">Remove</button>' : ''), function (p) {
          var url = $('linkIn').value.trim();
          if (p.dataset.v === 'rm' || !url) chain().extendMarkRange('link').unsetLink().run();
          else chain().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(url) ? url : 'https://' + url }).run();
          $('pop').classList.add('hidden');
        });
        $('pop').onpointerdown = null;
        setTimeout(function () { $('linkIn').focus(); }, 30);
        return;
    }
    if (!quiet) updateFmt(ed);
    if (PREF.tool === 'type' && $('tools').classList.contains('opts')) setTool('type'); // the Text card shows what changed
  }

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
      '<button type="button" data-act="below">Below everything</button>' +
      '<button type="button" data-act="more"><b>Any files</b> on the page (videos, sounds, PDFs…)</button><button type="button" data-act="link"><b>A link</b></button></div><div class="row"><button type="button" data-act="close">Cancel</button></div>',
    function (act) {
      if (act === 'more') { closeSheet(); addToPage(); return; }
      if (act === 'link') { pasteLink(); return; }
      if (act !== 'caret' && act !== 'beside' && act !== 'below' && act !== 'page') return;
      imgWhere = act; closeSheet();
      imgInput.value = ''; imgInput.click();
    });
  }
  imgInput.onchange = async function () {
    var f = (this && this.files && this.files[0]) || (imgInput.files && imgInput.files[0]); // also called with a file from Add to the page
    if (!f || !S.canvas) return;
    if (!navigator.onLine || (Drive.isOffline && Drive.isOffline())) { toast('Images can be added while online (they are saved in Drive).'); return; }
    if (!Drive.signedIn()) { toast('Sign in to Google first (tap the sync button at the top).'); return; }
    toast('Adding the image…', null, null, 60000);
    try {
      var blob = await shrinkImage(f);
      var ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/gif' ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      var name = await saveMedia(blob, ext);
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
  // ---------- Fonts (3.27.1, #81) ----------
  // Six fonts come with the app and work offline. More: put font files (.ttf, .otf, .woff, .woff2) in the Fonts folder
  // inside the main folder in Drive (or add them from Settings › Fonts). Each is copied to this device once, so it
  // works offline too, and shows in every font list (text boxes and Text art).
  var CORE_FONTS = [['', 'Sans (standard)', 'var(--font)'], ['Lora, serif', 'Serif', 'Lora, serif'], ['"JetBrains Mono", monospace', 'Mono', '"JetBrains Mono", monospace'],
    ['Caveat, cursive', 'Handwriting', 'Caveat, cursive'], ['"Permanent Marker", cursive', 'Marker', '"Permanent Marker", cursive'], ['"Playfair Display", serif', 'Display', '"Playfair Display", serif']];
  var userFonts = [], FONT_EXT = /\.(ttf|otf|woff2?)$/i, fontsDone = {}, fontsChecked = 0;
  function fontFamilyOf(file) {
    return file.replace(FONT_EXT, '').replace(/[-_ ]?(Regular|Book|Normal|Roman|VariableFont.*)$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim() || file;
  }
  function fontCss(f) { return '"' + f.family.replace(/"/g, '') + '", sans-serif'; }
  function allFonts() { return CORE_FONTS.concat(userFonts.map(function (f) { return [fontCss(f), f.family, fontCss(f)]; })); }
  async function addFontFace(file, buf) {
    if (fontsDone[file]) return;
    var fam = fontFamilyOf(file);
    try { var ff = new FontFace(fam.replace(/"/g, ''), buf); await ff.load(); document.fonts.add(ff); } catch (e) { return; } // not a font after all
    fontsDone[file] = 1;
    if (!userFonts.some(function (f) { return f.family === fam; })) userFonts.push({ family: fam, file: file });
    userFonts.sort(function (a, b) { return a.family.localeCompare(b.family); });
  }
  function fontKey(file) { return new Request(location.origin + '/qn-font/' + encodeURIComponent(file)); }
  async function fontsFolder(make) {
    var t = tree(), root = rootId();
    if (!root) return null;
    var hit = Object.keys(t).filter(function (k) { return t[k].name === 'Fonts' && t[k].parentId === root; })[0];
    return hit || (make ? sync.createFolder('Fonts', root) : null);
  }
  async function loadFonts(fromDrive) {
    var cache = null; try { cache = await caches.open('qn-fonts'); } catch (e) {}
    if (cache) { // what is on this device already: at once, online or not
      var keys = await cache.keys();
      for (var i = 0; i < keys.length; i++) {
        var file = decodeURIComponent(keys[i].url.split('/qn-font/')[1] || ''); if (!file) continue;
        var r = await cache.match(keys[i]); if (r) await addFontFace(file, await r.arrayBuffer());
      }
    }
    if (!fromDrive || Drive.demo && !Drive.list) return;
    var fid = await fontsFolder(false); if (!fid) return;
    var list = (await Drive.list(fid)).filter(function (f) { return FONT_EXT.test(f.name); });
    for (var j = 0; j < list.length; j++) {
      if (fontsDone[list[j].name]) continue;
      try {
        var blob = await Drive.readBlob(list[j].id), buf = await blob.arrayBuffer();
        if (cache) await cache.put(fontKey(list[j].name), new Response(buf.slice(0), { headers: { 'Content-Type': 'font/' + list[j].name.split('.').pop().toLowerCase() } }));
        await addFontFace(list[j].name, buf);
      } catch (e) { if (e.code === 'auth' || e.code === 'offline') return; }
    }
    // Fonts taken out of the Drive folder go from this device too.
    if (cache) {
      var names = {}; list.forEach(function (f) { names[f.name] = 1; });
      var ks = await cache.keys();
      for (var k = 0; k < ks.length; k++) { var fn = decodeURIComponent(ks[k].url.split('/qn-font/')[1] || ''); if (fn && !names[fn]) await cache.delete(ks[k]); }
    }
    fontsChecked = Date.now();
  }
  function fontsFromDriveSoon() { // once the main folder is known; then again at most every 10 minutes
    if (Date.now() - fontsChecked < 10 * 60 * 1000) return;
    if (!rootId()) { setTimeout(fontsFromDriveSoon, 4000); return; }
    fontsChecked = Date.now();
    loadFonts(true).catch(function () { fontsChecked = 0; });
  }
  loadFonts(false).catch(function () {});
  setTimeout(fontsFromDriveSoon, 2500);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') fontsFromDriveSoon(); });
  var fontInput = document.createElement('input');
  fontInput.type = 'file'; fontInput.multiple = true; fontInput.accept = '.ttf,.otf,.woff,.woff2,font/*'; fontInput.className = 'hidden';
  document.body.appendChild(fontInput);
  fontInput.addEventListener('change', async function () {
    var files = Array.prototype.slice.call(fontInput.files || []).filter(function (f) { return FONT_EXT.test(f.name); }); fontInput.value = '';
    if (!files.length) { toast('Those aren’t font files (.ttf, .otf, .woff or .woff2).'); return; }
    try {
      if (!rootId()) await sync.run();
      var fid = await fontsFolder(true), have = {};
      (await Drive.list(fid)).forEach(function (f) { have[f.name] = 1; });
      for (var i = 0; i < files.length; i++) {
        if (!have[files[i].name]) await Drive.upload(files[i].name, fid, files[i], files[i].type || 'application/octet-stream');
        var buf = await files[i].arrayBuffer();
        try { var c = await caches.open('qn-fonts'); await c.put(fontKey(files[i].name), new Response(buf.slice(0))); } catch (e) {}
        await addFontFace(files[i].name, buf);
      }
      toast(files.length === 1 ? 'Font added: ' + fontFamilyOf(files[0].name) : files.length + ' fonts added');
      if ($('sheet') && $('sheet').querySelector('[data-act="addfont"]')) settingsSheet();
    } catch (e) { toast(e.code === 'auth' ? 'Your Google sign-in ran out. Tap the sync button, then try again.' : 'The font could not be added: ' + (e.message || e)); }
  });
  function fontsHtml() {
    return '<div class="set"><b>Fonts</b><p>Built in, and work offline: ' + CORE_FONTS.map(function (f) { return '<span style="font-family:' + esc(f[2]) + '">' + f[1].replace(' (standard)', '') + '</span>'; }).join(', ') + '.</p>' +
      '<p>Your own: put font files (.ttf, .otf, .woff) in Drive › ' + esc(sync.rootName()) + ' › Fonts, or add them here. Each is kept on this device too, so it works offline.</p>' +
      (userFonts.length ? '<p>' + userFonts.map(function (f) { return '<span style="font-family:' + esc(fontCss(f)) + ';font-size:17px">' + esc(f.family) + '</span>'; }).join(' · ') + '</p>' : '') +
      '<button type="button" data-act="addfont">Add font files</button>' +
      // (3.34) What text looks like when nothing else is chosen: all text boxes, new and old.
      '<p style="margin-top:12px !important">Default text (every note)</p><div class="pick" style="margin:0">' +
      allFonts().map(function (f) { var on = (PREF.defFont || '') === f[0]; return '<button type="button" data-act="deffont" data-v="' + esc(f[0]) + '" aria-pressed="' + on + '" style="font-family:' + esc(f[2]) + '">' + (on ? '◉ ' : '○ ') + esc(f[1].replace(' (standard)', '')) + '</button>'; }).join('') + '</div>' +
      '<div class="pick" style="margin:6px 0 0">' + [[15, 'Small'], [17, 'Normal'], [19, 'Large'], [22, 'Larger']].map(function (o) { var on = (PREF.defSize || 17) === o[0]; return '<button type="button" data-act="defsize" data-v="' + o[0] + '" aria-pressed="' + on + '">' + (on ? '◉ ' : '○ ') + o[1] + ' (' + o[0] + ')</button>'; }).join('') + '</div></div>';
  }
  function applyTextDefault() {
    var r = document.documentElement.style;
    if (PREF.defFont) r.setProperty('--qn-font', PREF.defFont); else r.removeProperty('--qn-font');
    if (PREF.defSize && PREF.defSize !== 17) r.setProperty('--qn-fs', PREF.defSize + 'px'); else r.removeProperty('--qn-fs');
    if (S.canvas && S.canvas.redraw) S.canvas.redraw();
  }
  // Photos from a phone camera are huge: keep them sharp on screen but small in Drive (longest side 2000 px).
  // ---------- Files on the page: saved once in Attachments, named by what is in them (3.20) ----------
  // The same picture, video or PDF added to several notes (or twice to one) is one file in Drive; notes only point to it.
  async function saveMedia(blob, ext) {
    var buf = await blob.arrayBuffer(), dig = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    var name = Array.prototype.map.call(dig.slice(0, 12), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('') + '.' + ext;
    var map = await attachments();
    if (!map[name]) { var made = await Drive.upload(name, await attachmentsFolder(), blob, blob.type || 'application/octet-stream'); map[name] = made.id; }
    if (!imgCache[name]) imgCache[name] = URL.createObjectURL(blob);
    return name;
  }
  var mediaInput = document.createElement('input');
  mediaInput.type = 'file'; mediaInput.multiple = true; mediaInput.className = 'hidden'; // any files, several at once (3.21)
  document.body.appendChild(mediaInput);
  // The Add button: straight to choosing files; the app works out what each one is. A link: hold the button (or the
  // ••• menu), and the link copied last goes on the page.
  // Holding the Add button: the link copied last goes on the page.
  var addHeld = false, addTimer = 0;
  document.addEventListener('pointerdown', function (e) {
    var b = e.target.closest && e.target.closest('#tools [data-act="image"]'); if (!b) return;
    addHeld = false; clearTimeout(addTimer);
    addTimer = setTimeout(function () { addHeld = true; if (navigator.vibrate) navigator.vibrate(15); pasteLink(); }, 550);
  }, true);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { document.addEventListener(t, function () { clearTimeout(addTimer); }, true); });
  // The Add button (3.22): files from the device, or Serendipity notes (a whole note, or a part of one).
  function addToPage() {
    if (!S.canvas) return;
    if (!$('layersPanel').classList.contains('hidden')) { $('layersPanel').classList.add('hidden'); layersBtn(); } // one panel at a time
    popAt(document.querySelector('#tools [data-act="image"]'), '<button data-v="files">Files from the device</button><button data-v="notes">Serendipity notes</button>', function (b) {
      $('pop').classList.add('hidden');
      if (b.dataset.v === 'files') { mediaInput.value = ''; mediaInput.click(); }
      else startImport();
    });
  }
  // ---- Bringing a note, or part of one, into this note: choose it in the list, open it, select a part or not ----
  function startImport() {
    if (!S.cur) return;
    S.importTo = { id: S.cur.id, title: S.cur.title || 'Untitled' };
    closeNote(); showList(); renderImportBar();
  }
  function renderImportBar() {
    var bar = $('importBar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'importBar'; document.body.appendChild(bar);
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('[data-imp]'); if (!b) return;
        if (b.dataset.imp === 'cancel') return endImport(null);
        var box = S.canvas && S.canvas.ink && S.canvas.ink().selBox ? S.canvas.ink().selBox() : null;
        var t = 'qn://note/' + encodeURIComponent(S.cur.id) + (box ? '#' + [box.x, box.y, box.w, box.h].map(function (v) { return Math.round(v); }).join(',') : '');
        endImport({ link: t, kind: b.dataset.imp });
      });
    }
    var I = S.importTo;
    if (!I) { bar.classList.add('hidden'); bar.dataset.mode = ''; return; }
    bar.classList.remove('hidden');
    if (S.view === 'note' && S.cur && !(S.cur.id === I.id)) {
      bar.dataset.mode = '';
      bar.innerHTML = '<span>Bring <b>' + (S.canvas && S.canvas.ink().selBox() ? 'the part selected' : 'this whole note') + '</b> into “' + esc(I.title) + '” <small>(use Select to pick a part)</small></span>' +
        '<button type="button" data-imp="note" class="primary">As a live picture</button><button type="button" data-imp="card">As a link</button><button type="button" data-imp="cancel">Cancel</button>';
    } else {
      // Searching right here (3.22): it searches the notes list underneath, titles and text.
      if (bar.dataset.mode !== 'list') {
        bar.innerHTML = '<span>Choose a note to bring into “' + esc(I.title) + '”</span><input type="search" id="impQ" placeholder="Search notes" aria-label="Search notes"><button type="button" data-imp="cancel">Cancel</button>';
        $('impQ').value = S.q || '';
        $('impQ').addEventListener('input', function () { $('q').value = S.q = this.value; renderList(); });
      }
    }
    bar.dataset.mode = S.view === 'note' && S.cur && S.cur.id !== I.id ? 'note' : 'list';
  }
  setInterval(function () { if (S.importTo && S.view === 'note') { var t = $('importBar') && $('importBar').querySelector('b'); var now = S.canvas && S.canvas.ink().selBox() ? 'the part selected' : 'this whole note'; if (t && t.textContent !== now) renderImportBar(); } }, 400);
  function endImport(res) {
    var I = S.importTo; S.importTo = null; renderImportBar();
    if (S.q) { $('q').value = S.q = ''; }
    var target = I && noteById(I.id); if (!target) return;
    if (S.cur !== target) openNote(target);
    if (res) setTimeout(function () { placeNoteLink(res.link, res.kind); }, 350);
  }
  async function pasteLink() {
    if (!S.canvas) return;
    var t = '';
    try { t = (await navigator.clipboard.readText()) || ''; } catch (e) {}
    t = t.trim() || S.copiedLink || ''; // (the clipboard may be out of reach; a link copied in the app still works)
    if (/^qn:\/\//.test(t)) return placeNoteLink(t);
    if (!/^https?:\/\/\S+$/i.test(t) && !/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return linkSheet(t);
    if (!/^https?:/i.test(t)) t = 'https://' + t;
    askLinkMode(t);
  }
  // How a web link shows (#71): asked every time; select the link later to change it.
  var LINKMODES = { link: [360, 84], web: [640, 440], thumb: [360, 270] };
  function askLinkMode(u) {
    var host = ''; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch (e) {}
    openSheet('<h2>How should this link show?</h2><p style="margin:0 0 8px">' + esc(host || u) + '</p>' +
      '<div class="pick" style="margin:0">' +
      '<button type="button" data-act="lm" data-v="link"><b>Link card</b>: a small card; tap it to open the page in your browser.</button>' +
      '<button type="button" data-act="lm" data-v="web"><b>The page in a window</b>: the page itself, live on the canvas (some sites refuse to be shown this way).</button>' +
      '<button type="button" data-act="lm" data-v="thumb"><b>A picture of the page</b>: a small snapshot on the canvas; tap it to open the page. The address is sent to a free screenshot service to make it.</button></div>' +
      '<p style="margin-top:8px">You can change this later: select the link and tap its mode button.</p>' +
      '<div class="row"><button type="button" data-act="close">Cancel</button></div>',
    function (act, b) {
      if (act !== 'lm') return;
      var m = b.dataset.v; closeSheet();
      S.canvas.placeMedia({ src: u, mk: m }, LINKMODES[m][0], LINKMODES[m][1]);
    });
  }
  function linkSheet(pre) {
    openSheet('<form><h2>Add a link</h2><input name="u" type="text" inputmode="url" autocapitalize="off" placeholder="https://…" autofocus required value="' + esc(pre && pre.length < 400 ? pre : '') + '">' +
      '<p class="err"></p><div class="row"><button type="button" data-act="close">Cancel</button><button type="submit" class="primary">Add</button></div></form>',
    null, function (e) {
      var u = String(e.target.u.value || '').trim();
      if (/^qn:\/\//.test(u)) { closeSheet(); return placeNoteLink(u); }
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      try { new URL(u); } catch (er) { return sheetError('That doesn\'t look like a web address.'); }
      closeSheet(); askLinkMode(u);
    });
  }
  mediaInput.onchange = async function () {
    var files = Array.prototype.slice.call(mediaInput.files || []);
    if (!files.length || !S.canvas) return;
    if (!navigator.onLine || (Drive.isOffline && Drive.isOffline())) { toast('Files can be added while online (they are saved in Drive).'); return; }
    if (!Drive.signedIn()) { toast('Sign in to Google first (tap the sync button at the top).'); return; }
    var dy = 0, n = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], ext = (f.name.split('.').pop() || 'bin').toLowerCase().slice(0, 5), ttl = f.name.replace(/\.[^.]+$/, '');
      toast((files.length > 1 ? (i + 1) + ' of ' + files.length + ': ' : '') + 'saving ' + f.name + ' in Drive…', null, null, 600000);
      try {
        if (f.type === 'application/pdf' || ext === 'pdf') { dy += await addPdf(f, ttl, dy); n++; continue; }
        if (/^image\//.test(f.type)) {
          var blob = await shrinkImage(f), iext = blob.type === 'image/png' ? 'png' : blob.type === 'image/gif' ? 'gif' : blob.type === 'image/webp' ? 'webp' : 'jpg';
          var iname = await saveMedia(blob, iext), dim = [800, 600];
          try { var bmp = await createImageBitmap(blob); dim = [bmp.width, bmp.height]; } catch (e) {}
          dy += S.canvas.placeMedia({ src: 'Attachments/' + encodeURIComponent(iname) }, dim[0], dim[1], dy) + 24; n++; continue;
        }
        var name = await saveMedia(f, ext), src = 'Attachments/' + encodeURIComponent(name);
        if (/^video\//.test(f.type)) {
          var dims = await new Promise(function (res) { var v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = function () { res([v.videoWidth || 640, v.videoHeight || 360]); }; v.onerror = function () { res([640, 360]); }; v.src = imgCache[name]; });
          dy += S.canvas.placeMedia({ src: src, mk: 'video', ttl: ttl }, dims[0], dims[1], dy) + 24;
        } else if (/^audio\//.test(f.type)) dy += S.canvas.placeMedia({ src: src, mk: 'audio', ttl: ttl }, 360, 96, dy) + 24;
        else dy += S.canvas.placeMedia({ src: src, mk: 'file', ttl: f.name }, 320, 72, dy) + 24; // any other file: a card that opens it
        n++;
      } catch (e) { toast(e.code === 'auth' ? 'Your Google sign-in ran out. Tap the sync button, then try again.' : f.name + ' could not be added: ' + (e.message || e)); return; }
    }
    hideToast();
  };
  // A PDF: kept once as it is, and each page shown on the page as a sheet to write on (one under another).
  var PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/';
  async function addPdf(f, ttl, dy0) {
    toast('Opening the PDF…', null, null, 600000);
    var lib = await import(PDFJS + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    var pdfName = await saveMedia(f, 'pdf'), doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    var n = Math.min(doc.numPages, 200), dy = dy0 || 0;
    // Long PDFs are drawn smaller so the canvas stays fast: full size up to 40 pages, then 1000px wide (to 100), then 800px.
    var maxW = n > 100 ? 800 : n > 40 ? 1000 : 1400, maxSc = n > 100 ? 1.2 : n > 40 ? 1.5 : 2.2;
    for (var i = 1; i <= n; i++) {
      toast('Page ' + i + ' of ' + n + '…', null, null, 600000);
      var pg = await doc.getPage(i), vp0 = pg.getViewport({ scale: 1 }), sc = Math.min(maxSc, maxW / vp0.width), vp = pg.getViewport({ scale: sc });
      var cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise;
      var jpg = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', 0.86); });
      var name = await saveMedia(jpg, 'jpg');
      var h = S.canvas.placeMedia({ src: 'Attachments/' + encodeURIComponent(name), mk: 'pdf', pg: i, of: 'Attachments/' + encodeURIComponent(pdfName), ttl: ttl }, vp0.width, vp0.height, dy);
      dy += h + 24;
    }
    if (doc.numPages > n) toast('The first ' + n + ' pages are on the page (the PDF has ' + doc.numPages + ').');
    return dy - (dy0 || 0);
  }
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
  function markPage() { // which pattern and paper are on
    var t = String((S.cur && S.cur.page) || '').split(/\s+/), st = t.filter(function (x) { return /^(grid|dots|lines)$/.test(x); })[0] || '', pp = t.filter(function (x) { return !/^(grid|dots|lines)$/.test(x); })[0] || '';
    document.querySelectorAll('#pageRow [data-pg]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.pg === st); });
    document.querySelectorAll('#pageRow [data-pp]').forEach(function (x) { x.setAttribute('aria-pressed', x.dataset.pp === pp); });
  }
  function closeMenu() { $('noteMenu').classList.add('hidden'); $('menuFab').setAttribute('aria-expanded', 'false'); }
  $('menuFab').onclick = function () {
    var open = $('noteMenu').classList.contains('hidden');
    $('noteMenu').classList.toggle('hidden', !open);
    if (open) markPage();
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
    if (b.dataset.pg != null || b.dataset.pp != null) { // the page: its pattern and paper, kept with the note
      var t = String(n.page || '').split(/\s+/).filter(Boolean), st = t.filter(function (x) { return /^(grid|dots|lines)$/.test(x); })[0] || '', pp = t.filter(function (x) { return !/^(grid|dots|lines)$/.test(x); })[0] || '';
      if (b.dataset.pg != null) st = b.dataset.pg; else pp = b.dataset.pp;
      n.page = [st, pp].filter(Boolean).join(' ');
      S.canvas.setPage(n.page); touchNote(n); markPage(); return;
    }
    closeMenu();
    if (b.dataset.m === 'labels') labelsSheet(n);
    if (b.dataset.m === 'image') pickImage();
    if (b.dataset.m === 'bgg' || b.dataset.m === 'bgt') { closeMenu(); bgSheet(b.dataset.m === 'bgg' ? 'g' : 't'); return; }
    if (b.dataset.m === 'link' && S.cur) copyNoteLink(S.cur, null);
    if (b.dataset.m === 'linked' && S.cur) { closeMenu(); linkedFromSheet(S.cur); return; }
    if (b.dataset.m === 'newtab' && S.cur) { closeMenu(); newTabPick(); return; }
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
        ['title', 'boxes', 'ink', 'links', 'labels', 'pinned', 'extra'].forEach(function (k) { n[k] = old[k]; });
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
  // The order of the tools on the rail is the user's own (Settings › Tools).
  function toolBtns() { return [].slice.call(document.querySelectorAll('#tools .tool-row > button.tool[data-tool]:not([data-tool=""])')); }
  function applyToolOrder() {
    var row = document.querySelector('#tools .tool-row'); if (!row || !PREF.toolOrder) return;
    var by = {}; toolBtns().forEach(function (b) { by[b.dataset.tool] = b; });
    var first = toolBtns()[0], at = first ? first.previousSibling : null;
    var names = PREF.toolOrder.filter(function (n) { return by[n]; }).concat(Object.keys(by).filter(function (n) { return PREF.toolOrder.indexOf(n) < 0; }));
    var ref = first;
    names.forEach(function (n) { var b = by[n]; if (b !== ref) row.insertBefore(b, ref); else ref = ref.nextElementSibling && ref.nextElementSibling.matches && ref.nextElementSibling.matches('button.tool[data-tool]:not([data-tool=""])') ? ref.nextElementSibling : ref.nextElementSibling; });
  }
  function toolLabel(b) { return (b.getAttribute('aria-label') || b.title || b.dataset.tool).split(':')[0]; }
  function toolOrderHtml() {
    return '<div class="set"><b>Tools</b><p>Put the tools on the side rail in the order you like.</p>' + toolBtns().map(function (b, i, a) {
      return '<div class="row" style="align-items:center;gap:8px;margin:2px 0"><span style="flex:1">' + esc(toolLabel(b)) + '</span>' +
        '<button type="button" data-act="tup" data-v="' + b.dataset.tool + '"' + (i ? '' : ' disabled') + ' aria-label="Move up">▲</button>' +
        '<button type="button" data-act="tdown" data-v="' + b.dataset.tool + '"' + (i < a.length - 1 ? '' : ' disabled') + ' aria-label="Move down">▼</button></div>';
    }).join('') + '<button type="button" data-act="treset">Original order</button></div>';
  }
  function moveTool(name, d) {
    var names = toolBtns().map(function (b) { return b.dataset.tool; }), i = names.indexOf(name), j = i + d;
    if (i < 0 || j < 0 || j >= names.length) return;
    names.splice(j, 0, names.splice(i, 1)[0]); PREF.toolOrder = names; savePref(); applyToolOrder();
  }
  // ---------- Look (3.30): skin, shade and motion ----------
  var LOOKS = [['paper', 'Paper', 'Warm paper, as before'], ['studio', 'Studio', 'Clean and crisp, a dark tool puck, one bright accent']]; // (3.31) the user kept these two
  if (PREF.skin === 'sketch' || PREF.skin === 'play') { PREF.skin = 'paper'; savePref(); }
  function applyLook() {
    var r = document.documentElement;
    if (PREF.skin && PREF.skin !== 'paper') r.dataset.skin = PREF.skin; else delete r.dataset.skin;
    if (PREF.shade && PREF.shade !== 'auto') r.dataset.shade = PREF.shade; else delete r.dataset.shade;
    r.dataset.motion = PREF.motion || 'gentle';
    var m = document.querySelector('meta[name=theme-color]:not([media])') || document.createElement('meta');
    m.name = 'theme-color'; m.content = getComputedStyle(r).getPropertyValue('--paper').trim() || '#f8f4ec';
    if (!m.parentNode) document.head.appendChild(m);
    if (S.canvas && S.canvas.redraw) S.canvas.redraw();
  }
  function lookHtml() {
    var sk = PREF.skin || 'paper', sh = PREF.shade || 'auto', mo = PREF.motion || 'gentle';
    function opt(act, v, label, on, note) { return '<button type="button" data-act="' + act + '" data-v="' + v + '" aria-pressed="' + on + '">' + (on ? '◉ ' : '○ ') + label + (note ? ' <span style="color:var(--muted);font-weight:400">· ' + note + '</span>' : '') + '</button>'; }
    return '<div class="set"><b>Look</b><div class="pick" style="margin:0">' + LOOKS.map(function (l) { return opt('skin', l[0], l[1], sk === l[0], l[2]); }).join('') + '</div>' +
      '<p style="margin-top:10px !important">Shade</p><div class="pick" style="margin:0">' + opt('shade', 'auto', 'Follow the phone', sh === 'auto', 'light by day, grey when the phone is dark') +
      opt('shade', 'light', 'Light', sh === 'light') + opt('shade', 'grey', 'Grey', sh === 'grey') + '</div>' +
      '<p style="margin-top:10px !important">Motion</p><div class="pick" style="margin:0">' + opt('motion', 'off', 'Off', mo === 'off', 'nothing moves') +
      opt('motion', 'gentle', 'Gentle', mo === 'gentle', 'panels ease in with a little give') + opt('motion', 'lively', 'Lively', mo === 'lively', 'pop, bounce and squish') + '</div>' +
      '<p style="margin-top:10px !important">Tool layout (fits itself to phone, tablet and computer, upright or sideways)</p><div class="pick" style="margin:0">' +
      [['rail', 'Rail', 'a column of tools at the side; tap a tool again for its card'], ['wheel', 'Wheel', 'like Concepts: tools, colours, size and opacity on one wheel; drag it anywhere; it shrinks while you draw'],
       ['pucks', 'Pucks', 'like Sketchbook: a tool bar, a size puck (drag ↕ size, ↔ opacity), a colour puck and a corner menu'], ['pen1', 'Pen first', 'almost nothing on screen: your last tools, and hold a finger on the page for the rest']]
        .map(function (o) { return opt('tl', o[0], o[1], (PREF.tl || 'rail') === o[0], o[2]); }).join('') + '</div></div>';
  }
  applyLook();
  applyTextDefault();
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
      lookHtml() + toolOrderHtml() + fontsHtml() +
      '<div class="set"><b>Smoothness</b><p>A small meter in the corner: how many pictures a second the screen gets (60 is smooth) and the longest wait in the last few seconds. Its numbers also go with feedback, so slowness can be fixed from real figures.</p>' +
        '<button type="button" data-act="meter">' + (PREF.meter ? 'Hide the smoothness meter' : 'Show the smoothness meter') + '</button></div>' +
      '<div class="set"><b>Copy notes in</b><p>A one-time copy from another app. Not a sync: the other app stays as it is.</p>' +
        '<button type="button" data-act="keep">From Google Keep</button> <button type="button" data-act="notion">From Notion</button> <button type="button" data-act="vault">From Obsidian</button></div>' +
      '<div class="set"><b>Feedback button</b><p>The small round button in the top bar. Touching it takes a picture of the app; draw on it, write notes on it, and tap the button again to send. It goes to the developer, with the picture and app details; replies show up here.</p>' +
        '<button type="button" data-act="bugbtn">' + (PREF.bugBtn !== false ? 'Hide the feedback button' : 'Show the feedback button') + '</button> <button type="button" data-act="bugnow">Send feedback now</button> <button type="button" data-act="fbinbox">Your feedback and replies</button></div>' +
      '<div class="set"><b>About</b><p>Serendipity ' + esc(CFG.VERSION) + '. Notes are Markdown files in your Google Drive › ' + esc(sync.rootName()) + ', readable by any notes app. Serendipity can only see the files it makes.</p>' +
        '<button type="button" data-act="update">Check for update</button> <button type="button" data-act="whatsnew">What’s new</button></div>' +
      (Drive.demo ? '<div class="set"><b>Demo tools</b><p>Try the offline queue and the changed-elsewhere warning.</p>' +
        '<button type="button" data-act="demoOffline">' + (Drive.isOffline() ? 'Back online' : 'Pretend offline') + '</button> <button type="button" data-act="demoElsewhere">Pretend the laptop edited the last note</button></div>' : '') +
      '<div class="row"><button type="button" data-act="close">Close</button></div>',
    function (act, b) {
      if (act === 'tup' || act === 'tdown') { moveTool(b.dataset.v, act === 'tup' ? -1 : 1); var sc = $('sheet'); var y = sc ? sc.scrollTop : 0; settingsSheet(); sc = $('sheet'); if (sc) sc.scrollTop = y; return; }
      if (act === 'addfont') { fontInput.click(); return; }
      if (act === 'meter') { PREF.meter = !PREF.meter; savePref(); Meter.show(PREF.meter); b.textContent = PREF.meter ? 'Hide the smoothness meter' : 'Show the smoothness meter'; return; }
      if (act === 'deffont' || act === 'defsize') {
        if (act === 'deffont') PREF.defFont = b.dataset.v || ''; else PREF.defSize = +b.dataset.v;
        savePref(); applyTextDefault(); var sc2 = $('sheet'), y2 = sc2 ? sc2.scrollTop : 0; settingsSheet(); sc2 = $('sheet'); if (sc2) sc2.scrollTop = y2; return;
      }
      if (act === 'treset') { delete PREF.toolOrder; savePref(); location.reload(); return; }
      if (act === 'start') { PREF.start = b.dataset.v; savePref(); settingsSheet(); return; }
      if (act === 'skin' || act === 'shade' || act === 'motion') { PREF[act] = b.dataset.v; savePref(); applyLook(); settingsSheet(); return; }
      if (act === 'tl') { PREF.tl = b.dataset.v; savePref(); applyLayout(); settingsSheet(); toast({ rail: 'Rail: tap a tool again for its settings.', wheel: 'Wheel: tap the middle for settings; drag the ring to move it; it shrinks to a dot while you draw.', pucks: 'Pucks: drag the left puck up/down for size, sideways for opacity; the right one is colour.', pen1: 'Pen first: hold one finger still on the page (or right-click) for all the tools.' }[PREF.tl], null, null, 5000); return; }
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
      if (act === 'vault') location.href = 'vault.html';
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
    { t: 'Smoother sliders, and a smoothness meter', d: 'Sliders no longer redraw the whole page while you move them: the pen size, a picked thing\'s opacity, line width and pattern sliders change only what they need, once per screen frame. New: Settings › Smoothness › Show the smoothness meter, a small pill at the top with frames a second (60 is smooth) and the longest wait. Its figures also go with your feedback, so slow spots can be fixed from real numbers.',
      a: art('<rect x="70" y="50" width="120" height="34" rx="17" fill="#222" opacity=".8"/><circle cx="90" cy="67" r="6" fill="#4caf50"/><rect x="104" y="62" width="70" height="10" rx="5" fill="#fff" opacity=".85"/><rect x="60" y="110" width="140" height="6" rx="3" fill="' + RULE + '"/><circle cx="150" cy="113" r="10" fill="' + A + '"/>') },
    { t: 'Smoother fills, tabs at a glance', d: 'Patterned fills are drawn as one picture now, so drawing, erasing and picking on pages with patterns is much lighter. Drawing a fill shape: a pause half way no longer turns it into a clean shape; only holding where you started does. Pick a filled shape: its patterns show as pictures, Turn rotates the pattern, + New makes one. Pen › your own tip: Spacing, and Spacing follows pressure. Open tabs spreads your tabs out as pages to pick from. The side map has arrows to see more around it and zooms with two fingers or − and +. Tab names stay readable over drawings.',
      a: art('<rect x="30" y="34" width="60" height="80" rx="8" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="100" y="26" width="60" height="88" rx="8" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/><rect x="170" y="34" width="60" height="80" rx="8" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M112 60 q18 -18 36 0 t0 30 q-18 18 -36 0z" fill="' + A + '" opacity=".35"/>') },
    { t: 'Two devices, nothing lost', d: 'A note changed on two devices (even both offline) is now combined by itself, with no question. Changes in different places are all kept. If the same paragraph was rewritten on both, both versions stay, each under a small label like "from phone, 24 Nov 06:40": delete the one you don\'t want. A note deleted on one device but changed on another comes back with the change.',
      a: art('<rect x="20" y="30" width="70" height="90" rx="10" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="170" y="22" width="60" height="100" rx="10" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="32" y="48" width="44" height="6" rx="3" fill="' + A + '"/><rect x="182" y="64" width="36" height="6" rx="3" fill="' + INKC + '" opacity=".6"/><path d="M92 74 C110 74 112 100 124 100 M168 74 C150 74 148 100 136 100" stroke="' + A + '" stroke-width="2.4" fill="none"/><circle cx="130" cy="104" r="12" fill="' + A + '"/><path d="M124 104 l4 4 8 -8" stroke="#fff" stroke-width="2.4" fill="none"/>') },
    { t: 'Paper and connectors', d: 'Text card › Paper adds sticky notes (six colours), index cards, sheets and cardboard to the page, or turns the text box in use into one. Write on them, move them, stretch them from the corner. The new Connect tool joins things: drag from one to another, or out to empty space for a new note already joined. Tap a line to change its arrows or delete it.',
      a: art('<rect x="24" y="26" width="70" height="62" rx="3" fill="#ffe680"/><rect x="150" y="60" width="76" height="52" rx="3" fill="#fffefa" stroke="' + RULE + '"/><rect x="150" y="60" width="76" height="3" fill="#dc5046" opacity=".5"/><path d="M94 57 C122 57 122 86 148 86" stroke="' + INKC + '" stroke-width="2.4" fill="none"/><path d="M141 81 l8 5 -8 5" fill="none" stroke="' + INKC + '" stroke-width="2.4"/><rect x="36" y="40" width="40" height="6" rx="3" fill="rgba(0,0,0,.2)"/><rect x="36" y="54" width="30" height="6" rx="3" fill="rgba(0,0,0,.2)"/>') },
    { t: 'Small touches', d: 'Drag a tab (hold it first on a phone) to change its place. Text card › Spacing now has Letters (tight to wider) for a text box. Settings › Fonts › Default text sets the font and size of all text. On a computer the pen-size slider stays faint until you point at it.',
      a: art('<rect x="20" y="40" width="64" height="30" rx="9" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="92" y="34" width="64" height="30" rx="9" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/><rect x="164" y="40" width="56" height="30" rx="9" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M110 98 h60 M170 98 l-8 -6 M170 98 l-8 6" stroke="' + A + '" stroke-width="3" fill="none" stroke-linecap="round"/><text x="28" y="124" font-size="16" fill="' + INKC + '" letter-spacing="3">A B C</text>') },
    { t: 'More room, easier moves', d: 'The page now runs under the top buttons and tabs, and a button fades away while you draw or move something under it. With Text, one tap picks a text box: drag it to move it, tap outside to let go, double tap to type. In the side map, drag the frame (or tap a part) to choose what the screen will show, then double tap to go there.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><circle cx="196" cy="30" r="9" fill="' + SOFT + '" opacity=".35"/><rect x="40" y="46" width="110" height="40" rx="6" fill="none" stroke="' + A + '" stroke-width="2" stroke-dasharray="6 4"/><rect x="48" y="56" width="80" height="7" rx="3" fill="' + RULE + '"/><rect x="48" y="70" width="60" height="7" rx="3" fill="' + RULE + '"/><path d="M150 96 q20 -30 46 -60" stroke="' + A + '" stroke-width="3" fill="none" stroke-linecap="round"/>') },
    { t: 'Fixes from your feedback', d: 'The tab now shows a note\u2019s name as you type it (and no stray tags when it has no title). Text stays where you left it when you tap outside. In Tap-to-pick, one finger pans. Double tapping a spot on the side map just moves there; it no longer starts typing.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="34" y="26" width="64" height="18" rx="6" fill="' + SOFT + '"/><rect x="104" y="26" width="64" height="18" rx="6" fill="' + SURF + '" stroke="' + A + '"/><rect x="40" y="62" width="120" height="8" rx="4" fill="' + RULE + '"/><rect x="40" y="80" width="90" height="8" rx="4" fill="' + RULE + '"/><circle cx="178" cy="96" r="10" fill="' + A + '" opacity=".25"/>') },
    { t: 'Four ways to lay out the tools', d: 'Settings › Look › Tool layout. Rail: the column you know. Wheel (like Concepts): tools, colours, size and opacity on one wheel; tap the middle for settings, drag the ring to move it, it shrinks to a dot while you draw. Pucks (like Sketchbook): a tool bar, a size puck (drag up/down for size, sideways for opacity), a colour puck and a corner menu. Pen first: just your last tools; hold one finger still on the page (or right-click) and all the tools come to it. Each fits itself to phone, tablet and computer, upright or sideways; on an upright phone the settings card is tall and narrow so the page stays in view.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><circle cx="70" cy="70" r="36" fill="#26272b"/><circle cx="70" cy="70" r="14" fill="' + SURF + '"/><rect x="122" y="28" width="84" height="16" rx="8" fill="#26272b"/><circle cx="134" cy="92" r="14" fill="#26272b"/><circle cx="182" cy="92" r="14" fill="' + A + '"/>') },
    { t: 'Looks, grey, motion, and every note in a tab', d: 'Settings › Look: four looks (Paper, Sketchbook, Studio, Playful), each in Light or Grey (grey replaces the old near-black dark), and Motion: Off, Gentle or Lively. Every note you open now gets its own tab. And when a note was changed on two devices, the newer change is kept by itself; the other version stays in ••• › Version history.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="34" y="30" width="38" height="80" rx="10" fill="#f2ebdd" stroke="#d6c8ae"/><rect x="80" y="30" width="38" height="80" rx="10" fill="#eeeeec" stroke="#26272b" stroke-width="3"/><rect x="126" y="30" width="38" height="80" rx="14" fill="#fff6e8" stroke="#e4572e" stroke-width="2"/><rect x="172" y="30" width="38" height="80" rx="10" fill="#3d3e42"/>') },
    { t: 'Tabs: several notes open at once', d: 'Tap a link to another note and it opens in a new tab; the note you came from stays open. Tabs show as a strip at the top: tap one to switch, × to close it, + (or ••• › Open another note in a new tab) to pick another note. A note opened from the list goes in the tab you were in. The tabs, and the note you were in, come back when the app opens again; from the list, “Open tabs” takes you back.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="30" y="24" width="56" height="20" rx="6" fill="' + SOFT + '"/><rect x="92" y="24" width="56" height="20" rx="6" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/><rect x="154" y="24" width="40" height="20" rx="6" fill="' + SOFT + '"/><path d="M40 62h150M40 78h120M40 94h136" stroke="' + RULE + '" stroke-width="6" stroke-linecap="round"/>') },
    { t: 'Perspective, isometric and text tools', d: 'Guides now has perspective (1, 2 or 3 vanishing points), an isometric grid and a square grid. With one on, a Pen line heads for the nearest vanishing point (or goes level or upright), or takes the nearest grid direction; a curve stays free. Drag the round points to move them. And the Text tool has its own card (tap T twice): letters (bold, font, size, colour), paragraphs (body, headings, quote, code, lists, indent, alignment incl. justify) and spacing between lines and paragraphs for the box.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M28 56H212" stroke="' + A + '" stroke-width="1.5"/><circle cx="60" cy="56" r="5" fill="none" stroke="' + A + '" stroke-width="2"/><circle cx="180" cy="56" r="5" fill="none" stroke="' + A + '" stroke-width="2"/><path d="M120 40V110M120 40L60 56M120 110L60 56M120 40L180 56M120 110L180 56M96 47V100M146 47V100" stroke="' + INKC + '" stroke-width="2" fill="none"/>') },
    { t: 'Your own fonts, also offline', d: 'Put font files (.ttf, .otf, .woff) in the Fonts folder inside your main folder in Drive, or add them from Settings › Fonts. Each is kept on this phone too, so it works without the internet, and it shows in every font list. The six built-in fonts always work offline. Also new: the side map takes in the screen you are on, so a drawing that runs half here and half to the side can be picked whole; in the Text tool a double tap starts typing; and the app no longer slows down after many notes are opened.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><text x="40" y="66" font-family="Lora, serif" font-size="34" fill="' + INKC + '">Aa</text><text x="104" y="66" font-family="Caveat, cursive" font-size="36" fill="' + A + '">Aa</text><text x="160" y="66" font-family="Permanent Marker, cursive" font-size="28" fill="' + INKC + '">Aa</text><path d="M40 96h160" stroke="' + RULE + '" stroke-width="2"/><text x="120" y="116" text-anchor="middle" font-size="12" fill="' + INKC + '">Drive › Fonts</text>') },
    { t: 'The Hand and Text are two tools', d: 'The Hand only moves the page: one finger drags it, and a tap does nothing. Double tap a drawing, picture or text to pick it (Select opens with it picked). Triple tap to type: in the text you tap, or new text on empty space; the rail switches to Text. Text (the T under the Hand) is for typing: double tap text to type in it (one tap only moves around, so the keyboard stays down). With every tool, two fingers move, zoom and turn the page. Typing also carries on after you come back from another app.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="34" y="28" width="40" height="84" rx="10" fill="' + SOFT + '" stroke="' + RULE + '"/><circle cx="54" cy="48" r="12" fill="' + A + '"/><text x="54" y="96" text-anchor="middle" font-size="26" font-weight="700" fill="' + INKC + '">T</text><path d="M96 52h104M96 68h80M96 84h92" stroke="' + RULE + '" stroke-width="3"/><circle cx="150" cy="70" r="5" fill="' + A + '"/><circle cx="150" cy="70" r="12" fill="none" stroke="' + A + '" stroke-width="2"/><circle cx="150" cy="70" r="19" fill="none" stroke="' + A + '" stroke-width="1.5" opacity=".6"/>') },
    { t: 'Linear mode: see a whole side', d: 'Tap an arrow at the edge and a map opens of everything that way: the whole right side, left side, above, below or a corner, not only the nearest part. Scroll it, and double tap a part to bring it into the column. The dashed outline shows where you are. A double tap on the arrow still goes straight to the nearest part. A note now opens in Linear mode or as a free canvas, the way you left it.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="34" y="24" width="70" height="92" rx="8" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="122" y="24" width="86" height="92" rx="8" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/><rect x="128" y="40" width="40" height="30" rx="6" fill="none" stroke="' + A + '" stroke-dasharray="5 4"/><path d="M132 86h60M132 98h44" stroke="' + RULE + '" stroke-width="3"/><path d="M108 70l8-6v12z" fill="' + A + '"/>') },
    { t: 'Your Obsidian vault, copied in', d: 'Settings › Copy notes in › From Obsidian copies a whole vault from your computer into Second brain, keeping its folders. [[Links]] become note links: tap one to open that note (while writing, tap it twice). ••• › Linked from… lists the notes that link to the one you are in. Excalidraw drawings and canvases come in as sharp pictures, with their words below for search. The vault itself is only read, never changed.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="34" y="30" width="64" height="80" rx="8" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="142" y="30" width="64" height="80" rx="8" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><path d="M98 70h40" stroke="' + A + '" stroke-width="3"/><path d="M130 62l8 8-8 8" fill="none" stroke="' + A + '" stroke-width="3"/><path d="M44 46h44M44 58h34M44 70h40" stroke="' + RULE + '" stroke-width="3"/>') },
    { t: 'Choose how a link shows', d: 'When you add a web link you now choose how it shows: a link card that opens the page in your browser, the page itself in a window, or a picture of the page (made by a free screenshot service, so the address is sent to it). Select the link later and tap its mode button to change it any time.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="40" y="30" width="72" height="26" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="128" y="30" width="72" height="50" rx="6" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><rect x="40" y="72" width="72" height="40" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/>') },
    { t: 'Linear mode shows what is off to the side', d: 'On an upright phone, notes scroll up and down as a column, and now arrows at the edges and corners show where more is: drawings, text or pictures off to the side, above or below. Tap an arrow to peek at it for a moment; double tap it (or tap the peek) to move the column there. The note remembers where you were when you open it again. Shake the phone to switch to the free canvas and back; on a tablet use the Linear/Free button. View › Lock zoom and turn keeps a note zoomed and turned as you set it, and fingers then only scroll along the lines or down the columns.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="70" y="26" width="100" height="88" rx="8" fill="' + SOFT + '" stroke="' + RULE + '"/><circle cx="200" cy="70" r="11" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/><path d="M197 65l5 5-5 5" fill="none" stroke="' + A + '" stroke-width="2"/><circle cx="40" cy="34" r="11" fill="' + SURF + '" stroke="' + A + '" stroke-width="2"/>') },
    { t: 'Your tools, your order', d: 'In Settings there is now a Tools list: move each tool up or down to put the side rail in the order you like. Original order puts it back.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="150" y="26" width="52" height="20" rx="6" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><rect x="150" y="54" width="52" height="20" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/><rect x="150" y="82" width="52" height="20" rx="6" fill="' + SOFT + '" stroke="' + RULE + '"/>') },
    { t: 'Links between notes, locks, and adding made simple', d: 'The Add button opens your files straight away: pick several of any kind. Hold it to add the link you copied. Select a part of a note and tap the link symbol, then hold Add in another note: that part shows there, live, with Open to jump to it (••• › Copy a link to this note does the whole note). Select › Lock: can\'t be erased, or can\'t be selected; tap the little sign to unlock. The lasso corner now has New, + Add and − Remove. Feedback notes can be dragged by their corner, and show in the picture exactly as typed.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="34" y="30" width="70" height="80" rx="8" fill="' + SOFT + '" stroke="' + A + '"/><rect x="136" y="30" width="70" height="80" rx="8" fill="' + SOFT + '" stroke="' + A + '"/><path d="M104 70h32" stroke="' + A + '" stroke-width="3" stroke-dasharray="5 4"/><circle cx="196" cy="34" r="10" fill="' + A + '"/>') },
    { t: 'Videos, sounds, PDFs and links on the page', d: 'The picture button in the tools (and Add image in the ••• menu) now adds any file: a picture, a video, a sound or a PDF. A PDF\'s pages go on the page one under another, ready to write on. Every file is saved once in Attachments in your Drive, named by what is in it, so adding the same file again (in this note or another) reuses it. Links go on as a card or as a window showing the page; switch between them from Select. With the Hand, videos play and links open.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><rect x="36" y="30" width="80" height="54" rx="6" fill="' + INKC + '"/><path d="M68 46l18 11-18 11z" fill="' + SURF + '"/><rect x="128" y="30" width="76" height="30" rx="6" fill="' + SOFT + '" stroke="' + A + '"/><rect x="128" y="68" width="40" height="46" rx="3" fill="#fff" stroke="' + RULE + '"/><rect x="172" y="68" width="40" height="46" rx="3" fill="#fff" stroke="' + RULE + '"/>') },
    { t: 'Page backgrounds, clean curves, names on hover', d: 'In a note, the ••• menu now has Page: plain, grid, dots or lines, on the theme or a paper colour (white, cream, kraft, grey, slate, black). Holding the pen at the end of an arc now makes a clean arc, and a wave a smooth curve, instead of straight pieces. Hover the pen over any tool or option to see its name. In the notes list, pinch a page picture with two fingers to zoom in and move around; double-tap to put it back.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M40 30v80M72 30v80M104 30v80M136 30v80M168 30v80M200 30v80M30 46h180M30 78h180M30 110h180" stroke="' + RULE + '"/><path d="M60 96a40 40 0 0 1 80 0" fill="none" stroke="' + A + '" stroke-width="4" stroke-linecap="round"/>') },
    { t: 'Faster drawing, and your feedback fixed', d: 'Pencil and your own pen tips no longer lag, and big pencil scribbles no longer vanish. Plain really is plain again. Text and drawings now stack by what is in front: new drawings go over older text, and Select › Arrange moves text boxes to the front or back too. Undo and redo are a two- or three-finger double tap. Zoom out down to 1%, and draw across the top of the page. Tap the dot on the size slider for colours; double-tap the slider for sizes up to 120. Each pen remembers its own size and colour. Select now shows symbols (hover or hold for names), with Align apart from Arrange, side handles to stretch, and line width under Colour. Fill: hold for a clean shape; patterns show while you draw and can be bigger or spaced out. Any text size in the Aa menu. Notes with drawings show a picture of the page in the list.',
      a: art('<rect x="20" y="14" width="200" height="112" rx="14" fill="' + SURF + '" stroke="' + RULE + '"/><path d="M40 92c20-40 40-40 60 0s40 40 60 0" fill="none" stroke="' + INKC + '" stroke-width="4" stroke-linecap="round"/>' +
        '<rect x="150" y="30" width="22" height="22" rx="5" fill="none" stroke="' + A + '" stroke-width="2"/><rect x="178" y="30" width="22" height="22" rx="5" fill="' + SOFT + '" stroke="' + A + '" stroke-width="2"/><circle cx="56" cy="40" r="9" fill="' + Y + '"/>') },
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
  // The guide: every update so far, as a page of cards to look around (newest first). Nothing is saved unless you write in it.
  function openGuide() {
    var n = newDraft('Serendipity: all updates and how to use it', '');
    n.labels = []; n.page = 'dots';
    var COLS = 3, CW = 560, GAP = 60, colY = [0, 0, 0];
    n.boxes = [{ id: 'b0', x: 0, y: 0, w: CW * COLS + GAP * (COLS - 1), md: '## All updates, newest first\n\nPinch to zoom out and see them all. Short moving pictures of each tool are coming here next.' }];
    colY = [170, 170, 170];
    SLIDES.forEach(function (sl, k) {
      var c = k % COLS, md = '### ' + sl.t + '\n\n' + sl.d, h = 90 + Math.ceil(sl.d.length / 62) * 26;
      n.boxes.push({ id: 'b' + (k + 1), x: c * (CW + GAP), y: colY[c], w: CW, md: md });
      colY[c] += h + GAP;
    });
    n.body = n.boxes.map(function (b) { return b.md; }).join('\n\n');
    openNote(n, true);
  }
  function whatsNew(force) {
    var seen = PREF.seenVersion;
    if (!force && seen === CFG.VERSION) return;
    var first = !seen && !Drive.signedInBefore() && !live().length;
    var i = 0, el = $('whatsNew');
    // Only the last three updates (3.21); everything else is in the guide, one tap away.
    var SL = first ? SLIDES : SLIDES.slice(0, 3);
    function draw(dir) {
      var sl = SL[i], SLIDES = SL;
      el.innerHTML = '<div class="wn-card" role="dialog" aria-modal="true" aria-label="What’s new">' +
        '<div class="wn-top">' + (i === 0 ? '<span class="wn-kicker">' + (first ? 'Welcome to Serendipity' : 'What’s new in ' + esc(CFG.VERSION)) + '</span>' : '<span class="wn-kicker">' + (i + 1) + ' of ' + SLIDES.length + '</span>') +
        '<button type="button" class="wn-skip" data-wn="done">Skip</button></div>' +
        '<div class="wn-slide ' + (dir || '') + '">' + sl.a + '<h2>' + esc(sl.t) + '</h2><p>' + esc(sl.d) + '</p></div>' +
        '<div class="wn-foot"><div class="wn-dots">' + SLIDES.map(function (x, k) { return '<i' + (k === i ? ' class="on"' : '') + '></i>'; }).join('') + '</div>' +
        (i > 0 ? '<button type="button" data-wn="prev">Back</button>' : '') +
        '<button type="button" class="primary" data-wn="' + (i === SLIDES.length - 1 ? 'done' : 'next') + '">' + (i === SLIDES.length - 1 ? 'Start writing' : 'Next') + '</button></div>' +
        '<button type="button" class="wn-all" data-wn="guide">All updates and how to use the app ›</button></div>';
    }
    function close() { el.classList.add('hidden'); el.innerHTML = ''; PREF.seenVersion = CFG.VERSION; savePref(); }
    S.closeWhatsNew = close; S.sheetState = history.state;
    el.onclick = function (e) {
      var b = e.target.closest('[data-wn]');
      if (!b) { if (e.target === el) close(); return; }
      if (b.dataset.wn === 'done') return close();
      if (b.dataset.wn === 'guide') { close(); return openGuide(); }
      if (b.dataset.wn === 'next' && i < SL.length - 1) { i++; draw('from-right'); }
      if (b.dataset.wn === 'prev' && i > 0) { i--; draw('from-left'); }
    };
    var sx = null;
    el.onpointerdown = function (e) { sx = e.clientX; };
    el.onpointerup = function (e) {
      if (sx == null) return; var dx = e.clientX - sx; sx = null;
      if (dx < -50 && i < SL.length - 1) { i++; draw('from-right'); }
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
        'Smoothness': Meter.summary(),
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
    // (3.29) Back in the note (and its tabs) you were in when the app was left.
    if (TABS.inNote && TABS.cur && notes[TABS.cur] && !notes[TABS.cur].deleted && !new URLSearchParams(location.search).has('text')) openNote(notes[TABS.cur]);

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
    var t0 = Date.now(), first = sync.run({ pull: true });
    if (first && first.then) first.then(function () { // a note that was only in Drive yet: open it once it has come in
      var n = TABS.inNote && TABS.cur && noteById(TABS.cur);
      if (n && S.view === 'list' && !S.cur && Date.now() - t0 < 10000) openNote(n);
    }).catch(function () {});
    setTimeout(function () { if (S.view === 'list') whatsNew(false); }, 700);
  })();

  // ---- Names of tools: shown while the pen hovers over a tool or any of its options (3.19) ----
  // (Android shows no tooltip for the pen, so the name of a symbol was nowhere to be seen.)
  (function () {
    var tip = document.createElement('div'); tip.className = 'apptip hidden'; document.body.appendChild(tip);
    var cur = null;
    function nameOf(el) {
      if (el.dataset.tip) return null; // the selection bar shows its own
      var t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      if (!t && el.classList.contains('swatch')) t = 'Colour';
      return t.trim();
    }
    function show(el) {
      var t = nameOf(el); if (!t) return hide();
      cur = el; tip.textContent = t; tip.classList.remove('hidden');
      var r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, x, y;
      if (el.closest('#tools')) { x = r.left - w - 10; y = r.top + r.height / 2 - h / 2; } // beside the rail
      else if (el.closest('#penQuick, #toolQuick')) { x = r.right + 10; y = r.top + r.height / 2 - h / 2; }
      else { x = r.left + r.width / 2 - w / 2; y = r.top - h - 8; if (y < 4) y = r.bottom + 8; }
      tip.style.left = Math.max(4, Math.min(innerWidth - w - 4, x)) + 'px'; tip.style.top = Math.max(4, Math.min(innerHeight - h - 4, y)) + 'px';
    }
    function hide() { cur = null; tip.classList.add('hidden'); }
    var SCOPE = '#tools, #penOpts, #penQuick, #toolQuick, #layersPanel, #noteMenu, #fmtBar, #topBar, .qn-bugview, #editorView header';
    document.addEventListener('pointerover', function (e) {
      if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
      var el = e.target.closest && e.target.closest('button, [role="button"], input[type="range"], .swatch');
      if (!el || !el.closest(SCOPE)) { if (cur) hide(); return; }
      if (el !== cur) show(el);
    }, true);
    document.addEventListener('pointerout', function (e) { if (cur && (!e.relatedTarget || !cur.contains(e.relatedTarget))) hide(); }, true);
    document.addEventListener('pointermove', function (e) { // (3.37, #96) hover that arrives only as moves
      if ((e.pointerType !== 'pen' && e.pointerType !== 'mouse') || e.buttons) return;
      var el = e.target.closest && e.target.closest('button, [role="button"], input[type="range"], .swatch');
      if (el && el !== cur && el.closest(SCOPE)) show(el);
    }, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);
  })();
})();
