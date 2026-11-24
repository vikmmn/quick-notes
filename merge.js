// Serendipity (3.36): combining a note changed on two devices. Nothing is lost and nothing is asked.
// Three versions are compared: the shared original (what both devices last had from Drive), mine and theirs.
// - Text boxes, drawing items, layers and connectors are matched by id: added on either side stays; deleted on
//   one side and untouched on the other goes; changed on one side takes that change; edited on one side and
//   deleted on the other stays with the edit (an edit beats a delete).
// - A text box changed on both sides is combined paragraph by paragraph. Paragraphs changed on one side only take
//   that side; the same paragraph rewritten differently on both sides keeps both, each under a small label
//   ("from phone, 24 Nov 06:40").
// - With no shared original (notes from before 3.36), what both versions share counts as the original.
(function () {
  'use strict';

  function canon(v) { // the same value, written the same way whatever the key order
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
        .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function same(a, b) { return canon(a) === canon(b); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  // ---- Lists of paragraphs: a three-way merge (like diff3) ----
  function lcs(a, b) { // pairs [i, j] of equal entries, in order
    var n = a.length, m = b.length, i, j, t = [];
    for (i = 0; i <= n; i++) t.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    var out = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
      else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
    }
    return out;
  }
  function eqList(a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
  // o: original, a: mine, b: theirs. Returns { out: [...], clash: n }.
  function merge3(o, a, b, labelA, labelB) {
    var ma = {}, mb = {};
    lcs(o, a).forEach(function (p) { ma[p[0]] = p[1]; });
    lcs(o, b).forEach(function (p) { mb[p[0]] = p[1]; });
    var out = [], clash = 0, i = 0, j = 0, k = 0;
    function chunk(x, ea, eb) {
      var oc = o.slice(i, x), ac = a.slice(j, ea), bc = b.slice(k, eb);
      if (eqList(ac, oc)) out.push.apply(out, bc);
      else if (eqList(bc, oc)) out.push.apply(out, ac);
      else if (eqList(ac, bc)) out.push.apply(out, ac);
      else if (!oc.length) { // both added different paragraphs at the same place: keep both
        out.push.apply(out, ac); out.push.apply(out, bc.filter(function (p) { return ac.indexOf(p) < 0; }));
      } else if (!ac.length) out.push.apply(out, bc); // deleted on mine, changed on theirs: the change stays
      else if (!bc.length) out.push.apply(out, ac);
      else {
        // Inside a clash, a paragraph one side left as it was and the other deleted is deleted on both.
        var ac2 = ac.filter(function (p) { return !(oc.indexOf(p) > -1 && bc.indexOf(p) < 0); });
        var bc2 = bc.filter(function (p) { return !(oc.indexOf(p) > -1 && ac.indexOf(p) < 0); });
        if (!ac2.length || !bc2.length || eqList(ac2, bc2)) out.push.apply(out, ac2.length ? ac2 : bc2);
        else { clash++; out.push(labelA); out.push.apply(out, ac2); out.push(labelB); out.push.apply(out, bc2); }
      }
    }
    for (var x = 0; x < o.length; x++) {
      if (ma[x] == null || mb[x] == null || ma[x] < j || mb[x] < k) continue;
      chunk(x, ma[x], mb[x]);
      out.push(o[x]); i = x + 1; j = ma[x] + 1; k = mb[x] + 1;
    }
    chunk(o.length, a.length, b.length);
    return { out: out, clash: clash };
  }
  function paras(md) { md = String(md || '').replace(/\s+$/, ''); return md ? md.split(/\n{2,}/) : []; }
  function mergeText(o, a, b, ctx) {
    if (a === b) return a;
    if (o != null) { if (a === o) return b; if (b === o) return a; }
    var pa = paras(a), pb = paras(b);
    var po = o != null ? paras(o) : lcs(pa, pb).map(function (p) { return pa[p[0]]; });
    var r = merge3(po, pa, pb, '*' + ctx.labelA + '*', '*' + ctx.labelB + '*');
    if (r.clash) ctx.clashes += r.clash;
    return r.out.join('\n\n');
  }

  // ---- Objects with ids (text boxes, layers, drawing items, connectors) ----
  // fields: how to merge one object found on both sides that changed on both.
  function mergeById(oList, aList, bList, both, ctx) {
    var O = {}, A = {}, B = {};
    (oList || []).forEach(function (x) { if (x && x.id) O[x.id] = x; });
    (aList || []).forEach(function (x) { if (x && x.id) A[x.id] = x; });
    (bList || []).forEach(function (x) { if (x && x.id) B[x.id] = x; });
    var out = [];
    function one(id) {
      var o = O[id], a = A[id], b = B[id];
      if (a && b) {
        if (same(a, b)) return clone(a);
        if (o && same(a, o)) return clone(b);
        if (o && same(b, o)) return clone(a);
        return both(o, a, b, ctx);
      }
      var x = a || b;
      if (!o) return clone(x); // added on one side
      return same(x, o) ? null : clone(x); // deleted on the other side: gone, unless it was changed here (edit beats delete)
    }
    (aList || []).forEach(function (a) { if (a && a.id) { var r = one(a.id); if (r) out.push(r); } });
    // Theirs only: put each after the thing it followed on their side.
    (bList || []).forEach(function (b, bi) {
      if (!b || !b.id || A[b.id]) return;
      var r = one(b.id);
      if (!r) return;
      var at = -1;
      for (var p = bi - 1; p >= 0 && at < 0; p--) { var prev = bList[p] && bList[p].id; for (var q = 0; q < out.length; q++) if (out[q].id === prev) { at = q; break; } }
      out.splice(at + 1, 0, r);
    });
    return out;
  }
  // A plain object: each field from whichever side changed it; both changed: the newer side.
  function mergeFields(o, a, b, ctx, skip) {
    var r = {}, keys = {};
    [o || {}, a, b].forEach(function (x) { Object.keys(x).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      if (skip && skip[k]) return;
      var ov = o ? o[k] : undefined, av = a[k], bv = b[k], v;
      if (same(av, bv)) v = av;
      else if (o && same(av, ov)) v = bv;
      else if (o && same(bv, ov)) v = av;
      else v = ctx.mineNewer ? av : bv;
      if (v !== undefined) r[k] = clone(v);
    });
    return r;
  }
  function mergeBox(o, a, b, ctx) {
    var r = mergeFields(o, a, b, ctx, { md: 1 });
    r.md = mergeText(o ? o.md : null, a.md || '', b.md || '', ctx);
    return r;
  }
  function mergeLayer(o, a, b, ctx) {
    var r = mergeFields(o, a, b, ctx, { items: 1 });
    r.items = mergeById(o && o.items, a.items, b.items, function (oi, ai, bi) { return clone(ctx.mineNewer ? ai : bi); }, ctx);
    return r;
  }
  function mergeSet(o, a, b) { // labels: what each side added or removed
    o = o || []; a = a || []; b = b || [];
    var out = a.filter(function (x) { return b.indexOf(x) > -1 || o.indexOf(x) < 0; });
    b.forEach(function (x) { if (out.indexOf(x) < 0 && o.indexOf(x) < 0) out.push(x); });
    return out;
  }
  function pick(o, a, b, mineNewer) {
    if (same(a, b)) return clone(a);
    if (o !== undefined && same(a, o)) return clone(b);
    if (o !== undefined && same(b, o)) return clone(a);
    return clone(mineNewer ? a : b);
  }

  // The note: o (original, may be null), a (mine), b (theirs). Returns the combined fields and how many clashes.
  // opts: { mineNewer, labelA, labelB }
  function mergeNote(o, a, b, opts) {
    var ctx = { mineNewer: !!opts.mineNewer, labelA: opts.labelA, labelB: opts.labelB, clashes: 0 };
    var r = {};
    r.boxes = mergeById(o && o.boxes, a.boxes, b.boxes, mergeBox, ctx);
    if (!r.boxes.length) r.boxes = [{ id: 'b0', x: 0, y: 0, w: null, md: '' }];
    r.ink = mergeById(o && o.ink, a.ink, b.ink, mergeLayer, ctx);
    // An empty layer each side made on its own (every note starts with one): keep one, not two.
    var mineL = {}; (a.ink || []).forEach(function (l) { mineL[l.id] = 1; });
    var kept = r.ink.filter(function (l) { return (l.items && l.items.length) || mineL[l.id]; });
    r.ink = kept.length ? kept : r.ink.slice(0, 1);
    var ids = {}; r.boxes.forEach(function (x) { ids[x.id] = 1; });
    r.links = mergeById(o && o.links, a.links, b.links, function (ol, al, bl) { return mergeFields(ol, al, bl, ctx); }, ctx)
      .filter(function (l) { return ids[l.a] && ids[l.b]; });
    // The title: one side's change; both changed: the newer one, and the other one kept as the note's first line.
    var oT = o ? o.title || '' : undefined, aT = a.title || '', bT = b.title || '';
    r.title = pick(oT, aT, bT, ctx.mineNewer);
    var lost = r.title === aT ? bT : aT;
    if (aT !== bT && lost && (o ? lost !== oT : true) && r.title !== lost) {
      var first = r.boxes.slice().sort(function (x, y) { return (x.y - y.y) || (x.x - y.x); })[0];
      first.md = '*' + (r.title === aT ? ctx.labelB : ctx.labelA) + ', title:* ' + lost + (first.md ? '\n\n' + first.md : '');
      ctx.clashes++;
    }
    r.labels = mergeSet(o && o.labels, a.labels, b.labels);
    ['pinned', 'order', 'page'].forEach(function (k) { r[k] = pick(o ? o[k] : undefined, a[k], b[k], ctx.mineNewer); });
    r.updated = String(a.updated || '') > String(b.updated || '') ? a.updated : b.updated;
    r.clashes = ctx.clashes;
    return r;
  }

  window.QNMerge = { mergeNote: mergeNote, mergeText: function (o, a, b, la, lb) { var c = { labelA: la || 'mine', labelB: lb || 'theirs', clashes: 0 }; return mergeText(o, a, b, c); }, merge3: merge3, same: same };
})();
