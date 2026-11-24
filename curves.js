// Serendipity (3.42): mathematical curves. A stroke may carry cv = { k: kind, c: [[x, y], …], w: [weights] (NURBS,
// T-spline), kn: [knots] (T-spline), cl: 1 (closed loop), pr: pressure, q3: ink strength }. Its points (p) are then
// worked out from cv, so the line keeps the brush's look but its shape comes only from its control points: a nudge
// moves a control point (or a straight line's end) instead of bending the line, and the eraser's slice leaves curves.
// Kinds:
//   line     straight lines through the points (two points: one straight line)
//   catmull  centripetal Catmull–Rom: a smooth curve through every point
//   bezier   cubic Bézier pieces: anchor, handle, handle, anchor, handle, handle, anchor…
//   bspline  cubic B-spline (uniform, clamped): the curve is pulled towards the points, ends on the first and last
//   nurbs    a B-spline whose points have weights (how hard each point pulls)
//   tspline  a NURBS with its own knots: adding a point inserts a knot, so the shape stays and only that part gets
//            finer control (on a single curve this is what T-splines' local refinement amounts to)
(function () {
  'use strict';
  var KINDS = [['line', 'Line', 'Straight lines from point to point'], ['catmull', 'Catmull-Rom', 'A smooth curve through every point'],
    ['bezier', 'Bézier', 'Anchors with handles, like Affinity\'s pen'], ['bspline', 'B-spline', 'Pulled smoothly towards the points'],
    ['nurbs', 'NURBS', 'A B-spline where each point has a weight (pull)'], ['tspline', 'T-spline', 'NURBS with local knots: adding a point keeps the shape']];
  var DEG = 3;
  function hyp(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function clone(cv) { return JSON.parse(JSON.stringify(cv)); }
  function spline(k) { return k === 'bspline' || k === 'nurbs' || k === 'tspline'; }
  function polyLen(c) { var L = 0; for (var i = 1; i < c.length; i++) L += hyp(c[i - 1], c[i]); return L; }

  // ---- Knots (clamped, uniform) ----
  function uniformKnots(n, p) { // n control points, degree p
    var kn = [], m = n + p + 1, inner = n - p;
    for (var i = 0; i < m; i++) kn.push(i <= p ? 0 : i >= n ? 1 : (i - p) / inner);
    return kn;
  }
  function degOf(n) { return Math.max(1, Math.min(DEG, n - 1)); }
  // A closed spline: the first points repeat at the end, with even (unclamped) knots.
  function splineSetup(cv) {
    var c = cv.c, n = c.length, w = cv.w && cv.w.length === n ? cv.w : null;
    if (cv.cl && n >= 3) {
      var p = Math.min(DEG, n - 1), P = c.concat(c.slice(0, p)), W = w ? w.concat(w.slice(0, p)) : null, N = P.length, kn = [];
      for (var i = 0; i < N + p + 1; i++) kn.push(i);
      return { P: P, W: W, kn: kn, p: p, t0: kn[p], t1: kn[N] };
    }
    var pd = degOf(n), kn2 = cv.kn && cv.kn.length === n + pd + 1 ? cv.kn : uniformKnots(n, pd);
    return { P: c, W: w, kn: kn2, p: pd, t0: kn2[pd], t1: kn2[n] };
  }
  function findSpan(kn, p, n, t) { // n = number of control points
    if (t >= kn[n]) return n - 1;
    var lo = p, hi = n;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (t < kn[mid]) hi = mid; else lo = mid; }
    return lo;
  }
  function deBoor(S, t) { // the point at t (rational when there are weights)
    var p = S.p, P = S.P, W = S.W, kn = S.kn, n = P.length, k = findSpan(kn, p, n, t), d = [];
    for (var j = 0; j <= p; j++) { var q = P[k - p + j], w = W ? W[k - p + j] : 1; d.push([q[0] * w, q[1] * w, w]); }
    for (var r = 1; r <= p; r++) for (var j2 = p; j2 >= r; j2--) {
      var i = k - p + j2, den = kn[i + p - r + 1] - kn[i], a = den ? (t - kn[i]) / den : 0;
      d[j2] = [(1 - a) * d[j2 - 1][0] + a * d[j2][0], (1 - a) * d[j2 - 1][1] + a * d[j2][1], (1 - a) * d[j2 - 1][2] + a * d[j2][2]];
    }
    return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
  }
  function basis(kn, p, n, t) { // all n basis functions at t (for fitting)
    var N = new Array(n).fill(0), k = findSpan(kn, p, n, t), B = [1], left = [], right = [];
    for (var j = 1; j <= p; j++) {
      left[j] = t - kn[k + 1 - j]; right[j] = kn[k + j] - t;
      var saved = 0, nb = [];
      for (var r = 0; r < j; r++) { var den = right[r + 1] + left[j - r], tmp = den ? B[r] / den : 0; nb[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp; }
      nb[j] = saved; B = nb;
    }
    for (var i = 0; i <= p; i++) N[k - p + i] = B[i];
    return N;
  }

  // ---- Catmull–Rom (centripetal) ----
  function crSeg(p0, p1, p2, p3, steps, out) {
    var a = 0.5, t0 = 0, t1 = t0 + Math.pow(Math.max(1e-6, hyp(p0, p1)), a), t2 = t1 + Math.pow(Math.max(1e-6, hyp(p1, p2)), a), t3 = t2 + Math.pow(Math.max(1e-6, hyp(p2, p3)), a);
    for (var s = 1; s <= steps; s++) {
      var t = t1 + (t2 - t1) * s / steps;
      var A1 = lerp(p0, p1, (t - t0) / (t1 - t0)), A2 = lerp(p1, p2, (t - t1) / (t2 - t1)), A3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      var B1 = lerp(A1, A2, (t - t0) / (t2 - t0)), B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
      out.push(lerp(B1, B2, (t - t1) / (t2 - t1)));
    }
  }
  function bez(a, b, c, d, t) { var u = 1 - t; return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]; }
  function stepsFor(len) { return Math.max(2, Math.min(64, Math.ceil(len / 3))); }

  // ---- The points of a curve, close enough together to look smooth at any zoom up to about 4× ----
  // Each sample also says which piece (seg) it belongs to and where along it (t), for inserting and breaking.
  function sampleT(cv) {
    var c = cv.c, n = c.length, out = [];
    if (!n) return out;
    if (n === 1) return [{ q: c[0].slice(0, 2), seg: 0, t: 0 }];
    var k = cv.k, cl = !!cv.cl && n >= 3;
    if (k === 'line') {
      var C = cl ? c.concat([c[0]]) : c;
      out.push({ q: C[0].slice(0, 2), seg: 0, t: 0 });
      for (var i = 1; i < C.length; i++) { // a few points along each straight piece, so brushes, slicing and hits behave as for a drawn line
        var ln = Math.max(1, Math.min(80, Math.ceil(hyp(C[i - 1], C[i]) / 6)));
        for (var j0 = 1; j0 <= ln; j0++) out.push({ q: j0 === ln ? C[i].slice(0, 2) : lerp(C[i - 1], C[i], j0 / ln), seg: i - 1, t: j0 / ln });
      }
      return out;
    }
    if (k === 'catmull') {
      var Pt = cl ? [c[n - 1]].concat(c, [c[0], c[1]]) : [lerp(c[0], c[1], -1)].concat(c, [lerp(c[n - 1], c[n - 2], -1)]);
      out.push({ q: c[0].slice(0, 2), seg: 0, t: 0 });
      var segs = cl ? n : n - 1;
      for (var s = 0; s < segs; s++) {
        var tmp = [], sn = stepsFor(hyp(Pt[s + 1], Pt[s + 2]));
        crSeg(Pt[s], Pt[s + 1], Pt[s + 2], Pt[s + 3], sn, tmp);
        tmp.forEach(function (q, j) { out.push({ q: q, seg: s, t: (j + 1) / sn }); });
      }
      return out;
    }
    if (k === 'bezier') {
      var Bc = c;
      if (cl && n >= 4 && (n - 1) % 3 === 0) Bc = c; // stored closed: the last anchor is the first one again
      out.push({ q: Bc[0].slice(0, 2), seg: 0, t: 0 });
      for (var b = 0; b + 3 < Bc.length; b += 3) {
        var bn = stepsFor(hyp(Bc[b], Bc[b + 1]) + hyp(Bc[b + 1], Bc[b + 2]) + hyp(Bc[b + 2], Bc[b + 3]));
        for (var j = 1; j <= bn; j++) out.push({ q: bez(Bc[b], Bc[b + 1], Bc[b + 2], Bc[b + 3], j / bn), seg: b / 3, t: j / bn });
      }
      if (out.length === 1) for (var e = 1; e < n; e++) out.push({ q: c[e].slice(0, 2), seg: 0, t: 1 }); // still being placed
      return out;
    }
    // B-spline, NURBS, T-spline
    var S = splineSetup(cv), total = Math.max(16, Math.min(900, Math.ceil(polyLen(S.P) / 2.5)));
    for (var m = 0; m <= total; m++) { var tt = S.t0 + (S.t1 - S.t0) * m / total; out.push({ q: deBoor(S, Math.min(tt, S.t1 - 1e-9 * (m === total ? 0 : 1))), seg: 0, t: tt }); }
    out[out.length - 1].q = deBoor(S, S.t1);
    return out;
  }
  function sample(cv) { return sampleT(cv).map(function (s) { return s.q; }); }
  // The stroke's points from its curve.
  function apply(it) {
    var pr = it.cv.pr == null ? 0.5 : it.cv.pr, q3 = it.cv.q3;
    var pts = sample(it.cv);
    if (pts.length === 1) pts.push([pts[0][0] + 0.4, pts[0][1] + 0.4]);
    it.p = pts.map(function (q) { var o = [Math.round(q[0] * 100) / 100, Math.round(q[1] * 100) / 100, pr]; if (q3 != null) o.push(q3); return o; });
    return it;
  }

  // ---- Fitting a curve to drawn points (a pen line → a curve, Trace, and the pieces left by slicing) ----
  function segDist(p, a, b) {
    var L = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]), t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / L)) : 0;
    return Math.hypot(a[0] + t * (b[0] - a[0]) - p[0], a[1] + t * (b[1] - a[1]) - p[1]);
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    var st = [[0, pts.length - 1]];
    while (st.length) {
      var s = st.pop(), a = s[0], b = s[1], best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) { var d = segDist(pts[i], pts[a], pts[b]); if (d > best) { best = d; bi = i; } }
      if (best > eps) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
    }
    return pts.filter(function (q, i) { return keep[i]; });
  }
  function clean(pts) {
    var out = [];
    pts.forEach(function (q) { var l = out[out.length - 1]; if (!l || hyp(l, q) > 0.3) out.push([q[0], q[1]]); });
    return out;
  }
  function crToBezier(c, cl) { // anchors → Bézier with smooth handles (Catmull–Rom tangents)
    var n = c.length, A = cl ? c.concat([c[0]]) : c, out = [A[0].slice(0, 2)];
    var at = function (i) { if (cl) return c[(i % n + n) % n]; return c[Math.max(0, Math.min(n - 1, i))]; };
    for (var i = 0; i + 1 < A.length; i++) {
      var p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      out.push([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2.slice(0, 2));
    }
    return out;
  }
  function solve(A, B) { // Gaussian elimination, A n×n, B n×2
    var n = A.length;
    for (var i = 0; i < n; i++) {
      var mx = i; for (var r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[mx][i])) mx = r;
      var t = A[i]; A[i] = A[mx]; A[mx] = t; var tb = B[i]; B[i] = B[mx]; B[mx] = tb;
      var piv = A[i][i]; if (Math.abs(piv) < 1e-12) return null;
      for (var r2 = i + 1; r2 < n; r2++) {
        var f = A[r2][i] / piv; if (!f) continue;
        for (var c2 = i; c2 < n; c2++) A[r2][c2] -= f * A[i][c2];
        B[r2] = [B[r2][0] - f * B[i][0], B[r2][1] - f * B[i][1]];
      }
    }
    var X = new Array(n);
    for (var i2 = n - 1; i2 >= 0; i2--) {
      var sx = B[i2][0], sy = B[i2][1];
      for (var c3 = i2 + 1; c3 < n; c3++) { sx -= A[i2][c3] * X[c3][0]; sy -= A[i2][c3] * X[c3][1]; }
      X[i2] = [sx / A[i2][i2], sy / A[i2][i2]];
    }
    return X;
  }
  function lsqSpline(Q, n) { // clamped cubic B-spline with n points through Q's ends, as close as can be to the rest
    var p = degOf(n), kn = uniformKnots(n, p), m = Q.length, u = [0], L = 0;
    for (var i = 1; i < m; i++) { L += hyp(Q[i - 1], Q[i]); u.push(L); }
    u = u.map(function (v) { return L ? v / L : 0; });
    var P = new Array(n); P[0] = Q[0].slice(0, 2); P[n - 1] = Q[m - 1].slice(0, 2);
    if (n > 2) {
      var k = n - 2, A = [], B = [];
      for (var a = 0; a < k; a++) { A.push(new Array(k).fill(0)); B.push([0, 0]); }
      for (var j = 1; j < m - 1; j++) {
        var N = basis(kn, p, n, u[j]), rx = Q[j][0] - N[0] * P[0][0] - N[n - 1] * P[n - 1][0], ry = Q[j][1] - N[0] * P[0][1] - N[n - 1] * P[n - 1][1];
        for (var r = 1; r < n - 1; r++) { if (!N[r]) continue; B[r - 1][0] += N[r] * rx; B[r - 1][1] += N[r] * ry; for (var c = 1; c < n - 1; c++) A[r - 1][c - 1] += N[r] * N[c]; }
      }
      for (var d = 0; d < k; d++) A[d][d] += 1e-6;
      var X = solve(A, B); if (!X) return null;
      for (var x = 0; x < k; x++) P[x + 1] = X[x];
    }
    return { c: P, kn: kn };
  }
  function maxErr(cv, Q) {
    var S = sample(cv), worst = 0, step = Math.max(1, Math.floor(Q.length / 60));
    for (var i = 0; i < Q.length; i += step) { var b = Infinity; for (var j = 1; j < S.length; j++) b = Math.min(b, segDist(Q[i], S[j - 1], S[j])); worst = Math.max(worst, b); }
    return worst;
  }
  // pts: the drawn points; tol: how close (page units) the curve should stay to them.
  function fit(pts, kind, tol, closed) {
    tol = tol || 1.5;
    var Q = clean(pts);
    if (Q.length < 2) Q = [pts[0].slice(0, 2), [pts[0][0] + 0.5, pts[0][1] + 0.5]];
    var cl = !!closed && Q.length > 6;
    if (cl && hyp(Q[0], Q[Q.length - 1]) < tol * 3) Q.pop();
    var cv = { k: kind };
    if (kind === 'line') cv.c = rdp(Q, tol * 2.5);
    else if (kind === 'catmull') cv.c = rdp(Q, tol * 1.4);
    else if (kind === 'bezier') { var an = rdp(Q, tol * 1.6); cv.c = an.length < 2 ? an : crToBezier(an, cl); }
    else {
      var target = Q.slice(); if (cl) target.push(Q[0]);
      var n = Math.max(4, Math.min(60, rdp(target, tol * 1.4).length + 1)), best = null;
      for (var tries = 0; tries < 5; tries++) {
        var f = lsqSpline(target, Math.min(n, target.length)); if (!f) break;
        best = f;
        if (maxErr({ k: 'bspline', c: f.c }, target) <= tol * 2 || n >= 60 || n >= target.length) break;
        n = Math.min(60, Math.round(n * 1.4) + 1);
      }
      if (!best) { cv.k = 'catmull'; cv.c = rdp(Q, tol * 1.4); }
      else { cv.c = best.c; if (kind !== 'bspline') cv.w = cv.c.map(function () { return 1; }); if (kind === 'tspline') cv.kn = best.kn; if (cl && kind !== 'tspline') { cv.c.pop(); /* the end repeats the start */ } }
      if (cl && kind === 'tspline') cl = false; // a T-spline stays open; its two ends meet
    }
    if (cl && kind !== 'tspline') cv.cl = 1;
    cv.c = cv.c.map(function (q) { return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]; });
    if (cv.w && cv.w.length !== cv.c.length) cv.w = cv.c.map(function () { return 1; });
    return cv;
  }
  // The same shape as another kind (the user can flip a curve between kinds).
  function convert(cv, kind, tol) {
    if (cv.k === kind) return clone(cv);
    var out = fit(sample(cv), kind, tol || 1, !!cv.cl);
    ['pr', 'q3'].forEach(function (f) { if (cv[f] != null) out[f] = cv[f]; });
    return out;
  }

  // ---- Editing ----
  function isAnchor(cv, i) { return cv.k !== 'bezier' || i % 3 === 0; }
  function nearest(cv, x, y, R) { // the control point within R of (x, y), anchors first
    var best = -1, bd = R;
    cv.c.forEach(function (q, i) { var d = Math.hypot(q[0] - x, q[1] - y) - (isAnchor(cv, i) ? 2 : 0); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  // Move control point i by (dx, dy). A Bézier anchor takes its handles with it; a handle keeps the other one in line.
  function movePt(cv, i, dx, dy, free) {
    var c = cv.c; if (!c[i]) return;
    c[i] = [c[i][0] + dx, c[i][1] + dy];
    if (cv.k !== 'bezier') return;
    var n = c.length;
    if (i % 3 === 0) {
      [i - 1, i + 1].forEach(function (h) { if (h >= 0 && h < n) c[h] = [c[h][0] + dx, c[h][1] + dy]; });
      if (cv.cl && (i === 0 || i === n - 1)) { var o = i === 0 ? n - 1 : 0, oh = i === 0 ? n - 2 : 1; c[o] = [c[o][0] + dx, c[o][1] + dy]; if (c[oh]) c[oh] = [c[oh][0] + dx, c[oh][1] + dy]; }
    } else if (!free) {
      var a = i % 3 === 1 ? i - 1 : i + 1, other = i % 3 === 1 ? i - 2 : i + 2;
      if (cv.cl && other < 0) other = n - 2; if (cv.cl && other >= n) other = 1;
      if (other >= 0 && other < n && c[a]) {
        var vx = c[i][0] - c[a][0], vy = c[i][1] - c[a][1], L = Math.hypot(vx, vy), oL = Math.hypot(c[other][0] - c[a][0], c[other][1] - c[a][1]);
        if (L > 1e-6) c[other] = [c[a][0] - vx / L * oL, c[a][1] - vy / L * oL];
      }
    }
  }
  // Where along the curve is nearest (x, y): {seg, t, q, d}
  function closestOn(cv, x, y) {
    var S = sampleT(cv), best = null;
    for (var i = 1; i < S.length; i++) {
      var a = S[i - 1].q, b = S[i].q, L = (b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]);
      var t = L ? Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / L)) : 0;
      var q = lerp(a, b, t), d = Math.hypot(q[0] - x, q[1] - y);
      if (!best || d < best.d) {
        var ta = S[i].seg === S[i - 1].seg ? S[i - 1].t : 0;
        best = { d: d, q: q, seg: S[i].seg, t: ta + (S[i].t - ta) * t, idx: i };
      }
    }
    return best;
  }
  function knotInsert(cv, t) { // Boehm's insertion: one more point, same shape
    var S = splineSetup(cv), p = S.p, kn = S.kn.slice(), P = cv.c, n = P.length, W = cv.w && cv.w.length === n ? cv.w : P.map(function () { return 1; });
    var k = findSpan(kn, p, n, t), NP = [], NW = [];
    for (var i = 0; i <= n; i++) {
      if (i <= k - p) { NP.push(P[i]); NW.push(W[i]); }
      else if (i > k) { NP.push(P[i - 1]); NW.push(W[i - 1]); }
      else {
        var a = (t - kn[i]) / ((kn[i + p] - kn[i]) || 1);
        var w = (1 - a) * W[i - 1] + a * W[i];
        NP.push([((1 - a) * P[i - 1][0] * W[i - 1] + a * P[i][0] * W[i]) / w, ((1 - a) * P[i - 1][1] * W[i - 1] + a * P[i][1] * W[i]) / w]); NW.push(w);
      }
    }
    kn.splice(k + 1, 0, t);
    cv.c = NP; cv.w = NW; cv.kn = kn;
  }
  // Add a point where (x, y) touches the curve. Returns the new point's index.
  function insertAt(cv, x, y) {
    var c = cv.c, n = c.length, h = closestOn(cv, x, y); if (!h) return -1;
    if (cv.k === 'line' || cv.k === 'catmull') { var at = h.seg + 1; c.splice(at, 0, cv.k === 'line' ? h.q : [x, y]); return at; }
    if (cv.k === 'bezier') { // de Casteljau split: same shape, one more anchor
      var b = h.seg * 3; if (b + 3 >= n) return -1;
      var t = h.t, P0 = c[b], P1 = c[b + 1], P2 = c[b + 2], P3 = c[b + 3];
      var a1 = lerp(P0, P1, t), a2 = lerp(P1, P2, t), a3 = lerp(P2, P3, t), b1 = lerp(a1, a2, t), b2 = lerp(a2, a3, t), m = lerp(b1, b2, t);
      c.splice(b + 1, 2, a1, b1, m, b2, a3);
      return b + 3;
    }
    if (cv.cl) { // a closed spline: put a point between the two control points nearest
      var bi = 0, bd = Infinity;
      for (var i = 0; i < n; i++) { var d = segDist([x, y], c[i], c[(i + 1) % n]); if (d < bd) { bd = d; bi = i; } }
      c.splice(bi + 1, 0, [x, y]); if (cv.w) cv.w.splice(bi + 1, 0, 1); return bi + 1;
    }
    var before = cv.c.map(function (q) { return q.slice(); }), hadKn = !!cv.kn, hadW = !!cv.w;
    knotInsert(cv, Math.max(1e-6, Math.min(1 - 1e-6, h.t)));
    // B-spline and NURBS go back to even knots (the shape shifts a little: the new point is a new handle on it);
    // a T-spline, or a curve with knots of its own (a broken-off part), keeps its knots: same shape, finer control.
    if (cv.k !== 'tspline' && !hadKn) { delete cv.kn; if (!hadW && cv.k === 'bspline') delete cv.w; }
    var bestI = 1, bD = Infinity; cv.c.forEach(function (q, i) { var d = Math.hypot(q[0] - h.q[0], q[1] - h.q[1]); if (d < bD) { bD = d; bestI = i; } });
    return before.length === cv.c.length ? -1 : bestI;
  }
  function removePt(cv, i) {
    var c = cv.c;
    if (cv.k === 'bezier') {
      if (c.length <= 4 || i % 3 !== 0) return false;
      if (i === 0) c.splice(0, 3); else if (i === c.length - 1) c.splice(c.length - 3, 3); else c.splice(i - 1, 3);
      return true;
    }
    if (c.length <= 2) return false;
    c.splice(i, 1); if (cv.w) cv.w.splice(i, 1);
    if (cv.kn) { var pd = degOf(c.length + 1), at = Math.max(pd + 1, Math.min(cv.kn.length - pd - 2, i + 1)); cv.kn.splice(at, 1); if (cv.kn.length !== c.length + degOf(c.length) + 1) delete cv.kn; }
    if (cv.cl && c.length < 3) delete cv.cl;
    return true;
  }
  // Add a point at the end (while placing points).
  function addPt(cv, q) {
    var c = cv.c;
    if (cv.k === 'bezier') {
      if (!c.length) { c.push(q); return 0; }
      var a = c[c.length - 1], prev = c.length >= 4 ? c[c.length - 4] : null, out = cv._out;
      var h1 = out || (prev ? [a[0] + (q[0] - prev[0]) / 6, a[1] + (q[1] - prev[1]) / 6] : lerp(a, q, 1 / 3));
      if (prev && !out && c.length >= 2) c[c.length - 2] = [a[0] - (q[0] - prev[0]) / 6, a[1] - (q[1] - prev[1]) / 6];
      delete cv._out;
      c.push(h1, lerp(a, q, 2 / 3).map(function (v, k) { return v + (q[k] - a[k]) * 0; }), q);
      c[c.length - 2] = [q[0] - (q[0] - a[0]) / 3, q[1] - (q[1] - a[1]) / 3];
      return c.length - 1;
    }
    c.push(q); if (cv.w) cv.w.push(1); delete cv.kn;
    return c.length - 1;
  }
  // Break at control point i (or where the curve was tapped): two open curves. Returns [cvA, cvB] or null.
  function breakAt(cv, i, x, y) {
    var c = cv.c, n = c.length;
    if (cv.cl) { // a loop breaks open at that point
      var o = clone(cv); delete o.cl;
      if (cv.k === 'bezier') { var j = i - i % 3; o.c = c.slice(j, n - 1).concat(c.slice(0, j + 1)); return [o]; }
      if (spline(cv.k)) { var S = sample(cv), h = closestOn(cv, x != null ? x : c[i][0], y != null ? y : c[i][1]); var Sr = S.slice(h.idx).concat(S.slice(1, h.idx)); return [fitLike(cv, Sr)]; }
      o.c = c.slice(i).concat(c.slice(0, i + 1)); if (o.w) o.w = cv.w.slice(i).concat(cv.w.slice(0, i + 1)); return [o];
    }
    if (cv.k === 'line' || cv.k === 'catmull') {
      if (i <= 0 || i >= n - 1) return null;
      var A = clone(cv), B = clone(cv); A.c = c.slice(0, i + 1); B.c = c.slice(i); return [A, B];
    }
    if (cv.k === 'bezier') {
      var a2 = i - i % 3; if (i % 3 === 2) a2 += 3; if (a2 <= 0 || a2 >= n - 1) return null;
      var A2 = clone(cv), B2 = clone(cv); A2.c = c.slice(0, a2 + 1); B2.c = c.slice(a2); return [A2, B2];
    }
    // splines: split exactly where the curve is nearest that point, by inserting the knot there until the curve
    // passes through it (same shape, two curves, no refitting)
    var S2 = sampleT(cv), h2 = closestOn(cv, x != null ? x : c[i][0], y != null ? y : c[i][1]);
    if (!h2 || h2.idx < 3 || h2.idx > S2.length - 3) return null;
    return splitSpline(cv, h2.t);
  }
  function splitSpline(cv, t) {
    var W = clone(cv), S = splineSetup(W), p = S.p;
    if (!W.kn || W.kn.length !== W.c.length + p + 1) W.kn = S.kn.slice();
    if (!W.w) W.w = W.c.map(function () { return 1; });
    var mult = function () { return W.kn.filter(function (v) { return Math.abs(v - t) < 1e-9; }).length; };
    for (var g = 0; g < p + 2 && mult() < p; g++) knotInsert(W, t);
    var kn = W.kn, s = -1;
    for (var j = 0; j < kn.length; j++) if (Math.abs(kn[j] - t) < 1e-9) { s = j; break; }
    if (s < 0) return null;
    var norm = function (k) { var a = k[0], b = k[k.length - 1]; return k.map(function (v) { return (v - a) / ((b - a) || 1); }); };
    var A = clone(cv), B = clone(cv);
    A.c = W.c.slice(0, s); A.kn = norm(kn.slice(0, s + p).concat([t])); A.w = W.w.slice(0, s);
    B.c = W.c.slice(s - 1); B.kn = norm([t].concat(kn.slice(s))); B.w = W.w.slice(s - 1);
    [A, B].forEach(function (o) { if (cv.k === 'bspline' && o.w.every(function (v) { return Math.abs(v - 1) < 1e-9; })) delete o.w; });
    if (A.c.length < 2 || B.c.length < 2) return null;
    return [A, B];
  }
  function fitLike(cv, pts) { var f = fit(pts, cv.k, 0.8, false); ['pr', 'q3'].forEach(function (k) { if (cv[k] != null) f[k] = cv[k]; }); return f; }
  function ends(cv) { var c = cv.c; return [c[0], c[c.length - 1]]; }
  // Join b onto a at the ends picked: one curve of a's kind.
  // endA / endB: which end of each (0 = its first point, 1 = its last), as the user picked them.
  function join(a, b, endA, endB) {
    var ea = ends(a), eb = ends(b), best = { o: [endA ? 1 : 0, endB ? 1 : 0] };
    best.d = hyp(ea[best.o[0]], eb[best.o[1]]);
    var A = clone(a), B = b.k === a.k ? clone(b) : convert(b, a.k, 0.8);
    var rev = function (cv) { cv.c.reverse(); if (cv.w) cv.w.reverse(); if (cv.kn) { var t1 = cv.kn[cv.kn.length - 1]; cv.kn = cv.kn.map(function (v) { return t1 - v; }).reverse(); } };
    if (best.o[0] === 0) rev(A);
    if (best.o[1] === 1) rev(B);
    var gap = best.d, aEnd = A.c[A.c.length - 1], bStart = B.c[0];
    if (A.k === 'line' || A.k === 'catmull') { A.c = A.c.concat(gap < 1 ? B.c.slice(1) : B.c); if (A.w) A.w = A.w.concat(B.w ? (gap < 1 ? B.w.slice(1) : B.w) : []); return A; }
    if (A.k === 'bezier') {
      var bridge = gap < 1 ? [] : [lerp(aEnd, bStart, 1 / 3), lerp(aEnd, bStart, 2 / 3), bStart];
      A.c = A.c.concat(bridge, B.c.slice(1)); return A;
    }
    // splines: one smooth fit through both
    var pts = sample(A).concat(sample(B)); return fitLike(A, pts);
  }
  function close(cv) {
    var o = clone(cv), c = o.c;
    if (c.length < 3 || o.k === 'tspline') { if (o.k === 'tspline') return fitLike(o, sample(o).concat([sample(o)[0]])); return null; }
    if (o.k === 'bezier') { if (c.length < 4) return null; var a = c[c.length - 1], s = c[0]; o.c = c.concat([lerp(a, s, 1 / 3), lerp(a, s, 2 / 3), s.slice()]); o.cl = 1; return o; }
    if (hyp(c[0], c[c.length - 1]) < 2) { c.pop(); if (o.w) o.w.pop(); }
    o.cl = 1; delete o.kn; return o;
  }
  window.QNCurves = { KINDS: KINDS, sample: sample, sampleT: sampleT, apply: apply, fit: fit, convert: convert, nearest: nearest, movePt: movePt,
    insertAt: insertAt, removePt: removePt, addPt: addPt, breakAt: breakAt, join: join, close: close, closestOn: closestOn, isAnchor: isAnchor, spline: spline, clone: clone };
})();
