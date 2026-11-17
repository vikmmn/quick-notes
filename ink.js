// Quick Notes: the drawing engine. Layers of vector strokes and fills, drawn as SVG.
//
// A note's drawing is a list of layers, bottom first:
//   { id, name, vis, lock, op (opacity 0–1), blend ('normal', 'multiply'…), clip (masked by the layer below), items: [...] }
// Items, bottom first, in note coordinates:
//   stroke { id, t: 's', b: brush, c: colour, s: size, o: opacity, f: 1 if drawn with a pen (real pressure), st: smoothing 0–1 (optional),
//            th: how much pressure thins the line 0–1 (optional), g: group id, p: [[x, y, pressure], …] }
//   fill   { id, t: 'f', c, o, g, d: [[[x, y], …], …] }   (one or more closed outlines)
// Saved inside the note's Markdown file as <!-- qn:ink {"v":2,"layers":[…]} -->.
// Older notes (groups of strokes, positions relative to the group) are converted when they are opened.
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var LIB = function () { return window.QNLib; };

  // ---------- Brushes ----------
  var BRUSH = {
    pen:         { label: 'Pen',         size: 1.6, thin: 0.45, smooth: 0.5,  stream: 0.45 },
    pencil:      { label: 'Pencil',      size: 1.1, thin: 0.2,  smooth: 0.35, stream: 0.3, grain: true },
    marker:      { label: 'Marker',      size: 2.4, thin: 0,    smooth: 0.6,  stream: 0.5 },
    brush:       { label: 'Brush',       size: 2.8, thin: 0.75, smooth: 0.62, stream: 0.5, taper: true },
    highlighter: { label: 'Highlighter', size: 4.2, thin: 0,    smooth: 0.6,  stream: 0.5, blend: 'multiply' }
  };
  var BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-burn', 'color-dodge', 'difference'];

  function uid(p) { return (p || 'i') + Math.random().toString(36).slice(2, 9); }
  function newLayer(name) { return { id: uid('L'), name: name || 'Layer 1', vis: true, lock: false, op: 1, blend: 'normal', clip: false, items: [] }; }
  function colorOf(c) { return !c || c === 'ink' ? 'var(--ink)' : c; }
  function widthOf(it) { return (it.s || 3) * ((BRUSH[it.b] || BRUSH.pen).size); }

  // ---------- Reading and saving ----------
  function normalize(raw) {
    if (raw && !Array.isArray(raw) && raw.layers) raw = raw.layers;
    if (!Array.isArray(raw) || !raw.length) return [newLayer()];
    if (raw[0] && raw[0].items) {
      return raw.map(function (l, i) {
        return { id: l.id || uid('L'), name: l.name || 'Layer ' + (i + 1), vis: l.vis !== false, lock: !!l.lock, op: l.op == null ? 1 : +l.op,
          blend: l.blend || 'normal', clip: !!l.clip, gid: l.gid || undefined, gname: l.gname || undefined, items: (l.items || []).filter(function (it) { return it && (it.t === 'f' ? it.d && it.d.length : it.p && it.p.length); }) };
      });
    }
    // Version 1: groups of strokes, each placed at the group's position.
    var L = newLayer();
    raw.forEach(function (g) {
      var gid = g.strokes && g.strokes.length > 1 ? g.id : null;
      (g.strokes || []).forEach(function (s) {
        var it = { id: uid('s'), t: 's', b: s.h ? 'highlighter' : 'pen', c: s.c, s: s.s, o: s.h ? 0.35 : 1,
          p: s.p.map(function (q) { return [q[0] + (g.x || 0), q[1] + (g.y || 0), q[2] == null ? 0.5 : q[2]]; }) };
        if (s.h) it.s = s.s * 3 / BRUSH.highlighter.size;
        if (s.f) it.f = 1;
        if (gid) it.g = gid;
        L.items.push(it);
      });
    });
    return [L];
  }
  function hasInk(layers) { return Array.isArray(layers) && layers.some(function (l) { return l.items && l.items.length; }); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function toJSON(layers) {
    return { v: 2, layers: layers.map(function (l) {
      var o = { id: l.id, name: l.name, items: l.items.map(function (it) {
        var x = { id: it.id, t: it.t, c: it.c };
        if (it.o != null && it.o !== 1) x.o = Math.round(it.o * 100) / 100;
        if (it.g) x.g = it.g;
        if (it.t === 'f') x.d = it.d.map(function (ring) { return ring.map(function (q) { return [r1(q[0]), r1(q[1])]; }); });
        else {
          x.b = it.b; x.s = r1(it.s);
          if (it.f) x.f = 1;
          if (it.st != null) x.st = Math.round(it.st * 100) / 100;
          if (it.th != null) x.th = Math.round(it.th * 100) / 100;
          // Each point: x, y, width (pressure, after the pen's pressure and tilt settings), and, when the pen's pressure or
          // tilt changes how strong the ink is, a fourth number: the ink's strength there (0–1).
          x.p = it.p.map(function (q) { var o = [r1(q[0]), r1(q[1]), Math.round((q[2] == null ? 0.5 : q[2]) * 100) / 100]; if (q[3] != null) o.push(Math.round(q[3] * 100) / 100); return o; });
        }
        return x;
      }) };
      if (!l.vis) o.vis = false;
      if (l.lock) o.lock = true;
      if (l.op !== 1) o.op = Math.round(l.op * 100) / 100;
      if (l.blend && l.blend !== 'normal') o.blend = l.blend;
      if (l.clip) o.clip = true;
      if (l.gid) { o.gid = l.gid; o.gname = l.gname || 'Group'; }
      return o;
    }) };
  }

  // ---------- Drawing ----------
  var cache = new WeakMap(), boxCache = new WeakMap();
  function invalidate(it) { cache.delete(it); boxCache.delete(it); }
  // The outline of a stroke (perfect-freehand), for the saved drawing and for the live stroke while drawing.
  function outline(it, pts, last) {
    var B = BRUSH[it.b] || BRUSH.pen;
    return pts.length ? LIB().getStroke(pts, {
      size: widthOf(it), thinning: it.f ? (it.th != null ? it.th : Math.min(0.7, B.thin + 0.1)) : B.thin, smoothing: B.smooth, streamline: it.st != null ? it.st : B.stream,
      simulatePressure: !it.f && B.thin > 0, last: last,
      start: B.taper ? { taper: widthOf(it) * 3 } : undefined, end: B.taper ? { taper: widthOf(it) * 4 } : undefined
    }) : [];
  }
  function itemD(it) {
    var d = cache.get(it);
    if (d != null) return d;
    if (it.t === 'f') {
      d = it.d.map(function (ring) {
        return 'M' + ring.map(function (q) { return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + 'Z';
      }).join('');
    } else {
      var out = outline(it, it.p, true);
      if (!out.length) d = '';
      else {
        d = 'M' + out[0][0].toFixed(1) + ' ' + out[0][1].toFixed(1);
        for (var i = 1; i < out.length; i++) d += 'L' + out[i][0].toFixed(1) + ' ' + out[i][1].toFixed(1);
        d += 'Z';
      }
    }
    cache.set(it, d);
    return d;
  }
  function hasFade(it) { return it.t !== 'f' && it.p && it.p.some(function (q) { return q[3] != null && q[3] < 0.99; }); }
  // A stroke whose ink gets lighter and stronger along the way (pressure or tilt on opacity): the whole line, seen
  // through a mask made of short pieces, each as strong as the ink there. The pieces overlap; "lighten" keeps the
  // overlaps from showing as darker seams.
  function fadeMask(it) {
    var pts = it.p, n = pts.length, step = Math.max(2, Math.round(n / 90)), parts = '';
    for (var i = 0; i < n - 1; i += step) {
      var seg = pts.slice(i, Math.min(n, i + step + 2)), a = 0;
      seg.forEach(function (q) { a += q[3] == null ? 1 : q[3]; }); a /= seg.length;
      var out = outline(it, seg, true); if (!out.length) continue;
      var v = Math.round(255 * Math.max(0, Math.min(1, a)));
      parts += '<path d="M' + out.map(function (q) { return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + 'Z" fill="rgb(' + v + ',' + v + ',' + v + ')"/>';
    }
    return '<mask id="pm-' + it.id + '" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><g style="mix-blend-mode:lighten;isolation:isolate">' + parts + '</g></mask>';
  }
  function itemSvg(it, plain) {
    var B = plain ? {} : BRUSH[it.b] || {};
    var o = it.o == null ? 1 : it.o, fade = !plain && hasFade(it);
    var path = '<path' + (fade ? '' : ' data-i="' + it.id + '"') + ' d="' + itemD(it) + '" fill="' + colorOf(it.c) + '"' +
      (it.t === 'f' ? ' fill-rule="evenodd"' : '') + (o !== 1 ? ' fill-opacity="' + o + '"' : '') + (fade ? ' mask="url(#pm-' + it.id + ')"' : '') +
      (B.grain ? ' filter="url(#qn-grain)"' : '') + (B.blend ? ' style="mix-blend-mode:' + B.blend + '"' : '') + '/>';
    return fade ? '<g data-i="' + it.id + '">' + fadeMask(it) + path + '</g>' : path;
  }
  function layerSvg(l, below, prefix, plain) {
    var st = 'opacity:' + l.op + ';' + (l.blend && l.blend !== 'normal' ? 'mix-blend-mode:' + l.blend + ';' : '') + 'isolation:isolate';
    var mask = l.clip && below ? ' mask="url(#' + prefix + 'm-' + l.id + ')"' : '';
    return '<g id="' + prefix + 'L-' + l.id + '" data-l="' + l.id + '" style="' + st + '"' + mask + (l.vis ? '' : ' display="none"') + '>' +
      l.items.map(function (it) { return itemSvg(it, plain); }).join('') + '</g>';
  }
  function defsSvg(layers, prefix) {
    var masks = '';
    layers.forEach(function (l, i) {
      var below = layers[i - 1];
      if (l.clip && below) masks += '<mask id="' + prefix + 'm-' + l.id + '" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><use href="#' + prefix + 'L-' + below.id + '"/></mask>';
    });
    return '<defs><filter id="qn-grain" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="3" result="n"/>' +
      '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.35" result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/></filter>' + masks + '</defs>';
  }
  function markup(layers, prefix, dx, dy, plain) {
    return defsSvg(layers, prefix) + '<g transform="translate(' + dx + ' ' + dy + ')">' +
      layers.map(function (l, i) { return layerSvg(l, layers[i - 1], prefix, plain); }).join('') + '</g>';
  }

  // ---------- Geometry ----------
  function itemBox(it) {
    var cached = boxCache.get(it);
    if (cached) return cached;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pad = it.t === 'f' ? 0 : widthOf(it) / 2;
    var each = function (q) { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] > x1) x1 = q[0]; if (q[1] > y1) y1 = q[1]; };
    if (it.t === 'f') it.d.forEach(function (ring) { ring.forEach(each); }); else it.p.forEach(each);
    var r = x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
    boxCache.set(it, r);
    return r;
  }
  function unionBox(list) {
    var b = null;
    list.forEach(function (it) {
      var r = itemBox(it);
      if (!b) b = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
      else { b.x0 = Math.min(b.x0, r.x); b.y0 = Math.min(b.y0, r.y); b.x1 = Math.max(b.x1, r.x + r.w); b.y1 = Math.max(b.y1, r.y + r.h); }
    });
    return b ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
  }
  function segDist(px, py, ax, ay, bx, by) {
    var L = (bx - ax) * (bx - ax) + (by - ay) * (by - ay), t = L ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L)) : 0;
    var dx = ax + t * (bx - ax) - px, dy = ay + t * (by - ay) - py;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function inPoly(x, y, ring) {
    var c = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function hits(it, x, y, r) {
    var bb = itemBox(it);
    if (x < bb.x - r || y < bb.y - r || x > bb.x + bb.w + r || y > bb.y + bb.h + r) return false;
    if (it.t === 'f') return it.d.some(function (ring) { return inPoly(x, y, ring); });
    var w = widthOf(it) / 2 + r, p = it.p;
    if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= w;
    for (var i = 1; i < p.length; i++) if (segDist(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= w) return true;
    return false;
  }
  // Adds points on segments near (x, y), so cuts and nudges are smooth and precise.
  function densify(p, x, y, R, step) {
    var out = [p[0]];
    for (var i = 1; i < p.length; i++) {
      var a = p[i - 1], b = p[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > step && segDist(x, y, a[0], a[1], b[0], b[1]) <= R) {
        var n = Math.ceil(len / step);
        for (var k = 1; k < n; k++) { var t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + ((b[2] || 0.5) - (a[2] || 0.5)) * t]); }
      }
      out.push(b);
    }
    return out;
  }
  // The slicer: removes the part of a stroke under the eraser, leaving the rest as separate strokes.
  function slice(it, x, y, r) {
    var R = r + widthOf(it) * 0.25;
    var p = densify(it.p, x, y, R + 4, 1.5), pieces = [], cur = [], cut = false;
    p.forEach(function (q) {
      if (Math.hypot(q[0] - x, q[1] - y) <= R) { cut = true; if (cur.length) pieces.push(cur); cur = []; }
      else cur.push(q);
    });
    if (cur.length) pieces.push(cur);
    if (!cut) return null;
    return pieces.filter(function (pp) { return pp.length > 1; }).map(function (pp) {
      var c = JSON.parse(JSON.stringify(it)); c.id = uid('s'); c.p = pp; return c;
    });
  }
  function eachPoint(it, fn) { if (it.t === 'f') it.d.forEach(function (ring) { ring.forEach(fn); }); else it.p.forEach(fn); }
  function nudge(it, x, y, dx, dy, R, k) {
    if (it.t !== 'f') it.p = densify(it.p, x, y, R, Math.max(2, R / 10));
    var moved = false;
    eachPoint(it, function (q) {
      var d = Math.hypot(q[0] - x, q[1] - y);
      if (d < R) { var w = Math.pow(1 - d / R, 2) * k; q[0] += dx * w; q[1] += dy * w; moved = true; }
    });
    if (moved) invalidate(it);
    return moved;
  }
  function smooth(it, x, y, R, k) {
    var moved = false;
    var run = function (ring, closed) {
      var n = ring.length, copy = ring.map(function (q) { return [q[0], q[1]]; });
      for (var i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) continue;
        var q = ring[i], d = Math.hypot(q[0] - x, q[1] - y);
        if (d >= R) continue;
        var a = copy[(i - 1 + n) % n], b = copy[(i + 1) % n], w = Math.pow(1 - d / R, 2) * k * 0.6;
        q[0] += ((a[0] + b[0]) / 2 - q[0]) * w; q[1] += ((a[1] + b[1]) / 2 - q[1]) * w; moved = true;
      }
    };
    if (it.t === 'f') it.d.forEach(function (ring) { run(ring, true); }); else run(it.p, false);
    if (moved) invalidate(it);
    return moved;
  }
  function simplify(pts, eps) { // Ramer–Douglas–Peucker
    if (pts.length < 3) return pts;
    var keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var s = stack.pop(), a = s[0], b = s[1], best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) { var d = segDist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]); if (d > best) { best = d; bi = i; } }
      if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter(function (q, i) { return keep[i]; });
  }

  // ---------- Filling a closed area (tap inside lines) ----------
  // Draws the visible strokes into a hidden picture of the area on screen, floods out from the tap, and turns the
  // flooded shape into a vector outline. Returns null when the area isn't closed (the flood reaches the screen's edge).
  function floodOutline(layers, view, x, y) {
    var scale = Math.min(1, 1800 / Math.max(view.w, view.h));
    var W = Math.max(8, Math.round(view.w * scale)), H = Math.max(8, Math.round(view.h * scale));
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale);
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2 / scale; ctx.lineJoin = 'round';
    layers.forEach(function (l) {
      if (!l.vis) return;
      l.items.forEach(function (it) { if (it.t !== 'f') { var path = new Path2D(itemD(it)); ctx.fill(path); ctx.stroke(path); } });
    });
    var data = ctx.getImageData(0, 0, W, H).data;
    var sx = Math.round((x - view.x) * scale), sy = Math.round((y - view.y) * scale);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
    var wall = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) wall[i] = data[i * 4 + 3] > 40 ? 1 : 0;
    if (wall[sy * W + sx]) return null; // tapped on a line
    var mask = new Uint8Array(W * H), stack = [sy * W + sx], edge = false;
    mask[sy * W + sx] = 1;
    while (stack.length) {
      var k = stack.pop(), px = k % W, py = (k - px) / W;
      if (px === 0 || py === 0 || px === W - 1 || py === H - 1) { edge = true; break; }
      var nb = [k - 1, k + 1, k - W, k + W];
      for (var j = 0; j < 4; j++) { var q = nb[j]; if (!mask[q] && !wall[q]) { mask[q] = 1; stack.push(q); } }
    }
    if (edge) return null;
    // Grow by a couple of pixels so the colour tucks under the lines around it.
    for (var pass = 0; pass < 2; pass++) {
      var grown = mask.slice();
      for (var yy = 1; yy < H - 1; yy++) for (var xx = 1; xx < W - 1; xx++) {
        var o = yy * W + xx;
        if (!mask[o] && (mask[o - 1] || mask[o + 1] || mask[o - W] || mask[o + W])) grown[o] = 1;
      }
      mask = grown;
    }
    var ring = trace(mask, W, H);
    if (!ring || ring.length < 3) return null;
    ring = simplify(ring.map(function (q) { return [q[0] / scale + view.x, q[1] / scale + view.y]; }), 0.6 / scale);
    return [ring];
  }
  // Moore-neighbour tracing of the outer edge of the shape in the mask.
  function trace(mask, W, H) {
    var start = -1;
    for (var i = 0; i < W * H; i++) if (mask[i]) { start = i; break; }
    if (start < 0) return null;
    var D = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    var at = function (x, y) { return x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x]; };
    var sx = start % W, sy = (start - sx) / W, cx = sx, cy = sy, back = 0, out = [[sx, sy]], second = null;
    for (var guard = 0; guard < W * H * 4; guard++) {
      var found = false;
      for (var s = 1; s <= 8; s++) {
        var d = (back + s) % 8, nx = cx + D[d][0], ny = cy + D[d][1];
        if (at(nx, ny)) {
          var bx = cx + D[(d + 7) % 8][0], by = cy + D[(d + 7) % 8][1];
          cx = nx; cy = ny;
          for (var t = 0; t < 8; t++) if (cx + D[t][0] === bx && cy + D[t][1] === by) { back = t; break; }
          found = true; break;
        }
      }
      if (!found) break; // a single pixel
      if (cx === sx && cy === sy) break;
      if (!second) second = [cx, cy];
      out.push([cx, cy]);
    }
    return out;
  }

  // ---------- Preview pictures (notes grid, version history) ----------
  var thumbN = 0;
  function thumb(raw, maxW, maxH) {
    var layers = normalize(raw);
    var all = []; layers.forEach(function (l) { if (l.vis) all = all.concat(l.items); });
    var b = unionBox(all);
    if (!b) return '';
    var w = Math.max(1, b.w), h = Math.max(1, b.h), sc = Math.min(1, maxW / w, maxH / h);
    return '<svg class="ink-thumb" width="' + Math.round(w * sc) + '" height="' + Math.round(h * sc) + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      markup(layers, 't' + (++thumbN) + '-', -b.x, -b.y, true) + '</svg>';
  }

  // ---------- The engine: tools working on one note's layers ----------
  function Engine(o) {
    var self = this;
    var layers = o.layers;           // the note's own array (kept, changed in place)
    var svg = o.svg, stage = o.stage, M = o.margin;
    var ui = document.createElementNS(NS, 'svg'); ui.setAttribute('class', 'ink-ui'); stage.appendChild(ui);
    var bar = document.createElement('div'); bar.className = 'inkbar hidden'; (o.uiHost || stage).appendChild(bar);
    // Handles, tool circles and tap distances stay the same size on screen at any zoom.
    function Z() { return o.zoom ? o.zoom() : 1; }
    var tool = 'pen', opt = { pen: { b: 'pen', c: 'ink', s: 3, o: 1 }, erase: { m: 'stroke', s: 14 }, nudge: { m: 'nudge', r: 48, k: 0.8 }, fill: { m: 'tap', c: '#f2c94c', o: 1 } };
    var activeId = layers[layers.length - 1].id;
    var drag = null, sel = null, raf = 0;

    function active() { return layers.filter(function (l) { return l.id === activeId; })[0] || layers[layers.length - 1]; }
    function editable(l) { return l.vis && !l.lock; }
    function render() { cancelAnimationFrame(raf); raf = 0; pending = []; svg.innerHTML = markup(layers, 'c-', M, M); drawUi(); }
    function soon() { if (!raf) raf = requestAnimationFrame(render); }
    // Undo keeps earlier versions of the drawing by reference (no copies), so an item is never changed in place once
    // it has been saved in a version: the first change in a gesture swaps in a copy (own), and every change that is
    // recorded (commit) starts afresh.
    var owned = new WeakSet();
    function own(it) {
      if (owned.has(it)) return it;
      var l = layerOf(it); if (!l) return it;
      var c = JSON.parse(JSON.stringify(it));
      l.items[l.items.indexOf(it)] = c; owned.add(c);
      if (sel) { var k = sel.items.indexOf(it); if (k > -1) sel.items[k] = c; }
      return c;
    }
    function commit(kind) { o.changed(kind || 'ink'); owned = new WeakSet(); }
    function done(kind) { render(); commit(kind); }
    function layerOf(it) { for (var i = 0; i < layers.length; i++) if (layers[i].items.indexOf(it) > -1) return layers[i]; return null; }

    // ---- Changing only what changed, instead of redrawing the whole drawing ----
    function elOf(it) { return svg.querySelector('[data-i="' + it.id + '"]'); }
    function groupOf(l) { return svg.querySelector('[data-l="' + l.id + '"]'); }
    var pending = [], patchRaf = 0;
    function patch(items) { items.forEach(function (it) { if (pending.indexOf(it) < 0) pending.push(it); }); if (!patchRaf) patchRaf = requestAnimationFrame(flushPatch); }
    function flushPatch() {
      cancelAnimationFrame(patchRaf); patchRaf = 0;
      var list = pending; pending = [];
      list.forEach(function (it) {
        var e = elOf(it); if (!e) return;
        if (e.tagName.toLowerCase() === 'g') { e.insertAdjacentHTML('afterend', itemSvg(it)); e.remove(); } // a fading stroke: its mask moves too
        else e.setAttribute('d', itemD(it));
      });
      drawUi();
    }
    function addEl(l, it) { var g = groupOf(l); if (g) g.insertAdjacentHTML('beforeend', itemSvg(it)); else soon(); }

    // ---- The stroke being drawn: painted on a low-latency canvas over the page, one frame at a time ----
    var host = o.uiHost || stage;
    var live = document.createElement('canvas'); live.className = 'ink-live'; host.appendChild(live);
    // A plain canvas: a "desynchronized" (low-latency) one shows as solid black over the page on some Android
    // tablets (3.4.0 on a Galaxy Tab S6 Lite). It is only shown while a stroke is being drawn.
    var lctx = live.getContext('2d'), liveRaf = 0;
    live.style.display = 'none';
    function inkColor(c) {
      if (c && c !== 'ink') return c;
      return getComputedStyle(svg).getPropertyValue('--ink').trim() || '#202124';
    }
    function startLive(d) {
      var dpr = Math.min(3, window.devicePixelRatio || 1), W = host.clientWidth, H = host.clientHeight;
      if (live.width !== Math.round(W * dpr) || live.height !== Math.round(H * dpr)) {
        live.width = Math.round(W * dpr); live.height = Math.round(H * dpr);
        live.style.width = W + 'px'; live.style.height = H + 'px';
      }
      // The view as a matrix (page → screen), so the stroke is drawn at the right place, size and turn.
      var a = o.toScreen(0, 0), bx = o.toScreen(1, 0), by = o.toScreen(0, 1);
      d.m = [dpr * (bx[0] - a[0]), dpr * (bx[1] - a[1]), dpr * (by[0] - a[0]), dpr * (by[1] - a[1]), dpr * a[0], dpr * a[1]];
      var B = BRUSH[d.stroke.b] || {};
      d.color = inkColor(d.stroke.c);
      d.alpha = (d.stroke.o == null ? 1 : d.stroke.o) * (d.layer.op == null ? 1 : d.layer.op) * (B.grain ? 0.88 : 1);
      live.style.mixBlendMode = B.blend || d.layer.blend !== 'normal' && d.layer.blend || '';
      clearLive();
    }
    function clearLive() { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height); live.style.display = 'none'; }
    function drawLive() {
      liveRaf = 0;
      var d = drag; if (!d || !d.stroke) return;
      var it = d.stroke, pts = d.pred && d.pred.length ? it.p.concat(d.pred) : it.p;
      var out = outline(it, pts, false);
      clearLive();
      if (!out.length) return;
      lctx.setTransform(d.m[0], d.m[1], d.m[2], d.m[3], d.m[4], d.m[5]);
      lctx.beginPath(); lctx.moveTo(out[0][0], out[0][1]);
      for (var i = 1; i < out.length; i++) lctx.lineTo(out[i][0], out[i][1]);
      lctx.closePath();
      lctx.globalAlpha = d.alpha; lctx.fillStyle = d.color; lctx.fill();
      live.style.display = '';
    }
    function liveSoon() { if (!liveRaf) liveRaf = requestAnimationFrame(drawLive); }

    // ---- Overlay: lasso line, tool circle, selection frame and handles ----
    var cursor = null;
    function drawUi() {
      var h = '', k = 1 / Z();
      if (drag && drag.lasso && drag.lasso.length > 1) {
        var lp = 'M' + drag.lasso.map(function (q) { return (q[0] + M) + ' ' + (q[1] + M); }).join('L');
        // Drawing a filled shape (like Concepts): the colour fills in as the outline is drawn.
        if (drag.fillShape) h += '<path d="' + lp + 'Z" fill="' + (opt.fill.c === 'ink' ? 'var(--ink)' : opt.fill.c) + '" fill-opacity="' + (opt.fill.o == null ? 1 : opt.fill.o) + '" stroke="none"/>';
        else h += '<path d="' + lp + '" fill="none" stroke="var(--accent)" stroke-width="' + 1.5 * k + '" stroke-dasharray="' + 5 * k + ' ' + 4 * k + '"/>';
      }
      if (cursor) h += '<circle cx="' + (cursor[0] + M) + '" cy="' + (cursor[1] + M) + '" r="' + cursor[2] + '" fill="none" stroke="var(--muted)" stroke-width="' + k + '" stroke-dasharray="' + 3 * k + ' ' + 3 * k + '"/>';
      if (sel && sel.box) {
        var b = sel.box, pd = 6 * k, x = b.x + M - pd, y = b.y + M - pd, w = b.w + 2 * pd, hh = b.h + 2 * pd;
        h += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh + '" fill="none" stroke="var(--accent)" stroke-width="' + 1.5 * k + '" stroke-dasharray="' + 6 * k + ' ' + 4 * k + '" rx="' + 6 * k + '"/>' +
          '<line x1="' + (x + w / 2) + '" y1="' + y + '" x2="' + (x + w / 2) + '" y2="' + (y - 22 * k) + '" stroke="var(--accent)" stroke-width="' + 1.5 * k + '"/>' +
          '<circle cx="' + (x + w / 2) + '" cy="' + (y - 28 * k) + '" r="' + 8 * k + '" fill="var(--surface)" stroke="var(--accent)" stroke-width="' + 2 * k + '"/>' +
          '<rect x="' + (x + w - 9 * k) + '" y="' + (y + hh - 9 * k) + '" width="' + 18 * k + '" height="' + 18 * k + '" rx="' + 4 * k + '" fill="var(--surface)" stroke="var(--accent)" stroke-width="' + 2 * k + '"/>';
      }
      ui.innerHTML = h;
      placeBar();
    }
    self.size = function (W, H) { ui.setAttribute('width', W); ui.setAttribute('height', H); };

    // ---- Selection (Lasso tool) ----
    // Text boxes can be in the selection too (o.boxes is the page's way to find, move and change them).
    var BX = o.boxes || null;
    function selBox(items, bids) {
      var b = items.length ? unionBox(items) : null;
      (bids || []).forEach(function (id) {
        var r = BX.rect(id); if (!r) return;
        if (!b) { b = { x: r.x, y: r.y, w: r.w, h: r.h }; return; }
        var x0 = Math.min(b.x, r.x), y0 = Math.min(b.y, r.y);
        b = { x: x0, y: y0, w: Math.max(b.x + b.w, r.x + r.w) - x0, h: Math.max(b.y + b.h, r.y + r.h) - y0 };
      });
      return b;
    }
    function setSel(items, bids) {
      items = items || []; bids = BX ? (bids || []) : [];
      if (!items.length && !bids.length) { sel = null; bar.classList.add('hidden'); drawUi(); return; }
      // Grouped items come along with each other.
      var gs = {}; items.forEach(function (it) { if (it.g) gs[it.g] = 1; });
      layers.forEach(function (l) { if (editable(l)) l.items.forEach(function (it) { if (it.g && gs[it.g] && items.indexOf(it) < 0) items.push(it); }); });
      sel = { items: items, boxes: bids, box: selBox(items, bids) };
      renderBar(); drawUi();
    }
    function refreshBox() { if (sel) sel.box = selBox(sel.items, sel.boxes); }
    var SW = ['ink', '#c0392b', '#d9822b', '#f2c94c', '#2f855a', '#00796b', '#2b6cb0', '#7e57c2', '#ffffff'];
    function renderBar(mode) {
      if (!sel) return;
      var grouped = sel.items.length > 1 && sel.items.every(function (it) { return it.g && it.g === sel.items[0].g; });
      var inkSel = sel.items.length > 0, h;
      if (mode === 'color') {
        h = SW.map(function (c) { return '<button type="button" class="sw" data-c="' + c + '" style="background:' + colorOf(c) + '" aria-label="Colour"></button>'; }).join('') +
          '<label class="op">Opacity <input type="range" min="5" max="100" value="' + Math.round((sel.items[0].o == null ? 1 : sel.items[0].o) * 100) + '" data-op></label><button type="button" data-act="back">Done</button>';
      } else if (mode === 'layer') {
        h = layers.slice().reverse().map(function (l) { return '<button type="button" data-tol="' + l.id + '">' + esc(l.name) + '</button>'; }).join('') + '<button type="button" data-act="back">Cancel</button>';
      } else {
        h = '<button type="button" data-act="dup">Duplicate</button><button type="button" data-act="del">Delete</button>' +
          (inkSel ? '<button type="button" data-act="' + (grouped ? 'ungroup' : 'group') + '"' + (sel.items.length < 2 ? ' disabled' : '') + '>' + (grouped ? 'Ungroup' : 'Group') + '</button>' +
            '<button type="button" data-act="color">Colour</button>' : '') + (layers.length > 1 ? '<button type="button" data-act="layer">Layer</button>' : '') +
          (o.zoomTo ? '<button type="button" data-act="zoom">Zoom to</button>' : '');
      }
      bar.innerHTML = h; bar.classList.remove('hidden'); placeBar();
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function placeBar() {
      if (!sel || !sel.box) { bar.classList.add('hidden'); return; }
      var b = sel.box;
      if (o.toScreen) { // the bar lives on the screen, under the selection, whatever the zoom and turn
        var pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(function (q) { return o.toScreen(q[0], q[1]); });
        var x0 = Math.min.apply(null, pts.map(function (q) { return q[0]; })), y1 = Math.max.apply(null, pts.map(function (q) { return q[1]; }));
        var host = o.uiHost, W = host.clientWidth, H = host.clientHeight;
        bar.style.left = Math.max(6, Math.min(W - bar.offsetWidth - 6, x0)) + 'px';
        bar.style.top = Math.max(6, Math.min(H - bar.offsetHeight - 6, y1 + 16)) + 'px';
        return;
      }
      bar.style.left = Math.max(4, b.x + M - 6) + 'px';
      bar.style.top = (b.y + b.h + M + 14) + 'px';
    }
    bar.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    bar.addEventListener('input', function (e) {
      if (e.target.dataset.op == null || !sel) return;
      var v = +e.target.value / 100; sel.items.slice().forEach(function (it) { own(it).o = v; }); render();
    });
    bar.addEventListener('change', function (e) { if (e.target.dataset.op != null) o.changed('ink'); });
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !sel) return;
      var act = b.dataset.act;
      if (b.dataset.c) { sel.items.slice().forEach(function (it) { own(it).c = b.dataset.c; }); done(); renderBar('color'); return; }
      if (b.dataset.tol) {
        var to = layers.filter(function (l) { return l.id === b.dataset.tol; })[0];
        sel.items.forEach(function (it) { var l = layerOf(it); if (l && l !== to) { l.items.splice(l.items.indexOf(it), 1); to.items.push(it); } });
        if (sel.boxes.length) BX.setLayer(sel.boxes, to.id);
        done(); renderBar(); return;
      }
      if (act === 'back') return renderBar();
      if (act === 'zoom') { o.zoomTo(sel.box); return; }
      if (act === 'color' || act === 'layer') return renderBar(act);
      if (act === 'del') { sel.items.forEach(function (it) { var l = layerOf(it); if (l) l.items.splice(l.items.indexOf(it), 1); }); if (sel.boxes.length) BX.remove(sel.boxes); setSel(null); done(); return; }
      if (act === 'dup') {
        var map = {}, copies = sel.items.map(function (it) {
          var c = JSON.parse(JSON.stringify(it)); c.id = uid(it.t);
          if (c.g) c.g = map[c.g] || (map[c.g] = uid('g'));
          eachPoint(c, function (q) { q[0] += 20; q[1] += 20; });
          (layerOf(it) || active()).items.push(c); return c;
        });
        var boxCopies = sel.boxes.length ? BX.dup(sel.boxes, 20, 20) : [];
        done(); setSel(copies, boxCopies); return;
      }
      if (act === 'group') { var g = uid('g'); sel.items.slice().forEach(function (it) { own(it).g = g; }); commit(); renderBar(); return; }
      if (act === 'ungroup') { sel.items.slice().forEach(function (it) { delete own(it).g; }); commit(); renderBar(); return; }
    });

    // ---- Transforming the selection: drag inside to move, the corner to scale, the knob to rotate ----
    function handleAt(p) {
      if (!sel || !sel.box) return null;
      var k = 1 / Z(), b = sel.box, x = b.x - 6 * k, y = b.y - 6 * k, w = b.w + 12 * k, h = b.h + 12 * k;
      if (Math.hypot(p[0] - (x + w / 2), p[1] - (y - 28 * k)) < 20 * k) return 'rotate';
      if (Math.hypot(p[0] - (x + w), p[1] - (y + h)) < 22 * k) return 'scale';
      if (p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h) return 'move';
      return null;
    }
    function startTransform(kind, p) {
      sel.items.slice().forEach(own);
      var b = sel.box;
      drag = { kind: kind, start: p, c: [b.x + b.w / 2, b.y + b.h / 2], tl: [b.x, b.y], orig: sel.items.map(function (it) { return JSON.parse(JSON.stringify(it)); }),
        borig: sel.boxes.map(function (id) { return BX.rect(id); }) };
    }
    function applyTransform(p) {
      var d = drag, ang = 0, s = 1;
      if (d.kind === 'rotate') ang = Math.atan2(p[1] - d.c[1], p[0] - d.c[0]) - Math.atan2(d.start[1] - d.c[1], d.start[0] - d.c[0]);
      if (d.kind === 'scale') {
        var a0 = (d.start[0] - d.tl[0]) + (d.start[1] - d.tl[1]), a1 = (p[0] - d.tl[0]) + (p[1] - d.tl[1]);
        s = Math.max(0.05, a0 > 1 ? a1 / a0 : 1);
      }
      var cos = Math.cos(ang), sin = Math.sin(ang), dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      var map = function (q) {
        if (d.kind === 'move') return [q[0] + dx, q[1] + dy];
        if (d.kind === 'scale') return [d.tl[0] + (q[0] - d.tl[0]) * s, d.tl[1] + (q[1] - d.tl[1]) * s];
        var x = q[0] - d.c[0], y = q[1] - d.c[1];
        return [d.c[0] + x * cos - y * sin, d.c[1] + x * sin + y * cos];
      };
      sel.items.forEach(function (it, i) {
        var src = d.orig[i];
        if (it.t === 'f') it.d = src.d.map(function (ring) { return ring.map(map); });
        else { it.p = src.p.map(function (q) { var m = map(q); var o2 = [m[0], m[1], q[2]]; if (q[3] != null) o2.push(q[3]); return o2; }); if (d.kind === 'scale') it.s = src.s * s; }
        invalidate(it);
      });
      // Text boxes move with it: their corner follows (turning moves them round the middle); scaling changes their width.
      sel.boxes.forEach(function (id, i) {
        var r0 = d.borig[i]; if (!r0) return;
        if (d.kind === 'rotate') { var c0 = map([r0.x + r0.w / 2, r0.y + r0.h / 2]); BX.place(id, c0[0] - r0.w / 2, c0[1] - r0.h / 2); }
        else { var q = map([r0.x, r0.y]); BX.place(id, q[0], q[1], d.kind === 'scale' ? Math.max(60, r0.w * s) : null); }
      });
      refreshBox(); patch(sel.items);
    }

    // A pen point as it is kept: its width from pressure (through the pressure curve) and tilt, and, when pressure
    // or tilt is set to change the ink's strength, that strength. Input: [x, y, pressure, tilt 0 (upright)–1 (flat)].
    function shapePt(q, isPen) {
      if (!isPen) return [q[0], q[1], q[2]];
      var pen = opt.pen, t = q[3] || 0;
      var g = pen.pc === 'soft' ? 0.55 : pen.pc === 'firm' ? 1.8 : 1;
      var pc = Math.pow(Math.max(0.01, Math.min(1, q[2] == null ? 0.5 : q[2])), g);
      var out = [q[0], q[1], Math.max(0.03, Math.min(1, pc + (pen.tw || 0) * t * 0.7))];
      if (pen.po || pen.to) out.push(Math.max(0.06, Math.min(1, 1 - (pen.po || 0) * (1 - pc) - (pen.to || 0) * t * 0.85)));
      return out;
    }

    // ---- Pointer input (positions are note coordinates) ----
    self.down = function (p, ev) {
      if (tool === 'lasso') {
        var hnd = handleAt(p);
        if (hnd) { startTransform(hnd, p); return true; }
        drag = { lasso: [p], t: Date.now() }; setSel(null); return true;
      }
      if (tool === 'pen') {
        var L = active();
        if (!editable(L)) { o.notice(L.vis ? 'This layer is locked.' : 'This layer is hidden.'); return false; }
        var pen = opt.pen, isPen = ev.pointerType === 'pen';
        var it = { id: uid('s'), t: 's', b: pen.b, c: pen.c, s: pen.s, o: pen.o, p: [shapePt(p, isPen)] };
        if (pen.st != null) it.st = pen.st;
        if (isPen) { it.f = 1; if (pen.th != null) it.th = pen.th; }
        drag = { stroke: it, layer: L };
        startLive(drag); liveSoon();
        return true;
      }
      if (tool === 'erase') { drag = { erase: true, any: false }; cursor = [p[0], p[1], opt.erase.s / Z()]; eraseAt(p); drawUi(); return true; }
      if (tool === 'nudge') { drag = { nudge: true, last: p, any: false }; cursor = [p[0], p[1], opt.nudge.r / Z()]; drawUi(); return true; }
      if (tool === 'fill') {
        if (opt.fill.m === 'lasso') drag = { lasso: [p], fillShape: true };
        else drag = { tap: p, t: Date.now() };
        return true;
      }
      return false;
    };
    self.move = function (p, ev, pts, pred) {
      if (!drag) {
        if (ev.pointerType !== 'touch' && (tool === 'erase' || tool === 'nudge')) { cursor = [p[0], p[1], (tool === 'erase' ? opt.erase.s : opt.nudge.r) / Z()]; drawUi(); }
        return;
      }
      if (drag.kind) { applyTransform(p); return; }
      if (drag.stroke) {
        var sp = drag.stroke.p, isPen = !!drag.stroke.f;
        (pts || [p]).map(function (q) { return shapePt(q, isPen); }).forEach(function (q) {
          var last = sp[sp.length - 1];
          if (last && Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) < 0.15 / Z()) { last[2] = Math.max(last[2], q[2]); return; } // no movement
          sp.push(q);
        });
        drag.pred = pred && pred.length ? pred.slice(-2).map(function (q) { return shapePt(q, isPen); }) : null;
        liveSoon();
        return;
      }
      if (drag.lasso) { drag.lasso.push(p); drawUi(); return; }
      if (drag.erase) { cursor = [p[0], p[1], opt.erase.s / Z()]; eraseAt(p); drawUi(); return; }
      if (drag.nudge) {
        cursor = [p[0], p[1], opt.nudge.r / Z()];
        var R = opt.nudge.r / Z(), k = opt.nudge.k, dx = p[0] - drag.last[0], dy = p[1] - drag.last[1];
        layers.forEach(function (l) {
          if (!editable(l)) return;
          l.items.forEach(function (it) {
            var b = itemBox(it);
            if (p[0] < b.x - R || p[0] > b.x + b.w + R || p[1] < b.y - R || p[1] > b.y + b.h + R) return;
            var t = own(it);
            if (opt.nudge.m === 'smooth' ? smooth(t, p[0], p[1], R, k) : nudge(t, drag.last[0], drag.last[1], dx, dy, R, k)) { drag.any = true; patch([t]); }
          });
        });
        drag.last = p; drawUi(); return;
      }
    };
    self.up = function (p) {
      var d = drag; drag = null;
      if (!d) return;
      if (d.kind) { refreshBox(); flushPatch(); commit(); return; }
      if (d.stroke) {
        cancelAnimationFrame(liveRaf); liveRaf = 0;
        if (d.stroke.p.length === 1) { var p0 = d.stroke.p[0]; d.stroke.p.push([p0[0] + 0.4, p0[1] + 0.4].concat(p0.slice(2))); }
        d.layer.items.push(d.stroke); invalidate(d.stroke);
        addEl(d.layer, d.stroke);
        // Take the live stroke away once the saved one is on screen (two frames), unless a new stroke has begun.
        requestAnimationFrame(function () { requestAnimationFrame(function () { if (!drag || !drag.stroke) clearLive(); }); });
        commit(); return;
      }
      if (d.erase) { cursor = null; drawUi(); if (d.any) commit(); return; }
      if (d.nudge) { cursor = null; flushPatch(); if (d.any) commit(); return; }
      if (d.tap) { fillAt(d.tap); return; }
      if (d.lasso) {
        var poly = d.lasso, len = 0;
        for (var i = 1; i < poly.length; i++) len += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
        if (d.fillShape) {
          drawUi();
          if (len < 20 / Z()) return;
          var L = active();
          if (!editable(L)) { o.notice('This layer is locked or hidden.'); return; }
          addFill(L, [simplify(poly.map(function (q) { return [q[0], q[1]]; }), 0.8)]);
          return;
        }
        if (len < 12 / Z()) { // a tap: pick what is under it
          var hit = null;
          for (var li = layers.length - 1; li >= 0 && !hit; li--) {
            if (!editable(layers[li])) continue;
            for (var j = layers[li].items.length - 1; j >= 0; j--) if (hits(layers[li].items[j], p[0], p[1], 8 / Z())) { hit = layers[li].items[j]; break; }
          }
          if (!hit && BX) { var bh = BX.at(p[0], p[1]); if (bh) { setSel([], [bh]); return; } }
          setSel(hit ? [hit] : null); return;
        }
        var picked = [];
        layers.forEach(function (l) {
          if (!editable(l)) return;
          l.items.forEach(function (it) {
            var n = 0, inside = 0;
            eachPoint(it, function (q) { n++; if (inPoly(q[0], q[1], poly)) inside++; });
            if (n && inside / n >= 0.5) picked.push(it);
          });
        });
        setSel(picked, BX ? BX.pick(poly, inPoly) : []);
      }
    };
    self.cancel = function () {
      if (drag && drag.stroke) { cancelAnimationFrame(liveRaf); liveRaf = 0; clearLive(); }
      if (drag && (drag.kind || drag.nudge || drag.erase) && drag.any !== false) { drag = null; cursor = null; flushPatch(); commit(); return; }
      drag = null; cursor = null; drawUi();
    };
    self.busy = function () { return !!drag; };
    self.leave = function () { if (!drag) { cursor = null; drawUi(); } };

    function eraseAt(p) {
      var r = opt.erase.s / Z();
      layers.forEach(function (l) {
        if (!editable(l)) return;
        for (var i = l.items.length - 1; i >= 0; i--) {
          var it = l.items[i];
          if (!hits(it, p[0], p[1], r)) continue;
          var e = elOf(it);
          if (opt.erase.m === 'slice' && it.t !== 'f') {
            var parts = slice(it, p[0], p[1], r);
            if (!parts) continue;
            Array.prototype.splice.apply(l.items, [i, 1].concat(parts));
            if (e) e.insertAdjacentHTML('afterend', parts.map(function (q) { return itemSvg(q); }).join(''));
          } else l.items.splice(i, 1);
          if (e) e.remove(); else soon();
          drag.any = true;
        }
      });
    }
    function addFill(L, rings) {
      var f = { id: uid('f'), t: 'f', c: opt.fill.c, o: opt.fill.o, d: rings };
      var at = L.items.findIndex(function (it) { return it.t !== 'f'; });
      if (at < 0) L.items.push(f); else L.items.splice(at, 0, f); // colour goes under the lines
      done();
    }
    function fillAt(p) {
      var L = active();
      if (!editable(L)) { o.notice('This layer is locked or hidden.'); return; }
      var rings = floodOutline(layers, o.view(), p[0], p[1]);
      if (!rings) { o.notice('Tap inside a closed shape to fill it, or switch Fill to “Draw shape”.'); return; }
      addFill(L, rings);
    }

    // ---- What the canvas and the app can ask ----
    self.render = render;
    self.viewChanged = function () { drawUi(); };
    self.box = function () { var all = []; layers.forEach(function (l) { if (l.vis) all = all.concat(l.items); }); return unionBox(all); };
    self.setTool = function (t) { tool = t; if (t !== 'lasso') setSel(null); cursor = null; drawUi(); };
    self.tool = function () { return tool; };
    self.opts = function (k, v) { if (v) Object.assign(opt[k], v); return opt[k]; };
    self.bounds = function () {
      var all = []; layers.forEach(function (l) { all = all.concat(l.items); });
      var b = unionBox(all); return b ? { r: b.x + b.w, b: b.y + b.h } : { r: 0, b: 0 };
    };
    self.shift = function (dx, dy) {
      layers.forEach(function (l) { l.items = l.items.map(function (it) { var c = JSON.parse(JSON.stringify(it)); eachPoint(c, function (q) { q[0] += dx; q[1] += dy; }); return c; }); });
      render(); owned = new WeakSet();
    };
    self.clearSelection = function () { setSel(null); };
    self.reset = function () { // after undo/redo replaced the layers
      if (!layers.length) layers.push(newLayer());
      if (!active() || active().id !== activeId) activeId = layers.filter(function (l) { return l.id === activeId; }).length ? activeId : layers[layers.length - 1].id;
      sel = null; bar.classList.add('hidden'); owned = new WeakSet(); render();
    };
    // Little pictures of each layer, all at the same scale, for the layers panel.
    self.layerThumbs = function (w, h) {
      var all = []; layers.forEach(function (l) { all = all.concat(l.items); });
      var b = unionBox(all), out = {};
      layers.forEach(function (l) {
        if (!b || !l.items.length) { out[l.id] = ''; return; }
        var sc = Math.min(w / Math.max(1, b.w), h / Math.max(1, b.h));
        var copy = { id: l.id, vis: true, op: 1, blend: 'normal', clip: false, items: l.items };
        out[l.id] = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + (w / sc) + ' ' + (h / sc) + '" preserveAspectRatio="xMidYMid meet">' +
          markup([copy], 'lt' + (++thumbN) + '-', -b.x + (w / sc - b.w) / 2, -b.y + (h / sc - b.h) / 2, true) + '</svg>';
      });
      return out;
    };
    // Layers
    self.layers = function () { return layers.map(function (l) { return { id: l.id, name: l.name, vis: l.vis, lock: l.lock, op: l.op, blend: l.blend, clip: l.clip, gid: l.gid, gname: l.gname, n: l.items.length, active: l.id === activeId }; }).reverse(); };
    self.activeLayer = function () { return activeId; };
    self.layerInfo = function (id) { var l = layers.filter(function (x) { return x.id === id; })[0]; return l ? { vis: l.vis, lock: l.lock, op: l.op } : null; };
    self.bottomLayer = function () { return layers[0].id; };
    // Several layers at once (selected with tap-and-hold): group, ungroup, hide, merge, delete.
    self.layersOp = function (op, ids, val) {
      var set = layers.filter(function (l) { return ids.indexOf(l.id) > -1; });
      if (!set.length) return;
      if (op === 'group') {
        // A group is a run of layers next to each other: the chosen layers gather just under the topmost of them.
        var gid = uid('G'), top = Math.max.apply(null, set.map(function (l) { return layers.indexOf(l); }));
        var anchor = layers[top];
        var order = layers.filter(function (l) { return set.indexOf(l) < 0 || l === anchor; }); // the note's own array is reordered in place
        var at = order.indexOf(anchor);
        var rest = set.filter(function (l) { return l !== anchor; }).sort(function (a, b) { return layers.indexOf(a) - layers.indexOf(b); });
        Array.prototype.splice.apply(order, [at, 0].concat(rest));
        layers.length = 0; order.forEach(function (l) { layers.push(l); });
        set.forEach(function (l) { l.gid = gid; l.gname = val || 'Group'; });
      }
      if (op === 'ungroup') set.forEach(function (l) { delete l.gid; delete l.gname; });
      if (op === 'vis') { var show = set.some(function (l) { return !l.vis; }); set.forEach(function (l) { l.vis = show; }); }
      if (op === 'lock') { var lk = set.some(function (l) { return !l.lock; }); set.forEach(function (l) { l.lock = lk; }); }
      if (op === 'gname') set.forEach(function (l) { l.gname = String(val || '').trim().slice(0, 40) || l.gname; });
      if (op === 'merge') {
        var order = set.slice().sort(function (a, b) { return layers.indexOf(a) - layers.indexOf(b); }), base = order[0];
        order.slice(1).forEach(function (l) { base.items = base.items.concat(l.items); layers.splice(layers.indexOf(l), 1); });
        activeId = base.id;
      }
      if (op === 'delete') {
        set.forEach(function (l) { layers.splice(layers.indexOf(l), 1); });
        if (!layers.length) layers.push(newLayer());
        if (!layers.some(function (l) { return l.id === activeId; })) activeId = layers[layers.length - 1].id;
      }
      setSel(null); done('ink');
    };
    // Drag a layer to a new place in the list (index counted from the bottom), into a group or out of one.
    self.moveLayer = function (id, to, gid, gname) {
      var i = layers.findIndex(function (l) { return l.id === id; }); if (i < 0) return;
      var l = layers.splice(i, 1)[0];
      to = Math.max(0, Math.min(layers.length, to));
      layers.splice(to, 0, l);
      if (gid) { l.gid = gid; l.gname = gname || 'Group'; } else { delete l.gid; delete l.gname; }
      setSel(null); done('ink');
    };
    self.layerOp = function (op, id, val) {
      var i = layers.findIndex(function (l) { return l.id === id; }), l = layers[i];
      if (op === 'add') { var nl = newLayer('Layer ' + (layers.length + 1)); var at = i < 0 ? layers.length : i + 1; layers.splice(at, 0, nl); activeId = nl.id; done('ink'); return; }
      if (!l) return;
      if (op === 'active') { activeId = id; setSel(null); return; }
      if (op === 'vis') l.vis = !l.vis;
      if (op === 'lock') l.lock = !l.lock;
      if (op === 'clip') l.clip = !l.clip;
      if (op === 'op') { l.op = val; render(); return; }      // live while sliding; 'opdone' records it
      if (op === 'opdone') l.op = val;
      if (op === 'blend') l.blend = val;
      if (op === 'name') l.name = String(val || '').trim().slice(0, 40) || l.name;
      if (op === 'up' && i < layers.length - 1) { layers.splice(i, 1); layers.splice(i + 1, 0, l); }
      if (op === 'down' && i > 0) { layers.splice(i, 1); layers.splice(i - 1, 0, l); }
      if (op === 'merge' && i > 0) { layers[i - 1].items = layers[i - 1].items.concat(l.items); layers.splice(i, 1); activeId = layers[i - 1].id; }
      if (op === 'delete') {
        layers.splice(i, 1);
        if (!layers.length) layers.push(newLayer());
        if (activeId === id) activeId = layers[Math.max(0, i - 1)].id;
      }
      if (op === 'dup') { var c = JSON.parse(JSON.stringify(l)); c.id = uid('L'); c.name = l.name + ' copy'; c.items.forEach(function (it) { it.id = uid(it.t); }); layers.splice(i + 1, 0, c); activeId = c.id; }
      setSel(null); done('ink');
    };
    render();
  }

  window.QNInk = { Engine: Engine, svgFor: function (layers, prefix, dx, dy, plain) { return markup(layers, prefix, dx, dy, plain); }, normalize: normalize, hasInk: hasInk, toJSON: toJSON, thumb: thumb, BRUSH: BRUSH, BLENDS: BLENDS, newLayer: newLayer,
    _test: { slice: slice, nudge: nudge, smooth: smooth, floodOutline: floodOutline, trace: trace, hits: hits, inPoly: inPoly } };
})();
