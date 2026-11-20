// Drawing guides (3.24): a ruler, two set squares (45° and 30/60°) and a protractor that sit on the page.
// They are only helpers: the pen can follow their edges (a straight edge, or the protractor's curved rim), and
// they are not saved with the note. One set per open note (the engine makes one with QNGuides.create()).
// Positions are note coordinates; every size that must stay the same on screen is given as "screen px / zoom".
(function () {
  'use strict';

  var CM = 37.8; // one centimetre, in note units at 100% zoom
  var S = 1 / 3;
  var SQ30 = 1 / Math.sqrt(3);

  // The shapes, at size 1, around their own centre (y goes down). poly: outline; edges: pairs of poly indices the pen
  // can follow; rule: edges with marks (from, to, which side is inside); arc: the protractor's rim.
  var SHAPES = {
    ruler: { label: 'Ruler', poly: [[-285, -26], [285, -26], [285, 26], [-285, 26]], edges: [[0, 1], [1, 2], [2, 3], [3, 0]],
      rule: [[[-285, -26], [285, -26], [0, 1]], [[-285, 26], [285, 26], [0, -1], 1]], grip: [285, 26] },
    sq45: { label: 'Set square 45°', poly: [[-330 * S, -330 * S], [330 * (1 - S), -330 * S], [-330 * S, 330 * (1 - S)]], edges: [[0, 1], [1, 2], [2, 0]],
      rule: [[[-330 * S, -330 * S], [330 * (1 - S), -330 * S], [0, 1]], [[-330 * S, -330 * S], [-330 * S, 330 * (1 - S)], [1, 0]]], grip: [330 * (1 - S), -330 * S] },
    sq30: { label: 'Set square 30/60°', poly: [[-380 * S, -380 * SQ30 * S], [380 * (1 - S), -380 * SQ30 * S], [-380 * S, 380 * SQ30 * (1 - S)]], edges: [[0, 1], [1, 2], [2, 0]],
      rule: [[[-380 * S, -380 * SQ30 * S], [380 * (1 - S), -380 * SQ30 * S], [0, 1]], [[-380 * S, -380 * SQ30 * S], [-380 * S, 380 * SQ30 * (1 - S)], [1, 0]]], grip: [380 * (1 - S), -380 * SQ30 * S] },
    prot: { label: 'Protractor', r: 175, poly: null, edges: null, rule: null, grip: [175, 0] }
  };
  // The protractor: a half disc, its flat edge along the bottom, its rim above.
  (function () {
    var r = SHAPES.prot.r, n = 36, rim = [];
    for (var j = 1; j < n; j++) { var b = -Math.PI * j / n; rim.push([r * Math.cos(b), r * Math.sin(b)]); }
    SHAPES.prot.poly = [[-r, 0], [r, 0]].concat(rim); // the flat edge left to right, then the rim from the right end back round
    SHAPES.prot.edges = [[0, 1]];
    SHAPES.prot.dy = -r / 2; // the shape's middle, so it sits in the middle of the screen
  })();

  function rot(v, a) { var c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; }
  function top(sh) { var m = 0; (sh.poly || []).forEach(function (q) { if (q[1] < m) m = q[1]; }); return m; }
  function inPoly(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function f(n) { return Math.round(n * 100) / 100; }

  function create() {
    var list = []; // {k, x, y, a (radians), s (size)}, the last is in front
    var self = {}, hl = null, badge = null;
    function shape(g) { return SHAPES[g.k]; }
    function toW(g, q) { var r = rot([q[0] * g.s, q[1] * g.s], g.a); return [g.x + r[0], g.y + r[1]]; }
    function toL(g, p) { var r = rot([p[0] - g.x, p[1] - g.y], -g.a); return [r[0] / g.s, r[1] / g.s]; }
    function polyW(g) { return shape(g).poly.map(function (q) { return toW(g, q); }); }

    self.count = function () { return list.length; };
    self.has = function (k) { return list.some(function (g) { return g.k === k; }); };
    self.kinds = function () { return Object.keys(SHAPES); };
    self.label = function (k) { return SHAPES[k].label; };
    self.clear = function () { list = []; hl = null; badge = null; };
    // Put one on the page (c: the middle of what is on screen), or take it away if it is already there.
    self.toggle = function (k, c, a) {
      for (var i = 0; i < list.length; i++) if (list[i].k === k) { list.splice(i, 1); return false; }
      var sh = SHAPES[k], n = list.length;
      list.push({ k: k, x: c[0] + n * 24, y: c[1] - (sh.dy || 0) + n * 24, a: a || 0, s: 1 });
      return true;
    };

    // What is under the pen: its turning knob, its size handle, or the guide itself.
    function knob(g, k) { var r = rot([0, top(shape(g)) * g.s - 36 * k], g.a); return [g.x + r[0], g.y + r[1]]; } // 36 screen px above its top edge
    function grip(g) { return toW(g, shape(g).grip); }
    self.hit = function (p, tol) {
      for (var i = list.length - 1; i >= 0; i--) {
        var g = list[i], kn = knob(g, tol / 18), gp = grip(g), mode = null;
        if (Math.hypot(p[0] - kn[0], p[1] - kn[1]) < tol) mode = 'rot';
        else if (Math.hypot(p[0] - gp[0], p[1] - gp[1]) < tol) mode = 'size';
        else {
          var pw = polyW(g), near = false;
          for (var j = 0; j < pw.length; j++) if (segDist(p, pw[j], pw[(j + 1) % pw.length]) < tol * 0.6) { near = true; break; }
          if (near || inPoly(p, pw)) mode = 'move';
        }
        if (mode) { list.push(list.splice(i, 1)[0]); return { g: g, mode: mode, p0: [p[0], p[1]], x0: g.x, y0: g.y, a0: g.a, s0: g.s, r0: Math.atan2(p[1] - g.y, p[0] - g.x), d0: Math.max(1, Math.hypot(p[0] - g.x, p[1] - g.y)) }; }
      }
      return null;
    };
    self.drag = function (h, p) {
      var g = h.g;
      if (h.mode === 'move') { g.x = h.x0 + p[0] - h.p0[0]; g.y = h.y0 + p[1] - h.p0[1]; }
      else if (h.mode === 'size') { g.s = Math.max(0.4, Math.min(3, h.s0 * Math.hypot(p[0] - g.x, p[1] - g.y) / h.d0)); }
      else {
        var a = h.a0 + Math.atan2(p[1] - g.y, p[0] - g.x) - h.r0, step = Math.PI / 12, nearest = Math.round(a / step) * step; // sticks at every 15°
        if (Math.abs(a - nearest) < Math.PI / 72) a = nearest;
        g.a = a; badge = { g: g };
      }
    };
    self.end = function () { badge = null; };

    // Where the pen would snap: the nearest edge of any guide within tol. A straight edge or the protractor's rim.
    self.snap = function (p, tol) {
      var best = null;
      list.forEach(function (g, gi) {
        var sh = shape(g);
        sh.edges.forEach(function (e, ei) {
          var a = toW(g, sh.poly[e[0]]), b = toW(g, sh.poly[e[1]]), d = segDist(p, a, b);
          if (d < tol && (!best || d < best.d)) best = { t: 'l', a: a, b: b, d: d, gi: gi, ei: ei };
        });
        if (g.k === 'prot') {
          var l = toL(g, p), r = SHAPES.prot.r, dd = Math.abs(Math.hypot(l[0], l[1]) - r) * g.s;
          if (dd < tol && l[1] < 6 && (!best || dd < best.d)) best = { t: 'a', c: [g.x, g.y], r: r * g.s, g: g, d: dd, gi: gi };
        }
      });
      return best;
    };
    self.follow = function (lock, q) {
      if (lock.t === 'l') {
        var dx = lock.b[0] - lock.a[0], dy = lock.b[1] - lock.a[1], l2 = dx * dx + dy * dy, t = l2 ? ((q[0] - lock.a[0]) * dx + (q[1] - lock.a[1]) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        return [lock.a[0] + t * dx, lock.a[1] + t * dy];
      }
      var l = rot([q[0] - lock.c[0], q[1] - lock.c[1]], -lock.g.a), th = Math.atan2(l[1], l[0]);
      if (th > 0) th = l[0] < 0 ? -Math.PI : 0; // below the flat edge: the nearest end of the rim
      var w = rot([lock.r * Math.cos(th), lock.r * Math.sin(th)], lock.g.a);
      return [lock.c[0] + w[0], lock.c[1] + w[1]];
    };
    self.highlight = function (lock) { hl = lock ? { gi: lock.gi, ei: lock.ei, arc: lock.t === 'a' } : null; };

    // How they look: drawn in the note's overlay (M: the margin the overlay has around the note).
    self.svg = function (Z, M) {
      if (!list.length) return '';
      var k = 1 / Z, h = '', ns = ' vector-effect="non-scaling-stroke"';
      list.forEach(function (g, gi) {
        var sh = shape(g), deg = g.a * 180 / Math.PI, tf = 'translate(' + f(g.x + M) + ' ' + f(g.y + M) + ') rotate(' + f(deg) + ') scale(' + g.s + ')', body = '';
        if (g.k === 'prot') {
          var r = sh.r;
          body += '<path d="M' + -r + ' 0A' + r + ' ' + r + ' 0 0 1 ' + r + ' 0Z" fill="var(--accent)" fill-opacity=".1" stroke="var(--accent)" stroke-width="1.4"' + ns + '/>';
          var inner = r * 0.62;
          body += '<path d="M' + -inner + ' 0A' + inner + ' ' + inner + ' 0 0 1 ' + inner + ' 0" fill="none" stroke="var(--accent)" stroke-opacity=".4" stroke-width="1"' + ns + '/>';
          for (var d = 0; d <= 180; d += 5) {
            var a = -d * Math.PI / 180, long = d % 10 === 0, l1 = long ? 14 : 8, c = Math.cos(a), s = Math.sin(a);
            body += '<line x1="' + f(r * c) + '" y1="' + f(r * s) + '" x2="' + f((r - l1) * c) + '" y2="' + f((r - l1) * s) + '" stroke="var(--ink)" stroke-opacity=".7" stroke-width="1"' + ns + '/>';
            if (d % 30 === 0) body += '<text x="' + f((r - 28) * c) + '" y="' + f((r - 28) * s + 3) + '" font-size="10" text-anchor="middle" fill="var(--ink)" fill-opacity=".8">' + d + '</text>';
          }
          body += '<line x1="0" y1="-6" x2="0" y2="6" stroke="var(--accent)" stroke-width="1.4"' + ns + '/><line x1="-6" y1="0" x2="6" y2="0" stroke="var(--accent)" stroke-width="1.4"' + ns + '/>';
        } else {
          body += '<path d="M' + sh.poly.map(function (q) { return f(q[0]) + ' ' + f(q[1]); }).join('L') + 'Z" fill="var(--accent)" fill-opacity=".1" stroke="var(--accent)" stroke-width="1.4"' + ns + '/>';
          sh.rule.forEach(function (ru) {
            var a0 = ru[0], b0 = ru[1], n = ru[2], len = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]), ux = (b0[0] - a0[0]) / len, uy = (b0[1] - a0[1]) / len;
            for (var m = 0; m * CM / 10 <= len; m++) {
              var cm = m % 10 === 0, half = m % 5 === 0, tl = cm ? 12 : half ? 8 : 5;
              if (!cm && !half && Z < 0.7) continue;
              var px = a0[0] + ux * m * CM / 10, py = a0[1] + uy * m * CM / 10;
              body += '<line x1="' + f(px) + '" y1="' + f(py) + '" x2="' + f(px + n[0] * tl) + '" y2="' + f(py + n[1] * tl) + '" stroke="var(--ink)" stroke-opacity=".7" stroke-width="1"' + ns + '/>';
              if (cm && m > 0 && !ru[3]) body += '<text x="' + f(px + n[0] * 22) + '" y="' + f(py + n[1] * 22 + 3) + '" font-size="9" text-anchor="middle" fill="var(--ink)" fill-opacity=".8">' + (m / 10) + '</text>';
            }
          });
        }
        if (hl && hl.gi === gi) {
          if (hl.arc) { var rr = sh.r; body += '<path d="M' + -rr + ' 0A' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' 0" fill="none" stroke="var(--accent)" stroke-width="3.2"' + ns + '/>'; }
          else { var e = sh.edges[hl.ei], pa = sh.poly[e[0]], pb = sh.poly[e[1]]; body += '<line x1="' + f(pa[0]) + '" y1="' + f(pa[1]) + '" x2="' + f(pb[0]) + '" y2="' + f(pb[1]) + '" stroke="var(--accent)" stroke-width="3.2"' + ns + '/>'; }
        }
        h += '<g transform="' + tf + '">' + body + '</g>';
        // The knob (turn) and the corner (size), the same size at any zoom
        var kn = knob(g, k), gp = grip(g), base = toW(g, [0, top(sh)]);
        h += '<line x1="' + f(base[0] + M) + '" y1="' + f(base[1] + M) + '" x2="' + f(kn[0] + M) + '" y2="' + f(kn[1] + M) + '" stroke="var(--accent)" stroke-width="' + f(1.4 * k) + '"/>' +
          '<circle cx="' + f(kn[0] + M) + '" cy="' + f(kn[1] + M) + '" r="' + f(8 * k) + '" fill="var(--surface)" stroke="var(--accent)" stroke-width="' + f(2 * k) + '"/>' +
          '<rect x="' + f(gp[0] + M - 8 * k) + '" y="' + f(gp[1] + M - 8 * k) + '" width="' + f(16 * k) + '" height="' + f(16 * k) + '" rx="' + f(3 * k) + '" fill="var(--surface)" stroke="var(--accent)" stroke-width="' + f(1.6 * k) + '"/>';
        if (badge && badge.g === g) {
          var dg = Math.round(((g.a * 180 / Math.PI) % 360 + 360) % 360 * 10) / 10;
          h += '<text x="' + f(kn[0] + M + 14 * k) + '" y="' + f(kn[1] + M + 4 * k) + '" font-size="' + f(13 * k) + '" fill="var(--ink)" font-weight="600">' + dg + '°</text>';
        }
      });
      return h;
    };
    return self;
  }

  window.QNGuides = { create: create };
})();
