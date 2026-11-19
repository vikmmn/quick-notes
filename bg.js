// Serendipity — page backgrounds (3.23): a grid, a texture and a colour, one behind the other, under every layer.
// A note keeps its background as `page:` in its header: either the older words ("grid cream") or a small JSON
// object {g, gs, go, t, ts, to, c}: grid id, size, strength; texture id, size, strength; colour.
(function () {
  'use strict';

  // ---- Grids: one tile each, as SVG; L is the line colour, S the tile size (at size 1) ----
  var GRIDS = [
    ['square', 'Squares', 32, function (S, L) { return '<path d="M0 .5H' + S + 'M.5 0V' + S + '" stroke="' + L + '"/>'; }],
    ['square-s', 'Small squares', 16, function (S, L) { return '<path d="M0 .5H' + S + 'M.5 0V' + S + '" stroke="' + L + '"/>'; }],
    ['square-l', 'Big squares', 64, function (S, L) { return '<path d="M0 .5H' + S + 'M.5 0V' + S + '" stroke="' + L + '"/>'; }],
    ['graph', 'Graph paper', 80, function (S, L) { var h = ''; for (var i = 16; i < 80; i += 16) h += 'M0 ' + (i + .5) + 'H80M' + (i + .5) + ' 0V80'; return '<path d="' + h + '" stroke="' + L + '" stroke-opacity=".45"/><path d="M0 .75H80M.75 0V80" stroke="' + L + '" stroke-width="1.5"/>'; }],
    ['dots', 'Dots', 32, function (S, L) { return '<circle cx="1.5" cy="1.5" r="1.5" fill="' + L + '"/>'; }],
    ['dots-s', 'Small dots', 16, function (S, L) { return '<circle cx="1" cy="1" r="1" fill="' + L + '"/>'; }],
    ['dots-l', 'Big dots', 48, function (S, L) { return '<circle cx="2.5" cy="2.5" r="2.5" fill="' + L + '"/>'; }],
    ['journal', 'Journal dots', 80, function (S, L) { var h = ''; for (var x = 0; x < 80; x += 16) for (var y = 0; y < 80; y += 16) h += '<circle cx="' + (x + 1) + '" cy="' + (y + 1) + '" r="' + (x === 0 && y === 0 ? 2.2 : 1) + '" fill="' + L + '"/>'; return h; }],
    ['lines', 'Lines', 32, function (S, L) { return '<path d="M0 ' + (S - .5) + 'H' + S + '" stroke="' + L + '"/>'; }],
    ['lines-w', 'Wide lines', 48, function (S, L) { return '<path d="M0 ' + (S - .5) + 'H' + S + '" stroke="' + L + '"/>'; }],
    ['handwriting', 'Handwriting', 48, function (S, L) { return '<path d="M0 8.5H48M0 40.5H48" stroke="' + L + '"/><path d="M0 24.5H48" stroke="' + L + '" stroke-dasharray="4 4" stroke-opacity=".6"/>'; }],
    ['music', 'Music staff', 96, function (S, L) { var h = ''; for (var i = 0; i < 5; i++) h += 'M0 ' + (20 + i * 10 + .5) + 'H96'; return '<path d="' + h + '" stroke="' + L + '"/>'; }],
    ['calligraphy', 'Calligraphy', 64, function (S, L) { return '<path d="M0 .5H64M0 32.5H64" stroke="' + L + '"/><path d="M-8 64L14 0M24 64L46 0M56 64L78 0" stroke="' + L + '" stroke-opacity=".45"/>'; }],
    ['iso-dots', 'Isometric dots', [32, 55.43], function (S, L) { return '<circle cx="1.5" cy="1.5" r="1.5" fill="' + L + '"/><circle cx="17.5" cy="29.2" r="1.5" fill="' + L + '"/>'; }],
    ['iso', 'Isometric', [32, 55.43], function (S, L) { return '<path d="M0 .5H32M0 28.2H32M0 0L32 55.43M32 0L0 55.43M16 -27.7L48 27.7M-16 27.7L16 83.1M16 83.1L48 27.7M-16 27.7L16 -27.7" stroke="' + L + '"/>'; }],
    ['hex', 'Hexagons', [55.43, 32], function (S, L) { return '<path d="M0 16L9.24 0H27.7L36.95 16L27.7 32H9.24ZM36.95 16H55.43" fill="none" stroke="' + L + '"/>'; }],
    ['cross', 'Crosses', 32, function (S, L) { return '<path d="M0 .5H4M28 .5H32M.5 0V4M.5 28V32" stroke="' + L + '"/>'; }],
    ['dashed', 'Dashed squares', 32, function (S, L) { return '<path d="M0 .5H32M.5 0V32" stroke="' + L + '" stroke-dasharray="3 3"/>'; }],
    ['diagonal', 'Diagonal lines', 24, function (S, L) { return '<path d="M-6 6L6 -6M0 24L24 0M18 30L30 18" stroke="' + L + '"/>'; }],
    ['diamond', 'Diamonds', 32, function (S, L) { return '<path d="M0 16L16 0L32 16L16 32Z" fill="none" stroke="' + L + '"/>'; }],
    ['brick', 'Bricks', [48, 24], function (S, L) { return '<path d="M0 .5H48M0 12.5H48M.5 0V12M24.5 12V24" stroke="' + L + '"/>'; }],
    ['stitch', 'Cross-stitch', 16, function (S, L) { return '<path d="M0 .5H16M.5 0V16" stroke="' + L + '" stroke-opacity=".5"/><circle cx="8.5" cy="8.5" r="1" fill="' + L + '"/>'; }],
    ['zigzag', 'Zigzag', [32, 16], function (S, L) { return '<path d="M0 12L8 4L16 12L24 4L32 12" fill="none" stroke="' + L + '"/>'; }]
  ];

  // ---- Textures: drawn once by code into a small picture that repeats (no downloads) ----
  function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
  function valueNoise(N, cell, R) { // smooth noise: random values on a coarse grid, blended (wraps round the tile)
    var G = Math.ceil(N / cell), v = [], out = new Float32Array(N * N);
    for (var i = 0; i < G * G; i++) v.push(R());
    var at = function (x, y) { return v[((y % G) + G) % G * G + ((x % G) + G) % G]; }, sm = function (t) { return t * t * (3 - 2 * t); };
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = sm(gx - x0), fy = sm(gy - y0);
      var a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
      out[y * N + x] = a + (b - a) * fy;
    }
    return out;
  }
  // ---- Textures: whole surfaces with their own colour (paper, cloth, wood, steel, boards…), drawn once by code ----
  // Each: [id, name, base colour, f(N, R) → per pixel -1 (darker) … 1 (lighter), strength]. The colour can be changed.
  function streaks(N, R, rowsOnly) { var r = [], o = new Float32Array(N * N); for (var i = 0; i < N; i++) r.push(R() - .5); for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) o[y * N + x] = r[y] * 1.4 + (R() - .5) * .25; return o; }
  function fibres(o, N, R, n, len, amt) { for (var f = 0; f < n; f++) { var x = R() * N, y = R() * N, a = R() * Math.PI * 2, c = (R() - .5) * .15, s = R() < .5 ? -amt : amt; for (var t = 0; t < len; t++) { a += c; x += Math.cos(a); y += Math.sin(a); o[((Math.floor(y) % N + N) % N) * N + (Math.floor(x) % N + N) % N] += s; } } return o; }
  function specks(o, N, R, n, amt) { for (var f = 0; f < n; f++) o[Math.floor(R() * N) * N + Math.floor(R() * N)] += amt * (R() < .5 ? -1 : 1); return o; }
  function mix(N, parts) { var o = new Float32Array(N * N); parts.forEach(function (p) { for (var i = 0; i < N * N; i++) o[i] += (p[0][i] - (p[2] || 0)) * p[1]; }); return o; }
  function rnd(N, R) { var o = new Float32Array(N * N); for (var i = 0; i < N * N; i++) o[i] = R(); return o; }
  function wave(N, R, k, dir, warp, cell) { // stripes that bend (wood, marble); k whole stripes across the tile so it repeats
    var n = valueNoise(N, cell || 24, R), o = new Float32Array(N * N);
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) { var u = dir === 'y' ? y : dir === 'd' ? x + y : x; o[y * N + x] = Math.sin(2 * Math.PI * k * u / N + warp * n[y * N + x] * 6); }
    return o;
  }
  var TEXTURES = [
    ['plain', 'Plain colour', '#f6f3ea', function (N, R) { return new Float32Array(N * N); }, 0],
    ['paper', 'Paper', '#fbf9f3', function (N, R) { return mix(N, [[rnd(N, R), .5, .5], [valueNoise(N, 8, R), .5, .5]]); }, .5],
    ['cream', 'Cream paper', '#f4ecd8', function (N, R) { return mix(N, [[rnd(N, R), .45, .5], [valueNoise(N, 10, R), .6, .5]]); }, .5],
    ['handmade', 'Handmade paper', '#efe7d6', function (N, R) { return specks(fibres(mix(N, [[valueNoise(N, 6, R), 1.2, .5], [rnd(N, R), .5, .5]]), N, R, 90, 26, .5), N, R, 160, 1.2); }, .7],
    ['recycled', 'Recycled paper', '#e7e1d4', function (N, R) { return specks(mix(N, [[rnd(N, R), .5, .5], [valueNoise(N, 4, R), .6, .5]]), N, R, 420, 1.5); }, .7],
    ['rice', 'Rice paper', '#f7f3e8', function (N, R) { return fibres(mix(N, [[rnd(N, R), .2, .5]]), N, R, 80, 70, .7); }, .5],
    ['watercolour', 'Watercolour paper', '#f8f5ee', function (N, R) { return mix(N, [[valueNoise(N, 5, R), 1.6, .5], [valueNoise(N, 2, R), .5, .5]]); }, .6],
    ['kraft', 'Kraft paper', '#c49a6c', function (N, R) { return fibres(mix(N, [[rnd(N, R), .5, .5], [valueNoise(N, 12, R), .6, .5]]), N, R, 400, 12, .5); }, .7],
    ['parchment', 'Parchment', '#e9d9b0', function (N, R) { return mix(N, [[valueNoise(N, 40, R), 1.8, .5], [valueNoise(N, 9, R), .7, .5], [rnd(N, R), .25, .5]]); }, .7],
    ['crumpled', 'Crumpled paper', '#f2efe8', function (N, R) { var a = valueNoise(N, 26, R), b = valueNoise(N, 9, R), o = new Float32Array(N * N); for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) { var i = y * N + x, v = a[i] + b[i] * .4, vx = a[y * N + (x + 1) % N] + b[y * N + (x + 1) % N] * .4 - v, vy = a[((y + 1) % N) * N + x] + b[((y + 1) % N) * N + x] * .4 - v; o[i] = (vx * 1.3 + vy) * 22; } return o; }, .8],
    ['cardboard', 'Cardboard', '#b98d5f', function (N, R) { return mix(N, [[wave(N, R, 12, 'y', 0), .35], [rnd(N, R), .5, .5], [valueNoise(N, 16, R), .6, .5]]); }, .7],
    ['newsprint', 'Newsprint', '#e4e0d6', function (N, R) { var o = mix(N, [[rnd(N, R), .4, .5]]); for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) { var dx = (x % 8) - 4, dy = (y % 8) - 4; if (dx * dx + dy * dy < 4) o[y * N + x] -= .5; } return o; }, .5],
    ['linen', 'Linen', '#ece4d4', function (N, R) { var rows = [], cols = [], o = new Float32Array(N * N); for (var i = 0; i < N; i++) { rows.push(R() - .5); cols.push(R() - .5); } for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) o[y * N + x] = rows[y] * 1.1 + cols[x] * 1.1 + (R() - .5) * .3; return o; }, .7],
    ['canvas', 'Canvas', '#e9e2d2', function (N, R) { var o = new Float32Array(N * N); for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) o[y * N + x] = (((x >> 2) + (y >> 2)) % 2 ? Math.sin(x * Math.PI / 2) : Math.sin(y * Math.PI / 2)) * .6 + (R() - .5) * .4; return o; }, .7],
    ['cotton', 'Cotton cloth', '#f1f1ef', function (N, R) { var o = new Float32Array(N * N); for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) o[y * N + x] = ((x + y) % 2 ? .3 : -.3) + (R() - .5) * .5; return mix(N, [[o, .7], [valueNoise(N, 3, R), .6, .5]]); }, .6],
    ['denim', 'Denim', '#3c5a80', function (N, R) { var o = new Float32Array(N * N); for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) o[y * N + x] = Math.sin((x + y) * Math.PI / 3) * .6 + (R() - .5) * .6; return o; }, .7],
    ['felt', 'Felt', '#8a3b3b', function (N, R) { return mix(N, [[valueNoise(N, 2, R), 1.4, .5], [valueNoise(N, 6, R), .8, .5]]); }, .6],
    ['wood', 'Oak wood', '#c79a64', function (N, R) { return mix(N, [[wave(N, R, 7, 'y', .3, 64), .45], [streaks(N, R), .35], [rnd(N, R), .2, .5]]); }, .8],
    ['walnut', 'Walnut wood', '#6b4630', function (N, R) { return mix(N, [[wave(N, R, 9, 'y', .4, 64), .5], [streaks(N, R), .4]]); }, .8],
    ['birch', 'Birch plywood', '#e3cfa6', function (N, R) { return mix(N, [[wave(N, R, 5, 'y', .25, 64), .35], [streaks(N, R), .3], [rnd(N, R), .15, .5]]); }, .7],
    ['cork', 'Cork', '#b98a58', function (N, R) { var a = valueNoise(N, 4, R), o = new Float32Array(N * N); for (var i = 0; i < N * N; i++) o[i] = a[i] > .62 ? -1 : a[i] < .3 ? .5 : (a[i] - .5) * 1.4; return o; }, .7],
    ['steel', 'Brushed steel', '#a8adb3', function (N, R) { return mix(N, [[streaks(N, R), .8], [valueNoise(N, 64, R), .5, .5]]); }, .6],
    ['aluminium', 'Aluminium', '#c9ccd0', function (N, R) { return mix(N, [[streaks(N, R), .4], [rnd(N, R), .3, .5]]); }, .5],
    ['concrete', 'Concrete', '#a9a7a2', function (N, R) { return specks(mix(N, [[valueNoise(N, 20, R), 1.2, .5], [rnd(N, R), .6, .5]]), N, R, 300, 1.4); }, .7],
    ['slate', 'Slate stone', '#4b5157', function (N, R) { return mix(N, [[valueNoise(N, 30, R), 1.3, .5], [wave(N, R, 3, 'd', 1.2, 40), .25], [rnd(N, R), .3, .5]]); }, .7],
    ['marble', 'Marble', '#ecebe7', function (N, R) { var w = wave(N, R, 2, 'd', 1.6, 32), o = new Float32Array(N * N); for (var i = 0; i < N * N; i++) o[i] = -Math.pow(1 - Math.abs(w[i]), 6) * 1.2; return mix(N, [[o, 1], [valueNoise(N, 20, R), .4, .5]]); }, .8],
    ['leather', 'Leather', '#7a4b2e', function (N, R) { var a = valueNoise(N, 3, R), b = valueNoise(N, 14, R), o = new Float32Array(N * N); for (var i = 0; i < N * N; i++) o[i] = (Math.abs(a[i] - .5) < .06 ? -.8 : 0) + (b[i] - .5) * .9; return o; }, .7],
    ['whiteboard', 'Whiteboard', '#f7f8f8', function (N, R) { return mix(N, [[valueNoise(N, 48, R), .5, .5], [streaks(N, R), .08]]); }, .4],
    ['greenboard', 'Green board', '#2f5d46', function (N, R) { return specks(mix(N, [[valueNoise(N, 36, R), 1.1, .5], [valueNoise(N, 8, R), .4, .5]]), N, R, 120, .9); }, .7],
    ['blackboard', 'Blackboard', '#262a2b', function (N, R) { return specks(mix(N, [[valueNoise(N, 36, R), 1.1, .5], [valueNoise(N, 8, R), .4, .5]]), N, R, 120, .9); }, .7],
    ['blueprint', 'Blueprint', '#1f4e8c', function (N, R) { return mix(N, [[valueNoise(N, 40, R), .8, .5], [rnd(N, R), .3, .5]]); }, .6],
    ['sand', 'Sand', '#dcc79a', function (N, R) { var o = new Float32Array(N * N); for (var i = 0; i < N * N; i++) { var r = R(); o[i] = r < .1 ? -1 : r > .92 ? 1 : (R() - .5) * .3; } return o; }, .6],
    ['night', 'Dark paper', '#1d1d22', function (N, R) { return mix(N, [[rnd(N, R), .5, .5], [valueNoise(N, 10, R), .5, .5]]); }, .5]
  ];
  var texCache = {};
  function hexRgb(h) { var m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [246, 243, 234]; var n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function textureUrl(id, colour) {
    var T = TEXTURES.filter(function (t) { return t[0] === id; })[0]; if (!T) return '';
    var key = id + '|' + (colour || ''); if (texCache[key]) return texCache[key];
    var N = 256, R = rng(7 + id.length * 131 + id.charCodeAt(0)), vals = T[3](N, R), base = hexRgb(colour || T[2]), k = T[4];
    var cv = document.createElement('canvas'); cv.width = cv.height = N;
    var g = cv.getContext('2d'), im = g.createImageData(N, N);
    for (var i = 0; i < N * N; i++) {
      var v = Math.max(-1, Math.min(1, vals[i] * k)) * 0.35;
      for (var c = 0; c < 3; c++) im.data[i * 4 + c] = Math.round(v > 0 ? base[c] + (255 - base[c]) * v : base[c] * (1 + v));
      im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return (texCache[key] = cv.toDataURL('image/png'));
  }

  var COLOURS = ['#ffffff', '#fbf8f1', '#f6efdc', '#efe6cf', '#e8dcc0', '#c9a77c', '#d9d9d6', '#bfc5cc', '#e6eef5', '#dfeee6', '#f6e3e3', '#efe4f6',
    '#fff5c2', '#ffe0b2', '#c8e6c9', '#b3e5fc', '#f8bbd0', '#d1c4e9', '#8aa8c4', '#7c9a6d', '#c0392b', '#d9822b', '#2b6cb0', '#2f855a', '#7e57c2',
    '#2f3640', '#1f3b57', '#173f3a', '#3b2f2f', '#2b2238', '#111113', '#000000'];
  var LEGACY = { white: '#ffffff', cream: '#f6efdc', kraft: '#c9a77c', grey: '#d9d9d6', slate: '#2f3640', black: '#111113' };

  // A note's background: {g: grid, gs: size, go: strength, gc: line colour, gv: false when hidden;
  //                        t: texture, ts: size, tc: colour, tv: false when hidden}
  function parse(page) {
    var s = String(page || '').trim(), o = {};
    if (s.charAt(0) === '{') { try { o = JSON.parse(s); } catch (e) { o = {}; } }
    else s.split(/\s+/).forEach(function (w) { if (/^(grid|dots|lines)$/.test(w)) o.g = w === 'grid' ? 'square' : w; else if (LEGACY[w]) { o.t = 'plain'; o.tc = LEGACY[w]; } });
    if (o.c && !o.t) { o.t = 'plain'; o.tc = o.c; delete o.c; } // (3.23 drafts)
    return o;
  }
  function stringify(o) {
    var x = {}; ['g', 'gs', 'go', 'gc', 'gv', 't', 'ts', 'tc', 'tv'].forEach(function (k) { if (o[k] != null && o[k] !== '' && !((k === 'gs' || k === 'ts') && o[k] === 1) && !((k === 'gv' || k === 'tv') && o[k] !== false)) x[k] = o[k]; });
    return Object.keys(x).length ? JSON.stringify(x) : '';
  }
  function isDark(hex) { var c = hexRgb(hex); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) < 128; }
  function surfaceColour(o) { var T = o.t && TEXTURES.filter(function (t) { return t[0] === o.t; })[0]; return T ? (o.tc || T[2]) : ''; }
  function gridTile(id, line, k) {
    var G = GRIDS.filter(function (g) { return g[0] === id; })[0]; if (!G) return null;
    var w = Array.isArray(G[2]) ? G[2][0] : G[2], h = Array.isArray(G[2]) ? G[2][1] : G[2];
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" fill="none">' + G[3](w, line) + '</svg>';
    return { url: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")', w: w * k, h: h * k };
  }
  function rgba(hex, a) { var c = hexRgb(hex); return 'rgba(' + c.join(',') + ',' + a + ')'; }
  // The CSS for a background: grid over texture, their sizes, and the ink colour that reads on it.
  function css(page, themeDark) {
    var o = parse(page), surf = o.tv === false ? '' : surfaceColour(o), dark = surf ? isDark(surf) : themeDark;
    var gs = o.gs || 1, ts = o.ts || 1, go = o.go == null ? 0.18 : o.go;
    var line = o.gc ? rgba(o.gc, Math.min(1, go * 2.2)) : (dark ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + go + ')';
    var imgs = [], sizes = [];
    var gt = o.gv !== false && o.g && gridTile(o.g, line, gs);
    if (gt) { imgs.push(gt.url); sizes.push(gt.w.toFixed(2) + 'px ' + gt.h.toFixed(2) + 'px'); }
    var tu = surf && o.t !== 'plain' && textureUrl(o.t, o.tc);
    if (tu) { imgs.push('url("' + tu + '")'); sizes.push((256 * ts).toFixed(1) + 'px ' + (256 * ts).toFixed(1) + 'px'); }
    return { image: imgs.join(', '), size: sizes.join(', '), color: surf || '', ink: surf ? (dark ? '#f1ece3' : '#1b1b1f') : '', any: !!(gt || surf) };
  }
  window.QNBg = { GRIDS: GRIDS, TEXTURES: TEXTURES, COLOURS: COLOURS, parse: parse, stringify: stringify, css: css, textureUrl: textureUrl, gridTile: gridTile, isDark: isDark, surfaceColour: surfaceColour };
})();
