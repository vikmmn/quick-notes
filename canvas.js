// Serendipity: the note canvas. Text boxes (rich text, saved as Markdown) and ink, placed anywhere.
// The page starts like Keep: one text box at the top left. Double-tap empty space for another text box,
// draw with the pen (an S Pen draws without switching tools), and move things with the Move tool.
(function () {
  'use strict';
  var M = 16;                 // margin around the content
  var LIB = function () { return window.QNLib; };

  // Blank lines between paragraphs. Markdown treats several blank lines as one, so an empty paragraph is
  // saved as a line holding only &nbsp; (Obsidian and other apps show it as an empty line too).
  var NBSP = '\u00a0', SPACER = '&nbsp;';
  function getMd(ed) {
    var doc = ed.state.doc, schema = ed.schema, kids = [], any = false;
    doc.forEach(function (node) {
      if (node.type.name === 'paragraph' && node.childCount === 0) { any = true; kids.push(schema.nodes.paragraph.create(node.attrs, schema.text(NBSP))); }
      else kids.push(node);
    });
    if (!any) return LIB().getMarkdown(ed);
    var md = ed.storage.markdown.serializer.serialize(doc.type.create(doc.attrs, kids));
    md = md.replace(/(^[ \t]*[-*] \[[ xX]\][^\n]*)\n\n(?=[ \t]*[-*] \[[ xX]\])/gm, '$1\n');
    md = md.replace(/^(\u00a0|&nbsp;|&#160;)$/gm, SPACER);
    return md.replace(/(\s*&nbsp;)+\s*$/, ''); // empty lines at the very end mean nothing
  }
  // Loading: each &nbsp; line becomes an empty paragraph again, so the caret starts on a truly empty line.
  function toEditor(md) { return String(md || '').replace(/^&nbsp;[ \t]*$/gm, '<p></p>'); }

  // (3.27.1) The editor has no tables or raw HTML blocks: it flattened a table into one run of words the moment a
  // note was opened and saved. Now each table (and block of HTML) is set aside before the box loads, shown as one
  // line like  ⟦table 1: A · B⟧, and put back exactly as written when the box is saved. Delete the line to delete it.
  var HTMLB = /^\s{0,3}<(div|table|details|iframe|section|center|video|audio|pre|ul|ol|blockquote|figure|p)\b/i;
  var SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  function protect(md) {
    var lines = String(md || '').split('\n'), out = [], keep = [], i = 0, fence = null;
    function take(kind, from, to, label) {
      keep.push(lines.slice(from, to).join('\n'));
      out.push('', '\u27e6' + kind + ' ' + keep.length + (label ? ': ' + label : '') + '\u27e7', '');
    }
    while (i < lines.length) {
      var L = lines[i], f = /^\s*(```|~~~)/.exec(L);
      if (f) { fence = fence ? (L.indexOf(fence) >= 0 ? null : fence) : f[1]; out.push(L); i++; continue; }
      if (!fence && /^\s*\|/.test(L) && i + 1 < lines.length && SEP.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
        var j = i + 2; while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
        var cells = L.replace(/^\s*\||\|\s*$/g, '').split('|').map(function (c) { return c.trim(); }).filter(Boolean).slice(0, 3).join(' \u00b7 ');
        take('table', i, j, cells); i = j; continue;
      }
      if (!fence && HTMLB.test(L)) {
        var k = i; while (k < lines.length && lines[k].trim() !== '') k++;
        take('html', i, k, ''); i = k; continue;
      }
      out.push(L); i++;
    }
    return { text: keep.length ? out.join('\n') : String(md || ''), keep: keep };
  }
  function unprotect(md, keep) {
    if (!keep || !keep.length) return md;
    return md.replace(/\u27e6(?:table|html) (\d+)[^\u27e7]*\u27e7/g, function (m, n) { return keep[+n - 1] != null ? keep[+n - 1] : m; });
  }

  function el(tag, cls, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Drawing lives in ink.js (layers, brushes, erasers, lasso, nudge, fills).
  var INK = { pen: 1, erase: 1, lasso: 1, nudge: 1, fill: 1, guide: 1 };

  // ---------- The canvas ----------
  function NoteCanvas(host, wrap, note, hooks) {
    var self = this;
    // Every listener on the shared page elements is removed again when the note closes. (Before 3.4 they stayed,
    // so each note opened in a session added another copy that handled every touch and pen movement again.)
    var offs = [];
    function on(t, type, fn, opt) { t.addEventListener(type, fn, opt); offs.push(function () { t.removeEventListener(type, fn, opt); }); }
    var stage = el('div', 'stage', host);
    // The page behind everything (3.19): plain, grid, dots or lines, on the theme's paper or a paper colour.
    var pageBg = el('div', 'page-bg', stage);
    // (3.23) Two background layers, drawn by bg.js: a grid over a texture (paper, cloth, wood, steel, boards…).
    function setPage(page) {
      var pc = getComputedStyle(stage).getPropertyValue('--paper').trim(), themeDark = window.QNBg && /^#[0-9a-f]{6}$/i.test(pc) ? window.QNBg.isDark(pc) : false;
      var C = window.QNBg ? window.QNBg.css(page, themeDark) : { any: false };
      stage.classList.toggle('on-paper', !!C.color);
      if (C.ink) { stage.style.setProperty('--ink', C.ink); } else stage.style.removeProperty('--ink');
      pageBg.style.display = C.any ? '' : 'none';
      pageBg.style.backgroundColor = C.color || 'var(--paper)';
      pageBg.style.backgroundImage = C.image || 'none';
      pageBg.style.backgroundSize = C.size || '';
      pageBg.style.setProperty('--qn-m', M + 'px');
    }
    setPage(note.page);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ink-layer');
    stage.appendChild(svg);
    var selBox = el('div', 'sel hidden', stage);
    var selBar = el('div', 'selbar hidden', stage);
    selBar.innerHTML = '<button type="button" data-act="delete">Delete</button>';

    var boxes = note.boxes;
    var zPos = {}, zIdx = {}, zTie = {}; // each text box's depth and place in the stack (worked out by ink.js)
    if (!Array.isArray(note.ink) || !note.ink.length) note.ink = [window.QNInk.newLayer()];
    var ink = note.ink;
    var editors = {};          // box id -> { el, ed }
    var tool = 'type', penSeen = !!(hooks.penKnown && hooks.penKnown());
    // A finger draws, scrolls, or (auto) draws until a pen has been used on this device.
    function fingerDraws() { var m = hooks.finger ? hooks.finger() : 'auto'; return m === 'draw' || (m !== 'scroll' && !penSeen); }

    // The title, labels and "Edited" line sit on the page above the text, so they move and zoom with it.
    // (3.33, #90) The top buttons and tabs float over the page: this much of the top of the screen is under them.
    function topIn() { return hooks.topInset ? hooks.topInset() : 0; }
    var head = hooks.head ? hooks.head() : null, headH = 0, headRO = null;
    function placeHead() {
      if (!head) return;
      head.style.width = Math.max(240, host.clientWidth) + 'px';
      headH = head.offsetHeight;
      head.style.top = (-headH) + 'px';
    }
    if (head) {
      head.classList.add('in-page'); stage.appendChild(head); placeHead();
      if (window.ResizeObserver) headRO = new ResizeObserver(function () {
        var h = headH; placeHead();
        if (h === headH) return;
        if (!h && view) { view.y += headH; applyView(); } // measured for the first time: show it
        drawNavSoon(true);
      });
      if (headRO) headRO.observe(head);
    }

    // ---- The view: an endless page you can move, zoom and turn ----
    // A point on the page (stage coordinates) appears on screen at (x, y) + rotate(r) · z · point.
    var VKEY = 'qn-view:' + note.id;
    var view = { x: 0, y: headH + topIn(), z: 1, r: 0, h: 2 };
    try {
      var sv = JSON.parse(localStorage.getItem(VKEY) || 'null');
      if (sv && isFinite(sv.z)) { view = sv; if (!sv.h) { view.y += headH; view.h = 1; } if (view.h === 1) { view.y += topIn(); view.h = 2; } } // saved before the title moved onto the page (h 1) / before the top buttons floated over it (h 2)
    } catch (e) {}
    var ZMIN = 0.01, ZMAX = 12, viewTimer = null, navRaf = 0;
    function clampZ(z) { return Math.max(ZMIN, Math.min(ZMAX, z)); }
    function toWorld(sx, sy) { var dx = sx - view.x, dy = sy - view.y, c = Math.cos(-view.r), s = Math.sin(-view.r); return [(dx * c - dy * s) / view.z, (dx * s + dy * c) / view.z]; }
    function toScreen(wx, wy) { var c = Math.cos(view.r), s = Math.sin(view.r); return [view.x + (wx * c - wy * s) * view.z, view.y + (wx * s + wy * c) * view.z]; }
    function local(ev) { var r = host.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
    // While typing, the line being typed stays in view, about a third of the way down the space the keyboard leaves
    // (3.23). The page moves only when the caret gets near the edges of that space.
    var caretRaf = 0;
    function keepCaret() {
      cancelAnimationFrame(caretRaf);
      caretRaf = requestAnimationFrame(function () {
        var s = window.getSelection(); if (!s || !s.rangeCount || !active) return;
        // (3.32, #84) Only while a text box really has the caret. After a tap outside, the keyboard closes and this ran on
        // a leftover selection, moving the page so the text jumped away from where it was left.
        var fe = document.activeElement; if (!fe || !fe.closest || !fe.closest('.box') || !stage.contains(fe)) return;
        var r = s.getRangeAt(0).getBoundingClientRect(); if (!r || (!r.height && !r.top)) return;
        var vv = window.visualViewport, top = (vv ? vv.offsetTop : 0), hgt = vv ? vv.height : innerHeight, hr = host.getBoundingClientRect();
        var lo = Math.max(hr.top + topIn(), top) + 40, hi = Math.min(hr.bottom, top + hgt) - 60;
        if (hi - lo < 80) return;
        var want = null;
        if (r.bottom > hi) want = lo + (hi - lo) * 0.38; else if (r.top < lo) want = lo + (hi - lo) * 0.25;
        if (want == null) return;
        view.y += want - (r.top + r.bottom) / 2; clampPage(); applyView();
      });
    }
    if (window.visualViewport) on(window.visualViewport, 'resize', function () { if (active) keepCaret(); });
    // Page mode (3.23): a phone held upright opens notes like a page, only scrolling up and down (no sideways moving
    // or zooming), as in Keep. Turned sideways, or on a tablet, it is the open canvas. View › Free canvas switches.
    // (3.24.1: in Auto, a note with drawings, pictures or text boxes out to the side of the page opens as the free canvas,
    // so nothing seems lost; Always keeps it a page.)
    // 3.25 (#70): Linear mode is no longer only the left column. Arrows at the screen's edges and corners show where
    // more is; a double tap moves the column there (view.lx) and that is remembered with the note's view. A shake on a
    // phone, or the Linear/Free button on a tablet, switches between Linear mode and the free canvas for this note.
    // 3.27 (feedback 22 Nov): the switch is saved with the note's view (view.mo), so a note closed in Linear mode
    // opens in Linear mode again, and one closed as a free canvas opens as a free canvas.
    var modeOv = view.mo === 'lin' || view.mo === 'free' ? view.mo : null; // 'lin' | 'free' | null (follow View › Linear mode)
    function phoneNow() { return Math.min(screen.width, screen.height) < 600; }
    function pageMode() {
      if (modeOv) return modeOv === 'lin';
      var pref = (window.QNPageMode || 'auto');
      return pref === 'on' || (pref === 'auto' && phoneNow() && innerHeight > innerWidth);
    }
    var topCache = null;
    function topLimit() { return topLimit0() + topIn(); } // the title sits just below the floating top buttons
    function topLimit0() { // how far up Linear mode scrolls: the title, or higher if something sits above it
      if (topCache != null) return topCache;
      if (!eng) return headH;
      var b = contentBox(); topCache = b ? Math.max(headH, -b.y + (b.y < -headH ? M : 0)) : headH;
      return topCache;
    }
    function clampPage() {
      if (!pageMode()) return;
      view.z = 1; view.r = 0; view.x = view.lx || 0; // the column in focus fills the width
      var t = topLimit(); if (view.y > t) view.y = t;
    }
    self.pageMode = pageMode;
    function applyView() {
      clampPage();
      stage.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) rotate(' + view.r + 'rad) scale(' + view.z + ')';
      if (eng) eng.viewChanged();
      if (hooks.view) hooks.view({ z: view.z, r: view.r });
      clearTimeout(viewTimer); viewTimer = setTimeout(function () { try { localStorage.setItem(VKEY, JSON.stringify(view)); } catch (e) {} }, 400);
      drawNavSoon(); drawDirsSoon();
    }
    var eng = null;
    eng = new window.QNInk.Engine({
      center: function () { var w = toWorld(host.clientWidth / 2, host.clientHeight / 2); return [w[0] - M, w[1] - M, -(view.r || 0)]; }, // the middle of the screen, and the page's turn
      uiHost: host, toScreen: function (x, y) { return toScreen(x + M, y + M); }, zoom: function () { return view.z; },
      zoomTo: function (b) { fitRect(b, true); },
      layers: ink, svg: svg, stage: stage, margin: M, boxes: boxApi(),
      changed: function () { changed('ink'); },
      notice: function (t) { if (hooks.notice) hooks.notice(t); },
      textLook: function (t) { if (hooks.textLook) hooks.textLook(t); },
      toNewNote: hooks.toNewNote ? function (d, move) { return hooks.toNewNote(d, move); } : null,
      copyLink: hooks.copyLink ? function (b) { return hooks.copyLink(b); } : null,
      imageUrl: function (src) { return hooks.imageUrl ? hooks.imageUrl(src) : null; },
      view: function () { // the part of the page on screen, as a box in page coordinates
        var W = host.clientWidth, H = host.clientHeight, pts = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H)];
        var xs = pts.map(function (q) { return q[0]; }), ys = pts.map(function (q) { return q[1]; });
        var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
        return { x: x0 - M, y: y0 - M, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0 };
      }
    });
    var selected = null;       // { kind: 'box'|'ink', id }
    var hist = [], future = [], textTimer = null, mdTimer = null;
    var active = null;         // the editor with the caret

    // A version for undo: the text boxes as text, the drawing as its layers and the (unchanging) items in them.
    // Items are shared between versions, never copied: ink.js swaps in a copy before changing one.
    function copyLayers(ls) { return ls.map(function (l) { var c = {}; for (var k in l) c[k] = l[k]; c.items = l.items.slice(); return c; }); }
    function snapshot() { return { boxes: JSON.stringify(boxes.map(function (b) { var o = { id: b.id, x: b.x, y: b.y, w: b.w, md: b.md }; if (b.l) o.l = b.l; if (b.r) o.r = b.r; if (b.g) o.g = b.g; if (b.co) o.co = b.co; if (b.z != null) o.z = b.z; if (b.ls) o.ls = b.ls; if (b.ps != null) o.ps = b.ps; return o; })), ink: copyLayers(ink) }; }
    function sameAs(a, b) {
      if (!b || a.boxes !== b.boxes || a.ink.length !== b.ink.length) return false;
      for (var i = 0; i < a.ink.length; i++) {
        var x = a.ink[i], y = b.ink[i];
        if (x.id !== y.id || x.name !== y.name || x.gid !== y.gid || x.gname !== y.gname || x.vis !== y.vis || x.lock !== y.lock || x.op !== y.op || x.blend !== y.blend || x.clip !== y.clip || x.items.length !== y.items.length) return false;
        for (var j = 0; j < x.items.length; j++) if (x.items[j] !== y.items[j]) return false;
      }
      return true;
    }
    hist.push(snapshot());
    var lastRec = Date.now();
    function record() {
      lastRec = Date.now();
      var s = snapshot();
      if (sameAs(s, hist[hist.length - 1])) return;
      hist.push(s); if (hist.length > 200) hist.shift();
      future = [];
      hooks.history(hist.length > 1, false);
    }
    // Text boxes belong to a drawing layer (the bottom one unless placed on another): hidden, locked and faded
    // with it. (Since 3.18.2 text and drawings stack by what is in front: see the order in ink.js.)
    function layerOfBox(b) {
      for (var i = 0; i < ink.length; i++) if (ink[i].id === b.l) return ink[i];
      // Text without a layer (or whose layer was deleted) goes on the bottom one, and stays there once there are
      // several layers (so moving layers around doesn't move the text to another one).
      if (ink.length > 1) b.l = ink[0].id; else delete b.l;
      return ink[0];
    }
    function applyBoxLayers() {
      boxes.forEach(function (b) {
        var e = editors[b.id], L = layerOfBox(b); if (!e || !L) return;
        e.el.style.display = L.vis === false ? 'none' : '';
        var op = (L.op == null ? 1 : L.op) * (b.co || 1);
        e.el.style.opacity = op === 1 ? '' : op;
        e.el.classList.toggle('locked', !!L.lock);
        if (e.ed.setEditable && e.lockState !== !!L.lock) { e.lockState = !!L.lock; e.ed.setEditable(!L.lock); }
      });
    }
    self.textCounts = function () {
      var out = {};
      boxes.forEach(function (b) { if (!String(b.md || '').trim()) return; var L = layerOfBox(b); if (L) out[L.id] = (out[L.id] || 0) + 1; });
      return out;
    };
    function changed(kind) {
      topCache = null; blocksC = null; drawDirsSoon();
      applyBoxLayers();
      hooks.change(kind);
      if (kind === 'text') { clearTimeout(textTimer); textTimer = setTimeout(record, 700); }
      else record();
      layout();
    }

    // ---- Size: the stage is as big as the content plus room to grow; never smaller than the screen ----
    function contentRight() {
      var r = 0, b = 0;
      boxes.forEach(function (bx) {
        var e = editors[bx.id];
        r = Math.max(r, bx.x + (bx.w || 0)); b = Math.max(b, bx.y + (e ? e.el.offsetHeight : 40));
      });
      var q = eng.bounds(); r = Math.max(r, q.r); b = Math.max(b, q.b);
      return { r: r, b: b };
    }
    function autoWidth() { return Math.max(240, host.clientWidth - 2 * M); }
    var TEXT_W = 620;
    function layout() {
      boxes.forEach(function (b) {
        var e = editors[b.id];
        if (!e) return;
        e.el.style.left = (b.x + M) + 'px'; e.el.style.top = (b.y + M) + 'px';
        e.el.style.transform = b.r ? 'rotate(' + b.r + 'rad)' : ''; // text written on a turned page stays straight to how it was written
        if (b.ls) e.el.style.setProperty('--qn-lh', b.ls); else e.el.style.removeProperty('--qn-lh'); // (3.28) line and paragraph spacing
        if (b.ps != null) e.el.style.setProperty('--qn-ps', b.ps + 'em'); else e.el.style.removeProperty('--qn-ps');
        // A text box without its own width: a comfortable reading width, not the whole screen (3.18.1), so in
        // landscape the rest of the page stays free for a quick scribble with the pen.
        e.el.style.width = (b.w || Math.max(160, Math.min(TEXT_W, autoWidth() - b.x))) + 'px';
      });
      var c = contentRight();
      var W = Math.max(host.clientWidth, c.r + 2 * M + 160);
      var H = Math.max(host.clientHeight, c.b + 2 * M + 200);
      stage.style.width = W + 'px'; stage.style.height = H + 'px';
      placeHead();
      svg.setAttribute('width', W); svg.setAttribute('height', H); eng.size(W, H);
      drawSelection(); drawNavSoon(true);
    }

    // ---- Text boxes ----
    function mountBox(b) {
      var e = el('div', 'box', stage);
      e.dataset.id = b.id;
      if (zIdx[b.id] != null) e.style.zIndex = zIdx[b.id];
      var grip = el('div', 'grip', e); grip.title = 'Drag to move'; grip.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16"><circle cx="2" cy="3" r="1.4"/><circle cx="8" cy="3" r="1.4"/><circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="2" cy="13" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>';
      var mount = el('div', 'ed', e);
      el('div', 'resize', e).title = 'Drag to change the width';
      var isFirst = boxes[0] === b;
      var pr = protect(b.md);
      var ed = LIB().makeEditor(mount, toEditor(pr.text), {
        placeholder: isFirst ? 'Note' : 'Text',
        onUpdate: function () {
          clearTimeout(mdTimer);
          mdTimer = setTimeout(function () { flushText(b.id); }, 250);
          hooks.change('typing');
          clearTimeout(textTimer);
          // An undo step every pause in typing, and at least every 2 seconds while typing on.
          if (Date.now() - lastRec > 2000) { flushText(b.id); record(); }
          else textTimer = setTimeout(function () { flushText(b.id); record(); }, 700);
          requestAnimationFrame(layout);
        },
        onFocus: function () { active = { box: b, ed: ed }; lastBoxId = b.id; e.classList.add('focused'); hooks.focus(ed); },
        onBlur: function () {
          e.classList.remove('focused');
          flushText(b.id);
          // 3.27 (feedback 22 Nov): switching to another app takes the caret away. Remember where it was, so typing
          // carries on there on coming back, and keep a new empty box: it was not left, the app was.
          var sl = ed.state.selection;
          if (awayNow()) away = { id: b.id, from: sl.from, to: sl.to };
          setTimeout(function () {
            if (awayNow() || (away && away.id === b.id)) { away = away || { id: b.id, from: sl.from, to: sl.to }; return; }
            if (active && active.ed === ed && !e.contains(document.activeElement)) { hooks.blur(ed); }
            // A text box that was added and left empty goes away again.
            if (!isFirst && boxes.indexOf(b) > -1 && !b.md.trim() && !e.contains(document.activeElement)) removeBox(b.id);
          }, 200);
        },
        onSelectionUpdate: function () { hooks.selection(ed); keepCaret(); },
        onTransaction: function () { hooks.selection(ed); }
      });
      editors[b.id] = { el: e, ed: ed, keep: pr.keep };
      // (3.30) What the editor makes of the text as it loads (its own way of writing the same Markdown). Saving that
      // back unchanged made opening a note count as an edit, which could collide with an edit on another device.
      try { editors[b.id].base = unprotect(getMd(ed), pr.keep); } catch (x) {}
      return editors[b.id];
    }
    function flushText(id) {
      var b = boxes.filter(function (x) { return x.id === id; })[0], e = editors[id];
      if (!b || !e) return;
      var md = unprotect(getMd(e.ed), e.keep);
      if (md !== b.md && md !== e.base) { b.md = md; e.base = null; hooks.change('text'); }
    }
    function flushAll() { if (eng && eng.finishText) eng.finishText(); clearTimeout(mdTimer); boxes.forEach(function (b) { flushText(b.id); }); }
    // What the Lasso needs from the text boxes: find them, move them, copy, delete, change layer.
    function boxApi() {
      function byId(id) { return boxes.filter(function (x) { return x.id === id; })[0]; }
      function usable(b) {
        var e = editors[b.id], L = layerOfBox(b);
        return e && String(b.md || '').trim() && (!L || (L.vis !== false && !L.lock));
      }
      function lid(b) { var L = layerOfBox(b); return L ? L.id : null; }
      function rect(b) { var e = editors[b.id]; return { x: b.x, y: b.y, w: e ? e.el.offsetWidth : (b.w || 160), h: e ? e.el.offsetHeight : 32 }; }
      return {
        // What is in front (3.18.2): each box sits just above one drawing item (z), at a depth (zp) kept for when
        // that item goes; the engine works out the order and gives each box its place in the stack (zIndex).
        list: function () { return boxes.map(function (b) { return { id: b.id, l: b.l || null, z: b.z, zp: zPos[b.id], zt: zTie[b.id] }; }); },
        setTie: function (id, t) { zTie[id] = t; },
        setAnchor: function (id, z) { var b = byId(id); if (b) b.z = z || ''; },
        setPos: function (id, pos) { zPos[id] = pos; },
        setZ: function (id, z) { zIdx[id] = z; var e = editors[id]; if (e) e.el.style.zIndex = z; },
        rect: function (id) { var b = byId(id); return b ? rect(b) : null; },
        at: function (x, y, okL) {
          for (var i = boxes.length - 1; i >= 0; i--) { var b = boxes[i]; if (!usable(b) || okL && !okL(lid(b))) continue; var r = rect(b); if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return b.id; }
          return null;
        },
        pick: function (poly, inPoly, m, okL) {
          // Circling the start of the text, or its middle, is enough (a text box is often much wider than its text);
          // Fully needs the whole box, Partly any corner of it.
          return boxes.filter(usable).filter(function (b) {
            if (okL && !okL(lid(b))) return false;
            var r = rect(b), cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
            if (m === 'full') return cs.every(function (q) { return inPoly(q[0], q[1], poly); });
            if (m === 'part' && cs.some(function (q) { return inPoly(q[0], q[1], poly); })) return true;
            return inPoly(r.x + 12, r.y + Math.min(r.h / 2, 20), poly) || inPoly(r.x + r.w / 2, r.y + r.h / 2, poly);
          }).map(function (b) { return b.id; });
        },
        place: function (id, x, y, w) {
          var b = byId(id), e = editors[id]; if (!b || !e) return;
          b.x = Math.max(0, x); b.y = Math.max(0, y); if (w) b.w = Math.round(w);
          e.el.style.left = (b.x + M) + 'px'; e.el.style.top = (b.y + M) + 'px'; if (w) e.el.style.width = b.w + 'px';
        },
        remove: function (ids) {
          ids.forEach(function (id) {
            var i = boxes.findIndex(function (x) { return x.id === id; }); if (i < 0) return;
            if (boxes.length === 1) { var e1 = editors[id]; if (e1) e1.ed.commands.clearContent(); boxes[0].md = ''; return; }
            var e = editors[id]; if (e) { e.ed.destroy(); e.el.remove(); delete editors[id]; }
            boxes.splice(i, 1);
            if (selected && selected.id === id) select(null);
          });
        },
        dup: function (ids, dx, dy) {
          return ids.map(function (id) {
            var b = byId(id); if (!b) return null;
            var c = { id: 'b' + window.Notes.shortId(), x: b.x + dx, y: b.y + dy, w: b.w, md: b.md, z: eng.topAnchor() };
            if (b.l) c.l = b.l;
            if (b.r) c.r = b.r;
            if (b.co) c.co = b.co;
            boxes.push(c); mountBox(c); return c.id;
          }).filter(Boolean);
        },
        setLayer: function (ids, lid) { ids.forEach(function (id) { var b = byId(id); if (b) b.l = lid; }); },
        turned: function (ids) { return ids.some(function (id) { var b = byId(id); return b && b.r; }); },
        // Collectives: text boxes can belong to one with drawings (g), and fade with it (co).
        groupOf: function (id) { var b = byId(id); return b && b.g || null; },
        inGroups: function (gs) { return boxes.filter(function (b) { return b.g && gs[b.g] && usable(b); }).map(function (b) { return b.id; }); },
        setGroup: function (ids, g, co) {
          ids.forEach(function (id) { var b = byId(id); if (!b) return; if (g) b.g = g; else { delete b.g; delete b.co; } if (co != null) { if (co >= 1) delete b.co; else b.co = co; } });
          applyBoxLayers();
        },
        exportBoxes: function (ids) { return ids.map(function (id) { flushText(id); var b = byId(id); return b ? JSON.parse(JSON.stringify(b)) : null; }).filter(Boolean); },
        hasImages: function (ids) { return ids.some(function (id) { var e = editors[id]; return e && e.el.querySelector('.ProseMirror img:not(.ProseMirror-separator)'); }); },
        // Images in text boxes → their sources, sizes and places on the page; they leave the text.
        takeImages: function (ids) {
          var out = [];
          ids.forEach(function (id) {
            var b = byId(id), e = editors[id]; if (!b || !e) return;
            var imgs = e.el.querySelectorAll('.ProseMirror img:not(.ProseMirror-separator)'), k = 0, a = b.r || 0, found = [];
            e.ed.state.doc.descendants(function (node, pos) {
              if (node.type.name !== 'image') return;
              var im = imgs[k++]; if (!im) return;
              var dx = 0, dy = 0;
              for (var n = im; n && n !== e.el; n = n.offsetParent) { dx += n.offsetLeft; dy += n.offsetTop; }
              var iw = im.offsetWidth, ih = im.offsetHeight;
              if (!iw || !ih) { iw = Math.min(e.el.offsetWidth || 300, im.naturalWidth || 300); ih = im.naturalWidth ? iw * im.naturalHeight / im.naturalWidth : iw * 0.75; }
              found.push({ pos: pos, size: node.nodeSize, src: node.attrs.src, w: iw, h: ih,
                x: b.x + dx * Math.cos(a) - dy * Math.sin(a), y: b.y + dx * Math.sin(a) + dy * Math.cos(a), r: a, lid: lid(b) });
            });
            if (!found.length) return;
            var tr = e.ed.state.tr;
            found.slice().reverse().forEach(function (f) { tr.delete(f.pos, f.pos + f.size); });
            e.ed.view.dispatch(tr);
            flushText(id);
            if (!String(b.md || '').trim() && boxes[0] !== b) this.remove([id]);
            out = out.concat(found);
          }, this);
          return out;
        },
        // Text box → Text art: its words, font, size and place (the box goes).
        toArt: function (ids) {
          return ids.map(function (id) {
            var b = byId(id), e = editors[id]; if (!b || !e) return null;
            var txt = e.ed.getText({ blockSeparator: '\n' }).replace(/\s+$/, ''); if (!txt) return null;
            var pm = e.el.querySelector('.ProseMirror'), first = pm && pm.firstElementChild || pm;
            var leaf = first; while (leaf && leaf.firstElementChild) leaf = leaf.firstElementChild;
            var cs = getComputedStyle(leaf || first), dx = 0, dy = 0;
            for (var n = first; n && n !== e.el; n = n.offsetParent) { dx += n.offsetLeft; dy += n.offsetTop; }
            var fs = parseFloat(cs.fontSize) || 16, a = b.r || 0;
            return { id: id, txt: txt, fs: fs, font: cs.fontFamily, r: a, lid: lid(b), co: b.co,
              x: b.x + dx * Math.cos(a) - dy * Math.sin(a), y: b.y + dx * Math.sin(a) + dy * Math.cos(a) };
          }).filter(Boolean);
        },
        // Text art → a text box with the same words, font and size.
        fromArt: function (s, bottomId) {
          var md = String(s.txt).split('\n').map(function (l) { return l.replace(/^(\s*)([#>*+-]|\d+[.)])/, '$1\\$2'); }).join('\n\n');
          var b = { id: 'b' + window.Notes.shortId(), x: Math.max(0, s.x), y: Math.max(0, s.y - s.fs * 0.2), w: null, md: md };
          if (s.lid && s.lid !== bottomId) b.l = s.lid;
          if (s.r) b.r = s.r;
          if (s.z != null) b.z = s.z; // where the Text art was in the order
          boxes.push(b);
          var e = mountBox(b); layout();
          var ch = e.ed.chain().selectAll();
          if (s.font && !/Google Sans/.test(s.font)) ch = ch.setFontFamily(s.font);
          if (Math.abs(s.fs - 16) > 0.5) ch = ch.setFontSize(Math.round(s.fs) + 'px');
          ch.run(); e.ed.commands.setTextSelection(0);
          flushText(b.id); applyBoxLayers();
          return b.id;
        },
        straighten: function (ids) { ids.forEach(function (id) { var b = byId(id); if (b && b.r) { delete b.r; if (editors[id]) editors[id].el.style.transform = ''; } }); }
      };
    }
    function removeBox(id) {
      var i = boxes.findIndex(function (x) { return x.id === id; });
      if (i < 0 || i === 0 && boxes.length === 1) return;
      var e = editors[id];
      if (e) { e.ed.destroy(); e.el.remove(); delete editors[id]; }
      boxes.splice(i, 1);
      if (selected && selected.id === id) select(null);
      changed('layout');
    }
    function addBox(x, y) {
      var w = Math.max(160, Math.min(320, autoWidth() - x));
      var b = { id: 'b' + window.Notes.shortId(), x: Math.max(0, x), y: Math.max(0, y), w: w, md: '' };
      if (eng && eng.topAnchor) b.z = eng.topAnchor(); // new text goes in front
      var al = eng && eng.activeLayer ? eng.activeLayer() : null;
      if (al && al !== ink[0].id) b.l = al; // new text goes on the layer being worked on
      // On a turned page, new text starts straight to the screen; after that it belongs to the page and turns with it.
      var tr = -(view.r || 0); tr = Math.atan2(Math.sin(tr), Math.cos(tr));
      if (Math.abs(tr) > 0.01) b.r = Math.round(tr * 1000) / 1000;
      boxes.push(b);
      var e = mountBox(b);
      layout();
      setTimeout(function () { e.ed.commands.focus('end'); }, 30);
      return b;
    }
    function renderAll() {
      Object.keys(editors).forEach(function (id) { editors[id].ed.destroy(); editors[id].el.remove(); });
      editors = {};
      boxes.forEach(mountBox);
      eng.render();
      applyBoxLayers();
      layout();
    }

    // How far the pen leans: 0 upright, 1 lying flat (from the angle the pen reports, if it reports one).
    function penTilt(ev) {
      if (ev.altitudeAngle != null && ev.altitudeAngle < Math.PI / 2 - 0.001) return Math.max(0, Math.min(1, 1 - ev.altitudeAngle / (Math.PI / 2)));
      var tx = ev.tiltX || 0, ty = ev.tiltY || 0;
      if (!tx && !ty) return 0;
      var a = Math.atan(Math.sqrt(Math.pow(Math.tan(tx * Math.PI / 180), 2) + Math.pow(Math.tan(ty * Math.PI / 180), 2)));
      return Math.max(0, Math.min(1, a / (Math.PI / 2)));
    }
    function point(ev) {
      var l = local(ev), w = toWorld(l[0], l[1]);
      if (ev.pointerType !== 'pen') return [w[0] - M, w[1] - M, 0.5];
      return [w[0] - M, w[1] - M, ev.pressure || 0.5, penTilt(ev)];
    }

    // ---- Coming back from another app (3.27, feedback 22 Nov): typing carries on where it was ----
    // Phones take the focus away when another app comes to the front. A text box gets its caret back at the same
    // place, and Text art that was being written opens again for writing.
    var away = null;
    function awayNow() { return document.visibilityState === 'hidden' || !document.hasFocus(); }
    function comeBack() {
      if (document.visibilityState !== 'visible' || !host.isConnected) return;
      setTimeout(function () {
        var ae = document.activeElement;
        if (ae && ae !== document.body && !stage.contains(ae)) { away = null; return; } // something else has the focus now
        if (away && tool === 'type') {
          var e = editors[away.id], a = away; away = null;
          if (e && !e.el.contains(ae)) {
            var max = e.ed.state.doc.content.size;
            try { e.ed.chain().focus().setTextSelection({ from: Math.min(a.from, max), to: Math.min(a.to, max) }).run(); } catch (x) { e.ed.commands.focus('end'); }
          }
          return;
        }
        away = null;
        if (tool === 'text' && eng.resumeText) eng.resumeText();
      }, 60);
    }
    on(document, 'visibilitychange', comeBack);
    on(window, 'focus', comeBack);
    on(host, 'pointerdown', function () { away = null; if (eng.forgetText) eng.forgetText(); }, true); // a tap says where to go next

    // ---- Selection (Move tool) ----
    function itemRect(sel) {
      if (!sel) return null;
      var b = boxes.filter(function (x) { return x.id === sel.id; })[0], e = editors[sel.id];
      return b && e ? { x: b.x, y: b.y, w: e.el.offsetWidth, h: e.el.offsetHeight } : null;
    }
    function drawSelection() {
      var r = itemRect(selected);
      selBox.classList.toggle('hidden', !r); selBar.classList.toggle('hidden', !r);
      Object.keys(editors).forEach(function (id) { editors[id].el.classList.toggle('selected', !!selected && selected.kind === 'box' && selected.id === id); });
      if (!r) return;
      selBox.style.left = (r.x + M - 6) + 'px'; selBox.style.top = (r.y + M - 6) + 'px';
      selBox.style.width = (r.w + 12) + 'px'; selBox.style.height = (r.h + 12) + 'px';
      selBar.style.left = (r.x + M - 6) + 'px'; selBar.style.top = Math.max(0, r.y + M - 44) + 'px';
      selBar.querySelector('[data-act=delete]').classList.toggle('hidden', selected.kind === 'box' && boxes[0].id === selected.id && boxes.length === 1);
    }
    function select(sel) { selected = sel; drawSelection(); }
    selBar.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    selBar.addEventListener('click', function (e) {
      if (!e.target.closest('[data-act=delete]') || !selected) return;
      removeBox(selected.id);
    });

    // ---- Pointer handling ----
    var drag = null, taps = [], typeTaps = [], panV = null, panMoved = false;
    on(host, 'pointerdown', function (ev) {
      // With the Hand, a video's buttons, a sound's player, a link and a live page work as themselves.
      if ((tool === 'type' || tool === 'hand') && ev.target.closest && ev.target.closest('.emb-live')) return;
      // The title and labels work as usual, except with a drawing tool: the title's strip runs right across the top of
      // the page, and before 3.18 nothing could be drawn over any of it.
      if (head && head.contains(ev.target)) {
        var drawsHere = INK[tool] ? !ev.target.closest('button, .chip, a') : (tool === 'type' || tool === 'hand') && ev.pointerType === 'pen' && !ev.target.closest('input, button, .chip, a');
        if (!drawsHere) return;
      }
      if (ev.pointerType === 'pen' && !penSeen) { penSeen = true; hooks.penSeen(); }
      if (ev.button && ev.button !== 0 && ev.pointerType === 'mouse') return;
      var p = point(ev);
      var onBox = ev.target.closest('.box');
      var onGrip = ev.target.closest('.grip'), onResize = ev.target.closest('.resize');
      var isFinger = ev.pointerType === 'touch';

      // A second finger while drawing with a finger: stop drawing, scroll instead.
      if (drag && drag.type === 'ink' && isFinger && drag.finger) { eng.cancel(); drag = null; }
      if (drag && drag.type === 'pan' && isFinger) { drag.fingers[ev.pointerId] = [ev.clientX, ev.clientY]; return; }

      // Moving or resizing a text box by its handles (any tool).
      if (onGrip || onResize || (tool === 'select' && onBox)) {
        var id = onBox.dataset.id, b = boxes.filter(function (x) { return x.id === id; })[0];
        select({ kind: 'box', id: id });
        if (tool === 'select' || onGrip || onResize) {
          ev.preventDefault();
          if (onResize && !b.w) b.w = editors[id].el.offsetWidth;
          drag = { type: onResize ? 'resize' : 'move', item: b, sx: ev.clientX, sy: ev.clientY, ox: b.x, oy: b.y, ow: b.w, id: ev.pointerId };
          host.setPointerCapture(ev.pointerId);
          return;
        }
      }
      if (tool === 'select') { select(null); startPan(ev); return; }
      if (tool === 'text') { // artistic text: a tap writes there (or edits the text tapped), a drag scrolls
        if (ev.pointerType === 'mouse') { ev.preventDefault(); eng.textAt(p, -(view.r || 0)); return; }
        startPan(ev); if (drag) drag.textTap = p;
        return;
      }
      // Drawing tools. A pen draws even in Type mode; once a pen has been used, a finger scrolls instead.
      var inkTool = INK[tool] ? tool : ((tool === 'type' && !onBox || tool === 'hand') && ev.pointerType === 'pen' ? 'pen' : null);
      if (inkTool && !(isFinger && !fingerDraws() && inkTool !== 'guide')) { // (a finger can always move a guide)
        // The pen writing in Type mode switches the tools to Pen, so the toolbar shows what is happening.
        if ((tool === 'type' || tool === 'hand') && inkTool === 'pen' && hooks.autoTool) { hooks.autoTool('pen'); tool = 'pen'; }
        if (eng.tool() !== inkTool) eng.setTool(inkTool);
        if (eng.down(p, ev)) {
          ev.preventDefault();
          if (document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
          drag = { type: 'ink', id: ev.pointerId, finger: isFinger, t: ev.timeStamp };
          // (3.32, #85) Tap-to-pick: a finger that starts on empty space and moves is panning (only the Lasso needs two fingers).
          if (isFinger && tool === 'lasso' && eng.pickPending && eng.pickPending()) drag.pickPan = { x: ev.clientX, y: ev.clientY };
          host.setPointerCapture(ev.pointerId);
          return;
        }
      }
      if (tool === 'hand') { handDown(ev, p, onBox); return; }
      if (onBox) { // typing, selecting text: leave it to the editor, but a finger drag over the text still scrolls
        if (isFinger && tool === 'type') {
          // (3.27.1, #79) With a finger, a double tap starts typing in a text box, as it does for a new box on empty
          // space. One tap only scrolls or does nothing, so the keyboard doesn't jump up while moving around.
          var tb = editors[onBox.dataset.id];
          if (tb && tb.el.contains(document.activeElement)) { startPan(ev); return; } // already typing here: the caret moves
          ev.preventDefault();
          var nw = Date.now(), lt = typeTaps[typeTaps.length - 1];
          if (!lt || nw - lt.t > 400 || Math.hypot(lt.cx - ev.clientX, lt.cy - ev.clientY) > 32) typeTaps = [];
          typeTaps.push({ t: nw, cx: ev.clientX, cy: ev.clientY });
          var tTap = { n: typeTaps.length, box: onBox.dataset.id, cx: ev.clientX, cy: ev.clientY };
          // (3.33, #88) One tap picks the text box; a picked box moves with one finger. A swipe that starts on a box
          // that isn't picked still scrolls, and a double tap still types.
          if (selected && selected.kind === 'box' && selected.id === tTap.box) {
            var sb = boxes.filter(function (x) { return x.id === tTap.box; })[0];
            drag = { type: 'move', item: sb, sx: ev.clientX, sy: ev.clientY, ox: sb.x, oy: sb.y, ow: sb.w, id: ev.pointerId, typeTap: tTap };
            host.setPointerCapture(ev.pointerId);
            return;
          }
          startPan(ev);
          if (drag) drag.typeTap = tTap;
        }
        return;
      }
      // Empty space, finger (or mouse), any tool: a double-tap starts writing there (a new text box, Type tool);
      // in Type mode a single tap just below the text carries on at its end, like Keep. A drag scrolls.
      var now = Date.now();
      taps = taps.filter(function (t) { return now - t.t < 350; });
      var last = taps[taps.length - 1];
      if (last && Math.abs(last.x - p[0]) < 40 / view.z && Math.abs(last.y - p[1]) < 40 / view.z) {
        taps = []; clearTimeout(self._tapTimer); ev.preventDefault();
        if (tool !== 'type' && hooks.autoTool) { hooks.autoTool('type'); tool = 'type'; }
        // Just below the first text, a double tap carries on at its end (like Keep); elsewhere it starts new text.
        var f0 = editors[boxes[0].id], b0 = boxes[0];
        if (f0 && p[1] > b0.y + f0.el.offsetHeight - 10 && p[1] < b0.y + f0.el.offsetHeight + 90 && p[0] > b0.x - 20 && p[0] < b0.x + f0.el.offsetWidth) { f0.ed.commands.focus('end'); return; }
        addBox(p[0] - 4, p[1] - 14); changed('layout');
        return;
      }
      taps.push({ t: now, x: p[0], y: p[1] });
      if (tool === 'type' && !isFinger) { // a mouse: one click below the text carries on (a finger double taps)
        var wasTyping = !!(document.activeElement && stage.contains(document.activeElement) && document.activeElement.closest('.box'));
        panMoved = false;
        var pDown = p;
        clearTimeout(self._tapTimer);
        self._tapTimer = setTimeout(function () {
          if (drag && drag.type === 'pan' || panMoved || wasTyping || taps.length !== 1) return; // held, dragged, typing, or a double-tap
          var first = editors[boxes[0].id], fb = boxes[0];
          var below = first && pDown[1] > fb.y + first.el.offsetHeight - 10 && pDown[1] < fb.y + first.el.offsetHeight + 90 &&
            pDown[0] > fb.x - 20 && pDown[0] < fb.x + first.el.offsetWidth;
          if (first && (below || !String(fb.md || '').trim() && pDown[1] < fb.y + 140 && pDown[0] < fb.x + 400)) first.ed.commands.focus('end');
        }, 360);
      }
      startPan(ev);
      if (drag && drag.type === 'pan') drag.emptyTap = true;
    });
    // ---- The Hand (3.27, feedback 21 Nov): it only moves the page. A tap does nothing; a double tap on a thing
    // picks it and switches to Select; a triple tap switches to Text and types there (in the text tapped, or new
    // text on empty space). A pen still writes. Two fingers move, zoom and turn the page with every tool. ----
    var handTaps = [], handTimer = 0;
    function handDown(ev, p, onBox) {
      ev.preventDefault(); // no caret and no keyboard: the Hand doesn't type
      if (document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
      var now = Date.now(), lt = handTaps[handTaps.length - 1];
      if (!lt || now - lt.t > 400 || Math.hypot(lt.cx - ev.clientX, lt.cy - ev.clientY) > 32) handTaps = [];
      handTaps.push({ t: now, cx: ev.clientX, cy: ev.clientY });
      clearTimeout(handTimer);
      startPan(ev, true);
      if (drag) drag.hand = { n: handTaps.length, p: p, box: onBox ? onBox.dataset.id : null, cx: ev.clientX, cy: ev.clientY };
    }
    function handUp(h) { // a tap that didn't move: count it
      if (h.n === 2) { handTimer = setTimeout(function () { if (handTaps.length === 2) { handTaps = []; handPick(h.p); } }, 320); return; }
      if (h.n >= 3) { handTaps = []; handType(h); }
    }
    function handPick(p) {
      if (!eng.pickAt || !eng.pickAt(p)) return;
      if (hooks.autoTool) hooks.autoTool('lasso'); else self.setTool('lasso');
      tool = 'lasso'; eng.selectAt(p);
    }
    function handType(h) {
      if (hooks.autoTool) hooks.autoTool('type'); else self.setTool('type');
      tool = 'type';
      var e = h.box && editors[h.box];
      if (e) {
        var pos = null; try { pos = e.ed.view.posAtCoords({ left: h.cx, top: h.cy }); } catch (x) {}
        e.ed.commands.focus(pos ? pos.pos : 'end');
        return;
      }
      addBox(h.p[0] - 4, h.p[1] - 14); changed('layout');
    }
    function startPan(ev, mouseToo) {
      if (ev.pointerType === 'mouse' && !mouseToo) return; // a mouse scrolls with its wheel
      drag = { type: 'pan', id: ev.pointerId, fingers: {}, lx: ev.clientX, ly: ev.clientY, moved: false, t: Date.now() };
      drag.fingers[ev.pointerId] = [ev.clientX, ev.clientY];
      if (panV) { cancelAnimationFrame(panV.raf); panV = null; }
    }
    // Pen and finger movement while drawing: every in-between point (coalesced events), as early as the browser
    // gives them (pointerrawupdate), plus where the pen is about to be (predicted events) for the live stroke.
    function inkMove(ev) {
      if (ev.pointerId !== drag.id) return;
      var list = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
      if (!list.length) list = [ev];
      list = list.filter(function (e) { return e.timeStamp > drag.t; });
      if (!list.length) return;
      drag.t = list[list.length - 1].timeStamp;
      var pr = ev.getPredictedEvents ? ev.getPredictedEvents() : [];
      eng.move(point(list[list.length - 1]), ev, list.map(point), pr.map(point));
    }
    if ('onpointerrawupdate' in window) on(host, 'pointerrawupdate', function (ev) { if (drag && drag.type === 'ink') inkMove(ev); });
    on(host, 'pointermove', function (ev) {
      if (!drag) { if (INK[tool]) eng.move(point(ev), ev); return; } // the eraser/nudge circle follows a hovering pen
      // (3.33, #90) Drawing or moving something under a button: that button steps aside until you lift.
      if (hooks.dodge && ev.pointerId === drag.id && (drag.type === 'ink' && !drag.pickPan || drag.type === 'move' || drag.type === 'resize')) hooks.dodge(ev.clientX, ev.clientY);
      if (drag.type === 'ink' && drag.pickPan && ev.pointerId === drag.id) {
        if (Math.hypot(ev.clientX - drag.pickPan.x, ev.clientY - drag.pickPan.y) > 8) {
          var pp = drag.pickPan; eng.cancel(); drag = null;
          startPan({ pointerId: ev.pointerId, pointerType: 'touch', clientX: pp.x, clientY: pp.y });
          drag.moved = true; taps = []; // from here on it is the same as any one-finger pan
        } else return;
      }
      if (drag.type === 'ink') { inkMove(ev); return; }
      if (drag.type === 'pan') {
        if (!(ev.pointerId in drag.fingers)) return;
        var prev = drag.fingers[ev.pointerId];
        var n = Object.keys(drag.fingers).length;
        var dx = (ev.clientX - prev[0]) / n, dy = (ev.clientY - prev[1]) / n;
        drag.fingers[ev.pointerId] = [ev.clientX, ev.clientY];
        if (view.lk && !pageMode()) { var ld = axisLock(dx, dy, drag, ev.clientX - drag.lx, ev.clientY - drag.ly); dx = ld[0]; dy = ld[1]; }
        if (Math.abs(dx) + Math.abs(dy) > 0) {
          drag.moved = drag.moved || Math.abs(ev.clientX - drag.lx) + Math.abs(ev.clientY - drag.ly) > 8;
          view.x += dx; view.y += dy; applyView();
          var t = Date.now(); drag.vx = dx / Math.max(1, t - drag.t) * 16; drag.vy = dy / Math.max(1, t - drag.t) * 16; drag.t = t;
        }
        return;
      }
      if (ev.pointerId !== drag.id) return;
      var dd = pageDelta(ev.clientX - drag.sx, ev.clientY - drag.sy);
      if (drag.type === 'move') {
        drag.item.x = drag.ox + dd[0];
        drag.item.y = drag.oy + dd[1];
        layout();
      } else if (drag.type === 'resize') {
        drag.item.w = Math.max(120, (drag.ow || 200) + dd[0]);
        layout();
      }
    });
    function typeTapUp(t) { // a finger tap on a text box with the Text tool: one picks it, two type there
      if (t.n >= 2) {
        typeTaps = []; if (selected) select(null);
        var te = editors[t.box]; if (te) { var tp = null; try { tp = te.ed.view.posAtCoords({ left: t.cx, top: t.cy }); } catch (x) {} te.ed.commands.focus(tp ? tp.pos : 'end'); }
        return;
      }
      select({ kind: 'box', id: t.box });
    }
    function endPointer(ev) {
      if (hooks.dodge) hooks.dodge(null);
      if (!drag) return;
      if (drag.type === 'pan') {
        delete drag.fingers[ev.pointerId];
        if (Object.keys(drag.fingers).length) return;
        var vx = drag.vx || 0, vy = drag.vy || 0;
        if (drag.moved) { taps = []; clearTimeout(self._tapTimer); panMoved = true; handTaps = []; clearTimeout(handTimer); }
        var tapAt = !drag.moved && drag.textTap, handTap = !drag.moved && drag.hand, typeTap = !drag.moved && drag.typeTap, emptyTap = !drag.moved && drag.emptyTap;
        if (drag.moved) typeTaps = [];
        drag = null;
        if (tapAt && tool === 'text') { eng.textAt(tapAt, -(view.r || 0)); return; }
        if (handTap && tool === 'hand') { handUp(handTap); return; }
        if (typeTap && tool === 'type') { typeTapUp(typeTap); return; }
        if (emptyTap && tool === 'type' && selected) select(null); // (3.33, #88) a tap outside lets go of the picked box
        if (Math.abs(vx) + Math.abs(vy) > 1) { // glide a little, like normal scrolling
          panV = { vx: vx, vy: vy };
          var step = function () {
            if (!panV) return;
            view.x += panV.vx; view.y += panV.vy; applyView();
            panV.vx *= 0.94; panV.vy *= 0.94;
            if (Math.abs(panV.vx) + Math.abs(panV.vy) < 0.4) { panV = null; return; }
            panV.raf = requestAnimationFrame(step);
          };
          panV.raf = requestAnimationFrame(step);
        }
        return;
      }
      if (ev.pointerId !== drag.id) return;
      var d = drag; drag = null;
      if (d.type === 'ink') { drag = d; inkMove(ev); drag = null; eng.up(point(ev)); return; }
      if (d.type === 'move' || d.type === 'resize') {
        var mv = d.item.x !== d.ox || d.item.y !== d.oy || d.item.w !== d.ow;
        if (mv) changed('layout');
        if (d.typeTap) { if (mv) typeTaps = []; else typeTapUp(d.typeTap); }
      }
    }
    on(host, 'pointerup', endPointer);
    on(host, 'pointercancel', function (ev) { if (drag && drag.type === 'ink') { eng.cancel(); drag = null; } else endPointer(ev); });
    on(host, 'pointerleave', function () { eng.leave(); });

    // ---- Fingers: two to move, zoom and turn the page; a quick two-finger double tap undoes, three-finger double tap redoes ----
    var touches = {}, gest = null, rotateOn = true, areaMode = false, lastTap = null;
    function tcount() { return Object.keys(touches).length; }
    function pairNow() {
      var ids = Object.keys(touches).slice(0, 2), r = host.getBoundingClientRect();
      return ids.map(function (k) { return [touches[k].x - r.left, touches[k].y - r.top]; });
    }
    function startPair() {
      var p = pairNow();
      gest.v0 = { x: view.x, y: view.y, z: view.z, r: view.r };
      gest.c0 = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
      gest.d0 = Math.max(1, Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]));
      gest.a0 = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
      gest.rotOn = false; gest.rotOff = 0;
    }
    function startGesture() {
      // A second finger: whatever the first finger started (a stroke, scrolling, moving a box) gives way.
      if (drag && drag.type === 'ink') eng.cancel();
      if (panV) { cancelAnimationFrame(panV.raf); panV = null; }
      drag = null; taps = []; clearTimeout(self._tapTimer); cancelAnimationFrame(anim); handTaps = []; clearTimeout(handTimer);
      gest = { t: Date.now(), max: tcount(), moved: false, transformed: false };
      // While two fingers move and zoom, the page is drawn once and the picture moved and scaled (it sharpens again
      // when the fingers lift), so big drawings don't have to be redrawn at every step of a pinch.
      stage.style.willChange = 'transform';
      startPair();
    }
    function moveGesture() {
      if (tcount() < 2) return;
      if (!gest.moved) {
        for (var k in touches) if (Math.hypot(touches[k].x - touches[k].x0, touches[k].y - touches[k].y0) > 12) gest.moved = true;
        if (!gest.moved) return; // still could be a tap
        startPair(); // start measuring from here, so the page doesn't jump
      }
      var p = pairNow(), v0 = gest.v0;
      var c1 = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
      var d1 = Math.max(1, Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]));
      var dA = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]) - gest.a0;
      dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      // Turning only starts after a clear twist, so zooming and moving never turn the page by accident.
      if (rotateOn && !gest.rotOn && Math.abs(dA) > 0.3) { gest.rotOn = true; gest.rotOff = dA; }
      if (view.lk && !pageMode()) { // locked: two fingers only move, along the page's lines or columns
        var lt = axisLock(c1[0] - gest.c0[0], c1[1] - gest.c0[1], gest, c1[0] - gest.c0[0], c1[1] - gest.c0[1]);
        view.x = v0.x + lt[0]; view.y = v0.y + lt[1]; gest.transformed = false; applyView(); return;
      }
      var r = v0.r + (gest.rotOn ? dA - gest.rotOff : 0), z = clampZ(v0.z * d1 / gest.d0);
      // Keep the page point that was under the fingers under the fingers.
      var dx = gest.c0[0] - v0.x, dy = gest.c0[1] - v0.y, c = Math.cos(-v0.r), sn = Math.sin(-v0.r);
      var wx = (dx * c - dy * sn) / v0.z, wy = (dx * sn + dy * c) / v0.z;
      var cr = Math.cos(r), sr = Math.sin(r);
      view.z = z; view.r = r; view.x = c1[0] - (wx * cr - wy * sr) * z; view.y = c1[1] - (wx * sr + wy * cr) * z;
      gest.transformed = true; applyView();
    }
    function endGesture() {
      var g = gest; gest = null;
      stage.style.willChange = '';
      // A double tap: two fingers undo, three redo. (A single tap did it before 3.18, and a resting hand or a slip
      // undid things by accident.)
      if (!g.moved && Date.now() - g.t < 450) {
        var n = Math.min(3, g.max), now = Date.now(), prev = lastTap; lastTap = { n: n, t: now };
        if (prev && prev.n === n && now - prev.t < 500) {
          lastTap = null;
          if (n === 2) { self.undo(); if (hooks.gesture) hooks.gesture('undo'); }
          else { self.redo(); if (hooks.gesture) hooks.gesture('redo'); }
        }
        return;
      }
      if (g.transformed) {
        var r = Math.atan2(Math.sin(view.r), Math.cos(view.r));
        // Close to straight, or to a quarter turn: settle there.
        var q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(r - q) < 0.07) animateView(view.z, q, toWorld(host.clientWidth / 2, host.clientHeight / 2));
      }
    }
    on(host, 'pointerdown', function (ev) {
      if (ev.pointerType !== 'touch' || ev.target.closest('.qn-nav, .inkbar, .selbar, .qn-dirs, .qn-peek, .qn-side, .qn-modebtn')) return;
      touches[ev.pointerId] = { x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY };
      if (tcount() >= 2) {
        if (!gest) startGesture(); else { gest.max = Math.max(gest.max, tcount()); if (!gest.moved) startPair(); }
        try { host.setPointerCapture(ev.pointerId); } catch (e) {}
        ev.stopImmediatePropagation(); ev.preventDefault();
      }
    }, true);
    on(host, 'pointermove', function (ev) {
      if (ev.pointerType !== 'touch' || !touches[ev.pointerId]) return;
      touches[ev.pointerId].x = ev.clientX; touches[ev.pointerId].y = ev.clientY;
      if (gest) { moveGesture(); ev.stopImmediatePropagation(); ev.preventDefault(); }
    }, true);
    function touchUp(ev) {
      if (ev.pointerType !== 'touch' || !touches[ev.pointerId]) return;
      delete touches[ev.pointerId];
      if (gest) {
        ev.stopImmediatePropagation();
        if (!tcount()) endGesture();
        else if (gest.moved && tcount() >= 2) startPair();
      }
    }
    on(host, 'pointerup', touchUp, true);
    on(host, 'pointercancel', touchUp, true);

    // ---- Mouse and trackpad: the wheel moves the page; Ctrl + wheel (or a trackpad pinch) zooms ----
    on(host, 'wheel', function (e) {
      e.preventDefault();
      var l = local(e), k = e.deltaMode === 1 ? 30 : 1;
      if (e.ctrlKey || e.metaKey) { if (!view.lk) zoomAt(l[0], l[1], Math.exp(-e.deltaY * k * 0.004)); }
      else { view.x -= e.deltaX * k; view.y -= e.deltaY * k; applyView(); }
    }, { passive: false });
    // The browser scrolls to show the text cursor; turn that into moving the page instead.
    [host, wrap].forEach(function (el) {
      on(el, 'scroll', function () {
        if (!el.scrollTop && !el.scrollLeft) return;
        if (el === host) { view.x -= el.scrollLeft; view.y -= el.scrollTop; }
        el.scrollTop = 0; el.scrollLeft = 0; applyView();
      });
    });

    function zoomAt(sx, sy, f) {
      var w = toWorld(sx, sy);
      view.z = clampZ(view.z * f);
      var s2 = toScreen(w[0], w[1]); view.x += sx - s2[0]; view.y += sy - s2[1];
      applyView();
    }
    function pageDelta(dx, dy) { var c = Math.cos(-view.r), s = Math.sin(-view.r); return [(dx * c - dy * s) / view.z, (dx * s + dy * c) / view.z]; }
    var anim = 0;
    // Glide to a zoom and turn, with page point `wc` (stage coordinates) in the middle of the screen.
    function animateView(tz, tr, wc) {
      cancelAnimationFrame(anim);
      var W = host.clientWidth / 2, H = host.clientHeight / 2, c0 = toWorld(W, H), z0 = view.z, r0 = view.r, t0 = performance.now();
      var dr = Math.atan2(Math.sin(tr - r0), Math.cos(tr - r0));
      tz = clampZ(tz);
      function step(now) {
        var k = Math.min(1, (now - t0) / 280), e = 1 - Math.pow(1 - k, 3);
        view.z = z0 * Math.pow(tz / z0, e); view.r = r0 + dr * e;
        var cx = c0[0] + (wc[0] - c0[0]) * e, cy = c0[1] + (wc[1] - c0[1]) * e, c = Math.cos(view.r), s = Math.sin(view.r);
        view.x = W - (cx * c - cy * s) * view.z; view.y = H - (cx * s + cy * c) * view.z;
        if (k >= 1) view.r = Math.atan2(Math.sin(view.r), Math.cos(view.r));
        applyView();
        if (k < 1) anim = requestAnimationFrame(step);
      }
      anim = requestAnimationFrame(step);
    }
    function contentBox() { // everything on the page, in stage coordinates
      var list = boxes.filter(function (b) { return b.md && b.md.trim() || boxes.length === 1; }).map(function (b) {
        var e = editors[b.id]; return { x: b.x + M, y: b.y + M, w: e ? e.el.offsetWidth : 200, h: e ? e.el.offsetHeight : 40 };
      });
      var ib = eng.box(); if (ib) list.push({ x: ib.x + M, y: ib.y + M, w: ib.w, h: ib.h });
      if (head && headH) list.push({ x: 0, y: -headH, w: Math.min(head.offsetWidth, 480), h: headH });
      if (!list.length) return null;
      var x0 = Math.min.apply(null, list.map(function (b) { return b.x; })), y0 = Math.min.apply(null, list.map(function (b) { return b.y; }));
      var x1 = Math.max.apply(null, list.map(function (b) { return b.x + b.w; })), y1 = Math.max.apply(null, list.map(function (b) { return b.y + b.h; }));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    // Fit a box (stage coordinates) on screen.
    function fitStage(b, r) {
      var W = host.clientWidth, H = host.clientHeight, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      var bw = Math.max(20, b.w * c + b.h * s), bh = Math.max(20, b.w * s + b.h * c);
      animateView(Math.min(4, (W - 40) / bw, (H - 40) / bh), r, [b.x + b.w / 2, b.y + b.h / 2]);
    }
    function fitRect(b, keepR) { fitStage({ x: b.x + M, y: b.y + M, w: b.w, h: b.h }, keepR ? view.r : 0); }
    function showPoint(x, y) { // page coordinates
      var sp = toScreen(x + M, y + M), W = host.clientWidth, H = host.clientHeight;
      if (sp[0] < 30 || sp[1] < 30 || sp[0] > W - 30 || sp[1] > H - 30) animateView(view.z, view.r, [x + M, y + M]);
    }

    // ---- Zoom into an area: drag a box across it ----
    var areaEl = null;
    on(host, 'pointerdown', function (ev) {
      if (!areaMode || ev.target.closest('.qn-nav, .qn-dirs, .qn-peek, .qn-side, .qn-modebtn')) return;
      ev.stopImmediatePropagation(); ev.preventDefault();
      var l = local(ev);
      areaEl = el('div', 'qn-area', host);
      drag = { type: 'area', id: ev.pointerId, s: l };
      host.setPointerCapture(ev.pointerId);
      areaEl.style.left = l[0] + 'px'; areaEl.style.top = l[1] + 'px';
    }, true);
    on(host, 'pointermove', function (ev) {
      if (!drag || drag.type !== 'area') return;
      ev.stopImmediatePropagation();
      var l = local(ev), s0 = drag.s;
      areaEl.style.left = Math.min(l[0], s0[0]) + 'px'; areaEl.style.top = Math.min(l[1], s0[1]) + 'px';
      areaEl.style.width = Math.abs(l[0] - s0[0]) + 'px'; areaEl.style.height = Math.abs(l[1] - s0[1]) + 'px';
    }, true);
    on(host, 'pointerup', function (ev) {
      if (!drag || drag.type !== 'area') return;
      ev.stopImmediatePropagation();
      var l = local(ev), s0 = drag.s; drag = null; areaMode = false;
      if (areaEl) { areaEl.remove(); areaEl = null; }
      host.classList.remove('picking');
      var w = Math.abs(l[0] - s0[0]), h = Math.abs(l[1] - s0[1]);
      if (w < 12 || h < 12) return;
      var W = host.clientWidth, H = host.clientHeight;
      animateView(view.z * Math.min(W / w, H / h) * 0.95, view.r, toWorld((l[0] + s0[0]) / 2, (l[1] + s0[1]) / 2));
    }, true);

    // ---- Lock zoom and turn (3.25, #54): read a long note zoomed and turned as you like; fingers then only scroll,
    // along the page's lines or down its columns (whichever way the move starts). Saved with the note's view. ----
    function axisLock(dx, dy, st, tx, ty) {
      var c = Math.cos(-view.r), s = Math.sin(-view.r);
      if (!st.ax) { if (Math.abs(tx) + Math.abs(ty) < 10) return [0, 0]; var px = tx * c - ty * s, py = tx * s + ty * c; st.ax = Math.abs(px) > Math.abs(py) ? 'x' : 'y'; }
      var qx = dx * c - dy * s, qy = dx * s + dy * c;
      if (st.ax === 'x') qy = 0; else qx = 0;
      var c2 = Math.cos(view.r), s2 = Math.sin(view.r);
      return [qx * c2 - qy * s2, qx * s2 + qy * c2];
    }

    // ---- Linear mode's arrows: where more is, beyond the screen ----
    var DIRS = { n: 270, ne: 315, e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225 };
    var dirEl = el('div', 'qn-dirs hidden', host), dirRaf = 0, blocksC = null, lastDir = null;
    dirEl.innerHTML = Object.keys(DIRS).map(function (d) {
      return '<button type="button" class="qn-dir hidden" data-d="' + d + '" aria-label="More this way: tap to see all of it, double tap to go to the nearest" title="More this way: tap to see all of it, double tap to go to the nearest">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" style="transform:rotate(' + DIRS[d] + 'deg)"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
    }).join('');
    var dirBtns = [].slice.call(dirEl.children);
    function blocks() { // everything there is, in stage coordinates: text boxes one by one, drawings by area
      if (blocksC) return blocksC;
      var out = [];
      boxes.forEach(function (b) {
        var e = editors[b.id]; if (!e || !(b.md && b.md.trim())) return;
        var L = layerOfBox(b); if (L && L.vis === false) return;
        out.push({ x: b.x + M, y: b.y + M, w: e.el.offsetWidth, h: e.el.offsetHeight, box: b });
      });
      eng.blocks(320).forEach(function (q) { out.push({ x: q.x + M, y: q.y + M, w: q.w, h: q.h }); });
      return (blocksC = out);
    }
    function drawDirsSoon() { if (!dirRaf) dirRaf = requestAnimationFrame(drawDirs); }
    function drawDirs() {
      dirRaf = 0;
      var on = !!eng && pageMode();
      dirEl.classList.toggle('hidden', !on);
      modeBtn.classList.toggle('hidden', phoneNow());
      modeBtn.textContent = pageMode() ? 'Linear' : 'Free';
      modeBtn.setAttribute('aria-pressed', pageMode() ? 'true' : 'false');
      if (!on) { hidePeek(); hideSide(); return; }
      var W = host.clientWidth, H = host.clientHeight, best = {};
      blocks().forEach(function (q) {
        var p = [toScreen(q.x, q.y), toScreen(q.x + q.w, q.y + q.h)];
        var x0 = Math.min(p[0][0], p[1][0]), x1 = Math.max(p[0][0], p[1][0]), y0 = Math.min(p[0][1], p[1][1]), y1 = Math.max(p[0][1], p[1][1]);
        var hz = x1 < 6 ? 'w' : x0 > W - 6 ? 'e' : '', vt = y1 < topIn() + 6 ? 'n' : y0 > H - 6 ? 's' : '';
        if (!hz && !vt) return;
        var d = vt + hz, dist = Math.hypot(Math.max(0, -x1, x0 - W), Math.max(0, -y1, y0 - H));
        if (!best[d] || dist < best[d].dist) best[d] = { q: q, dist: dist };
      });
      dirBtns.forEach(function (b) { var c = best[b.dataset.d]; b.classList.toggle('hidden', !c); b._q = c ? c.q : null; });
      // Keep clear of the tool rail (right) and the quick corner (bottom left).
      var hr = host.getBoundingClientRect(), t = document.getElementById('tools'), qk = document.getElementById('toolQuick');
      var tr = t && !t.classList.contains('hidden') ? t.getBoundingClientRect() : null, qr = qk && !qk.classList.contains('hidden') ? qk.getBoundingClientRect() : null;
      dirEl.style.setProperty('--dt', (topIn() + 8) + 'px');
      dirEl.style.setProperty('--dr', (tr && tr.width ? Math.max(8, hr.right - tr.left + 6) : 8) + 'px');
      dirEl.style.setProperty('--dbl', (qr && qr.width && qr.left < hr.left + hr.width / 2 ? Math.max(76, hr.bottom - qr.top + 6) : 76) + 'px');
    }
    function blockText(q) {
      var e = editors[q.box.id]; var t = (e ? e.el.innerText : q.box.md || '').replace(/\s+\n/g, '\n').trim();
      return t.length > 420 ? t.slice(0, 420) + '…' : t;
    }
    var peekEl = null, peekTimer = 0;
    function hidePeek() { clearTimeout(peekTimer); if (peekEl) { peekEl.remove(); peekEl = null; } }
    function showPeek(q, d) {
      hidePeek();
      peekEl = el('div', 'qn-peek', host);
      peekEl.dataset.d = d;
      var W = host.clientWidth, pw = Math.min(W - 40, 340);
      if (q.box) peekEl.innerHTML = '<div class="pk-text"></div>', peekEl.firstChild.textContent = blockText(q);
      else {
        var pad = 12, x = q.x - pad, y = q.y - pad, w = q.w + 2 * pad, h = q.h + 2 * pad;
        var txt = boxes.map(function (b) {
          var e = editors[b.id]; if (!e || !(b.md && b.md.trim())) return '';
          return '<rect x="' + (b.x + M) + '" y="' + (b.y + M) + '" width="' + e.el.offsetWidth + '" height="' + e.el.offsetHeight + '" rx="6" fill="var(--rule)"/>';
        }).join('');
        peekEl.innerHTML = '<svg viewBox="' + x + ' ' + y + ' ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' + txt + window.QNInk.svgFor(ink, 'pk-', M, M, true) + '</svg>';
      }
      peekEl.insertAdjacentHTML('beforeend', '<div class="pk-hint">Double tap the arrow, or tap here, to go there</div>');
      peekEl.style.width = pw + 'px';
      peekEl.style.left = (W - pw) / 2 + 'px';
      if (d.charAt(0) === 'n') peekEl.style.top = (topIn() + 52) + 'px'; else if (d.charAt(0) === 's') peekEl.style.bottom = '64px'; else peekEl.style.top = '30%';
      peekEl.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      peekEl.addEventListener('click', function () { hidePeek(); goTo(q, d); });
      peekTimer = setTimeout(hidePeek, 3500);
    }
    function goTo(q, d) { // the column moves to it (sideways only if it is to the side), and it comes to the top of the screen
      glide(/[ew]/.test(d) ? (Math.abs(M - q.x) < 40 ? 0 : M - q.x) : (view.lx || 0), topIn() + 36 - q.y);
    }
    function glide(lx1, y1) {
      cancelAnimationFrame(anim);
      var lx0 = view.lx || 0, y0 = view.y, t0 = performance.now();
      topCache = null; if (y1 > topLimit()) y1 = topLimit();
      function step(now) {
        var k = Math.min(1, (now - t0) / 320), e = 1 - Math.pow(1 - k, 3);
        view.lx = lx0 + (lx1 - lx0) * e; view.y = y0 + (y1 - y0) * e; applyView();
        if (k < 1) anim = requestAnimationFrame(step);
      }
      anim = requestAnimationFrame(step);
    }
    dirEl.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    dirEl.addEventListener('click', function (ev) {
      var b = ev.target.closest('.qn-dir'); if (!b || !b._q) return;
      var d = b.dataset.d, now = Date.now();
      if (lastDir && lastDir.d === d && now - lastDir.t < 450) { lastDir = null; hidePeek(); hideSide(); goTo(b._q, d); return; }
      lastDir = { d: d, t: now };
      if (sideEl && sideEl.dataset.d === d) { hideSide(); return; } // a second tap on the same arrow closes it
      showSide(d);
    });

    // ---- 3.27 (feedback 22 Nov): a side's navigator. A tap on an arrow opens a map of everything on that side, not
    // only the nearest part: the whole strip to the right (or left, above, below), or the whole corner. It scrolls;
    // a double tap on a part brings that part into the column. The part now on screen is outlined. ----
    var sideEl = null;
    var SIDE_NAMES = { n: 'Above', s: 'Below', e: 'To the right', w: 'To the left', ne: 'Up and to the right', nw: 'Up and to the left', se: 'Down and to the right', sw: 'Down and to the left' };
    function hideSide() { if (sideEl) { sideEl.remove(); sideEl = null; } }
    function sideBlocks(d) { // everything wholly off screen that way: a side takes in its corners too
      var W = host.clientWidth, H = host.clientHeight;
      return blocks().filter(function (q) {
        var p = [toScreen(q.x, q.y), toScreen(q.x + q.w, q.y + q.h)];
        var x0 = Math.min(p[0][0], p[1][0]), x1 = Math.max(p[0][0], p[1][0]), y0 = Math.min(p[0][1], p[1][1]), y1 = Math.max(p[0][1], p[1][1]);
        var hz = x1 < 6 ? 'w' : x0 > W - 6 ? 'e' : '', vt = y1 < topIn() + 6 ? 'n' : y0 > H - 6 ? 's' : '';
        if (d.length === 2) return vt === d.charAt(0) && hz === d.charAt(1);
        return d === 'e' || d === 'w' ? hz === d : vt === d;
      });
    }
    function wrapLines(t, n) { // a box's text as lines of about n characters, for the map
      var out = [];
      String(t || '').split('\n').forEach(function (para) {
        if (!para) { out.push(''); return; }
        while (para.length > n) { var cut = para.lastIndexOf(' ', n); if (cut < n * 0.5) cut = n; out.push(para.slice(0, cut)); para = para.slice(cut).replace(/^ /, ''); }
        out.push(para);
      });
      return out;
    }
    function escX(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function showSide(d) {
      hidePeek(); hideSide();
      var list = sideBlocks(d); if (!list.length) return;
      var W = host.clientWidth, H = host.clientHeight, pad = 24;
      var a = toWorld(0, 0), b = toWorld(W, H); // the part on screen now, in page coordinates
      var R = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      list.forEach(function (q) { R.x0 = Math.min(R.x0, q.x); R.y0 = Math.min(R.y0, q.y); R.x1 = Math.max(R.x1, q.x + q.w); R.y1 = Math.max(R.y1, q.y + q.h); });
      // (3.27.1, #82/#83) The map always takes in the screen you are on too, so a part that lies half here and half
      // to the side can be picked as a whole, and the outline of "here" is never cut off at the map's edge.
      R.x0 = Math.min(R.x0, a[0]); R.x1 = Math.max(R.x1, b[0]); R.y0 = Math.min(R.y0, a[1]); R.y1 = Math.max(R.y1, b[1]);
      R.x0 -= pad; R.y0 -= pad; R.x1 += pad; R.y1 += pad;
      var rw = R.x1 - R.x0, rh = R.y1 - R.y0;
      var dr = parseFloat(dirEl.style.getPropertyValue('--dr')) || 8; // the tool rail's room on the right
      var pw = Math.max(200, Math.min(W - dr - 64, 360)), ph = Math.round(H * 0.62);
      var s = Math.max(0.12, Math.min(1, (pw - 2) / rw));
      var txt = boxes.map(function (bx) {
        var e = editors[bx.id]; if (!e || !(bx.md && bx.md.trim())) return '';
        var L = layerOfBox(bx); if (L && L.vis === false) return '';
        var x = bx.x + M, y = bx.y + M, w = e.el.offsetWidth, h = e.el.offsetHeight;
        if (x > R.x1 || x + w < R.x0 || y > R.y1 || y + h < R.y0) return '';
        var fs = 16, lines = wrapLines(e.el.innerText, Math.max(8, Math.floor(w / (fs * 0.52)))), maxL = Math.max(1, Math.floor(h / (fs * 1.45)));
        return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="6" fill="var(--rule)" opacity=".45"/>' +
          '<text x="' + (x + 4) + '" y="' + y + '" font-size="' + fs + '" fill="var(--ink)">' + lines.slice(0, maxL).map(function (l) { return '<tspan x="' + (x + 4) + '" dy="' + (fs * 1.4) + '">' + escX(l) + '</tspan>'; }).join('') + '</text>';
      }).join('');
      // (3.33, #86) Where the screen is now: a faint outline. The frame on top of it can be moved (drag it, or tap a
      // part to bring it there) to choose what the screen will show; a double tap goes there.
      var here = '<rect x="' + a[0] + '" y="' + a[1] + '" width="' + (b[0] - a[0]) + '" height="' + (b[1] - a[1]) + '" fill="none" stroke="var(--muted, #888)" stroke-opacity=".5" stroke-width="' + (1.5 / s) + '" stroke-dasharray="' + (4 / s) + ' ' + (4 / s) + '" rx="' + (8 / s) + '"/>';
      sideEl = el('div', 'qn-side', host);
      sideEl.dataset.d = d;
      sideEl.innerHTML = '<div class="sd-head"><b>' + SIDE_NAMES[d] + '</b><span>Drag the frame, double tap</span><button type="button" class="sd-x" aria-label="Close">×</button></div>' +
        '<div class="sd-scroll"><svg width="' + Math.round(rw * s) + '" height="' + Math.round(rh * s) + '" viewBox="' + R.x0 + ' ' + R.y0 + ' ' + rw + ' ' + rh + '">' +
        txt + window.QNInk.svgFor(ink, 'sd-', M, M, true) + here + '</svg></div>';
      pw = Math.max(200, Math.min(pw, Math.round(rw * s) + 2)); // no empty strip beside a narrow map
      sideEl.style.width = pw + 'px';
      var sc = sideEl.querySelector('.sd-scroll'); sc.style.maxHeight = (ph - 44) + 'px';
      sc.querySelector('svg').style.margin = '0 auto'; sc.querySelector('svg').style.display = 'block';
      var v = d.charAt(0), h0 = d.length === 2 ? d.charAt(1) : d;
      if (v === 'n') sideEl.style.top = (topIn() + 52) + 'px'; else if (v === 's') sideEl.style.bottom = '64px'; else sideEl.style.top = Math.max(topIn() + 8, (H - ph) / 2) + 'px';
      // Beside its arrow, and never under the tool rail or off the screen.
      var lx = h0 === 'e' ? W - dr - 48 - pw : h0 === 'w' ? 56 : (W - dr - pw) / 2;
      sideEl.style.left = Math.max(8, Math.min(W - dr - pw - 4, lx)) + 'px';
      // Open where the screen meets that side: the edge of "here" a third of the way in, the side beyond it.
      var cw = sc.clientWidth, ch = sc.clientHeight;
      var cx = ((a[0] + b[0]) / 2 - R.x0) * s - cw / 2, cy = ((a[1] + b[1]) / 2 - R.y0) * s - ch / 2;
      if (h0 === 'e') cx = (b[0] - R.x0) * s - cw * 0.3; else if (h0 === 'w') cx = (a[0] - R.x0) * s - cw * 0.7;
      if (v === 's') cy = (b[1] - R.y0) * s - ch * 0.3; else if (v === 'n') cy = (a[1] - R.y0) * s - ch * 0.7;
      sc.scrollTop = Math.max(0, cy); sc.scrollLeft = Math.max(0, cx);
      sideEl.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); if (ev.pointerType !== 'mouse') ev.preventDefault(); }); // (3.32, #87) no stray tap events reach the page under the map
      sideEl.querySelector('.sd-x').addEventListener('click', hideSide);
      var lastTap = null;
      // The frame: what the screen will show. Page mode only (z 1, no turn), so the screen's top-left in page
      // coordinates is (-lx, -y), and going there is glide(-x, -y).
      sc.style.position = 'relative';
      var fw = b[0] - a[0], fh = b[1] - a[1], fr = { x: a[0], y: a[1] }, list0 = blocks();
      var frEl = el('div', 'sd-frame', sc); frEl.innerHTML = '<span>Double tap to go</span>';
      frEl.style.width = (fw * s) + 'px'; frEl.style.height = (fh * s) + 'px';
      function placeFr() {
        fr.x = Math.max(R.x0 - fw / 2, Math.min(R.x1 - fw / 2, fr.x));
        fr.y = Math.max(Math.max(R.y0 - fh / 2, -topLimit()), Math.min(R.y1 - fh / 2, fr.y));
        frEl.style.left = ((fr.x - R.x0) * s) + 'px'; frEl.style.top = ((fr.y - R.y0) * s) + 'px';
        frEl.classList.toggle('moved', Math.abs(fr.x - a[0]) > 2 || Math.abs(fr.y - a[1]) > 2);
      }
      placeFr();
      function goFr() { lastTap = null; swallowTap(); hideSide(); glide(-fr.x, -fr.y); }
      function mapTap(ev, inFrame) {
        var t = Date.now();
        if (lastTap && t - lastTap.t < 420 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 40) { goFr(); return; }
        lastTap = { t: t, x: ev.clientX, y: ev.clientY };
        if (inFrame) return;
        // A tap on a part brings the frame there, placed as a double tap used to place the screen: a text box with its
        // left edge at the margin, anything else in the middle, a third of the way down.
        var r = sc.querySelector('svg').getBoundingClientRect();
        var tg = pointTarget(R.x0 + (ev.clientX - r.left) / s, R.y0 + (ev.clientY - r.top) / s, d, list0);
        fr.x = -tg[0]; fr.y = -tg[1]; placeFr();
      }
      var fd = null;
      frEl.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        frEl.setPointerCapture(ev.pointerId);
        fd = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: fr.x, oy: fr.y, moved: false };
      });
      frEl.addEventListener('pointermove', function (ev) {
        if (!fd || ev.pointerId !== fd.id) return;
        var dx = ev.clientX - fd.sx, dy = ev.clientY - fd.sy;
        if (!fd.moved && Math.hypot(dx, dy) < 6) return;
        fd.moved = true; lastTap = null;
        fr.x = fd.ox + dx / s; fr.y = fd.oy + dy / s; placeFr();
        // Near the map's edge, the map scrolls along.
        var cr = sc.getBoundingClientRect(), e = 28;
        if (ev.clientY > cr.bottom - e) sc.scrollTop += 8; else if (ev.clientY < cr.top + e) sc.scrollTop -= 8;
        if (ev.clientX > cr.right - e) sc.scrollLeft += 8; else if (ev.clientX < cr.left + e) sc.scrollLeft -= 8;
      });
      function frUp(ev) { if (!fd || ev.pointerId !== fd.id) return; var m = fd.moved; fd = null; if (!m && ev.type === 'pointerup') mapTap(ev, true); }
      frEl.addEventListener('pointerup', frUp); frEl.addEventListener('pointercancel', frUp);
      sc.addEventListener('pointerdown', function (ev) { sc._down = { x: ev.clientX, y: ev.clientY }; });
      sc.addEventListener('pointerup', function (ev) {
        var dn = sc._down; sc._down = null;
        if (!dn || Math.hypot(ev.clientX - dn.x, ev.clientY - dn.y) > 10) return; // it scrolled
        mapTap(ev, false);
      });
    }
    // (3.32, #87) The double tap that jumps there must not also start typing in the text box now under the finger:
    // for a moment, the page ignores the click that follows and takes the focus back if a box grabbed it.
    function swallowTap() {
      var eat = function (e) { e.preventDefault(); e.stopPropagation(); };
      var had = !!(document.activeElement && stage.contains(document.activeElement) && document.activeElement.closest('.box'));
      ['click', 'mousedown', 'mouseup', 'dblclick'].forEach(function (k) { document.addEventListener(k, eat, true); });
      setTimeout(function () {
        ['click', 'mousedown', 'mouseup', 'dblclick'].forEach(function (k) { document.removeEventListener(k, eat, true); });
        var ae = document.activeElement; if (ae && stage.contains(ae) && ae.closest('.box') && !had) ae.blur();
      }, 450);
    }
    function pointTarget(px, py, d, list) { // -> [lx, y] that brings this point of the page to its place on screen
      // (3.27.1, #82) A text box: its left edge goes to the margin. Anything else (a drawing that may run across the
      // screen and the side): the point comes to the middle of the screen, a third of the way down.
      var W = host.clientWidth, H = host.clientHeight, lx1 = view.lx || 0, hit = null;
      list.forEach(function (q) { if (q.box && px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h) hit = q; });
      var a = toWorld(0, 0), b = toWorld(W, H), onScreenX = px >= a[0] && px <= b[0];
      if (hit && hit.w < W) lx1 = Math.abs(M - hit.x) < 40 ? 0 : M - hit.x;
      else if (/[ew]/.test(d) || !onScreenX) lx1 = W / 2 - px;
      return [lx1, Math.min(topLimit(), topIn() + (H - topIn()) * 0.3 - py)];
    }
    function goToPoint(px, py, d, list) { var t = pointTarget(px, py, d, list); glide(t[0], t[1]); }
    on(host, 'pointerdown', function (ev) { if (sideEl && !sideEl.contains(ev.target) && !(ev.target.closest && ev.target.closest('.qn-dir'))) hideSide(); }, true);

    // ---- Linear mode or free canvas, for this note: a shake on a phone, the button elsewhere ----
    var modeBtn = el('button', 'qn-modebtn hidden', host);
    modeBtn.type = 'button'; modeBtn.title = 'Linear mode (scrolls up and down) or the free canvas';
    modeBtn.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    modeBtn.addEventListener('click', function () { toggleMode(); });
    function toggleMode() {
      var W = host.clientWidth / 2, H = host.clientHeight / 2, wc = toWorld(W, H);
      if (pageMode()) { modeOv = 'free'; view.x = view.lx || 0; }
      else { // the middle of what is on screen stays in the middle of the column
        modeOv = 'lin'; var lx = W - wc[0]; view.lx = Math.abs(lx) < 60 ? 0 : lx; view.y = H - wc[1];
      }
      view.mo = modeOv;
      hidePeek(); hideSide(); applyView(); drawDirs();
      if (hooks.view) hooks.view({ z: view.z, r: view.r });
      if (hooks.notice) hooks.notice(pageMode() ? 'Linear mode: scrolls up and down. Arrows show what is off to the side.' : 'Free canvas: move, zoom and turn as you like.' + (phoneNow() ? ' Shake again for Linear mode.' : ''));
    }
    var shk = { t: 0, n: 0, last: 0 };
    on(window, 'devicemotion', function (e) {
      if (!phoneNow() || !host.isConnected) return;
      var a = e.acceleration, m;
      if (a && a.x != null) m = Math.hypot(a.x, a.y, a.z);
      else { var g = e.accelerationIncludingGravity; if (!g || g.x == null) return; m = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81); }
      if (m < 16) return;
      var t = Date.now();
      if (t - shk.t < 110) return; // the same jolt
      if (t - shk.t > 800) shk.n = 0;
      shk.t = t; shk.n++;
      if (shk.n >= 3 && t - shk.last > 1500 && !drag && !gest) { shk.n = 0; shk.last = t; toggleMode(); }
    });

    // ---- The navigator: a small map of the whole page; tap or drag in it to go there ----
    var navOn = false, navEl = el('div', 'qn-nav hidden', host), navContent = null, navBox = null;
    navEl.innerHTML = '<svg preserveAspectRatio="xMidYMid meet"></svg>';
    var navSvg = navEl.firstChild;
    // The map's picture of the page is rebuilt a moment after drawing stops, not after every stroke.
    var navTimer = null;
    function drawNavSoon(contentToo) {
      if (!navOn) return;
      if (contentToo) { clearTimeout(navTimer); navTimer = setTimeout(function () { navContent = null; drawNavSoon(); }, 700); return; }
      if (!navRaf) navRaf = requestAnimationFrame(drawNav);
    }
    function drawNav() {
      navRaf = 0;
      if (!navOn) return;
      var W = host.clientWidth, H = host.clientHeight;
      var vp = [toWorld(0, 0), toWorld(W, 0), toWorld(W, H), toWorld(0, H)];
      if (!navContent) {
        navBox = contentBox();
        navContent = boxes.map(function (b) {
          var e = editors[b.id]; if (!e || !(b.md && b.md.trim())) return '';
          return '<rect x="' + (b.x + M) + '" y="' + (b.y + M) + '" width="' + e.el.offsetWidth + '" height="' + e.el.offsetHeight + '" rx="6" fill="var(--rule)"/>';
        }).join('') + window.QNInk.svgFor(ink, 'nv-', M, M, true);
      }
      var xs = vp.map(function (q) { return q[0]; }), ys = vp.map(function (q) { return q[1]; });
      var b = navBox || { x: xs[0], y: ys[0], w: 1, h: 1 };
      var x0 = Math.min(b.x, Math.min.apply(null, xs)), y0 = Math.min(b.y, Math.min.apply(null, ys));
      var x1 = Math.max(b.x + b.w, Math.max.apply(null, xs)), y1 = Math.max(b.y + b.h, Math.max.apply(null, ys));
      var pad = Math.max(x1 - x0, y1 - y0) * 0.06;
      navSvg.setAttribute('viewBox', (x0 - pad) + ' ' + (y0 - pad) + ' ' + (x1 - x0 + 2 * pad) + ' ' + (y1 - y0 + 2 * pad));
      var sw = (x1 - x0 + 2 * pad) / 160;
      navSvg.innerHTML = navContent + '<polygon points="' + vp.map(function (q) { return q[0] + ',' + q[1]; }).join(' ') + '" fill="var(--accent)" fill-opacity=".12" stroke="var(--accent)" stroke-width="' + (2 * sw) + '"/>';
    }
    function navGo(ev) {
      var m = navSvg.getScreenCTM(); if (!m) return;
      var pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
      var W = host.clientWidth / 2, H = host.clientHeight / 2, c = Math.cos(view.r), s = Math.sin(view.r);
      view.x = W - (pt.x * c - pt.y * s) * view.z; view.y = H - (pt.x * s + pt.y * c) * view.z; applyView();
    }
    var navDrag = false;
    navEl.addEventListener('pointerdown', function (ev) { ev.stopImmediatePropagation(); ev.preventDefault(); navDrag = true; navEl.setPointerCapture(ev.pointerId); navGo(ev); });
    navEl.addEventListener('pointermove', function (ev) { ev.stopImmediatePropagation(); if (navDrag) navGo(ev); });
    navEl.addEventListener('pointerup', function (ev) { ev.stopImmediatePropagation(); navDrag = false; });

    self.viewOps = {
      fit: function () { var b = contentBox(); if (b) fitStage({ x: b.x - 16, y: b.y - 16, w: b.w + 32, h: b.h + 32 }, 0); else animateView(1, 0, [host.clientWidth / 2, host.clientHeight / 2]); },
      actual: function () { animateView(1, view.r, toWorld(host.clientWidth / 2, host.clientHeight / 2)); },
      straighten: function () { animateView(view.z, 0, toWorld(host.clientWidth / 2, host.clientHeight / 2)); },
      zoomIn: function () { animateView(view.z * 1.5, view.r, toWorld(host.clientWidth / 2, host.clientHeight / 2)); },
      zoomOut: function () { animateView(view.z / 1.5, view.r, toWorld(host.clientWidth / 2, host.clientHeight / 2)); },
      area: function () { areaMode = true; host.classList.add('picking'); },
      navigator: function (on) { navOn = !!on; navEl.classList.toggle('hidden', !navOn); navContent = null; drawNavSoon(); },
      gestures: function () { return 'pinch to zoom, two fingers to move, twist to turn, two-finger double tap to undo, three-finger double tap to redo'; },
      rotate: function (on) { rotateOn = !!on; },
      info: function () { return { z: view.z, r: view.r, lk: !!view.lk, linear: pageMode() }; },
      lock: function () { view.lk = !view.lk; applyView(); return view.lk; },
      locked: function () { return !!view.lk; },
      linear: function () { return pageMode(); },
      toggleMode: toggleMode,
      followPref: function () { modeOv = null; delete view.mo; applyView(); }
    };

    // ---- What the app can ask of the canvas ----
    self.setTool = function (t) {
      tool = t;
      stage.dataset.tool = t;
      if (t !== 'select') select(null);
      if (INK[t] || t === 'text') eng.setTool(t); else { eng.finishText(); eng.clearSelection(); }
      var ae = document.activeElement;
      if (t !== 'type' && ae && stage.contains(ae) && !(t === 'text' && ae.classList.contains('ink-textedit'))) ae.blur();
    };
    self.ink = function () { return eng; };
    self.resuming = function () { return !!away || !!(eng.awayPending && eng.awayPending()); };
    self.tool = function () { return tool; };
    self.penSeen = function () { return penSeen; };
    self.busy = function () { return !!drag || eng.busy(); };
    self.active = function () { return active && editors[active.box.id] ? active.ed : null; };
    // (3.28, #80) The Text card works on the box being typed in, or else the one typed in last.
    var lastBoxId = null;
    function lastBox() { var id = active ? active.box.id : lastBoxId; var b = boxes.filter(function (x) { return x.id === id; })[0]; return b && editors[b.id] ? b : null; }
    self.textTarget = function () { var b = lastBox(); return b ? { ed: editors[b.id].ed, typing: editors[b.id].el.contains(document.activeElement), ls: b.ls || null, ps: b.ps == null ? null : b.ps } : null; };
    self.boxSpacing = function (k, v) {
      var b = lastBox(); if (!b) return false;
      if (v == null || v === '') delete b[k]; else b[k] = +v;
      layout(); changed('layout'); record(); return true;
    };
    self.flush = flushAll;
    self.undo = function () {
      flushAll(); clearTimeout(textTimer); record();
      if (hist.length < 2) return;
      future.push(hist.pop()); restore(hist[hist.length - 1]);
    };
    self.redo = function () {
      if (!future.length) return;
      var s = future.pop(); hist.push(s); restore(s);
    };
    function restore(s) {
      boxes.length = 0; JSON.parse(s.boxes).forEach(function (b) { boxes.push(b); });
      ink.length = 0; copyLayers(s.ink).forEach(function (g) { ink.push(g); });
      select(null); active = null; eng.reset(); renderAll();
      hooks.change('restore');
      hooks.history(hist.length > 1, future.length > 0);
    }
    // Make room on the left or at the top by shifting everything over.
    self.addSpace = function (dir) {
      var dx = dir === 'left' ? 240 : 0, dy = dir === 'up' ? 240 : 0;
      if (dir === 'right' || dir === 'down') { // room on these sides grows by itself; add a text box out there
        var c = contentRight();
        var b = dir === 'right' ? addBox(c.r + 40, 0) : addBox(0, c.b + 60);
        showPoint(b.x + 60, b.y + 20);
        changed('layout'); return;
      }
      boxes.forEach(function (b) { b.x += dx; b.y += dy; });
      eng.shift(dx, dy); changed('layout');
    };
    // An image: at the caret, beside the text (both side by side), or in a new text box below.
    // An image as its own object on the page: in the middle of the screen, straight to it, at most about 60% of it.
    self.placeImage = function (src, nw, nh) {
      var c = toWorld(host.clientWidth / 2, host.clientHeight / 2), cx = c[0] - M, cy = c[1] - M;
      var k = Math.min(host.clientWidth * 0.6 / view.z / nw, host.clientHeight * 0.6 / view.z / nh, 1 / view.z); // never blown up past its own size
      var w = Math.max(20, nw * k), h = Math.max(20, nh * k), a = -(view.r || 0);
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (hooks.autoTool) hooks.autoTool('lasso');
      eng.addImage(src, cx - (w / 2 * Math.cos(a) - h / 2 * Math.sin(a)), cy - (w / 2 * Math.sin(a) + h / 2 * Math.cos(a)), w, h, a);
    };
    // A video, sound, link or live page (3.20), in the middle of the screen; several PDF pages go one under another.
    self.placeMedia = function (spec, nw, nh, dy) {
      var c = toWorld(host.clientWidth / 2, host.clientHeight / 2), cx = c[0] - M, cy = c[1] - M + (dy || 0);
      var k = Math.min(host.clientWidth * 0.7 / view.z / nw, 1 / view.z), w = Math.max(40, nw * k), h = Math.max(30, nh * k), a = -(view.r || 0);
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (hooks.autoTool) hooks.autoTool('lasso');
      eng.addMedia(spec, cx - (w / 2 * Math.cos(a) - h / 2 * Math.sin(a)), cy - (w / 2 * Math.sin(a) + h / 2 * Math.cos(a)), w, h, a);
      return h;
    };
    self.insertImage = function (src, where) {
      var a = self.active() ? active : null;
      if (where === 'caret' && a) { a.ed.chain().focus().setImage({ src: src }).run(); flushText(a.box.id); changed('text'); return; }
      var b, c = contentRight();
      if (where === 'beside') {
        var ref = a ? a.box : boxes[0], refEl = editors[ref.id].el;
        if (!ref.w) ref.w = Math.max(140, Math.round((autoWidth() - ref.x) * 0.55));
        var x = ref.x + (ref.w || refEl.offsetWidth) + 16;
        b = addBox(x, ref.y);
        b.w = Math.max(140, autoWidth() - x);
      } else b = addBox(0, c.b + 24);
      var e = editors[b.id];
      e.ed.chain().focus().setImage({ src: src }).run();
      flushText(b.id); layout(); changed('layout');
      showPoint(b.x + 40, b.y + 40);
    };
    self.focusStart = function () { var f = editors[boxes[0].id]; if (f) f.ed.commands.focus('end'); };
    self.showRect = function (b) { fitRect(b, false); }; // a part of the page, filling the screen
    self.setPage = function (page) { note.page = page || ''; setPage(note.page); };
    self.destroy = function () {
      flushAll();
      Object.keys(editors).forEach(function (id) { editors[id].ed.destroy(); });
      if (head) { if (headRO) headRO.disconnect(); head.classList.remove('in-page'); head.style.width = head.style.top = ''; wrap.insertBefore(head, host); }
      clearTimeout(navTimer); clearTimeout(viewTimer);
      if (eng && eng.destroy) eng.destroy();
      try { localStorage.setItem(VKEY, JSON.stringify(view)); } catch (e) {} // the view as left, Linear or free (3.27)
      editors = {}; host.innerHTML = ''; if (self._unbind) self._unbind();
    };
    self.relayout = layout;

    stage.dataset.tool = tool;
    stage.addEventListener('load', function () { requestAnimationFrame(layout); }, true); // images change a box's height
    stage.style.transformOrigin = '0 0';
    renderAll();
    applyView();
    on(window, 'resize', function () { layout(); topCache = null; drawDirsSoon(); });
    self._unbind = function () { offs.forEach(function (f) { f(); }); offs = []; };
  }

  window.QNCanvas = { NoteCanvas: NoteCanvas, protect: protect, unprotect: unprotect, inkSvg: function (ink, w, h) { return window.QNInk.thumb(ink, w, h); } };
})();
