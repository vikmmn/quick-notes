// Offshoot: the drawing engine. Layers of vector strokes and fills, drawn as SVG.
//
// A note's drawing is a list of layers, bottom first:
//   { id, name, vis, lock, op (opacity 0–1), blend ('normal', 'multiply'…), clip (masked by the layer below), items: [...] }
// Items, bottom first, in note coordinates:
//   stroke { id, t: 's', b: brush, c: colour, s: size, o: opacity, f: 1 if drawn with a pen (real pressure), st: smoothing 0–1 (optional),
//            th: how much pressure thins the line 0–1 (optional), g: group id,
//   text   { id, t: 'x', txt, x, y (top-left corner), r: angle (radians), fs: font size, font: CSS font family, c, o, g }
//            (artistic text: a drawing object in its layer, in front of or behind other layers, masked, lassoed…)
//   shapes { id, t: 'b', op: 'union'|'subtract'|'intersect'|'exclude', k: [items, bottom one first], c, o, g }
//            (a non-destructive boolean: the parts stay whole and can be released; each part remembers its layer in L)
//   image  { id, t: 'i', src (a link, or Attachments/<name> in Drive), x, y (top-left corner), w, h, r: angle, o, g } p: [[x, y, pressure], …] }
//   fill   { id, t: 'f', c, o, g, d: [[[x, y], …], …], pt: a fill pattern's id (optional) }   (one or more closed outlines)
//   A stroke may have cs: the id of a home-made pen tip or line style. Those (and fill patterns) are "defs":
//     { id, k: 'tip' | 'line' | 'pat', name, items: [strokes, drawn in the def's own little space], rot (tip turns with the stroke), sp (tip spacing), sz (pattern tile size) }
//     tip: a round box, −50…50 across; line: one repeat, 0…400 along and −50…50 across; pattern: one tile, 0…100 both ways
//     (drawn in hundredths of the size they are used at, so the pen's maths works at a normal scale).
//     A note keeps a copy of every def it uses, in its saved drawing.
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
  var DEFS = {};
  // A note's copy only fills a gap: the one in this device's own collection (maybe just edited) wins.
  function addDefs(list, weak) { (list || []).forEach(function (d) { if (d && d.id && d.items && !(weak && DEFS[d.id])) DEFS[d.id] = d; }); }
  function normalize(raw) {
    if (raw && !Array.isArray(raw) && raw.defs) addDefs(raw.defs, true);
    if (raw && !Array.isArray(raw) && raw.layers) raw = raw.layers;
    if (!Array.isArray(raw) || !raw.length) return [newLayer()];
    if (raw[0] && raw[0].items) {
      return raw.map(function (l, i) {
        return { id: l.id || uid('L'), name: l.name || 'Layer ' + (i + 1), vis: l.vis !== false, lock: !!l.lock, op: l.op == null ? 1 : +l.op,
          blend: l.blend || 'normal', clip: !!l.clip, gid: l.gid || undefined, gname: l.gname || undefined, items: (l.items || []).filter(validItem) };
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
  function validItem(it) {
    if (!it) return false;
    if (it.t === 'b') { it.k = (it.k || []).filter(validItem); return it.k.length > 1; }
    return it.t === 'f' ? it.d && it.d.length : it.t === 'x' ? !!it.txt : it.t === 'i' ? !!it.src && it.w > 0 : it.p && it.p.length;
  }
  function hasInk(layers) { return Array.isArray(layers) && layers.some(function (l) { return l.items && l.items.length; }); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function toJSON(layers) {
    var used = {};
    var out = { v: 2, layers: layers.map(function (l) {
      var o = { id: l.id, name: l.name, items: l.items.map(function ser(it) {
        var x = { id: it.id, t: it.t, c: it.c };
        if (it.L) x.L = it.L;
        if (it.cs) { x.cs = it.cs; used[it.cs] = 1; }
        if (it.pt) { x.pt = it.pt; used[it.pt] = 1; }
        if (it.o != null && it.o !== 1) x.o = Math.round(it.o * 100) / 100;
        if (it.g) x.g = it.g;
        if (it.co != null && it.co !== 1) x.co = Math.round(it.co * 100) / 100; // the collective's opacity
        if (it.t === 'f') x.d = it.d.map(function (ring) { return ring.map(function (q) { return [r1(q[0]), r1(q[1])]; }); });
        else if (it.t === 'b') { x.op = it.op; x.k = it.k.map(ser); }
        else if (it.t === 'i') { x.src = it.src; x.x = r1(it.x); x.y = r1(it.y); x.w = r1(it.w); x.h = r1(it.h); if (it.r) x.r = Math.round(it.r * 1000) / 1000; }
        else if (it.t === 'x') { x.txt = it.txt; x.x = r1(it.x); x.y = r1(it.y); if (it.r) x.r = Math.round(it.r * 1000) / 1000; x.fs = r1(it.fs); x.font = it.font; }
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
    var defs = Object.keys(used).map(function (id) { return DEFS[id]; }).filter(Boolean);
    if (defs.length) out.defs = defs;
    return out;
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
  // ---- Artistic text: measured with the font it uses ----
  var mctx = null;
  function textSize(it) {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = it.fs + 'px ' + (it.font || 'sans-serif');
    var lines = String(it.txt || '').split('\n'), w = 0;
    lines.forEach(function (l) { w = Math.max(w, mctx.measureText(l).width); });
    return { w: Math.max(w, it.fs * 0.4), h: lines.length * it.fs * 1.25 };
  }
  function boxy(it) { return it.t === 'x' || it.t === 'i'; } // placed by a corner, a size and an angle
  function textCorners(it) {
    var s = it.t === 'i' ? { w: it.w, h: it.h } : textSize(it), c = Math.cos(it.r || 0), sn = Math.sin(it.r || 0);
    return [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]].map(function (q) { return [it.x + q[0] * c - q[1] * sn, it.y + q[0] * sn + q[1] * c]; });
  }
  function xmlEsc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function textSvg(it, plain) {
    var o = (it.o == null ? 1 : it.o) * (it.co || 1), deg = (it.r || 0) * 180 / Math.PI;
    var lines = String(it.txt || '').split('\n');
    return '<text data-i="' + it.id + '" transform="translate(' + it.x.toFixed(1) + ' ' + it.y.toFixed(1) + ')' + (deg ? ' rotate(' + deg.toFixed(2) + ')' : '') + '"' +
      ' style="font-family:' + xmlEsc(it.font || 'sans-serif') + ';font-size:' + it.fs + 'px;white-space:pre" fill="' + colorOf(it.c) + '"' + (o !== 1 ? ' fill-opacity="' + o + '"' : '') + '>' +
      lines.map(function (l, i) { return '<tspan x="0" y="' + (it.fs * (0.93 + 1.25 * i)).toFixed(1) + '">' + (xmlEsc(l) || ' ') + '</tspan>'; }).join('') + '</text>';
  }
  function itemD(it) {
    if (boxy(it) || it.t === 'b') return '';
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
  // ---- Images: their files are fetched (from Drive) by the app; until then a dashed frame stands in ----
  var IMG = { url: {}, asked: {}, resolve: null, ready: null };
  function imageUrl(src) {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    if (IMG.url[src]) return IMG.url[src];
    if (IMG.resolve && !IMG.asked[src]) {
      IMG.asked[src] = 1;
      Promise.resolve(IMG.resolve(src)).then(function (u) { if (u) { IMG.url[src] = u; if (IMG.ready) IMG.ready(); } }).catch(function () { delete IMG.asked[src]; });
    }
    return null;
  }
  function imageSvg(it) {
    var o = (it.o == null ? 1 : it.o) * (it.co || 1), deg = (it.r || 0) * 180 / Math.PI, u = imageUrl(it.src);
    var tr = 'translate(' + it.x.toFixed(1) + ' ' + it.y.toFixed(1) + ')' + (deg ? ' rotate(' + deg.toFixed(2) + ')' : '');
    if (!u) return '<rect data-i="' + it.id + '" transform="' + tr + '" width="' + it.w.toFixed(1) + '" height="' + it.h.toFixed(1) + '" rx="6" fill="var(--field, #8882)" stroke="var(--rule, #8886)" stroke-dasharray="6 5"/>';
    return '<image data-i="' + it.id + '" transform="' + tr + '" width="' + it.w.toFixed(1) + '" height="' + it.h.toFixed(1) + '" preserveAspectRatio="none" href="' + xmlEsc(u) + '"' + (o !== 1 ? ' opacity="' + o + '"' : '') + '/>';
  }
  // ---- Home-made pen tips, line styles and fill patterns ----
  function defItems(d, col) { // the def's own strokes, in the colour given (or their own)
    return d.items.map(function (p) { return bare(itemSvg(col ? Object.assign({}, p, { c: col }) : p, true)); }).join('');
  }
  function along(pts) { // a stroke's line, measured, to find points and directions by distance along it
    var L = [0];
    for (var i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    var j = 1;
    return { len: L[L.length - 1], at: function (s) {
      if (pts.length === 1) return [pts[0][0], pts[0][1], 1, 0, pts[0][2]];
      if (s < L[j - 1]) j = 1;
      while (j < pts.length - 1 && L[j] < s) j++;
      var a = pts[j - 1], b = pts[j], seg = L[j] - L[j - 1] || 1, t = Math.max(0, Math.min(1, (s - L[j - 1]) / seg));
      var dx = (b[0] - a[0]) / seg, dy = (b[1] - a[1]) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, dx || 1, dy, (a[2] == null ? 0.5 : a[2]) * (1 - t) + (b[2] == null ? 0.5 : b[2]) * t];
    } };
  }
  // Pressure can change how big each stamp is (pm 'size'), how much of the tip shows, from its middle out ('reveal'), or both.
  function tipSvg(it, d) { // the tip, stamped along the line, turned with the line if asked
    var w = widthOf(it), sp = Math.max(0.05, d.sp || 0.25) * w, A = along(it.p), o = (it.o == null ? 1 : it.o) * (it.co || 1);
    var pm = d.pm || 'size', tid = 'tp-' + it.id, uses = '', clips = {}, LV = 10;
    for (var s = 0; s <= A.len + 0.01; s += sp) {
      var q = A.at(s), pr = it.f ? q[4] : 0.5, ang = d.rot ? Math.atan2(q[3], q[2]) * 180 / Math.PI : 0;
      var k = w * (pm !== 'reveal' && it.f ? 0.45 + 1.1 * pr : 1), clip = '';
      if (pm !== 'size') { var lv = Math.max(1, Math.min(LV, Math.round((0.15 + 0.85 * (it.f ? pr : 1)) * LV))); clips[lv] = 1; clip = ' clip-path="url(#' + tid + '-c' + lv + ')"'; }
      uses += '<use href="#' + tid + '"' + clip + ' transform="translate(' + q[0].toFixed(1) + ' ' + q[1].toFixed(1) + ')' + (ang ? ' rotate(' + ang.toFixed(1) + ')' : '') + ' scale(' + (k / 100).toFixed(4) + ')"/>';
      if (A.len === 0) break;
    }
    var cdefs = Object.keys(clips).map(function (lv) { return '<clipPath id="' + tid + '-c' + lv + '"><circle r="' + (50 * lv / LV).toFixed(1) + '"/></clipPath>'; }).join('');
    return '<g data-i="' + it.id + '"' + (o !== 1 ? ' opacity="' + o + '"' : '') + '><defs><g id="' + tid + '">' + defItems(d, colorOf(it.c)) + '</g>' + cdefs + '</defs>' + uses + '</g>';
  }
  function lineSvg(it, d) { // one repeat of the style, bent along the line, again and again
    var w = widthOf(it), rep = 4 * w, A = along(it.p), o = (it.o == null ? 1 : it.o) * (it.co || 1), col = colorOf(it.c), out = '';
    d.items.forEach(function (p) {
      var dd = '', pw = Math.max(0.4, widthOf(p) / 100 * w * 0.8);
      for (var k = 0; k * rep < A.len; k++) {
        var started = false;
        p.p.forEach(function (q) {
          var s = k * rep + q[0] / 100 * w; if (s > A.len) { started = false; return; }
          var m = A.at(s), x = m[0] - m[3] * q[1] / 100 * w, y = m[1] + m[2] * q[1] / 100 * w;
          dd += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); started = true;
        });
      }
      if (dd) out += '<path d="' + dd + '" fill="none" stroke="' + col + '" stroke-width="' + pw.toFixed(2) + '" stroke-linecap="round" stroke-linejoin="round"' + (p.o != null && p.o !== 1 ? ' stroke-opacity="' + p.o + '"' : '') + '/>';
    });
    return '<g data-i="' + it.id + '"' + (o !== 1 ? ' opacity="' + o + '"' : '') + '>' + out + '</g>';
  }
  function patternDef(d, pid) { // a tile, with its edges wrapped round so the pattern runs on without seams
    var sz = d.sz || 48, inner = defItems(d), nine = '';
    [-1, 0, 1].forEach(function (a) { [-1, 0, 1].forEach(function (b) { nine += '<g transform="translate(' + a * 100 + ' ' + b * 100 + ')">' + inner + '</g>'; }); });
    return '<pattern id="' + pid + '" patternUnits="userSpaceOnUse" width="' + sz + '" height="' + sz + '"><g transform="scale(' + (sz / 100) + ')">' + nine + '</g></pattern>';
  }
  function itemSvg(it, plain) {
    if (it.t === 'x') return textSvg(it, plain);
    if (it.t === 'i') return imageSvg(it);
    if (it.t === 'b') return boolSvg(it);
    if (it.cs && DEFS[it.cs] && it.p && it.p.length) return DEFS[it.cs].k === 'line' ? lineSvg(it, DEFS[it.cs]) : tipSvg(it, DEFS[it.cs]);
    if (it.pt && DEFS[it.pt] && it.t === 'f') {
      var pid = 'pt-' + it.id, po = (it.o == null ? 1 : it.o) * (it.co || 1);
      return '<g data-i="' + it.id + '"><defs>' + patternDef(DEFS[it.pt], pid) + '</defs><path d="' + itemD(it) + '" fill="url(#' + pid + ')" fill-rule="evenodd"' + (po !== 1 ? ' fill-opacity="' + po + '"' : '') + '/></g>';
    }
    var B = plain ? {} : BRUSH[it.b] || {};
    var o = (it.o == null ? 1 : it.o) * (it.co || 1), fade = !plain && hasFade(it);
    var path = '<path' + (fade ? '' : ' data-i="' + it.id + '"') + ' d="' + itemD(it) + '" fill="' + colorOf(it.c) + '"' +
      (it.t === 'f' ? ' fill-rule="evenodd"' : '') + (o !== 1 ? ' fill-opacity="' + o + '"' : '') + (fade ? ' mask="url(#pm-' + it.id + ')"' : '') +
      (B.grain ? ' filter="url(#qn-grain)"' : '') + (B.blend ? ' style="mix-blend-mode:' + B.blend + '"' : '') + '/>';
    return fade ? '<g data-i="' + it.id + '">' + fadeMask(it) + path + '</g>' : path;
  }
  // ---- Shapes (booleans), drawn live with masks, so the parts stay as they are ----
  var HUGE = ' maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"';
  function bare(s) { return s.replace(/ data-i="[^"]*"/g, ''); }
  function boolSvg(it) {
    var k = it.k, base = k[0], others = k.slice(1), id = 'bm-' + it.id, defs = '', body;
    var shape = function (p, black) { return '<g style="filter:brightness(0)' + (black ? '' : ' invert(1)') + '">' + bare(itemSvg(p, true)) + '</g>'; };
    if (it.op === 'subtract') { // the bottom part, with the others cut out of it
      defs = '<mask id="' + id + '"' + HUGE + '><rect x="-100000" y="-100000" width="200000" height="200000" fill="#fff"/>' + others.map(function (p) { return shape(p, true); }).join('') + '</mask>';
      body = '<g mask="url(#' + id + ')">' + bare(itemSvg(base)) + '</g>';
    } else if (it.op === 'intersect') { // only where every part is
      body = bare(itemSvg(base));
      others.forEach(function (p, i) { defs += '<mask id="' + id + '-' + i + '"' + HUGE + '>' + shape(p) + '</mask>'; body = '<g mask="url(#' + id + '-' + i + ')">' + body + '</g>'; });
    } else { // union, or exclude (where an odd number of parts overlap): one shape, in the bottom part's colour
      var lead = k.filter(function (p) { return p.t !== 'i' && p.t !== 'b'; })[0];
      if (!lead && it.op === 'union') return '<g data-i="' + it.id + '">' + k.map(function (p) { return bare(itemSvg(p)); }).join('') + '</g>';
      var bb = unionBox(k), col = it.c && it.c !== 'ink' ? it.c : lead ? lead.c : it.c;
      var xo = it.op === 'exclude';
      defs = '<mask id="' + id + '"' + HUGE + '>' + (xo ? '<g style="isolation:isolate">' : '') +
        k.map(function (p) { var s = shape(p); return xo ? s.replace('<g style="', '<g style="mix-blend-mode:difference;') : s; }).join('') + (xo ? '</g>' : '') + '</mask>';
      var lo = lead && lead.o != null ? lead.o : 1;
      body = '<rect x="' + bb.x.toFixed(1) + '" y="' + bb.y.toFixed(1) + '" width="' + bb.w.toFixed(1) + '" height="' + bb.h.toFixed(1) + '" fill="' + colorOf(col) + '"' + (lo !== 1 ? ' fill-opacity="' + lo + '"' : '') + ' mask="url(#' + id + ')"/>';
    }
    var o = (it.o == null ? 1 : it.o) * (it.co || 1);
    return '<g data-i="' + it.id + '"' + (o !== 1 ? ' opacity="' + o + '"' : '') + '>' + defs + body + '</g>';
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
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pad = it.t === 'f' || boxy(it) || it.t === 'b' ? 0 : widthOf(it) / 2;
    if (it.t === 'b') { var ub = unionBox(it.k); boxCache.set(it, ub); return ub; }
    var each = function (q) { if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] > x1) x1 = q[0]; if (q[1] > y1) y1 = q[1]; };
    if (it.t === 'f') it.d.forEach(function (ring) { ring.forEach(each); }); else if (boxy(it)) textCorners(it).forEach(each); else it.p.forEach(each);
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
    if (it.t === 'b') return it.k.some(function (p) { return hits(p, x, y, r); });
    if (boxy(it)) return inPoly(x, y, textCorners(it)) || textCorners(it).some(function (q, i, a) { var n = a[(i + 1) % 4]; return segDist(x, y, q[0], q[1], n[0], n[1]) <= r; });
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
  // (For text, its corners: looking at them is fine, but moving text is done with x and y.)
  function eachPoint(it, fn) { if (it.t === 'b') it.k.forEach(function (p) { eachPoint(p, fn); }); else if (it.t === 'f') it.d.forEach(function (ring) { ring.forEach(fn); }); else if (boxy(it)) textCorners(it).forEach(fn); else it.p.forEach(fn); }
  function shiftItem(it, dx, dy) { if (it.t === 'b') { it.k.forEach(function (p) { shiftItem(p, dx, dy); invalidate(p); }); return; } if (boxy(it)) { it.x += dx; it.y += dy; } else eachPoint(it, function (q) { q[0] += dx; q[1] += dy; }); }
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
      l.items.forEach(function (it) { if (it.t !== 'f' && it.t !== 'b' && !boxy(it)) { var path = new Path2D(itemD(it)); ctx.fill(path); ctx.stroke(path); } });
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

  // ---------- Hold the pen still at the end of a stroke: it becomes a clean shape (like QuickShape) ----------
  function dense(poly, step) {
    var out = [];
    for (var i = 0; i < poly.length - 1; i++) {
      var a = poly[i], b = poly[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (var j = 0; j < n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
    }
    out.push(poly[poly.length - 1].slice(0, 2));
    return out;
  }
  function recognize(raw) {
    var pts = raw.map(function (q) { return [q[0], q[1]]; });
    if (pts.length < 4) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, L = 0;
    pts.forEach(function (q, i) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); if (i) L += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]); });
    var D = Math.hypot(x1 - x0, y1 - y0); if (D < 8) return null;
    var A = pts[0], Bp = pts[pts.length - 1], ab = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]), step = Math.max(1, D / 80);
    // A line: nothing strays far from the straight line between the ends.
    if (ab > 0.75 * L) {
      var far = 0; pts.forEach(function (q) { far = Math.max(far, segDist(q[0], q[1], A[0], A[1], Bp[0], Bp[1])); });
      if (far < Math.max(3, 0.06 * ab)) return { name: 'line', pts: dense([A, Bp], step), closed: false };
    }
    var closed = ab < Math.max(0.22 * D, 0.12 * L);
    var c = [0, 0]; pts.forEach(function (q) { c[0] += q[0]; c[1] += q[1]; }); c[0] /= pts.length; c[1] /= pts.length;
    if (closed) {
      // An ellipse (or circle): from the spread of the points, then checked against them.
      var sxx = 0, syy = 0, sxy = 0;
      pts.forEach(function (q) { var dx = q[0] - c[0], dy = q[1] - c[1]; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
      sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
      var th = 0.5 * Math.atan2(2 * sxy, sxx - syy), qt = Math.round(th / (Math.PI / 2)) * Math.PI / 2;
      if (Math.abs(th - qt) < 0.12) th = qt;
      var ct = Math.cos(th), st2 = Math.sin(th);
      var ra = 0, rb = 0;
      pts.forEach(function (q) { var dx = q[0] - c[0], dy = q[1] - c[1]; ra = Math.max(ra, Math.abs(dx * ct + dy * st2)); rb = Math.max(rb, Math.abs(-dx * st2 + dy * ct)); });
      ra *= 0.97; rb *= 0.97;
      var err = 0;
      pts.forEach(function (q) { var dx = q[0] - c[0], dy = q[1] - c[1], u = (dx * ct + dy * st2) / ra, v = (-dx * st2 + dy * ct) / rb; err += Math.abs(Math.sqrt(u * u + v * v) - 1); });
      err /= pts.length;
      var corners = simplify(pts.concat([pts[0]]), 0.09 * D); corners.pop();
      var k = corners.length;
      if (err < 0.085 && k > 4) {
        if (Math.min(ra, rb) / Math.max(ra, rb) > 0.86) { var rr = (ra + rb) / 2; ra = rb = rr; }
        var n = Math.max(24, Math.round(Math.PI * (ra + rb) / step)), ell = [];
        for (var i = 0; i <= n; i++) { var t = i / n * Math.PI * 2, ex = ra * Math.cos(t), ey = rb * Math.sin(t); ell.push([c[0] + ex * ct - ey * st2, c[1] + ex * st2 + ey * ct]); }
        return { name: ra === rb ? 'circle' : 'ellipse', pts: ell, closed: true, c: c };
      }
      if (k === 3) return { name: 'triangle', pts: dense(corners.concat([corners[0]]), step), closed: true, c: c };
      if (k === 4) { // a rectangle (a square if nearly so), turned like the first side drawn
        var a = Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]);
        var qa = Math.round(a / (Math.PI / 2)) * Math.PI / 2; if (Math.abs(a - qa) < 0.12) a = qa; // nearly level: level
        var ca = Math.cos(-a), sa = Math.sin(-a);
        var rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
        pts.forEach(function (q) { var dx = q[0] - c[0], dy = q[1] - c[1], u = dx * ca - dy * sa, v = dx * sa + dy * ca; rx0 = Math.min(rx0, u); rx1 = Math.max(rx1, u); ry0 = Math.min(ry0, v); ry1 = Math.max(ry1, v); });
        var w = rx1 - rx0, h = ry1 - ry0;
        if (Math.min(w, h) / Math.max(w, h) > 0.88) { var m = (w + h) / 2, mx = (rx0 + rx1) / 2, my = (ry0 + ry1) / 2; rx0 = mx - m / 2; rx1 = mx + m / 2; ry0 = my - m / 2; ry1 = my + m / 2; }
        var back = function (u, v) { var cb = Math.cos(a), sb = Math.sin(a); return [c[0] + u * cb - v * sb, c[1] + u * sb + v * cb]; };
        var rect = [back(rx0, ry0), back(rx1, ry0), back(rx1, ry1), back(rx0, ry1), back(rx0, ry0)];
        return { name: 'rectangle', pts: dense(rect, step), closed: true, c: c };
      }
      // A star (points going out and in by turns), or a polygon with sides about the same: made regular.
      var radii = corners.map(function (q) { return Math.hypot(q[0] - c[0], q[1] - c[1]); });
      if (k >= 8 && k % 2 === 0) {
        var odd = radii.filter(function (_, i) { return i % 2; }), even = radii.filter(function (_, i) { return !(i % 2); });
        var mo = odd.reduce(function (s, x) { return s + x; }, 0) / odd.length, me = even.reduce(function (s, x) { return s + x; }, 0) / even.length;
        if (Math.max(mo, me) / Math.min(mo, me) > 1.4) {
          var outerFirst = me > mo, R1 = Math.max(mo, me), R0 = Math.min(mo, me), q0 = corners[outerFirst ? 0 : 1];
          var a0 = Math.atan2(q0[1] - c[1], q0[0] - c[0]), star = [];
          for (var j = 0; j <= k; j++) { var aj = a0 + j * Math.PI * 2 / k, rj = j % 2 ? R0 : R1; star.push([c[0] + rj * Math.cos(aj), c[1] + rj * Math.sin(aj)]); }
          return { name: 'star', pts: dense(star, step), closed: true, c: c };
        }
      }
      if (k >= 5 && k <= 8) {
        var mr = radii.reduce(function (s, x) { return s + x; }, 0) / k, dev = 0; radii.forEach(function (x) { dev = Math.max(dev, Math.abs(x - mr) / mr); });
        var poly = corners;
        if (dev < 0.2) { var b0 = Math.atan2(corners[0][1] - c[1], corners[0][0] - c[0]); poly = []; for (var m2 = 0; m2 < k; m2++) poly.push([c[0] + mr * Math.cos(b0 + m2 * Math.PI * 2 / k), c[1] + mr * Math.sin(b0 + m2 * Math.PI * 2 / k)]); }
        return { name: 'polygon', pts: dense(poly.concat([poly[0]]), step), closed: true, c: c };
      }
      return null;
    }
    // Open: a few straight sides (a corner, a zigzag) become exact straight lines.
    var bends = simplify(pts, 0.07 * D);
    if (bends.length >= 3 && bends.length <= 6) return { name: 'lines', pts: dense(bends, step), closed: false, c: c };
    return null;
  }

  // ---------- Distort: the map that takes one four-cornered shape onto another (perspective, skew, shear) ----------
  function homography(src, dst) {
    var A = [], B = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    for (var c = 0; c < 8; c++) { // Gaussian elimination
      var piv = c; for (var r2 = c + 1; r2 < 8; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[piv][c])) piv = r2;
      var t = A[c]; A[c] = A[piv]; A[piv] = t; var tb = B[c]; B[c] = B[piv]; B[piv] = tb;
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (var r3 = 0; r3 < 8; r3++) if (r3 !== c) { var f = A[r3][c] / A[c][c]; for (var k = c; k < 8; k++) A[r3][k] -= f * A[c][k]; B[r3] -= f * B[c]; }
    }
    var h = B.map(function (b, i) { return b / A[i][i]; });
    return function (q) { var w = h[6] * q[0] + h[7] * q[1] + 1; return [(h[0] * q[0] + h[1] * q[1] + h[2]) / w, (h[3] * q[0] + h[4] * q[1] + h[5]) / w]; };
  }

  // ---------- Text art → the outline of each letter, as pen lines (traced from the letters drawn big) ----------
  function textOutlines(it) {
    var S = Math.max(1, 160 / it.fs), pad = 6, sz = textSize(it);
    var W = Math.ceil(sz.w * S + pad * 2 + it.fs * S * 0.3), H = Math.ceil(sz.h * S + pad * 2);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.font = (it.fs * S) + 'px ' + (it.font || 'sans-serif'); ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
    String(it.txt).split('\n').forEach(function (l, i) { ctx.fillText(l, pad, pad + it.fs * S * (0.93 + 1.25 * i)); });
    var px = ctx.getImageData(0, 0, W, H).data, N = W * H, ink = new Uint8Array(N), lab = new Int32Array(N), rings = [];
    for (var i = 0; i < N; i++) ink[i] = px[i * 4 + 3] > 110 ? 1 : 0;
    // Each separate patch of ink (a letter, or the dot of an i), and each closed gap inside one (the hole of an o).
    var comp = 0, stack = new Int32Array(N);
    function region(seed, want) {
      comp++; var n = 0, top = 0, edge = false; stack[top++] = seed; lab[seed] = comp;
      while (top) {
        var c = stack[--top], x = c % W, y = (c - x) / W; n++;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        var nb = [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1];
        for (var k = 0; k < 4; k++) { var q = nb[k]; if (q >= 0 && !lab[q] && ink[q] === want) { lab[q] = comp; stack[top++] = q; } }
      }
      return { id: comp, n: n, edge: edge };
    }
    var regs = [];
    for (var j = 0; j < N; j++) if (!lab[j]) { var g = region(j, ink[j]); g.ink = ink[j]; g.seed = j; regs.push(g); }
    regs.forEach(function (g) {
      if (g.n < 5 || (!g.ink && g.edge)) return; // specks, and the space around the letters
      var m = new Uint8Array(N);
      for (var i2 = g.seed; i2 < N; i2++) if (lab[i2] === g.id) m[i2] = 1;
      var ring = trace(m, W, H);
      if (!ring || ring.length < 3) return;
      ring = simplify(ring, 0.45);
      var c = Math.cos(it.r || 0), sn = Math.sin(it.r || 0);
      rings.push(ring.map(function (q) {
        var lx = (q[0] + 0.5 - pad) / S, ly = (q[1] + 0.5 - pad) / S;
        return [it.x + lx * c - ly * sn, it.y + lx * sn + ly * c];
      }));
    });
    return rings;
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
    if (o.imageUrl) IMG.resolve = o.imageUrl;
    IMG.ready = function () { soon(); }; // an image file has arrived: draw it
    var ui = document.createElementNS(NS, 'svg'); ui.setAttribute('class', 'ink-ui'); stage.appendChild(ui);
    var bar = document.createElement('div'); bar.className = 'inkbar hidden'; (o.uiHost || stage).appendChild(bar);
    // Handles, tool circles and tap distances stay the same size on screen at any zoom.
    function Z() { return o.zoom ? o.zoom() : 1; }
    var tool = 'pen', opt = { pen: { b: 'pen', c: 'ink', s: 3, o: 1 }, erase: { m: 'stroke', s: 14 }, nudge: { m: 'nudge', r: 48, k: 0.8 }, fill: { m: 'tap', c: '#f2c94c', o: 1 },
      lasso: { m: 'most', how: 'loop', sc: 'all' },
      text: { font: '"Google Sans", Roboto, system-ui, sans-serif', fs: 32, c: 'ink', o: 1 } };
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
        var tg = e.tagName.toLowerCase();
        if (tg === 'g' || tg === 'text' || tg === 'image' || tg === 'rect') { e.insertAdjacentHTML('afterend', itemSvg(it)); e.remove(); } // a fading stroke (its mask moves too) or text
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
      // A home-made tip or line style, pencil grain, a blend, or ink that fades with pressure/tilt: drawn as it will
      // look, straight into its layer, while drawing (a plain line that changes on lifting the pen looked wrong).
      d.svgLive = !!(d.stroke.cs && DEFS[d.stroke.cs]) || !!B.grain || !!B.blend || !!(opt.pen.po || opt.pen.to);
      clearLive();
    }
    function dropLiveSvg(d) { if (d && d.liveEl) { d.liveEl.remove(); d.liveEl = null; } }
    function clearLive() { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height); live.style.display = 'none'; }
    function drawLive() {
      liveRaf = 0;
      var d = drag; if (!d || !d.stroke) return;
      var it = d.stroke, pts = d.pred && d.pred.length ? it.p.concat(d.pred) : it.p;
      if (d.svgLive) {
        var g = groupOf(d.layer); if (!g) return;
        if (!d.liveEl) { d.liveEl = document.createElementNS('http://www.w3.org/2000/svg', 'g'); d.liveEl.setAttribute('class', 'ink-livesvg'); g.appendChild(d.liveEl); }
        d.liveEl.innerHTML = itemSvg(Object.assign({}, it, { id: 'live' + it.id, p: pts.length > 1 ? pts : pts.concat([[pts[0][0] + 0.4, pts[0][1] + 0.4].concat(pts[0].slice(2))]) }));
        return;
      }
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
      if (sel && sel.warp && sel.quad) { // Distort: four corners (perspective) and four sides (skew / shear)
        var Q = sel.quad.map(function (q) { return [q[0] + M, q[1] + M]; });
        h += '<path d="M' + Q.map(function (q) { return q[0] + ' ' + q[1]; }).join('L') + 'Z" fill="none" stroke="var(--accent)" stroke-width="' + 1.5 * k + '" stroke-dasharray="' + 6 * k + ' ' + 4 * k + '"/>';
        Q.forEach(function (q) { h += '<rect x="' + (q[0] - 8 * k) + '" y="' + (q[1] - 8 * k) + '" width="' + 16 * k + '" height="' + 16 * k + '" rx="' + 3 * k + '" fill="var(--surface)" stroke="var(--accent)" stroke-width="' + 2 * k + '"/>'; });
        Q.forEach(function (q, i) { var n = Q[(i + 1) % 4], mx = (q[0] + n[0]) / 2, my = (q[1] + n[1]) / 2; h += '<circle cx="' + mx + '" cy="' + my + '" r="' + 6 * k + '" fill="var(--accent)"/>'; });
      } else if (sel && sel.box) {
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
      // A collective (items grouped across layers, text boxes too) comes along as one.
      var gs = {}, any = false; items.forEach(function (it) { if (it.g) { gs[it.g] = 1; any = true; } });
      bids.forEach(function (id) { var g = BX.groupOf(id); if (g) { gs[g] = 1; any = true; } });
      if (any) {
        layers.forEach(function (l) { if (editable(l)) l.items.forEach(function (it) { if (it.g && gs[it.g] && items.indexOf(it) < 0) items.push(it); }); });
        if (BX) BX.inGroups(gs).forEach(function (id) { if (bids.indexOf(id) < 0) bids.push(id); });
      }
      sel = { items: items, boxes: bids, box: selBox(items, bids) };
      renderBar(); drawUi();
    }
    function startWarp() {
      var b = sel.box, k = 1 / Z(), pd = 6 * k;
      sel.warp = true; sel.quad = [[b.x - pd, b.y - pd], [b.x + b.w + pd, b.y - pd], [b.x + b.w + pd, b.y + b.h + pd], [b.x - pd, b.y + b.h + pd]];
      if (sel.items.some(boxy) || sel.boxes.length) o.notice('Text art, images and text boxes move along but do not bend. Turn Text art into outlines to bend it.');
      drawUi();
    }
    function refreshBox() { if (sel) sel.box = selBox(sel.items, sel.boxes); }
    var SW = ['ink', '#c0392b', '#d9822b', '#f2c94c', '#2f855a', '#00796b', '#2b6cb0', '#7e57c2', '#ffffff'];
    function renderBar(mode) {
      if (!sel) return;
      var g0 = sel.items.length ? sel.items[0].g : sel.boxes.length ? BX.groupOf(sel.boxes[0]) : null;
      var grouped = !!g0 && sel.items.every(function (it) { return it.g === g0; }) && sel.boxes.every(function (id) { return BX.groupOf(id) === g0; });
      var count = sel.items.length + sel.boxes.length;
      var inkSel = sel.items.length > 0, h;
      var hasArt = sel.items.some(function (it) { return it.t === 'x'; });
      var isShape = sel.items.length === 1 && sel.items[0].t === 'b';
      if (mode === 'color') {
        var onlyImg = sel.items.every(function (it) { return it.t === 'i'; });
        h = (onlyImg ? '' : SW.map(function (c) { return '<button type="button" class="sw" data-c="' + c + '" style="background:' + colorOf(c) + '" aria-label="Colour"></button>'; }).join('')) +
          '<label class="op">Opacity <input type="range" min="5" max="100" value="' + Math.round((sel.items[0].o == null ? 1 : sel.items[0].o) * 100) + '" data-op></label><button type="button" data-act="back">Done</button>';
      } else if (mode === 'cop') { // the collective's own opacity, on top of each item's
        var co = sel.items.length ? sel.items[0].co || 1 : 1;
        h = '<label class="op">Collective opacity <input type="range" min="5" max="100" value="' + Math.round(co * 100) + '" data-cop></label><button type="button" data-act="back">Done</button>';
      } else if (mode === 'newnote') {
        h = '<button type="button" data-act="nn-copy" title="This note stays as it is">Copy to new note</button>' +
          '<button type="button" data-act="nn-move" title="It leaves this note">Extract to new note</button><button type="button" data-act="back">Cancel</button>';
      } else if (mode === 'bool') {
        var cur = isShape ? sel.items[0].op : '';
        var BI = function (op, label, d) {
          return '<button type="button" class="bop" data-bop="' + op + '"' + (cur === op ? ' aria-pressed="true"' : '') + '><svg viewBox="0 0 24 24" width="22" height="22">' + d + '</svg>' + label + '</button>';
        };
        var A1 = 'M3 6h11v11H3z', A2 = 'M9 9h12v12H9z', S = 'fill="currentColor"', E = 'fill="none" stroke="currentColor" stroke-width="1.5"';
        h = BI('union', 'Join', '<path d="' + A1 + 'M9 9h12v12H9z" ' + S + '/>') +
          BI('subtract', 'Cut out', '<path d="M3 6h11v3H9v8H3z" ' + S + '/><path d="' + A2 + '" ' + E + ' stroke-dasharray="2 2"/>') +
          BI('intersect', 'Overlap', '<path d="' + A1 + '" ' + E + '/><path d="' + A2 + '" ' + E + '/><path d="M9 9h5v8H9z" ' + S + '/>') +
          BI('exclude', 'Exclude', '<path d="M3 6h11v3H9v8H3z" ' + S + '/><path d="M14 9h7v12H9v-4h5z" ' + S + '/>') +
          (isShape ? '<button type="button" data-act="release" title="Back to separate parts, each in its own layer">Release</button>' : '') +
          '<button type="button" data-act="back">Done</button>';
      } else if (mode === 'arrange') {
        var I = function (act, label, d) { return '<button type="button" class="ic" data-arr="' + act + '" title="' + label + '" aria-label="' + label + '"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' + d + '</svg></button>'; };
        h = I('l', 'Align left', '<path d="M4 3v18M8 7h10M8 15h6"/>') + I('cx', 'Align centres', '<path d="M12 3v18M6 7h12M8 15h8"/>') + I('r', 'Align right', '<path d="M20 3v18M6 7h10M10 15h6"/>') +
          I('t', 'Align top', '<path d="M3 4h18M7 8v10M15 8v6"/>') + I('cy', 'Align middles', '<path d="M3 12h18M7 6v12M15 8v8"/>') + I('b', 'Align bottom', '<path d="M3 20h18M7 6v10M15 10v6"/>') +
          (count > 2 ? I('dx', 'Spread evenly across', '<path d="M4 4v16M20 4v16M10 8v8M14 8v8"/>') + I('dy', 'Spread evenly down', '<path d="M4 4h16M4 20h16M8 10h8M8 14h8"/>') : '') +
          (inkSel ? I('front', 'To the front', '<rect x="8" y="8" width="10" height="10" rx="1" fill="currentColor"/><path d="M5 15V5h10"/>') + I('fwd', 'Forward', '<rect x="8" y="8" width="10" height="10" rx="1"/><path d="M13 11v4M11 13h4"/><path d="M5 15V5h10"/>') +
            I('bwd', 'Backward', '<rect x="8" y="8" width="10" height="10" rx="1"/><path d="M11 13h4"/><path d="M5 15V5h10"/>') + I('back', 'To the back', '<rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor"/><path d="M18 9v9H9"/>') : '') +
          '<button type="button" data-act="back">Done</button>';
      } else if (mode === 'layer') {
        h = layers.slice().reverse().map(function (l) { return '<button type="button" data-tol="' + l.id + '">' + esc(l.name) + '</button>'; }).join('') + '<button type="button" data-act="back">Cancel</button>';
      } else {
        h = '<button type="button" data-act="dup">Duplicate</button><button type="button" data-act="del">Delete</button>' +
          (grouped ? '<button type="button" data-act="ungroup" title="The items go back to being separate">Break up</button><button type="button" data-act="cop">Opacity</button>'
            : count > 1 ? '<button type="button" data-act="group" title="Move, turn and fade these together, whatever layer each is on">Collective</button>' : '') +
          (inkSel ? '<button type="button" data-act="color">' + (sel.items.every(function (it) { return it.t === 'i'; }) ? 'Opacity' : 'Colour') + '</button>' : '') +
          (count > 1 || inkSel ? '<button type="button" data-act="arrange">Arrange</button>' : '') +
          (sel.items.length > 1 || isShape ? '<button type="button" data-act="bool" title="Join, cut out, overlap or exclude: the parts stay as they are">' + (isShape ? 'Shape' : 'Combine shapes') + '</button>' : '') +
          (sel.boxes.length && BX.hasImages(sel.boxes) ? '<button type="button" data-act="imgout" title="Each image becomes its own object on the page">Take images out</button>' : '') +
          (sel.items.length ? '<button type="button" data-act="warp" title="Drag the corners for perspective, the sides to skew">' + (sel.warp ? 'Done distorting' : 'Distort') + '</button>' : '') +
          (o.toNewNote ? '<button type="button" data-act="newnote" title="Copy or move this into a note of its own">To new note</button>' : '') +
          (sel.boxes.length ? '<button type="button" data-act="toart" title="Make this text part of the drawing">To Text art</button>' : '') +
          (hasArt ? '<button type="button" data-act="outline" title="Each letter becomes pen lines you can erase, nudge, fill or redraw">To outlines</button>' : '') +
          (hasArt ? '<button type="button" data-act="tobox" title="Make this normal, editable text">To text box</button>' : '') + (layers.length > 1 ? '<button type="button" data-act="layer">Layer</button>' : '') +
          (o.zoomTo ? '<button type="button" data-act="zoom">Zoom to</button>' : '') +
          ((sel.items.some(function (it) { return boxy(it) && it.r; }) || (sel.boxes.length && BX.turned(sel.boxes))) ? '<button type="button" data-act="straight">Straighten</button>' : '');
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
    bar.addEventListener('input', function (e) {
      if (e.target.dataset.cop == null || !sel) return;
      var v = +e.target.value / 100;
      sel.items.slice().forEach(function (it) { var t = own(it); if (v >= 1) delete t.co; else t.co = v; });
      if (sel.boxes.length) BX.setGroup(sel.boxes, BX.groupOf(sel.boxes[0]), v);
      render();
    });
    bar.addEventListener('change', function (e) { if (e.target.dataset.op != null) o.changed('ink'); if (e.target.dataset.cop != null) commit(); });
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !sel) return;
      var act = b.dataset.act;
      if (b.dataset.c) {
        var paint = function (it) { it.c = b.dataset.c; if (it.t === 'b') it.k.forEach(function (p) { if (p.t !== 'i') paint(p); }); };
        sel.items.slice().forEach(function (it) { paint(own(it)); }); done(); renderBar('color'); return;
      }
      if (b.dataset.tol) {
        var to = layers.filter(function (l) { return l.id === b.dataset.tol; })[0];
        sel.items.forEach(function (it) { var l = layerOf(it); if (l && l !== to) { l.items.splice(l.items.indexOf(it), 1); to.items.push(it); } });
        if (sel.boxes.length) BX.setLayer(sel.boxes, to.id);
        done(); renderBar(); return;
      }
      if (act === 'back') return renderBar();
      if (act === 'straight') { // text lines up with the page again
        sel.items.slice().forEach(function (it) { if (boxy(it) && it.r) { var t = own(it); t.r = 0; invalidate(t); } });
        if (sel.boxes.length) BX.straighten(sel.boxes);
        refreshBox(); render(); commit(); renderBar(); return;
      }
      if (act === 'zoom') { o.zoomTo(sel.box); return; }
      if (act === 'color' || act === 'layer' || act === 'cop' || act === 'arrange' || act === 'bool' || act === 'newnote') return renderBar(act);
      if (act === 'nn-copy' || act === 'nn-move') {
        // What is picked, with the layers it is on (their look kept), its text boxes, and where it all sits.
        var out = [], bb = selBox(sel.items, sel.boxes);
        layers.forEach(function (l) {
          var its = l.items.filter(function (it) { return sel.items.indexOf(it) > -1; });
          if (!its.length) return;
          var c = JSON.parse(JSON.stringify(l)); c.items = JSON.parse(JSON.stringify(its)); out.push(c);
        });
        var ok = o.toNewNote({ ink: out, boxes: BX.exportBoxes(sel.boxes), box: bb }, act === 'nn-move');
        if (ok !== false && act === 'nn-move') {
          sel.items.forEach(function (it) { var l = layerOf(it); if (l) l.items.splice(l.items.indexOf(it), 1); });
          if (sel.boxes.length) BX.remove(sel.boxes);
          setSel(null); done(); return;
        }
        renderBar(); return;
      }
      if (b.dataset.bop) { makeShape(b.dataset.bop); return; }
      if (act === 'warp') { if (sel.warp) { sel.warp = false; sel.quad = null; refreshBox(); drawUi(); } else startWarp(); renderBar(); return; }
      if (act === 'release') { releaseShape(); return; }
      if (b.dataset.arr) { arrange(b.dataset.arr); return; }
      if (act === 'toart') { // text boxes become Text art, in their layers, looking the same
        var specs = BX.toArt(sel.boxes), made = [];
        specs.forEach(function (s) {
          var L = layers.filter(function (l) { return l.id === s.lid; })[0] || layers[0];
          var it = { id: uid('x'), t: 'x', txt: s.txt, x: s.x, y: s.y, r: s.r || 0, fs: Math.round(s.fs * 10) / 10, font: s.font, c: 'ink', o: 1 };
          var g = BX.groupOf(s.id); if (g) { it.g = g; if (s.co) it.co = s.co; }
          L.items.push(it); made.push(it);
        });
        BX.remove(specs.map(function (s) { return s.id; }));
        render(); commit(); setSel(sel.items.concat(made), []); return;
      }
      if (act === 'imgout') { // images inside text boxes become free objects, where they were, in the box's layer
        var outs = BX.takeImages(sel.boxes), got = [];
        outs.forEach(function (s) {
          var L = layers.filter(function (l) { return l.id === s.lid; })[0] || layers[0];
          var it = { id: uid('i'), t: 'i', src: s.src, x: s.x, y: s.y, w: s.w, h: s.h, r: s.r || 0, c: 'ink', o: 1 };
          L.items.push(it); got.push(it);
        });
        render(); commit(); setSel(got, []); return;
      }
      if (act === 'outline') { // Text art → pen lines round each letter, kept together as a collective
        var arts2 = sel.items.filter(function (it) { return it.t === 'x'; }), made2 = [];
        var fontsReady = document.fonts && document.fonts.load ? Promise.all(arts2.map(function (it) { return document.fonts.load(it.fs + 'px ' + it.font, it.txt).catch(function () {}); })) : Promise.resolve();
        fontsReady.then(function () {
          arts2.forEach(function (it) {
            var l = layerOf(it); if (!l) return;
            var g = it.g || uid('g'), w = Math.max(0.8, it.fs * 0.035), at = l.items.indexOf(it);
            var lines = textOutlines(it).map(function (ring) {
              var p = ring.concat([ring[0]]).map(function (q) { return [q[0], q[1], 0.5]; });
              var s = { id: uid('s'), t: 's', b: 'marker', c: it.c, s: Math.round(w / BRUSH.marker.size * 100) / 100, o: it.o == null ? 1 : it.o, g: g, p: p };
              if (it.co) s.co = it.co;
              return s;
            });
            if (!lines.length) return;
            l.items.splice.apply(l.items, [at, 1].concat(lines));
            made2 = made2.concat(lines);
          });
          render(); commit(); setSel(sel ? sel.items.filter(function (it) { return arts2.indexOf(it) < 0; }).concat(made2) : made2, sel ? sel.boxes : []);
        });
        return;
      }
      if (act === 'tobox') { // Text art becomes normal text boxes
        var arts = sel.items.filter(function (it) { return it.t === 'x'; }), nb = [];
        arts.forEach(function (it) {
          var l = layerOf(it); if (!l) return;
          var id = BX.fromArt({ txt: it.txt, x: it.x, y: it.y, r: it.r, fs: it.fs, font: it.font, lid: l.id }, layers[0].id);
          if (it.g) BX.setGroup([id], it.g, it.co || 1); nb.push(id);
          l.items.splice(l.items.indexOf(it), 1);
        });
        render(); commit(); setSel(sel.items.filter(function (it) { return arts.indexOf(it) < 0; }), sel.boxes.concat(nb)); return;
      }
      if (act === 'del') { sel.items.forEach(function (it) { var l = layerOf(it); if (l) l.items.splice(l.items.indexOf(it), 1); }); if (sel.boxes.length) BX.remove(sel.boxes); setSel(null); done(); return; }
      if (act === 'dup') {
        var map = {}, copies = sel.items.map(function (it) {
          var c = JSON.parse(JSON.stringify(it)); c.id = uid(it.t);
          if (c.g) c.g = map[c.g] || (map[c.g] = uid('g'));
          shiftItem(c, 20, 20);
          (layerOf(it) || active()).items.push(c); return c;
        });
        var boxCopies = sel.boxes.length ? BX.dup(sel.boxes, 20, 20) : [];
        done(); setSel(copies, boxCopies); return;
      }
      if (act === 'group') { var g = uid('g'); sel.items.slice().forEach(function (it) { var t = own(it); t.g = g; delete t.co; }); if (sel.boxes.length) BX.setGroup(sel.boxes, g, 1); render(); commit(); renderBar(); return; }
      if (act === 'ungroup') { sel.items.slice().forEach(function (it) { var t = own(it); delete t.g; delete t.co; }); if (sel.boxes.length) BX.setGroup(sel.boxes, null); render(); commit(); renderBar(); return; }
    });

    // ---- Shapes: several items become one non-destructive boolean; the bottom one decides its layer and place ----
    function makeShape(op) {
      if (!sel) return;
      if (sel.items.length === 1 && sel.items[0].t === 'b') { // change what an existing shape does
        var t = own(sel.items[0]); t.op = op; invalidate(t); render(); commit(); renderBar('bool'); return;
      }
      var parts = [];
      layers.forEach(function (l, li) { l.items.forEach(function (it, ii) { if (sel.items.indexOf(it) > -1) parts.push({ it: it, l: l, li: li, ii: ii }); }); });
      if (parts.length < 2) { o.notice('Pick two or more drawings, Text art or images.'); return; }
      if (sel.boxes.length) o.notice('Text boxes stay as they are: turn them into Text art to use them in shapes.');
      var home = parts[0].l, at = parts[0].ii;
      var g0 = parts[0].it.g, sameG = parts.every(function (p) { return p.it.g === g0; });
      var shape = { id: uid('b'), t: 'b', op: op, c: 'ink', o: 1, k: parts.map(function (p) {
        var c = JSON.parse(JSON.stringify(p.it)); if (p.l !== home) c.L = p.l.id; delete c.g; delete c.co; return c;
      }) };
      if (sameG && g0) shape.g = g0;
      parts.slice().reverse().forEach(function (p) { p.l.items.splice(p.l.items.indexOf(p.it), 1); });
      home.items.splice(Math.min(at, home.items.length), 0, shape);
      render(); commit(); setSel([shape], sel.boxes.slice()); renderBar('bool');
    }
    function releaseShape() {
      if (!sel || sel.items.length !== 1 || sel.items[0].t !== 'b') return;
      var sh = sel.items[0], home = layerOf(sh); if (!home) return;
      var at = home.items.indexOf(sh), back = [];
      home.items.splice(at, 1);
      sh.k.forEach(function (p) {
        var c = JSON.parse(JSON.stringify(p)), to = home;
        if (c.L) { var l = layers.filter(function (x) { return x.id === c.L; })[0]; if (l && editable(l)) to = l; delete c.L; }
        if (sh.g) c.g = sh.g;
        if (to === home) home.items.splice(at++, 0, c); else to.items.push(c);
        back.push(c);
      });
      render(); commit(); setSel(back, []);
    }

    // ---- Align and arrange: each collective counts as one piece, each other item and text box as one ----
    function arrange(a) {
      if (!sel) return;
      if (a === 'front' || a === 'back' || a === 'fwd' || a === 'bwd') { // order within each item's own layer
        layers.forEach(function (l) {
          var its = l.items, isSel = function (it) { return sel.items.indexOf(it) > -1; };
          if (!its.some(isSel)) return;
          if (a === 'front') l.items = its.filter(function (it) { return !isSel(it); }).concat(its.filter(isSel));
          else if (a === 'back') l.items = its.filter(isSel).concat(its.filter(function (it) { return !isSel(it); }));
          else if (a === 'fwd') { for (var i = its.length - 2; i >= 0; i--) if (isSel(its[i]) && !isSel(its[i + 1])) { var t = its[i]; its[i] = its[i + 1]; its[i + 1] = t; } }
          else { for (var j = 1; j < its.length; j++) if (isSel(its[j]) && !isSel(its[j - 1])) { var u = its[j]; its[j] = its[j - 1]; its[j - 1] = u; } }
        });
        render(); commit(); renderBar('arrange'); return;
      }
      var units = [], byG = {};
      sel.items.forEach(function (it) { if (it.g) { if (!byG[it.g]) units.push(byG[it.g] = { items: [], boxes: [] }); byG[it.g].items.push(it); } else units.push({ items: [it], boxes: [] }); });
      sel.boxes.forEach(function (id) { var g = BX.groupOf(id); if (g) { if (!byG[g]) units.push(byG[g] = { items: [], boxes: [] }); byG[g].boxes.push(id); } else units.push({ items: [], boxes: [id] }); });
      if (units.length === 1) { // one collective on its own: line up its members
        units = units[0].items.map(function (it) { return { items: [it], boxes: [] }; }).concat(units[0].boxes.map(function (id) { return { items: [], boxes: [id] }; }));
      }
      units.forEach(function (u) { u.r = selBox(u.items, u.boxes); });
      units = units.filter(function (u) { return u.r; });
      if (units.length < 2) { o.notice('Pick two or more things to line up.'); return; }
      var B = sel.box, move = function (u, dx, dy) {
        if (!dx && !dy) return;
        u.items.forEach(function (it) { var t = own(it); shiftItem(t, dx, dy); invalidate(t); });
        u.boxes.forEach(function (id) { var r0 = BX.rect(id); BX.place(id, r0.x + dx, r0.y + dy); });
      };
      if (a === 'dx' || a === 'dy') {
        var X = a === 'dx', pos = function (u) { return X ? u.r.x : u.r.y; }, size = function (u) { return X ? u.r.w : u.r.h; };
        units.sort(function (p, q) { return pos(p) + size(p) / 2 - pos(q) - size(q) / 2; });
        var start = X ? B.x : B.y, span = X ? B.w : B.h, used = units.reduce(function (s, u) { return s + size(u); }, 0);
        var gap = (span - used) / (units.length - 1), at = start;
        units.forEach(function (u) { move(u, X ? at - u.r.x : 0, X ? 0 : at - u.r.y); at += size(u) + gap; });
      } else units.forEach(function (u) {
        var r0 = u.r;
        if (a === 'l') move(u, B.x - r0.x, 0);
        if (a === 'r') move(u, B.x + B.w - r0.x - r0.w, 0);
        if (a === 'cx') move(u, B.x + B.w / 2 - r0.x - r0.w / 2, 0);
        if (a === 't') move(u, 0, B.y - r0.y);
        if (a === 'b') move(u, 0, B.y + B.h - r0.y - r0.h);
        if (a === 'cy') move(u, 0, B.y + B.h / 2 - r0.y - r0.h / 2);
      });
      refreshBox(); render(); commit(); renderBar('arrange');
    }

    // ---- What the selection tools reach: all layers, the layer being worked on, or its group ----
    function inScope(l) {
      if (!editable(l)) return false;
      var sc = opt.lasso.sc || 'all'; if (sc === 'all') return true;
      var A = active(); if (sc === 'group' && A.gid) return l.gid === A.gid;
      return l === A;
    }
    function scopeId(id) { if (!id) return true; var l = layers.filter(function (x) { return x.id === id; })[0]; return !l || inScope(l); }
    function pickAt(p) { // the top thing under a tap: an item, or else a text box
      for (var li = layers.length - 1; li >= 0; li--) {
        if (!inScope(layers[li])) continue;
        for (var j = layers[li].items.length - 1; j >= 0; j--) if (hits(layers[li].items[j], p[0], p[1], 8 / Z())) return { it: layers[li].items[j] };
      }
      var bh = BX && BX.at(p[0], p[1], scopeId); return bh ? { box: bh } : null;
    }
    function toggleAt(p) { // the item selector: a tap adds to the selection, or takes away what is already in it
      var h = pickAt(p);
      if (!h) { setSel(null); return; }
      var items = sel ? sel.items.slice() : [], bids = sel ? sel.boxes.slice() : [];
      var g = h.it ? h.it.g : BX.groupOf(h.box);
      var isIn = h.it ? items.indexOf(h.it) > -1 : bids.indexOf(h.box) > -1;
      if (isIn) {
        items = items.filter(function (it) { return g ? it.g !== g : it !== h.it; });
        bids = bids.filter(function (id) { return g ? BX.groupOf(id) !== g : id !== h.box; });
      } else if (h.it) items.push(h.it); else bids.push(h.box);
      setSel(items, bids);
    }

    // ---- Transforming the selection: drag inside to move, the corner to scale, the knob to rotate ----
    function handleAt(p) {
      if (sel && sel.warp && sel.quad) {
        var kq = 1 / Z(), Qd = sel.quad;
        for (var i = 0; i < 4; i++) if (Math.hypot(p[0] - Qd[i][0], p[1] - Qd[i][1]) < 22 * kq) return 'warp' + i;
        for (var e = 0; e < 4; e++) { var n = Qd[(e + 1) % 4]; if (Math.hypot(p[0] - (Qd[e][0] + n[0]) / 2, p[1] - (Qd[e][1] + n[1]) / 2) < 20 * kq) return 'warp' + (4 + e); }
        return inPoly(p[0], p[1], Qd) ? 'move' : null;
      }
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
        borig: sel.boxes.map(function (id) { return BX.rect(id); }), q0: sel.quad ? sel.quad.map(function (q) { return q.slice(); }) : null };
    }
    function applyTransform(p) {
      var d = drag, ang = 0, s = 1;
      if (d.kind === 'rotate') ang = Math.atan2(p[1] - d.c[1], p[0] - d.c[0]) - Math.atan2(d.start[1] - d.c[1], d.start[0] - d.c[0]);
      if (d.kind === 'scale') {
        var a0 = (d.start[0] - d.tl[0]) + (d.start[1] - d.tl[1]), a1 = (p[0] - d.tl[0]) + (p[1] - d.tl[1]);
        s = Math.max(0.05, a0 > 1 ? a1 / a0 : 1);
      }
      var cos = Math.cos(ang), sin = Math.sin(ang), dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      var H = null;
      if (d.kind.indexOf('warp') === 0) {
        var wi = +d.kind.slice(4), q1 = d.q0.map(function (q) { return q.slice(); });
        if (wi < 4) { q1[wi][0] += dx; q1[wi][1] += dy; }
        else { var e1 = wi - 4, e2 = (e1 + 1) % 4; q1[e1][0] += dx; q1[e1][1] += dy; q1[e2][0] += dx; q1[e2][1] += dy; }
        H = homography(d.q0, q1); if (!H) return;
        d.q1 = q1; sel.quad = q1;
      } else if (d.q0) sel.quad = d.q0.map(function (q) { return [q[0] + dx, q[1] + dy]; }); // moving keeps the frame with it
      var map = H || function (q) {
        if (d.kind === 'move') return [q[0] + dx, q[1] + dy];
        if (d.kind === 'scale') return [d.tl[0] + (q[0] - d.tl[0]) * s, d.tl[1] + (q[1] - d.tl[1]) * s];
        var x = q[0] - d.c[0], y = q[1] - d.c[1];
        return [d.c[0] + x * cos - y * sin, d.c[1] + x * sin + y * cos];
      };
      var xf = function (it, src) {
        if (it.t === 'b') it.k.forEach(function (p, j) { xf(p, src.k[j]); });
        else if (it.t === 'f') it.d = src.d.map(function (ring) { return ring.map(map); });
        else if (boxy(it) && H) { // text art and images go where their middle goes (they do not bend)
          var cs0 = textCorners(src), cx0 = (cs0[0][0] + cs0[2][0]) / 2, cy0 = (cs0[0][1] + cs0[2][1]) / 2, mc = H([cx0, cy0]);
          it.x = src.x + mc[0] - cx0; it.y = src.y + mc[1] - cy0;
        }
        else if (boxy(it)) {
          var a0 = map([src.x, src.y]); it.x = a0[0]; it.y = a0[1];
          if (d.kind === 'rotate') it.r = (src.r || 0) + ang;
          if (d.kind === 'scale') { if (it.t === 'x') it.fs = Math.max(4, src.fs * s); else { it.w = Math.max(4, src.w * s); it.h = Math.max(4, src.h * s); } }
        }
        else { it.p = src.p.map(function (q) { var m = map(q); var o2 = [m[0], m[1], q[2]]; if (q[3] != null) o2.push(q[3]); return o2; }); if (d.kind === 'scale') it.s = src.s * s; }
        invalidate(it);
      };
      sel.items.forEach(function (it, i) { xf(it, d.orig[i]); });
      // Text boxes move with it: their corner follows (turning moves them round the middle); scaling changes their width.
      sel.boxes.forEach(function (id, i) {
        var r0 = d.borig[i]; if (!r0) return;
        if (d.kind === 'rotate' || H) { var c0 = map([r0.x + r0.w / 2, r0.y + r0.h / 2]); BX.place(id, c0[0] - r0.w / 2, c0[1] - r0.h / 2); }
        else { var q = map([r0.x, r0.y]); BX.place(id, q[0], q[1], d.kind === 'scale' ? Math.max(60, r0.w * s) : null); }
      });
      refreshBox(); patch(sel.items); if (H) drawUi();
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
        if (opt.lasso.how === 'tap') { drag = { pick: p }; return true; } // the item selector: tap to add or take away; a drag still moves
        drag = { lasso: [p], t: Date.now() }; setSel(null); return true;
      }
      if (tool === 'pen') {
        var L = active();
        if (!editable(L)) { o.notice(L.vis ? 'This layer is locked.' : 'This layer is hidden.'); return false; }
        var pen = opt.pen, isPen = ev.pointerType === 'pen';
        var it = { id: uid('s'), t: 's', b: pen.b, c: pen.c, s: pen.s, o: pen.o, p: [shapePt(p, isPen)] };
        if (pen.cs && DEFS[pen.cs]) it.cs = pen.cs; // a home-made tip or line style
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
      if (drag.kind) { if (Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > 6 / Z()) drag.far = true; if (drag.far) applyTransform(p); return; }
      if (drag.pick) return;
      if (drag.stroke && drag.snap) { // a clean shape: the pen now sizes and turns it (a line: moves its end)
        var S0 = drag.snap, it0 = drag.stroke;
        if (S0.name === 'line') { var e0 = S0.base[0]; it0.p = dense([e0, p], Math.max(1, 2 / Z())).map(function (q) { return [q[0], q[1], S0.pr].concat(S0.q3 != null ? [S0.q3] : []); }); }
        else {
          var v0 = [S0.at[0] - S0.c[0], S0.at[1] - S0.c[1]], v1 = [p[0] - S0.c[0], p[1] - S0.c[1]];
          var sc = Math.max(0.05, Math.hypot(v1[0], v1[1]) / Math.max(1e-6, Math.hypot(v0[0], v0[1]))), an = Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]);
          var ca2 = Math.cos(an) * sc, sa2 = Math.sin(an) * sc;
          it0.p = S0.base.map(function (q) { var dx = q[0] - S0.c[0], dy = q[1] - S0.c[1]; return [S0.c[0] + dx * ca2 - dy * sa2, S0.c[1] + dx * sa2 + dy * ca2, S0.pr].concat(S0.q3 != null ? [S0.q3] : []); });
        }
        drag.pred = null; liveSoon(); return;
      }
      if (drag.stroke) {
        var sp = drag.stroke.p, isPen = !!drag.stroke.f;
        if (opt.pen.snap !== false) { // still for a moment (and the line long enough)? then it becomes a shape
          var hs = drag.hold, cur = sp[sp.length - 1] || p;
          if (!hs || Math.hypot(p[0] - hs.x, p[1] - hs.y) > 5 / Z()) {
            clearTimeout(hs && hs.t);
            drag.hold = { x: p[0], y: p[1], t: setTimeout(function () { snapShape(); }, 550) };
          }
        }
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
            if (boxy(it) || it.t === 'b') return; // nudging bends lines; text, images and shapes are moved with Select
            var b = itemBox(it);
            if (p[0] < b.x - R || p[0] > b.x + b.w + R || p[1] < b.y - R || p[1] > b.y + b.h + R) return;
            var t = own(it);
            if (opt.nudge.m === 'smooth' ? smooth(t, p[0], p[1], R, k) : nudge(t, drag.last[0], drag.last[1], dx, dy, R, k)) { drag.any = true; patch([t]); }
          });
        });
        drag.last = p; drawUi(); return;
      }
    };
    function snapShape() {
      var d = drag; if (!d || !d.stroke || d.snap) return;
      var it = d.stroke, len = 0;
      for (var i = 1; i < it.p.length; i++) len += Math.hypot(it.p[i][0] - it.p[i - 1][0], it.p[i][1] - it.p[i - 1][1]);
      if (len < 30 / Z()) return;
      var sh = recognize(it.p); if (!sh) return;
      var pr = 0, q3 = null, n = 0;
      it.p.forEach(function (q) { pr += q[2] == null ? 0.5 : q[2]; if (q[3] != null) { q3 = (q3 || 0) + q[3]; n++; } });
      pr /= it.p.length; if (n) q3 /= n;
      var last = it.p[it.p.length - 1];
      d.snap = { name: sh.name, base: sh.pts, c: sh.c || sh.pts[0], at: [last[0], last[1]], pr: pr, q3: q3 };
      it.p = sh.pts.map(function (q) { return [q[0], q[1], pr].concat(q3 != null ? [q3] : []); });
      it.st = 0; // keep the corners sharp
      if (navigator.vibrate) navigator.vibrate(15);
      if (o.notice && !self._shapeHinted) { self._shapeHinted = true; o.notice(sh.name.charAt(0).toUpperCase() + sh.name.slice(1) + ': keep holding and move to size or turn it'); }
      liveSoon();
    }
    self.up = function (p) {
      var d = drag; drag = null;
      if (!d) return;
      if (d.hold) clearTimeout(d.hold.t);
      if (d.kind && !d.far && opt.lasso.how === 'tap' && d.kind === 'move') { toggleAt(d.start); return; } // a tap on the selection: in or out
      if (d.kind) { if (!d.far) return; refreshBox(); flushPatch(); commit(); return; }
      if (d.pick) { toggleAt(d.pick); return; }
      if (d.stroke) {
        cancelAnimationFrame(liveRaf); liveRaf = 0;
        if (d.stroke.p.length === 1) { var p0 = d.stroke.p[0]; d.stroke.p.push([p0[0] + 0.4, p0[1] + 0.4].concat(p0.slice(2))); }
        d.layer.items.push(d.stroke); invalidate(d.stroke);
        addEl(d.layer, d.stroke); dropLiveSvg(d);
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
          var hit = pickAt(p);
          setSel(hit ? hit.it ? [hit.it] : [] : null, hit && hit.box ? [hit.box] : []); return;
        }
        var picked = [];
        layers.forEach(function (l) {
          if (!inScope(l)) return;
          l.items.forEach(function (it) {
            var n = 0, inside = 0;
            eachPoint(it, function (q) { n++; if (inPoly(q[0], q[1], poly)) inside++; });
            // Partly: any of it inside the loop; Fully: all of it; Mostly (standard): at least half.
            var need = opt.lasso.m === 'part' ? 1 : opt.lasso.m === 'full' ? n : n / 2;
            if (n && inside >= need) picked.push(it);
          });
        });
        setSel(picked, BX ? BX.pick(poly, inPoly, opt.lasso.m, scopeId) : []);
      }
    };
    self.cancel = function () {
      if (drag && drag.stroke) { cancelAnimationFrame(liveRaf); liveRaf = 0; clearLive(); dropLiveSvg(drag); }
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
          if (it.t === 'i' || it.t === 'b' || !hits(it, p[0], p[1], r)) continue; // images and shapes are removed with Select › Delete, never rubbed out by accident
          var e = elOf(it);
          if (opt.erase.m === 'slice' && it.t !== 'f' && it.t !== 'x') {
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
      if (opt.fill.pt && DEFS[opt.fill.pt]) f.pt = opt.fill.pt; // a home-made pattern
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
    self.redraw = function () { layers.forEach(function (l) { l.items.forEach(invalidate); }); render(); }; // a tip, line style or pattern changed
    self.box = function () { var all = []; layers.forEach(function (l) { if (l.vis) all = all.concat(l.items); }); return unionBox(all); };
    self.setTool = function (t) { if (t !== 'text') finishText(); tool = t; if (t !== 'lasso') setSel(null); cursor = null; drawUi(); };
    self.tool = function () { return tool; };
    self.opts = function (k, v) {
      if (v) Object.assign(opt[k], v);
      if (k === 'text' && v && editing) styleEdit(); // the text being written takes the new look at once
      return opt[k];
    };

    // ---- Artistic text: tap the page with the Text tool to write; tap text to change it ----
    var editing = null;
    function styleEdit() {
      var e = editing, t = opt.text, lk = e.look = { font: t.font, fs: t.fs, c: t.c, o: t.o == null ? 1 : t.o }; // the saved text is only changed when writing ends
      var ta = e.ta;
      ta.style.font = lk.fs + 'px/1.25 ' + lk.font; ta.style.color = colorOf(lk.c); ta.style.opacity = lk.o;
      sizeEdit();
    }
    function sizeEdit() {
      var ta = editing.ta; ta.style.width = '10px'; ta.style.height = '10px';
      ta.style.width = (ta.scrollWidth + editing.look.fs * 0.6) + 'px'; ta.style.height = ta.scrollHeight + 'px';
    }
    function editText(it, isNew) {
      finishText();
      var ta = document.createElement('textarea');
      ta.className = 'ink-textedit'; ta.value = it.txt || ''; ta.setAttribute('wrap', 'off'); ta.spellcheck = true;
      ta.style.left = (it.x + M) + 'px'; ta.style.top = (it.y + M) + 'px';
      ta.style.transform = 'rotate(' + (it.r || 0) + 'rad)';
      stage.appendChild(ta);
      editing = { it: it, ta: ta, isNew: isNew, look: {} };
      opt.text = { font: it.font, fs: it.fs, c: it.c, o: it.o == null ? 1 : it.o };
      if (o.textLook) o.textLook(opt.text); // the Text card shows this text's font, size and colour
      styleEdit();
      var el = !isNew && elOf(it); if (el) el.style.visibility = 'hidden';
      ta.addEventListener('input', sizeEdit);
      ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') ta.blur(); });
      ta.addEventListener('blur', function () {
        setTimeout(function () {
          var a = document.activeElement; // a slider or colour on the Text card: still writing
          if (editing && editing.ta === ta && a !== ta && !(a && a.closest && a.closest('[data-keeps-text]'))) finishText();
        }, 0);
      });
      ta.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 20);
    }
    function finishText() {
      if (!editing) return;
      var e = editing; editing = null;
      var txt = e.ta.value.replace(/\s+$/, ''); e.ta.remove();
      var lk = e.look;
      if (e.isNew) {
        if (!txt) return;
        e.it.txt = txt; e.it.font = lk.font; e.it.fs = lk.fs; e.it.c = lk.c; e.it.o = lk.o;
        var L = active(); if (!editable(L)) { o.notice('This layer is locked or hidden.'); return; }
        L.items.push(e.it); invalidate(e.it); addEl(L, e.it); commit(); return;
      }
      var l = layerOf(e.it);
      if (!l) return;
      if (!txt) { var el0 = elOf(e.it); l.items.splice(l.items.indexOf(e.it), 1); if (el0) el0.remove(); commit(); return; }
      var it0 = e.it, changedLook = it0.font !== lk.font || it0.fs !== lk.fs || it0.c !== lk.c || (it0.o == null ? 1 : it0.o) !== lk.o;
      if (txt !== it0.txt || changedLook) { var t = own(it0); t.txt = txt; t.font = lk.font; t.fs = lk.fs; t.c = lk.c; t.o = lk.o; invalidate(t); render(); commit(); }
      else { var el1 = elOf(it0); if (el1) el1.style.visibility = ''; }
    }
    // A tap with the Text tool: on text (in a layer that can be changed), edit it; elsewhere, start new text there,
    // straight to the screen (angle), then it belongs to the page.
    self.textAt = function (p, angle) {
      for (var li = layers.length - 1; li >= 0; li--) {
        if (!editable(layers[li])) continue;
        for (var j = layers[li].items.length - 1; j >= 0; j--) {
          var it = layers[li].items[j];
          if (it.t === 'x' && hits(it, p[0], p[1], 6 / Z())) { setSel(null); editText(it, false); return; }
        }
      }
      if (editing) { finishText(); return; } // a tap elsewhere ends the writing
      var t = opt.text;
      setSel(null);
      var a = angle || 0; // the tap is about the middle of the first line: its top-left corner is a little "up" the text
      editText({ id: uid('x'), t: 'x', txt: '', x: p[0] + Math.sin(a) * t.fs * 0.6, y: p[1] - Math.cos(a) * t.fs * 0.6, r: Math.abs(a) > 0.01 ? Math.round(a * 1000) / 1000 : 0, fs: t.fs, font: t.font, c: t.c, o: t.o }, true);
    };
    self.finishText = finishText;
    // A new image on the page: in the layer being worked on, straight to the screen (angle), selected.
    self.addImage = function (src, x, y, w, h, angle) {
      var L = active(); if (!editable(L)) { o.notice('This layer is locked or hidden.'); return null; }
      var it = { id: uid('i'), t: 'i', src: src, x: x, y: y, w: w, h: h, r: Math.abs(angle || 0) > 0.01 ? Math.round(angle * 1000) / 1000 : 0, c: 'ink', o: 1 };
      L.items.push(it); render(); commit(); setSel([it], []); return it.id;
    };
    self.editingText = function () { return !!editing; };
    // Fonts arrive a moment after the page: measure and draw text again with them.
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () {
      var any = false; layers.forEach(function (l) { l.items.forEach(function (it) { if (it.t === 'x') { invalidate(it); any = true; } }); });
      if (any) { soon(); if (sel) { refreshBox(); drawUi(); } }
    });
    self.bounds = function () {
      var all = []; layers.forEach(function (l) { all = all.concat(l.items); });
      var b = unionBox(all); return b ? { r: b.x + b.w, b: b.y + b.h } : { r: 0, b: 0 };
    };
    self.shift = function (dx, dy) {
      layers.forEach(function (l) { l.items = l.items.map(function (it) { var c = JSON.parse(JSON.stringify(it)); shiftItem(c, dx, dy); return c; }); });
      render(); owned = new WeakSet();
    };
    self.clearSelection = function () { setSel(null); };
    self.selection = function () { return sel ? { items: sel.items.length, boxes: sel.boxes.length } : null; };
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

  // For moving drawings between notes: shift them, and give items, collectives and layers new ids.
  function shiftAll(layers, dx, dy) { layers.forEach(function (l) { l.items.forEach(function (it) { shiftItem(it, dx, dy); invalidate(it); }); }); }
  function freshIds(layers) {
    var lmap = {}, gmap = {};
    var re = function (it) { it.id = uid(it.t || 's'); if (it.g) it.g = gmap[it.g] || (gmap[it.g] = uid('g')); if (it.t === 'b') it.k.forEach(re); };
    layers.forEach(function (l) {
      var nid = uid('L'); lmap[l.id] = nid; l.id = nid;
      if (l.gid) l.gid = gmap['L' + l.gid] || (gmap['L' + l.gid] = uid('G'));
      l.items.forEach(re);
    });
    layers.forEach(function (l) { l.items.forEach(function fixL(it) { if (it.t === 'b') it.k.forEach(function (p) { if (p.L) p.L = lmap[p.L] || undefined; fixL(p); }); }); });
    return { layers: lmap, groups: gmap };
  }
  function boundsOf(layers) { var all = []; layers.forEach(function (l) { all = all.concat(l.items); }); return unionBox(all); }
  window.QNInk = { Engine: Engine, addDefs: addDefs, defs: DEFS, itemSvg: function (it) { return itemSvg(it); }, patternDef: patternDef, widthOf: widthOf, shiftAll: shiftAll, freshIds: freshIds, boundsOf: boundsOf, svgFor: function (layers, prefix, dx, dy, plain) { return markup(layers, prefix, dx, dy, plain); }, normalize: normalize, hasInk: hasInk, toJSON: toJSON, thumb: thumb, BRUSH: BRUSH, BLENDS: BLENDS, newLayer: newLayer,
    _test: { slice: slice, nudge: nudge, smooth: smooth, floodOutline: floodOutline, trace: trace, hits: hits, inPoly: inPoly } };
})();
