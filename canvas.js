// Quick Notes: the note canvas. Text boxes (rich text, saved as Markdown) and ink, placed anywhere.
// The page starts like Keep: one text box at the top left. Double-tap empty space for another text box,
// draw with the pen (an S Pen draws without switching tools), and move things with the Move tool.
(function () {
  'use strict';
  var M = 16;                 // margin around the content
  var HIT = 14;               // how close (px) a tap must be to a stroke to pick it
  var LIB = function () { return window.QNLib; };

  function el(tag, cls, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- Ink drawing helpers (also used for the previews on the notes grid) ----------
  function strokePath(s) {
    var pts = s.p;
    if (!pts.length) return '';
    var outline = LIB().getStroke(pts, {
      size: s.s * (s.h ? 3 : 1.6), thinning: s.h ? 0 : (s.f ? 0.55 : 0.35), smoothing: 0.5, streamline: 0.45,
      simulatePressure: !s.f, last: true
    });
    if (!outline.length) return '';
    var d = 'M' + outline[0][0].toFixed(1) + ' ' + outline[0][1].toFixed(1);
    for (var i = 1; i < outline.length; i++) d += 'L' + outline[i][0].toFixed(1) + ' ' + outline[i][1].toFixed(1);
    return d + 'Z';
  }
  function color(c) { return !c || c === 'ink' ? 'var(--ink)' : c; }
  function groupBox(g) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    g.strokes.forEach(function (s) {
      var pad = s.s * (s.h ? 1.6 : 1);
      s.p.forEach(function (p) { x0 = Math.min(x0, p[0] - pad); y0 = Math.min(y0, p[1] - pad); x1 = Math.max(x1, p[0] + pad); y1 = Math.max(y1, p[1] + pad); });
    });
    if (x0 === Infinity) return { x: g.x, y: g.y, w: 0, h: 0 };
    return { x: g.x + x0, y: g.y + y0, w: x1 - x0, h: y1 - y0 };
  }
  function inkSvg(ink, maxW, maxH) {
    if (!ink || !ink.length) return '';
    var b = null;
    ink.forEach(function (g) {
      var r = groupBox(g);
      if (!b) b = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
      else { b.x0 = Math.min(b.x0, r.x); b.y0 = Math.min(b.y0, r.y); b.x1 = Math.max(b.x1, r.x + r.w); b.y1 = Math.max(b.y1, r.y + r.h); }
    });
    var w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    var scale = Math.min(1, maxW / w, maxH / h);
    var paths = ink.map(function (g) {
      return '<g transform="translate(' + (g.x - b.x0) + ' ' + (g.y - b.y0) + ')">' + g.strokes.map(function (s) {
        return '<path d="' + strokePath(s) + '" fill="' + color(s.c) + '"' + (s.h ? ' opacity="0.35"' : '') + '/>';
      }).join('') + '</g>';
    }).join('');
    return '<svg class="ink-thumb" width="' + Math.round(w * scale) + '" height="' + Math.round(h * scale) + '" viewBox="0 0 ' + w + ' ' + h + '">' + paths + '</svg>';
  }

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

    var boxes = note.boxes, ink = note.ink;
    var editors = {};          // box id -> { el, ed }
    var tool = 'type', pen = { c: 'ink', s: 3 }, penSeen = false;
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
      ink.forEach(function (g) { var q = groupBox(g); r = Math.max(r, q.x + q.w); b = Math.max(b, q.y + q.h); });
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
      svg.setAttribute('width', W); svg.setAttribute('height', H);
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
      var ed = LIB().makeEditor(mount, b.md, {
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
      var md = LIB().getMarkdown(e.ed);
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
      drawInk();
      layout();
    }

    // ---- Ink ----
    function drawInk() {
      svg.innerHTML = ink.map(function (g) {
        return '<g data-g="' + g.id + '" transform="translate(' + (g.x + M) + ' ' + (g.y + M) + ')">' + g.strokes.map(function (s, i) {
          return '<path data-s="' + i + '" d="' + strokePath(s) + '" fill="' + color(s.c) + '"' + (s.h ? ' opacity="0.35"' : '') + '/>';
        }).join('') + '</g>';
      }).join('');
    }
    function point(ev) {
      var r = stage.getBoundingClientRect();
      return [ev.clientX - r.left - M, ev.clientY - r.top - M, ev.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5];
    }
    function hitStroke(x, y, r) {
      for (var gi = ink.length - 1; gi >= 0; gi--) {
        var g = ink[gi];
        for (var si = g.strokes.length - 1; si >= 0; si--) {
          var s = g.strokes[si], rr = r + s.s;
          for (var k = 0; k < s.p.length; k++) {
            var dx = s.p[k][0] + g.x - x, dy = s.p[k][1] + g.y - y;
            if (dx * dx + dy * dy <= rr * rr) return { g: gi, s: si };
            if (k) { // between points
              var ax = s.p[k - 1][0] + g.x, ay = s.p[k - 1][1] + g.y, bx = s.p[k][0] + g.x, by = s.p[k][1] + g.y;
              var L = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
              if (L > 0) {
                var t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L));
                var px = ax + t * (bx - ax) - x, py = ay + t * (by - ay) - y;
                if (px * px + py * py <= rr * rr) return { g: gi, s: si };
              }
            }
          }
        }
      }
      return null;
    }
    function addStroke(s) {
      var x0 = Infinity, y0 = Infinity;
      s.p.forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); });
      // Strokes drawn close together form one drawing that moves as a whole (a word, a sketch).
      var start = s.p[0], target = null;
      for (var i = ink.length - 1; i >= 0; i--) {
        var q = groupBox(ink[i]);
        if (start[0] >= q.x - 48 && start[0] <= q.x + q.w + 48 && start[1] >= q.y - 40 && start[1] <= q.y + q.h + 40) { target = ink[i]; break; }
      }
      if (!target) { target = { id: 'g' + window.Notes.shortId(), x: Math.max(0, x0), y: Math.max(0, y0), strokes: [] }; ink.push(target); }
      s.p = s.p.map(function (p) { return [p[0] - target.x, p[1] - target.y, p[2]]; });
      target.strokes.push(s);
    }

    // ---- Selection (Move tool) ----
    function itemRect(sel) {
      if (!sel) return null;
      if (sel.kind === 'box') {
        var b = boxes.filter(function (x) { return x.id === sel.id; })[0], e = editors[sel.id];
        return b && e ? { x: b.x, y: b.y, w: e.el.offsetWidth, h: e.el.offsetHeight } : null;
      }
      var g = ink.filter(function (x) { return x.id === sel.id; })[0];
      return g ? groupBox(g) : null;
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
      if (selected.kind === 'box') removeBox(selected.id);
      else { ink = ink.filter(function (g) { return g.id !== selected.id; }); note.ink = ink; select(null); drawInk(); changed('ink'); }
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
      if (drag && drag.type === 'stroke' && isFinger && drag.finger) { cancelStroke(); }
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
      if (tool === 'select') {
        var hit = hitStroke(p[0], p[1], HIT);
        if (hit) {
          var g = ink[hit.g];
          select({ kind: 'ink', id: g.id });
          drag = { type: 'move', item: g, sx: ev.clientX, sy: ev.clientY, ox: g.x, oy: g.y, id: ev.pointerId };
          stage.setPointerCapture(ev.pointerId); ev.preventDefault();
          return;
        }
        select(null);
        startPan(ev); return;
      }
      var drawing = tool === 'pen' || tool === 'highlighter' ? !(isFinger && penSeen) : (tool === 'type' && ev.pointerType === 'pen' && !onBox);
      if (tool === 'eraser' && !(isFinger && penSeen)) {
        drag = { type: 'erase', id: ev.pointerId, any: false };
        stage.setPointerCapture(ev.pointerId); ev.preventDefault();
        erase(p); return;
      }
      if (drawing) {
        ev.preventDefault();
        if (document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
        var hl = tool === 'highlighter';
        var s = { c: hl ? (pen.hc || '#f2c94c') : pen.c, s: hl ? 6 : pen.s, p: [p] };
        if (hl) s.h = 1;
        if (ev.pointerType === 'pen') s.f = 1;
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', color(s.c)); if (hl) path.setAttribute('opacity', '0.35');
        path.setAttribute('transform', 'translate(' + M + ' ' + M + ')');
        svg.appendChild(path);
        drag = { type: 'stroke', s: s, path: path, id: ev.pointerId, finger: isFinger };
        stage.setPointerCapture(ev.pointerId);
        return;
      }
      if (onBox) return; // typing, selecting text: leave it to the editor
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
    function cancelStroke() { if (drag && drag.path) drag.path.remove(); drag = null; }
    function erase(p) {
      var hit = hitStroke(p[0], p[1], 10);
      if (!hit) return;
      ink[hit.g].strokes.splice(hit.s, 1);
      if (!ink[hit.g].strokes.length) ink.splice(hit.g, 1);
      drag.any = true; drawInk();
    }
    stage.addEventListener('pointermove', function (ev) {
      if (!drag) return;
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
      if (drag.type === 'stroke') {
        var evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
        (evs.length ? evs : [ev]).forEach(function (e) { drag.s.p.push(point(e)); });
        drag.path.setAttribute('d', strokePath(drag.s));
      } else if (drag.type === 'erase') {
        erase(point(ev));
      } else if (drag.type === 'move') {
        drag.item.x = Math.max(0, drag.ox + ev.clientX - drag.sx);
        drag.item.y = Math.max(0, drag.oy + ev.clientY - drag.sy);
        if (drag.item.strokes) drawInk();
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
      if (d.type === 'stroke') {
        d.path.remove();
        if (d.s.p.length === 1) d.s.p.push([d.s.p[0][0] + 0.5, d.s.p[0][1] + 0.5, d.s.p[0][2]]); // a dot
        addStroke(d.s); drawInk(); changed('ink');
      } else if (d.type === 'erase') {
        if (d.any) changed('ink');
      } else if (d.type === 'move' || d.type === 'resize') {
        if (d.item.x !== d.ox || d.item.y !== d.oy || d.item.w !== d.ow) changed('layout');
      }
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', function (ev) { if (drag && drag.type === 'stroke') cancelStroke(); else endPointer(ev); });

    // ---- What the app can ask of the canvas ----
    self.setTool = function (t) {
      tool = t;
      stage.dataset.tool = t;
      if (t !== 'select') select(null);
      if (t !== 'type' && document.activeElement && stage.contains(document.activeElement)) document.activeElement.blur();
    };
    self.setPen = function (p) { Object.assign(pen, p); };
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
      select(null); active = null; renderAll();
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
      ink.forEach(function (g) { g.x += dx; g.y += dy; });
      drawInk(); changed('layout');
    };
    self.focusStart = function () { var f = editors[boxes[0].id]; if (f) f.ed.commands.focus('end'); };
    self.destroy = function () {
      flushAll();
      Object.keys(editors).forEach(function (id) { editors[id].ed.destroy(); });
      editors = {}; host.innerHTML = ''; if (self._unbind) self._unbind();
    };
    self.relayout = layout;

    stage.dataset.tool = tool;
    renderAll();
    window.addEventListener('resize', layout);
    self._unbind = function () { window.removeEventListener('resize', layout); };
  }

  window.QNCanvas = { NoteCanvas: NoteCanvas, inkSvg: inkSvg, strokePath: strokePath };
})();
