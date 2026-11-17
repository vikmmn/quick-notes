// Serendip: search across every note on this device. Free, instant and offline.
// Matches word forms (plan, plans, planning), small typos (recieve -> receive), "exact phrases",
// and ranks titles and labels above body text and recent notes above old ones.
(function () {
  'use strict';
  var N = window.Notes;

  function norm(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); }
  function stem(w) {
    if (w.length <= 3) return w;
    return w.replace(/(ational|tional)$/, 'tion').replace(/(ies|ied)$/, 'y').replace(/(sses)$/, 'ss')
      .replace(/(ingly|edly)$/, '').replace(/(ing|ings)$/, '').replace(/(ed|er|ers)$/, '').replace(/(ly)$/, '')
      .replace(/(ment|ments|ness)$/, '').replace(/([^s])s$/, '$1').replace(/(.)\1$/, '$1') || w;
  }
  function words(s) { return norm(s).match(/[a-z0-9ऀ-ॿ]+/g) || []; }
  function near(a, b) { // at most one edit apart (for typos), only for words of 5+ letters
    if (Math.abs(a.length - b.length) > 1 || a.length < 5) return false;
    var i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++;
      else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  function parseQuery(q) {
    var phrases = [], rest = String(q || '').replace(/"([^"]+)"/g, function (_, p) { phrases.push(norm(p).trim()); return ' '; });
    var terms = words(rest).filter(function (w) { return w.length > 1 || /\d/.test(w); });
    return { phrases: phrases.filter(Boolean), terms: terms, stems: terms.map(stem) };
  }

  // Index is rebuilt per note only when the note changes (cached by its version).
  var cache = {};
  function indexOf(n) {
    var key = n.id, sig = n.v + ':' + n.updated + ':' + (n.title || '').length + ':' + (n.body || '').length;
    if (cache[key] && cache[key].sig === sig) return cache[key];
    var text = N.plainText(n.body || '');
    var ix = {
      sig: sig, text: text, ntext: norm(text), ntitle: norm(n.title), nlabels: norm((n.labels || []).join(' ')),
      title: {}, body: {}, labels: {}
    };
    words(n.title).forEach(function (w) { ix.title[stem(w)] = 1; });
    words(text).forEach(function (w) { var s = stem(w); ix.body[s] = (ix.body[s] || 0) + 1; });
    words((n.labels || []).join(' ')).forEach(function (w) { ix.labels[stem(w)] = 1; });
    ix.vocab = Object.keys(ix.body).concat(Object.keys(ix.title));
    cache[key] = ix;
    return ix;
  }

  function score(n, q) {
    var ix = indexOf(n), s = 0, matched = [];
    for (var i = 0; i < q.phrases.length; i++) {
      var ph = q.phrases[i];
      var inT = ix.ntitle.indexOf(ph) > -1, inB = ix.ntext.indexOf(ph) > -1;
      if (!inT && !inB) return null;
      s += (inT ? 12 : 0) + (inB ? 6 : 0); matched.push(ph);
    }
    for (var k = 0; k < q.stems.length; k++) {
      var st = q.stems[k], raw = q.terms[k], got = 0;
      if (ix.title[st]) got += 8;
      if (ix.labels[st]) got += 5;
      if (ix.body[st]) got += 3 + Math.min(3, ix.body[st]);
      if (!got && raw.length >= 3) { // the start of a word: "marg" finds "margins"
        if (ix.vocab.some(function (v) { return v.indexOf(st) === 0; })) got += 2;
      }
      if (!got && raw.length >= 5) { // a small typo
        var fuzzy = ix.vocab.filter(function (v) { return near(v, st); })[0];
        if (fuzzy) { got += 1.5; matched.push(fuzzy); }
      }
      if (!got) return null; // every word must be found somewhere
      s += got; matched.push(st);
    }
    var days = (Date.now() - new Date(n.updated).getTime()) / 86400000;
    s += Math.max(0, 2 - Math.log10(1 + Math.max(0, days))); // a little lift for recent notes
    if (n.pinned) s += 1;
    return { score: s, matched: matched };
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // A short piece of the note around the first match, with matches marked.
  function snippet(n, q, matched) {
    var ix = indexOf(n), text = ix.text.replace(/\s+/g, ' ').trim(), low = norm(text);
    var targets = q.phrases.concat(matched || []).filter(function (t, i, a) {
      return t && a.indexOf(t) === i && !q.phrases.some(function (p) { return p !== t && p.indexOf(t) > -1; });
    });
    var at = -1;
    targets.forEach(function (t) { var i = low.search(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); if (i > -1 && (at < 0 || i < at)) at = i; });
    var start = Math.max(0, at - 50), piece = text.slice(start, start + 180);
    var html = esc(piece);
    targets.sort(function (a, b) { return b.length - a.length; }).forEach(function (t) {
      html = html.replace(new RegExp('(\\b' + esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z0-9]*)', 'gi'), '<mark>$1</mark>');
    });
    return (start ? '…' : '') + html + (start + 180 < text.length ? '…' : '');
  }

  function run(notes, query) {
    var q = parseQuery(query);
    if (!q.phrases.length && !q.terms.length) return [];
    var out = [];
    notes.forEach(function (n) {
      var r = score(n, q);
      if (r) out.push({ note: n, score: r.score, snippet: snippet(n, q, r.matched) });
    });
    return out.sort(function (a, b) { return b.score - a.score; });
  }

  // Recent searches, kept on this device.
  function recent() { try { return JSON.parse(localStorage.getItem('qn-searches') || '[]'); } catch (e) { return []; } }
  function remember(q) {
    q = String(q || '').trim();
    if (q.length < 2) return;
    var list = [q].concat(recent().filter(function (x) { return x !== q; })).slice(0, 8);
    try { localStorage.setItem('qn-searches', JSON.stringify(list)); } catch (e) {}
  }
  function forget(q) { try { localStorage.setItem('qn-searches', JSON.stringify(recent().filter(function (x) { return x !== q; }))); } catch (e) {} }

  window.QNSearch = { run: run, recent: recent, remember: remember, forget: forget, stem: stem, near: near };
})();
