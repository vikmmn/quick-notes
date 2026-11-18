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

  function el(tag, cls, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Drawing lives in ink.js (layers, brushes, erasers, lasso, nudge, fills).
  var INK = { pen: 1, erase: 1, lasso: 1, nudge: 1, fill: 1 };

  // ---------- The canvas ----------
  function NoteCanvas(host, wrap, note, hooks) {
    var self = this;
    // Every listener on the shared page elements is removed again when the note closes. (Before 3.4 they stayed,
    // so each note opened in a session added another copy that handled every touch and pen movement again.)
    var offs = [];
    function on(t, type, fn, opt) { t.addEventListener(type, fn, opt); offs.push(function () { t.removeEventListener(type, fn, opt); }); }
    var stage = el('div', 'stage', host);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ink-layer');
    stage.appendChild(svg);
    var selBox = el('div', 'sel hidden', stage);
    var selBar = el('div', 'selbar hidden', stage);
    selBar.innerHTML = '<button type="button" data-act="delete">Delete</button>';

    var boxes = note.boxes;
    if (!Array.isArray(note.ink) || !note.ink.length) note.ink = [window.QNInk.newLayer()];
    var ink = note.ink;
    var editors = {};          // box id -> { el, ed }
    var tool = 'type', penSeen = !!(hooks.penKnown && hooks.penKnown());
    // A finger draws, scrolls, or (auto) draws until a pen has been used on this device.
    function fingerDraws() { var m = hooks.finger ? hooks.finger() : 'auto'; return m === 'draw' || (m !== 'scroll' && !penSeen); }

    // The title, labels and "Edited" line sit on the page above the text, so they move and zoom with it.
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
    var view = { x: 0, y: headH, z: 1, r: 0, h: 1 };
    try {
      var sv = JSON.parse(localStorage.getItem(VKEY) || 'null');
      if (sv && isFinite(sv.z)) { view = sv; if (!sv.h) { view.y += headH; view.h = 1; } } // saved before the title moved onto the page
    } catch (e) {}
    var ZMIN = 0.01, ZMAX = 12, viewTimer = null, navRaf = 0;
    function clampZ(z) { return Math.max(ZMIN, Math.min(ZMAX, z)); }
    function toWorld(sx, sy) { var dx = sx - view.x, dy = sy - view.y, c = Math.cos(-view.r), s = Math.sin(-view.r); return [(dx * c - dy * s) / view.z, (dx * s + dy * c) / view.z]; }
    function toScreen(wx, wy) { var c = Math.cos(view.r), s = Math.sin(view.r); return [view.x + (wx * c - wy * s) * view.z, view.y + (wx * s + wy * c) * view.z]; }
    function local(ev) { var r = host.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
    function applyView() {
      stage.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) rotate(' + view.r + 'rad) scale(' + view.z + ')';
      if (eng) eng.viewChanged();
      if (hooks.view) hooks.view({ z: view.z, r: view.r });
      clearTimeout(viewTimer); viewTimer = setTimeout(function () { try { localStorage.setItem(VKEY, JSON.stringify(view)); } catch (e) {} }, 400);
      drawNavSoon();
    }
    var eng = null;
    eng = new window.QNInk.Engine({
      uiHost: host, toScreen: function (x, y) { return toScreen(x + M, y + M); }, zoom: function () { return view.z; },
      zoomTo: function (b) { fitRect(b, true); },
      layers: ink, svg: svg, stage: stage, margin: M, boxes: boxApi(),
      changed: function () { changed('ink'); },
      notice: function (t) { if (hooks.notice) hooks.notice(t); },
      textLook: function (t) { if (hooks.textLook) hooks.textLook(t); },
      toNewNote: hooks.toNewNote ? function (d, move) { return hooks.toNewNote(d, move); } : null,
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
    function snapshot() { return { boxes: JSON.stringify(boxes.map(function (b) { var o = { id: b.id, x: b.x, y: b.y, w: b.w, md: b.md }; if (b.l) o.l = b.l; if (b.r) o.r = b.r; if (b.g) o.g = b.g; if (b.co) o.co = b.co; return o; })), ink: copyLayers(ink) }; }
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
    // with it. (Since 3.18 drawings show above text, so what is drawn later is never hidden behind older text.)
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
      var grip = el('div', 'grip', e); grip.title = 'Drag to move'; grip.innerHTML = '<svg viewBox="0 0 10 16" width="10" height="16"><circle cx="2" cy="3" r="1.4"/><circle cx="8" cy="3" r="1.4"/><circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="2" cy="13" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>';
      var mount = el('div', 'ed', e);
      el('div', 'resize', e).title = 'Drag to change the width';
      var isFirst = boxes[0] === b;
      var ed = LIB().makeEditor(mount, toEditor(b.md), {
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
        onFocus: function () { active = { box: b, ed: ed }; e.classList.add('focused'); hooks.focus(ed); },
        onBlur: function () {
          e.classList.remove('focused');
          flushText(b.id);
          setTimeout(function () {
            if (active && active.ed === ed && !e.contains(document.activeElement)) { hooks.blur(ed); }
            // A text box that was added and left empty goes away again.
            if (!isFirst && boxes.indexOf(b) > -1 && !b.md.trim() && !e.contains(document.activeElement)) removeBox(b.id);
          }, 200);
        },
        onSelectionUpdate: function () { hooks.selection(ed); },
        onTransaction: function () { hooks.selection(ed); }
      });
      editors[b.id] = { el: e, ed: ed };
      return editors[b.id];
    }
    function flushText(id) {
      var b = boxes.filter(function (x) { return x.id === id; })[0], e = editors[id];
      if (!b || !e) return;
      var md = getMd(e.ed);
      if (md !== b.md) { b.md = md; hooks.change('text'); }
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
            var c = { id: 'b' + window.Notes.shortId(), x: b.x + dx, y: b.y + dy, w: b.w, md: b.md };
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
    var drag = null, taps = [], panV = null, panMoved = false;
    on(host, 'pointerdown', function (ev) {
      // The title and labels work as usual, except with a drawing tool: the title's strip runs right across the top of
      // the page, and before 3.18 nothing could be drawn over any of it.
      if (head && head.contains(ev.target)) {
        var drawsHere = INK[tool] ? !ev.target.closest('button, .chip, a') : tool === 'type' && ev.pointerType === 'pen' && !ev.target.closest('input, button, .chip, a');
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
      var inkTool = INK[tool] ? tool : (tool === 'type' && ev.pointerType === 'pen' && !onBox ? 'pen' : null);
      if (inkTool && !(isFinger && !fingerDraws())) {
        // The pen writing in Type mode switches the tools to Pen, so the toolbar shows what is happening.
        if (tool === 'type' && inkTool === 'pen' && hooks.autoTool) { hooks.autoTool('pen'); tool = 'pen'; }
        if (eng.tool() !== inkTool) eng.setTool(inkTool);
        if (eng.down(p, ev)) {
          ev.preventDefault();
          if (document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
          drag = { type: 'ink', id: ev.pointerId, finger: isFinger, t: ev.timeStamp };
          host.setPointerCapture(ev.pointerId);
          return;
        }
      }
      if (onBox) { // typing, selecting text: leave it to the editor, but a finger drag over the text still scrolls
        if (isFinger && tool === 'type') startPan(ev);
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
        addBox(p[0] - 4, p[1] - 14); changed('layout');
        return;
      }
      taps.push({ t: now, x: p[0], y: p[1] });
      if (tool === 'type') {
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
    });
    function startPan(ev) {
      if (ev.pointerType === 'mouse') return; // a mouse scrolls with its wheel
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
      if (drag.type === 'ink') { inkMove(ev); return; }
      if (drag.type === 'pan') {
        if (!(ev.pointerId in drag.fingers)) return;
        var prev = drag.fingers[ev.pointerId];
        var n = Object.keys(drag.fingers).length;
        var dx = (ev.clientX - prev[0]) / n, dy = (ev.clientY - prev[1]) / n;
        drag.fingers[ev.pointerId] = [ev.clientX, ev.clientY];
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
    function endPointer(ev) {
      if (!drag) return;
      if (drag.type === 'pan') {
        delete drag.fingers[ev.pointerId];
        if (Object.keys(drag.fingers).length) return;
        var vx = drag.vx || 0, vy = drag.vy || 0;
        if (drag.moved) { taps = []; clearTimeout(self._tapTimer); panMoved = true; }
        var tapAt = !drag.moved && drag.textTap;
        drag = null;
        if (tapAt && tool === 'text') { eng.textAt(tapAt, -(view.r || 0)); return; }
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
        if (d.item.x !== d.ox || d.item.y !== d.oy || d.item.w !== d.ow) changed('layout');
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
      drag = null; taps = []; clearTimeout(self._tapTimer); cancelAnimationFrame(anim);
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
      if (ev.pointerType !== 'touch' || ev.target.closest('.qn-nav, .inkbar, .selbar')) return;
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
      if (e.ctrlKey || e.metaKey) zoomAt(l[0], l[1], Math.exp(-e.deltaY * k * 0.004));
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
      if (!areaMode || ev.target.closest('.qn-nav')) return;
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
      info: function () { return { z: view.z, r: view.r }; }
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
    self.tool = function () { return tool; };
    self.penSeen = function () { return penSeen; };
    self.busy = function () { return !!drag || eng.busy(); };
    self.active = function () { return active && editors[active.box.id] ? active.ed : null; };
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
    self.destroy = function () {
      flushAll();
      Object.keys(editors).forEach(function (id) { editors[id].ed.destroy(); });
      if (head) { if (headRO) headRO.disconnect(); head.classList.remove('in-page'); head.style.width = head.style.top = ''; wrap.insertBefore(head, host); }
      clearTimeout(navTimer);
      editors = {}; host.innerHTML = ''; if (self._unbind) self._unbind();
    };
    self.relayout = layout;

    stage.dataset.tool = tool;
    stage.addEventListener('load', function () { requestAnimationFrame(layout); }, true); // images change a box's height
    stage.style.transformOrigin = '0 0';
    renderAll();
    applyView();
    on(window, 'resize', layout);
    self._unbind = function () { offs.forEach(function (f) { f(); }); offs = []; };
  }

  window.QNCanvas = { NoteCanvas: NoteCanvas, inkSvg: function (ink, w, h) { return window.QNInk.thumb(ink, w, h); } };
})();
