// Quick Notes: the note canvas. Text boxes (rich text, saved as Markdown) and ink, placed anywhere.
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
    var tool = 'type', penSeen = false;
    var eng = new window.QNInk.Engine({
      layers: ink, svg: svg, stage: stage, margin: M,
      changed: function () { changed('ink'); },
      notice: function (t) { if (hooks.notice) hooks.notice(t); },
      view: function () {
        var r = stage.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        return { x: w.left - r.left - M, y: w.top - r.top - M, w: wrap.clientWidth, h: wrap.clientHeight };
      }
    });
    var selected = null;       // { kind: 'box'|'ink', id }
    var hist = [], future = [], textTimer = null, mdTimer = null;
    var active = null;         // the editor with the caret

    function snapshot() { return JSON.stringify({ boxes: boxes.map(function (b) { return { id: b.id, x: b.x, y: b.y, w: b.w, md: b.md }; }), ink: ink }); }
    hist.push(snapshot());
    var lastRec = Date.now();
    function record() {
      lastRec = Date.now();
      var s = snapshot();
      if (s === hist[hist.length - 1]) return;
      hist.push(s); if (hist.length > 200) hist.shift();
      future = [];
      hooks.history(hist.length > 1, false);
    }
    function changed(kind) {
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
    function autoWidth() { return Math.max(240, wrap.clientWidth - 2 * M); }
    function layout() {
      boxes.forEach(function (b) {
        var e = editors[b.id];
        if (!e) return;
        e.el.style.left = (b.x + M) + 'px'; e.el.style.top = (b.y + M) + 'px';
        e.el.style.width = (b.w || Math.max(160, autoWidth() - b.x)) + 'px';
      });
      var c = contentRight();
      var W = Math.max(wrap.clientWidth, c.r + 2 * M + 160);
      var H = Math.max(wrap.clientHeight - 60, c.b + 2 * M + Math.round(wrap.clientHeight * 0.5));
      stage.style.width = W + 'px'; stage.style.height = H + 'px';
      svg.setAttribute('width', W); svg.setAttribute('height', H); eng.size(W, H);
      drawSelection();
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
    function flushAll() { clearTimeout(mdTimer); boxes.forEach(function (b) { flushText(b.id); }); }
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
      layout();
    }

    function point(ev) {
      var r = stage.getBoundingClientRect();
      return [ev.clientX - r.left - M, ev.clientY - r.top - M, ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5];
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
    var drag = null, taps = [], panV = null;
    stage.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'pen') { penSeen = true; hooks.penSeen(); }
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
          stage.setPointerCapture(ev.pointerId);
          return;
        }
      }
      if (tool === 'select') { select(null); startPan(ev); return; }
      // Drawing tools. A pen draws even in Type mode; once a pen has been used, a finger scrolls instead.
      var inkTool = INK[tool] ? tool : (tool === 'type' && ev.pointerType === 'pen' && !onBox ? 'pen' : null);
      if (inkTool && !(isFinger && penSeen)) {
        if (eng.tool() !== inkTool) eng.setTool(inkTool);
        if (eng.down(p, ev)) {
          ev.preventDefault();
          if (document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
          drag = { type: 'ink', id: ev.pointerId, finger: isFinger };
          stage.setPointerCapture(ev.pointerId);
          return;
        }
      }
      if (onBox) { // typing, selecting text: leave it to the editor, but a finger drag over the text still scrolls
        if (isFinger && tool === 'type') startPan(ev);
        return;
      }
      // Empty space with the Type tool: double-tap adds a text box; a finger drag scrolls.
      if (tool === 'type') {
        var now = Date.now();
        taps = taps.filter(function (t) { return now - t.t < 400; });
        var last = taps[taps.length - 1];
        if (last && Math.abs(last.x - p[0]) < 30 && Math.abs(last.y - p[1]) < 30) {
          taps = []; ev.preventDefault(); clearTimeout(self._tapTimer);
          addBox(p[0] - 4, p[1] - 14); changed('layout');
          return;
        }
        taps.push({ t: now, x: p[0], y: p[1] });
        var pDown = p;
        clearTimeout(self._tapTimer);
        self._tapTimer = setTimeout(function () {
          // A single tap below the text puts the caret at the end of the note, like Keep.
          if (drag && drag.moved) return;
          var first = editors[boxes[0].id];
          if (first && pDown[1] > boxes[0].y + first.el.offsetHeight - 10 && pDown[0] < boxes[0].x + first.el.offsetWidth &&
            !boxes.some(function (b, i) { return i && pDown[1] > b.y - 20; })) first.ed.commands.focus('end');
        }, 380);
      }
      startPan(ev);
    });
    function startPan(ev) {
      if (ev.pointerType === 'mouse') return; // a mouse scrolls with its wheel
      drag = { type: 'pan', id: ev.pointerId, fingers: {}, lx: ev.clientX, ly: ev.clientY, moved: false, t: Date.now() };
      drag.fingers[ev.pointerId] = [ev.clientX, ev.clientY];
      if (panV) { cancelAnimationFrame(panV.raf); panV = null; }
    }
    stage.addEventListener('pointermove', function (ev) {
      if (!drag) { if (INK[tool]) eng.move(point(ev), ev); return; } // the eraser/nudge circle follows a hovering pen
      if (drag.type === 'ink') {
        if (ev.pointerId !== drag.id) return;
        var cev = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
        eng.move(point(ev), ev, (cev.length ? cev : [ev]).map(point));
        return;
      }
      if (drag.type === 'pan') {
        if (!(ev.pointerId in drag.fingers)) return;
        var prev = drag.fingers[ev.pointerId];
        var n = Object.keys(drag.fingers).length;
        var dx = (ev.clientX - prev[0]) / n, dy = (ev.clientY - prev[1]) / n;
        drag.fingers[ev.pointerId] = [ev.clientX, ev.clientY];
        if (Math.abs(dx) + Math.abs(dy) > 0) {
          drag.moved = drag.moved || Math.abs(ev.clientX - drag.lx) + Math.abs(ev.clientY - drag.ly) > 8;
          wrap.scrollLeft -= dx; wrap.scrollTop -= dy;
          var t = Date.now(); drag.vx = dx / Math.max(1, t - drag.t) * 16; drag.vy = dy / Math.max(1, t - drag.t) * 16; drag.t = t;
        }
        return;
      }
      if (ev.pointerId !== drag.id) return;
      if (drag.type === 'move') {
        drag.item.x = Math.max(0, drag.ox + ev.clientX - drag.sx);
        drag.item.y = Math.max(0, drag.oy + ev.clientY - drag.sy);
        layout();
      } else if (drag.type === 'resize') {
        drag.item.w = Math.max(120, (drag.ow || 200) + ev.clientX - drag.sx);
        layout();
      }
    });
    function endPointer(ev) {
      if (!drag) return;
      if (drag.type === 'pan') {
        delete drag.fingers[ev.pointerId];
        if (Object.keys(drag.fingers).length) return;
        var vx = drag.vx || 0, vy = drag.vy || 0;
        if (drag.moved) { taps = []; clearTimeout(self._tapTimer); }
        drag = null;
        if (Math.abs(vx) + Math.abs(vy) > 1) { // glide a little, like normal scrolling
          panV = { vx: vx, vy: vy };
          var step = function () {
            if (!panV) return;
            wrap.scrollLeft -= panV.vx; wrap.scrollTop -= panV.vy;
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
      if (d.type === 'ink') { eng.up(point(ev)); return; }
      if (d.type === 'move' || d.type === 'resize') {
        if (d.item.x !== d.ox || d.item.y !== d.oy || d.item.w !== d.ow) changed('layout');
      }
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', function (ev) { if (drag && drag.type === 'ink') { eng.cancel(); drag = null; } else endPointer(ev); });
    stage.addEventListener('pointerleave', function () { eng.leave(); });

    // ---- What the app can ask of the canvas ----
    self.setTool = function (t) {
      tool = t;
      stage.dataset.tool = t;
      if (t !== 'select') select(null);
      if (INK[t]) eng.setTool(t); else eng.clearSelection();
      if (t !== 'type' && document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
    };
    self.ink = function () { return eng; };
    self.tool = function () { return tool; };
    self.penSeen = function () { return penSeen; };
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
      var o = JSON.parse(s);
      boxes.length = 0; o.boxes.forEach(function (b) { boxes.push(b); });
      ink.length = 0; o.ink.forEach(function (g) { ink.push(g); });
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
        wrap.scrollTo({ left: Math.max(0, b.x - 40), top: Math.max(0, b.y - 80), behavior: 'smooth' });
        changed('layout'); return;
      }
      boxes.forEach(function (b) { b.x += dx; b.y += dy; });
      eng.shift(dx, dy); changed('layout');
    };
    // An image: at the caret, beside the text (both side by side), or in a new text box below.
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
      var right = b.x + M + (b.w || 0) > wrap.scrollLeft + wrap.clientWidth;
      if (right || where !== 'beside') wrap.scrollTo({ left: right ? Math.max(0, b.x - 40) : wrap.scrollLeft, top: Math.max(0, b.y - 80), behavior: 'smooth' });
    };
    self.focusStart = function () { var f = editors[boxes[0].id]; if (f) f.ed.commands.focus('end'); };
    self.destroy = function () {
      flushAll();
      Object.keys(editors).forEach(function (id) { editors[id].ed.destroy(); });
      editors = {}; host.innerHTML = ''; if (self._unbind) self._unbind();
    };
    self.relayout = layout;

    stage.dataset.tool = tool;
    stage.addEventListener('load', function () { requestAnimationFrame(layout); }, true); // images change a box's height
    renderAll();
    window.addEventListener('resize', layout);
    self._unbind = function () { window.removeEventListener('resize', layout); };
  }

  window.QNCanvas = { NoteCanvas: NoteCanvas, inkSvg: function (ink, w, h) { return window.QNInk.thumb(ink, w, h); } };
})();
