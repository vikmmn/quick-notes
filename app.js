// Quick Notes: opens to a blank note, saves as you type, syncs to Google Drive when it can.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG;
  var Drive = window.Drive;
  var N = window.Notes;
  var TASK = N.TASK;

  var notes = {};                 // id -> note
  var store = N.Store();
  var S = { view: 'editor', cur: null, items: null, label: null, q: '', saveTimer: null, undo: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function live() {
    return Object.keys(notes).map(function (k) { return notes[k]; }).filter(function (n) { return !n.deleted; });
  }
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
  function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  function toast(text, btn, fn, ms) {
    $('toastText').textContent = text;
    $('toastBtn').textContent = btn || '';
    $('toastBtn').classList.toggle('hidden', !btn);
    $('toastBtn').onclick = function () { hideToast(); if (fn) fn(); };
    $('toast').classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(hideToast, ms || 5000);
  }
  function hideToast() { $('toast').classList.add('hidden'); }

  // ---------- Sync ----------
  var sync = N.Sync(store, notes, {
    status: renderStatus,
    changed: function (ids) {
      if (S.view === 'list') renderList();
      else if (S.cur && ids.indexOf(S.cur.id) > -1) {
        if (!notes[S.cur.id]) { if (!S.cur.isDraft) showList(); }
        else if (!S.cur.dirty && document.activeElement && !$('editorView').contains(document.activeElement)) openNote(S.cur, true);
        else { renderConflict(); renderMeta(); }
      }
    }
  });

  function renderStatus(st) {
    st = st || sync.status();
    var pill = $('syncPill'), n = st.waiting.length, c = st.conflicts.length, text, cls = '';
    if (st.phase === 'syncing') text = 'Syncing…';
    else if (c) { text = c === 1 ? '1 needs a look' : c + ' need a look'; cls = 'waiting'; }
    else if (st.phase === 'offline') { text = n ? 'Offline · ' + n + ' waiting' : 'Offline'; cls = n ? 'waiting' : ''; }
    else if (st.phase === 'signin') { text = n ? 'Sign in · ' + n + ' waiting' : 'Sign in to sync'; cls = 'waiting'; }
    else if (st.phase === 'error') { text = 'Sync problem'; cls = 'bad'; }
    else if (n) { text = n + ' waiting'; cls = 'waiting'; }
    else text = 'Saved to Drive';
    pill.innerHTML = (cls ? '<span class="dot"></span>' : '') + esc(text);
    pill.className = 'pill ' + cls;
    if (!$('sheetBack').classList.contains('hidden')) renderSheet();
    renderMeta();
  }

  function renderSheet() {
    var st = sync.status(), text, items = st.conflicts.concat(st.waiting);
    if (st.phase === 'signin') text = 'Notes are saved on this device. Sign in with Google to send them to Drive › Readables › Notes. A sign-in lasts about an hour.';
    else if (st.phase === 'offline') text = "You're offline. Notes are saved on this device and go to Drive when you're back online.";
    else if (st.phase === 'error') text = 'Drive said: ' + ((st.error && st.error.message) || 'something went wrong') + '. Notes are safe on this device.';
    else if (st.phase === 'syncing') text = 'Sending changes to Drive…';
    else text = items.length ? 'These go to Drive in a moment.' : 'Everything is in Drive › Readables › Notes.' +
      (st.lastSynced ? ' Last checked ' + new Date(st.lastSynced).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.' : '');
    $('sheetText').textContent = text;
    $('sheetList').innerHTML = items.map(function (n) {
      return '<li>' + esc(n.title || N.fileName(n).replace(/^\S+ \S+ |\.md$/g, '')) +
        (n.conflict ? ' — changed on another device' : n.deleted ? ' — to delete' : '') + '</li>';
    }).join('');
    $('sheetSignIn').classList.toggle('hidden', st.phase !== 'signin');
    $('sheetSync').disabled = st.phase === 'syncing';
  }
  $('syncPill').onclick = function () { renderSheet(); $('sheetBack').classList.remove('hidden'); };
  $('sheetClose').onclick = function () { $('sheetBack').classList.add('hidden'); };
  $('sheetBack').addEventListener('click', function (e) { if (e.target === $('sheetBack')) $('sheetBack').classList.add('hidden'); });
  $('sheetSignIn').onclick = async function () {
    try { await Drive.signIn(); sync.run({ pull: true }); }
    catch (e) { $('sheetText').textContent = e.message; }
  };
  $('sheetSync').onclick = function () { sync.run({ pull: true }); };

  // Renew the sign-in on your first tap once it has run out (or is about to). Google needs a tap to open its
  // window; after the first sign-in it closes again by itself. Notes keep saving on the device meanwhile.
  var lastRenew = 0;
  document.addEventListener('click', function () {
    if (Drive.demo || !Drive.signedInBefore() || !navigator.onLine) return;
    if (Drive.signedIn() && Drive.minutesLeft() > 6) return;
    if (Date.now() - lastRenew < 60000) return; // don't keep popping up if Google says no
    lastRenew = Date.now();
    var wasOut = !Drive.signedIn();
    Drive.signIn().then(function () { if (wasOut) sync.run({ pull: true }); }).catch(function () {});
  }, true);

  // ---------- Saving ----------
  function touch() {
    var n = S.cur;
    if (!n) return;
    if (n.isDraft) {
      if (N.isEmpty(n)) return;
      delete n.isDraft;
      notes[n.id] = n;
    }
    n.updated = new Date().toISOString();
    n.dirty = true;
    n.v = (n.v || 0) + 1;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 250);
    // A new note waits a little, so its file name gets more than the first letters.
    sync.schedule(n.fileId ? 2500 : 8000);
    renderStatus();
  }
  function saveNow() {
    clearTimeout(S.saveTimer);
    if (S.cur && !S.cur.isDraft && notes[S.cur.id]) store.put(S.cur);
  }
  function flush() {
    saveNow();
    if (S.cur && S.cur.isDraft === undefined && N.isEmpty(S.cur) && !S.cur.fileId) {
      // Emptied a note that never reached Drive: just forget it.
      delete notes[S.cur.id]; store.del(S.cur.id);
    }
    sync.run();
  }

  // ---------- The note ----------
  function newDraft(title, body) {
    var now = new Date().toISOString();
    return { id: N.uuid(), title: title || '', body: body || '', kind: 'text', labels: S.label ? [S.label] : [], pinned: false,
      created: now, updated: now, source: 'notes', extra: [], fileId: null, md5: null, fileName: null, folder: null,
      dirty: false, deleted: false, conflict: null, v: 0, isDraft: true };
  }

  function parseItems(body) {
    return String(body || '').split('\n').filter(function (l) { return l.trim(); }).map(function (l) {
      var m = TASK.exec(l);
      return m ? { text: m[2], done: m[1] !== ' ' } : { text: l.replace(/^\s*[-*]\s+/, ''), done: false };
    });
  }
  function itemsToBody(items) {
    return items.map(function (it) { return '- [' + (it.done ? 'x' : ' ') + '] ' + it.text.replace(/\n/g, ' '); }).join('\n');
  }

  function openNote(n, keepView) {
    if (!keepView && S.cur && S.cur !== n) flush();
    S.cur = n;
    showEditor();
    $('noteTitle').value = n.title || '';
    $('noteBody').value = n.body || '';
    $('listBtn').setAttribute('aria-pressed', n.kind === 'list' ? 'true' : 'false');
    $('pinBtn').setAttribute('aria-pressed', n.pinned ? 'true' : 'false');
    $('pinBtn').textContent = n.pinned ? 'Pinned' : 'Pin';
    if (n.kind === 'list') { S.items = parseItems(n.body); renderItems(); }
    else S.items = null;
    $('noteBody').classList.toggle('hidden', n.kind === 'list');
    $('checklist').classList.toggle('hidden', n.kind !== 'list');
    renderLabels();
    renderConflict();
    renderMeta();
    requestAnimationFrame(function () { autosize($('noteBody')); });
  }

  function renderMeta() {
    var n = S.cur;
    if (!n || S.view !== 'editor') return;
    var where = n.isDraft ? '' : !n.fileId ? (n.dirty ? 'On this device, waiting to go to Drive' : '')
      : n.dirty ? 'Waiting to sync' : 'Saved in Drive › Notes' + (n.folder && n.folder !== CFG.NOTES_FOLDER_NAME ? ' › ' + n.folder : '');
    $('noteMeta').textContent = n.isDraft ? '' : ['Edited ' + fmtWhen(n.updated), where].filter(Boolean).join(' · ');
  }

  function renderConflict() {
    var n = S.cur, c = n && n.conflict;
    $('conflict').classList.toggle('hidden', !c);
    if (!c) return;
    $('conflictText').textContent = c.trashed
      ? 'It was deleted on another device. Your version is still here.'
      : 'Your version is kept here and hasn\'t been saved over the other one' + (c.modifiedTime ? ' (changed ' + fmtWhen(c.modifiedTime) + ')' : '') + '.';
    $('keepBoth').textContent = c.trashed ? 'Keep mine' : 'Keep both';
    $('useTheirs').textContent = c.trashed ? 'Delete it here too' : 'Use the other version';
    $('useMine').classList.toggle('hidden', !!c.trashed);
  }
  async function resolve(fn) {
    ['keepBoth', 'useTheirs', 'useMine'].forEach(function (id) { $(id).disabled = true; });
    try {
      var n = await fn(S.cur);
      if (n) openNote(n, true); else showList();
    } catch (e) {
      $('conflictText').textContent = (e.code === 'offline' ? "You're offline. " : e.code === 'auth' ? 'Sign in first (tap the sync button at the top). ' : '') + 'Nothing has been changed.';
    }
    ['keepBoth', 'useTheirs', 'useMine'].forEach(function (id) { $(id).disabled = false; });
  }
  $('keepBoth').onclick = function () { resolve(sync.keepBoth); };
  $('useTheirs').onclick = function () { resolve(sync.useTheirs); };
  $('useMine').onclick = function () { resolve(sync.useMine); };

  $('noteTitle').addEventListener('input', function () { S.cur.title = this.value; touch(); });
  $('noteTitle').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); if (S.cur.kind === 'list') focusItem(firstTodoIndex()); else $('noteBody').focus(); }
  });
  $('noteBody').addEventListener('input', function () { S.cur.body = this.value; autosize(this); touch(); });

  // Checklist: unticked items first, ticked ones under "Done".
  function firstTodoIndex() {
    for (var i = 0; i < S.items.length; i++) if (!S.items[i].done) return i;
    addItemAt(S.items.length);
    return S.items.length - 1;
  }
  function itemRow(it, i) {
    return '<li class="' + (it.done ? 'done' : '') + '" data-i="' + i + '"><input type="checkbox" aria-label="Done"' + (it.done ? ' checked' : '') + '>' +
      '<textarea rows="1" spellcheck="true" autocapitalize="sentences" aria-label="List item">' + esc(it.text) + '</textarea>' +
      '<button type="button" class="ghost remove" aria-label="Remove item">×</button></li>';
  }
  function renderItems() {
    var todo = [], done = [];
    S.items.forEach(function (it, i) { (it.done ? done : todo).push(itemRow(it, i)); });
    $('todoItems').innerHTML = todo.join('');
    $('doneItems').innerHTML = done.join('');
    $('doneHead').textContent = done.length + ' done';
    $('doneHead').classList.toggle('hidden', !done.length);
    Array.prototype.forEach.call($('checklist').querySelectorAll('textarea'), autosize);
  }
  function itemsChanged() { S.cur.body = itemsToBody(S.items); touch(); }
  function focusItem(i, atStart) {
    var ta = $('checklist').querySelector('li[data-i="' + i + '"] textarea');
    if (!ta) return;
    ta.focus();
    var p = atStart ? 0 : ta.value.length;
    ta.setSelectionRange(p, p);
  }
  function addItemAt(i, text) { S.items.splice(i, 0, { text: text || '', done: false }); }
  $('checklist').addEventListener('input', function (e) {
    if (e.target.tagName !== 'TEXTAREA') return;
    var i = +e.target.closest('li').dataset.i;
    var val = e.target.value;
    if (val.indexOf('\n') > -1) { // pasted several lines: one item each
      var parts = val.split('\n');
      S.items[i].text = parts[0];
      parts.slice(1).forEach(function (p, k) { addItemAt(i + 1 + k, p); });
      renderItems(); itemsChanged(); focusItem(i + parts.length - 1);
      return;
    }
    S.items[i].text = val; autosize(e.target); itemsChanged();
  });
  $('checklist').addEventListener('keydown', function (e) {
    if (e.target.tagName !== 'TEXTAREA') return;
    var i = +e.target.closest('li').dataset.i;
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      var pos = e.target.selectionStart, text = S.items[i].text;
      S.items[i].text = text.slice(0, pos);
      addItemAt(i + 1, text.slice(pos));
      renderItems(); itemsChanged(); focusItem(i + 1, true);
    } else if (e.key === 'Backspace' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
      e.preventDefault();
      var prev = i - 1;
      while (prev >= 0 && S.items[prev].done !== S.items[i].done) prev--;
      if (prev < 0 && S.items[i].text) return;
      var carry = S.items[i].text;
      S.items.splice(i, 1);
      if (prev >= 0) { var len = S.items[prev].text.length; S.items[prev].text += carry; renderItems(); itemsChanged();
        var ta = $('checklist').querySelector('li[data-i="' + prev + '"] textarea'); if (ta) { ta.focus(); ta.setSelectionRange(len, len); } }
      else { renderItems(); itemsChanged(); $('noteTitle').focus(); }
    }
  });
  $('checklist').addEventListener('change', function (e) {
    if (e.target.type !== 'checkbox') return;
    var i = +e.target.closest('li').dataset.i;
    S.items[i].done = e.target.checked;
    renderItems(); itemsChanged();
  });
  $('checklist').addEventListener('click', function (e) {
    var b = e.target.closest('button.remove');
    if (!b) return;
    S.items.splice(+b.closest('li').dataset.i, 1);
    renderItems(); itemsChanged();
  });
  $('addItem').onclick = function () {
    var last = -1;
    S.items.forEach(function (it, i) { if (!it.done) last = i; });
    addItemAt(last + 1); renderItems(); itemsChanged(); focusItem(last + 1);
  };

  $('listBtn').onclick = function () {
    var n = S.cur;
    if (n.kind === 'list') { n.kind = 'text'; n.body = itemsToBody(S.items); S.items = null; }
    else { n.kind = 'list'; S.items = parseItems(n.body); if (!S.items.length) S.items.push({ text: '', done: false }); n.body = itemsToBody(S.items); }
    openNote(n, true);
    if (n.kind === 'list') focusItem(firstTodoIndex()); else $('noteBody').focus();
    touch();
  };
  $('pinBtn').onclick = function () {
    S.cur.pinned = !S.cur.pinned;
    $('pinBtn').setAttribute('aria-pressed', S.cur.pinned ? 'true' : 'false');
    $('pinBtn').textContent = S.cur.pinned ? 'Pinned' : 'Pin';
    touch();
  };

  // Labels
  function renderLabels() {
    $('labelChips').innerHTML = (S.cur.labels || []).map(function (l, i) {
      return '<span class="chip">' + esc(l) + '<button type="button" data-rm="' + i + '" aria-label="Remove label ' + esc(l) + '">×</button></span>';
    }).join('');
    $('labelList').innerHTML = allLabels().map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
  }
  function addLabel(raw) {
    var l = String(raw || '').replace(/[,#]/g, ' ').trim().replace(/\s+/g, ' ');
    if (!l) return;
    var existing = allLabels().filter(function (x) { return x.toLowerCase() === l.toLowerCase(); })[0];
    l = existing || l;
    if (S.cur.labels.some(function (x) { return x.toLowerCase() === l.toLowerCase(); })) return;
    S.cur.labels.push(l);
    renderLabels(); touch();
  }
  $('labelInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLabel(this.value); this.value = ''; }
  });
  $('labelInput').addEventListener('change', function () { addLabel(this.value); this.value = ''; });
  $('labelChips').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-rm]');
    if (!b) return;
    S.cur.labels.splice(+b.dataset.rm, 1);
    renderLabels(); touch();
  });
  $('labelBtn').onclick = function () { $('labelInput').focus(); };

  // Delete (to Drive's trash), with Undo
  $('deleteBtn').onclick = function () {
    var n = S.cur;
    if (n.isDraft) { showList(); return; }
    clearTimeout(S.saveTimer);
    var neverSynced = !n.fileId;
    if (neverSynced) { delete notes[n.id]; store.del(n.id); }
    else { n.deleted = true; n.dirty = true; n.v++; store.put(n); sync.schedule(7000); }
    S.cur = null;
    showList();
    toast('Note deleted', 'Undo', function () {
      n.deleted = false; n.v++;
      if (neverSynced || !n.md5) { n.dirty = true; }
      notes[n.id] = n; store.put(n);
      openNote(n, true); pushView();
    }, 6500);
  };

  // ---------- The list ----------
  function matches(n, words) {
    if (S.label && !(n.labels || []).some(function (l) { return l.toLowerCase() === S.label.toLowerCase(); })) return false;
    if (!words.length) return true;
    var hay = (n.title + '\n' + n.body + '\n' + (n.labels || []).join(' ')).toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) > -1; });
  }
  function card(n) {
    var inner = '';
    if (n.title) inner += '<h3>' + esc(n.title) + '</h3>';
    if (n.kind === 'list') {
      var items = parseItems(n.body), todo = [], doneCount = 0;
      items.forEach(function (it, i) { if (it.done) doneCount++; else todo.push({ it: it, i: i }); });
      inner += '<ul>' + todo.slice(0, 8).map(function (x) {
        return '<li><input type="checkbox" data-tick="' + x.i + '" aria-label="Tick ' + esc(x.it.text) + '"><span>' + esc(x.it.text) + '</span></li>';
      }).join('') + '</ul>';
      var more = [];
      if (todo.length > 8) more.push('+' + (todo.length - 8) + ' more');
      if (doneCount) more.push(doneCount + ' done');
      if (more.length) inner += '<div class="more">' + more.join(' · ') + '</div>';
    } else if (n.body) {
      inner += '<p class="text">' + esc(n.body.slice(0, 600).replace(/^(\s*)[-*] \[ \] ?/gm, '$1☐ ').replace(/^(\s*)[-*] \[[xX]\] ?/gm, '$1☑ ')) + '</p>';
    }
    var foot = (n.labels || []).map(function (l) { return '<span class="chip">' + esc(l) + '</span>'; });
    if (n.conflict) foot.push('<span class="flag">Changed elsewhere</span>');
    else if (n.dirty) foot.push('<span class="flag">Waiting</span>');
    if (foot.length) inner += '<div class="foot">' + foot.join('') + '</div>';
    return '<article class="card" tabindex="0" data-id="' + esc(n.id) + '">' + (inner || '<p class="text muted">Empty note</p>') + '</article>';
  }
  function renderList() {
    var words = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    var list = live().filter(function (n) { return matches(n, words); })
      .sort(function (a, b) { return String(b.updated).localeCompare(String(a.updated)); });
    var pinned = list.filter(function (n) { return n.pinned; }), others = list.filter(function (n) { return !n.pinned; });
    $('pinned').innerHTML = pinned.map(card).join('');
    $('others').innerHTML = others.map(card).join('');
    $('pinnedHead').classList.toggle('hidden', !pinned.length);
    $('othersHead').classList.toggle('hidden', !pinned.length || !others.length);
    var empty = !list.length;
    $('emptyMsg').classList.toggle('hidden', !empty);
    $('emptyMsg').textContent = words.length || S.label ? 'No notes match.' : 'No notes yet. Tap + New to write one.';
    var labels = allLabels();
    if (S.label && labels.indexOf(S.label) < 0) labels.unshift(S.label);
    $('filters').innerHTML = labels.length ? ['<button type="button" data-label="" aria-pressed="' + (!S.label) + '">All</button>']
      .concat(labels.map(function (l) { return '<button type="button" data-label="' + esc(l) + '" aria-pressed="' + (S.label === l) + '">' + esc(l) + '</button>'; })).join('') : '';
  }
  $('q').addEventListener('input', function () { S.q = this.value; renderList(); });
  $('filters').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-label]');
    if (!b) return;
    S.label = b.dataset.label || null; renderList();
  });
  function onCards(e) {
    var tick = e.target.closest('input[data-tick]');
    var c = e.target.closest('.card');
    if (!c) return;
    var n = notes[c.dataset.id];
    if (!n) return;
    if (tick) {
      var items = parseItems(n.body);
      items[+tick.dataset.tick].done = true;
      n.body = itemsToBody(items);
      var prev = S.cur; S.cur = n; touch(); saveNow(); S.cur = prev;
      setTimeout(renderList, 250);
      return;
    }
    if (e.target.closest('input')) return;
    openNote(n); pushView();
  }
  $('pinned').addEventListener('click', onCards);
  $('others').addEventListener('click', onCards);
  ['pinned', 'others'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList.contains('card')) e.target.click(); });
  });

  // ---------- Views ----------
  function showEditor() {
    S.view = 'editor';
    $('editorView').classList.remove('hidden'); $('listView').classList.add('hidden');
    $('toolbar').classList.remove('hidden');
    $('backBtn').classList.remove('hidden'); $('pinBtn').classList.remove('hidden');
    $('appTitle').classList.add('hidden'); $('newBtn').classList.add('hidden'); $('barSpacer').classList.remove('hidden');
    $('footer').classList.add('hidden');
  }
  function showList() {
    if (S.cur) flush();
    S.view = 'list';
    $('editorView').classList.add('hidden'); $('listView').classList.remove('hidden');
    $('toolbar').classList.add('hidden');
    $('backBtn').classList.add('hidden'); $('pinBtn').classList.add('hidden');
    $('appTitle').classList.remove('hidden'); $('newBtn').classList.remove('hidden'); $('barSpacer').classList.add('hidden');
    $('footer').classList.remove('hidden');
    renderList();
    window.scrollTo(0, 0);
  }
  // The phone's back button goes from a note to the list.
  function pushView() { try { history.pushState({ v: 'editor' }, ''); } catch (e) {} }
  window.addEventListener('popstate', function () { if (S.view === 'editor') showList(); });
  $('backBtn').onclick = function () {
    if (history.state && history.state.v === 'editor') history.back(); else showList();
  };
  $('newBtn').onclick = function () { openNote(newDraft()); pushView(); $('noteBody').focus(); };
  window.addEventListener('scroll', function () { $('bar').classList.toggle('scrolled', window.scrollY > 4); }, { passive: true });

  // Save and sync when the app is put away or comes back.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { saveNow(); sync.run(); }
    else sync.run({ pull: true });
  });
  window.addEventListener('pagehide', saveNow);
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
    // Shown in the footer of the list, and works on the note opened last.
    $('demoElsewhere').onclick = function () {
      var n = S.lastOpened && notes[S.lastOpened];
      if (!n || !n.fileId) { toast('Open a note that is already in Drive first.'); return; }
      Drive.editElsewhere(n.fileId);
      toast('“' + (n.title || 'That note') + '” was changed on the pretend laptop. Edit it here before syncing to see the warning.', null, null, 7000);
    };
  }
  var _open = openNote;
  openNote = function (n, keep) { S.lastOpened = n.id; return _open(n, keep); };

  // ---------- Start ----------
  (async function start() {
    var saved = await store.load();
    saved.forEach(function (n) { notes[n.id] = n; });

    // Android "Share to Quick Notes": arrives as ?title=…&text=…&url=…
    var p = new URLSearchParams(location.search), shared = null;
    if (p.has('text') || p.has('url') || p.has('title')) {
      var url = p.get('url') || '', text = p.get('text') || '';
      if (url && text.indexOf(url) < 0) text = (text ? text + '\n\n' : '') + url;
      shared = newDraft(p.get('title') || '', text);
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
    }

    try { history.replaceState({ v: 'list' }, ''); } catch (e) {}
    var first = shared || newDraft();
    openNote(first, true);
    pushView();
    if (shared) touch();
    else $('noteBody').focus();

    if (Drive.demo) { await Drive.signIn(); }
    renderStatus();
    sync.run({ pull: true });
  })();
})();
