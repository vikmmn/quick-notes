// Serendipity: a one-time copy of an Obsidian vault (a folder on this computer) into Serendipity › Second brain.
// The vault is only read, never changed. Its folders are kept. Notes come in as notes; Excalidraw drawings and
// Obsidian canvases come in as sharp pictures (big ones in tiles) with their words below for search;
// [[links]] become note links (qn://note/<id>); pictures and files go to Attachments once, named by what is in them.
// Every note's id comes from its place in the vault, so links are known before anything is saved, and a second run
// skips what is already there (that is also how a stopped copy carries on).
(function () {
  'use strict';
  var Drive = window.Drive, FOLDER = Drive && Drive.FOLDER, TOP = 'Second brain';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mb(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function fnv(str, seed) { var h = seed || 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function base(p) { return p.split('/').pop(); }
  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function extOf(p) { var m = /\.([^./]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; }
  function noteId(path) { return 'vault-' + fnv(path) + fnv(path, 0x811c9dc5 ^ 0x5bd1e995); }
  function link(path) { return 'qn://note/' + encodeURIComponent(noteId(path)); }
  function mdLabel(s) { return String(s).replace(/([\[\]\\])/g, '\\$1').replace(/\n/g, ' '); }

  var S = { files: null, byPath: {}, stop: false, paused: null, rootName: '' };
  var IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp' };
  var MIME = Object.assign({ pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }, IMG);
  function mime(name) { return MIME[extOf(name)] || 'application/octet-stream'; }

  // ---------- 1. The vault folder: every file in it, minus Obsidian's own folders ----------
  // Skipped: hidden folders (.obsidian, .trash, .makemd, .space…), the templates folder, plugin code and data.
  var SKIP_DIRS = /^\./, TEMPLATES = /^001 Template$/i;
  function skipReason(path) {
    var parts = path.split('/'), name = parts[parts.length - 1], ext = extOf(name);
    for (var i = 0; i < parts.length - 1; i++) if (SKIP_DIRS.test(parts[i])) return parts[i];
    if (parts.length > 1 && TEMPLATES.test(parts[0])) return parts[0];
    if (/^\./.test(name)) return 'hidden files';
    if (ext === 'mdb') return '.mdb files';
    if (ext === 'js' || ext === 'css' || ext === 'json') return 'plugin files (.js, .css, .json)';
    return '';
  }
  async function walkHandle(dir, prefix, out) {
    for await (var pair of dir.entries()) {
      var name = pair[0], h = pair[1], path = prefix + name;
      if (h.kind === 'directory') {
        var why = skipReason(path + '/x');
        if (why) { out.skipped[why] = (out.skipped[why] || 0) + 1; continue; }
        await walkHandle(h, path + '/', out);
      } else out.list.push({ path: path, handle: h });
    }
  }
  async function readFolder(src) {
    var out = { list: [], skipped: {} }, files = [];
    if (src.handle) {
      S.rootName = src.handle.name;
      await walkHandle(src.handle, '', out);
      for (var i = 0; i < out.list.length; i += 64) {
        await Promise.all(out.list.slice(i, i + 64).map(async function (e) { e.file = await e.handle.getFile(); }));
        say('Looking through the vault… ' + Math.min(i + 64, out.list.length) + ' files');
      }
    } else {
      Array.prototype.forEach.call(src.files, function (f) {
        var rel = (f.webkitRelativePath || f.name).split('/');
        if (rel.length > 1) { S.rootName = rel[0]; rel.shift(); }
        var path = rel.join('/'), why = skipReason(path);
        if (why) {
          var seg = path.split('/').filter(function (s) { return SKIP_DIRS.test(s); })[0];
          if (seg && why === seg) out.skipped[seg] = (out.skipped[seg] || 0) + 1; else out.skipped[why] = (out.skipped[why] || 0) + 1;
          return;
        }
        out.list.push({ path: path, file: f });
      });
    }
    out.list.forEach(function (e) {
      var why = skipReason(e.path);
      if (why) { out.skipped[why] = (out.skipped[why] || 0) + 1; return; }
      files.push({ path: e.path, file: e.file, size: e.file.size, mtime: e.file.lastModified || Date.now() });
    });
    files.sort(function (a, b) { return a.path.localeCompare(b.path); });
    return { files: files, skipped: out.skipped };
  }

  // ---------- 2. What each file is ----------
  async function classify(files) {
    var texts = files.filter(function (f) { return /\.(md|canvas|excalidraw)$/i.test(f.path); });
    for (var i = 0; i < texts.length; i += 48) {
      await Promise.all(texts.slice(i, i + 48).map(async function (f) { f.text = (await f.file.text()).replace(/\r\n?/g, '\n').replace(/^﻿/, ''); }));
      say('Reading notes… ' + Math.min(i + 48, texts.length) + ' of ' + texts.length);
    }
    files.forEach(function (f) {
      var ext = extOf(f.path);
      if (ext === 'md') {
        if (/\.excalidraw\.md$/i.test(f.path) || /^---\n[\s\S]*?\nexcalidraw-plugin:/.test(f.text)) f.kind = 'drawing';
        else f.kind = f.text.trim() ? 'note' : 'empty';
      } else if (ext === 'excalidraw') f.kind = 'drawing';
      else if (ext === 'canvas') f.kind = 'canvas';
      else if (IMG[ext]) f.kind = 'image';
      else f.kind = 'file';
      S.byPath[f.path] = f;
    });
    buildIndex(files);
  }

  // ---------- Finding what a [[link]] points to, the way Obsidian does ----------
  // By path from the vault's top, then by name anywhere (the closest one to the linking note if names repeat).
  var IDX = { full: {}, name: {} };
  function keyNames(f) {
    var p = f.path.toLowerCase(), b = base(p), out = [b];
    if (/\.md$/.test(b)) out.push(b.slice(0, -3));
    if (/\.excalidraw\.md$/.test(b)) out.push(b.slice(0, -14));
    return out;
  }
  function buildIndex(files) {
    IDX = { full: {}, name: {} };
    files.forEach(function (f) {
      if (f.kind === 'empty') return;
      var p = f.path.toLowerCase();
      IDX.full[p] = f;
      if (/\.md$/.test(p)) IDX.full[p.slice(0, -3)] = IDX.full[p.slice(0, -3)] || f;
      if (/\.excalidraw\.md$/.test(p)) IDX.full[p.slice(0, -14)] = IDX.full[p.slice(0, -14)] || f;
      keyNames(f).forEach(function (k) { (IDX.name[k] = IDX.name[k] || []).push(f); });
    });
  }
  function resolve(target, from) {
    var t = String(target || '').trim().replace(/\\/g, '/');
    try { if (/%[0-9a-f]{2}/i.test(t)) t = decodeURIComponent(t); } catch (e) {}
    t = t.replace(/^\.\//, '').replace(/^\/+/, '');
    if (!t) return null;
    var lt = t.toLowerCase(), fromDir = dirOf(from || '').toLowerCase();
    if (/^\.\.?\//.test(t) || fromDir) { // relative to the linking note (Markdown links usually are)
      var parts = fromDir ? fromDir.split('/') : [];
      lt.split('/').forEach(function (s) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); });
      var rel = parts.join('/');
      if (IDX.full[rel]) return IDX.full[rel];
    }
    if (IDX.full[lt]) return IDX.full[lt];
    var hits = IDX.name[base(lt)] || [];
    if (!hits.length && !/\.[a-z0-9]{2,5}$/.test(lt)) hits = IDX.name[base(lt) + '.md'] || [];
    if (lt.indexOf('/') >= 0) hits = hits.filter(function (f) { var p = f.path.toLowerCase(); return p.endsWith(lt) || p.endsWith(lt + '.md') || p.endsWith(lt + '.excalidraw.md'); });
    if (hits.length < 2) return hits[0] || null;
    var best = null, score = -1;
    hits.forEach(function (f) {
      var a = dirOf(f.path).toLowerCase().split('/'), b = fromDir.split('/'), s = 0;
      while (s < a.length && s < b.length && a[s] === b[s]) s++;
      if (s > score) { score = s; best = f; }
    });
    return best;
  }

  // ---------- 3. Obsidian Markdown → Serendipity Markdown ----------
  // Attachments are written as markers here and get their saved names when the copy runs: ⟦A:path⟧ a file as it is,
  // ⟦P:path⟧ a picture of a drawing or canvas (for ![[drawing]] inside a note).
  var MK = '\u0001';
  function attRef(f) { return MK + 'A:' + f.path + MK; }
  function previewRef(f) { return MK + 'P:' + f.path + MK; }
  function isNoteLike(f) { return f.kind === 'note' || f.kind === 'drawing' || f.kind === 'canvas'; }
  function titleOf(f) {
    var b = base(f.path);
    if (f.kind === 'drawing') return b.replace(/\.excalidraw(\.md)?$/i, '').replace(/\.md$/i, '');
    if (f.kind === 'canvas') return b.replace(/\.canvas$/i, '');
    if (f.kind === 'note' || f.kind === 'empty') return b.replace(/\.md$/i, '');
    return b;
  }
  function splitAlias(inner) { // [[target#part|alias]], where a table cell writes the | as \|
    var i = inner.search(/\\?\|/), t = inner, a = '';
    if (i >= 0) { t = inner.slice(0, i); a = inner.slice(i + (inner[i] === '\\' ? 2 : 1)); }
    var h = t.indexOf('#'), part = '';
    if (h >= 0) { part = t.slice(h + 1); t = t.slice(0, h); }
    return { target: t.trim(), part: part.trim(), alias: a.trim() };
  }
  function partLabel(part) { return part.replace(/^\^/, '').replace(/#/g, ' › '); }

  function convertText(text, from, ctx) {
    // Code (fenced blocks and `inline code`) is left exactly as it is; everything else is converted.
    var out = [], lines = text.split('\n'), fence = null, chunk = [];
    function flush() { if (chunk.length) { out.push(convertChunk(chunk.join('\n'), from, ctx)); chunk = []; } }
    lines.forEach(function (line) {
      var m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) { out.push(line); if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) fence = null; return; }
      if (m) { flush(); fence = m[1]; out.push(line); return; }
      chunk.push(line);
    });
    flush();
    return out.join('\n');
  }
  function convertChunk(text, from, ctx) {
    var codes = [];
    text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (all) { codes.push(all); return MK + 'C' + (codes.length - 1) + MK; });
    // Tables: Serendipity's text boxes don't keep tables (opening the note would run the cells together), so each row
    // becomes a line, cells apart by ·, the header row in bold. Links in cells still work.
    text = text.replace(/^[ \t]*\|?.*\|.*\n[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n[ \t]*\|?.*\|.*)*$/gm, function (tbl) {
      var rows = tbl.split('\n'), cells = function (r) { return r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|'); }); };
      var head = cells(rows[0]).filter(Boolean), out = head.length ? ['**' + head.join(' · ') + '**'] : [];
      rows.slice(2).forEach(function (r) { var c = cells(r); if (c.some(Boolean)) out.push('- ' + c.join(' · ')); });
      return out.join('\n');
    });
    // %% comments %% are hidden in Obsidian: they stay out.
    text = text.replace(/%%[\s\S]*?%%/g, function () { ctx.comments++; return ''; });
    // ![[embeds]]
    text = text.replace(/!\[\[([^\]\n]+)\]\]/g, function (all, inner) {
      var L = splitAlias(inner), f = resolve(L.target, from);
      if (!f) { ctx.missing[L.target] = 1; return L.alias && !/^\d+(x\d+)?$/.test(L.alias) ? L.alias : L.target; }
      ctx.uses[f.path] = 1;
      if (f.kind === 'image') return '![' + mdLabel(L.alias && !/^\d+(x\d+)?$/.test(L.alias) ? L.alias : '') + '](' + attRef(f) + ')';
      if (f.kind === 'drawing' || f.kind === 'canvas') { ctx.previews[f.path] = 1; return '![' + mdLabel(titleOf(f)) + '](' + previewRef(f) + ')\n[↗ ' + mdLabel(titleOf(f)) + '](' + link(f.path) + ')'; }
      if (isNoteLike(f)) return '[↪ ' + mdLabel(L.alias || titleOf(f) + (L.part ? ' › ' + partLabel(L.part) : '')) + '](' + link(f.path) + ')';
      return '[📄 ' + mdLabel(L.alias || base(f.path)) + '](' + attRef(f) + ')';
    });
    // [[links]]
    text = text.replace(/\[\[([^\]\n]+)\]\]/g, function (all, inner) {
      var L = splitAlias(inner);
      if (!L.target) return L.alias || partLabel(L.part); // a heading in the same note
      var f = resolve(L.target, from), label = L.alias || (L.part ? L.target + ' › ' + partLabel(L.part) : L.target);
      if (!f) { ctx.missing[L.target] = 1; return label; }
      ctx.uses[f.path] = 1;
      if (isNoteLike(f)) { ctx.links[f.path] = 1; return '[' + mdLabel(label) + '](' + link(f.path) + ')'; }
      return '[' + mdLabel(label) + '](' + attRef(f) + ')';
    });
    // Markdown links and images to files in the vault: [x](Folder/Note.md), ![](Assets/pic.png), [x](<a b.md>)
    text = text.replace(/(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\)/g, function (all, bang, label, href) {
      var h = href.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:|^#/i.test(h) || h.indexOf(MK) >= 0) return all;
      var hash = h.indexOf('#'); if (hash > 0) h = h.slice(0, hash);
      var f = resolve(h, from);
      if (!f) { ctx.missing[h] = 1; return bang ? label : label || h; }
      ctx.uses[f.path] = 1;
      var lab = label.replace(/\|\d+(x\d+)?$/, '');
      if (f.kind === 'image') return bang + '[' + lab + '](' + attRef(f) + ')';
      if (isNoteLike(f)) { ctx.links[f.path] = 1; if (bang && f.kind !== 'note') { ctx.previews[f.path] = 1; return '![' + lab + '](' + previewRef(f) + ')'; } return '[' + (lab || mdLabel(titleOf(f))) + '](' + link(f.path) + ')'; }
      return '[' + (lab || mdLabel(base(f.path))) + '](' + attRef(f) + ')';
    });
    // Web images with an Obsidian size: ![alt|300](https://…)
    text = text.replace(/!\[([^\]\n|]*)\|\d+(x\d+)?\]\(/g, '![$1](');
    // ==highlights==
    text = text.replace(/==(?=\S)([^=\n]*?\S)==/g, '<mark>$1</mark>');
    // Callouts: > [!note] Title  →  a quote with the title in bold
    text = text.replace(/^((?:>\s*)+)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm, function (all, q, type, title) {
      var t = title.trim() || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      return q.replace(/\s*$/, ' ') + '**' + t + '**';
    });
    // Block ids at the end of a line: ^abc123
    text = text.replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, '');
    // #tags become labels (the text stays as it is)
    text.replace(/(^|[\s(,;])#([A-Za-zÀ-￿][\wÀ-￿/-]*)/g, function (all, pre, tag) { ctx.tags[tag] = 1; return all; });
    return text.replace(new RegExp(MK + 'C(\\d+)' + MK, 'g'), function (all, i) { return codes[+i]; });
  }
  function newCtx() { return { comments: 0, missing: {}, uses: {}, links: {}, previews: {}, tags: {} }; }

  // Front matter: tags → labels; created/date → the note's date; the rest is kept with the note.
  var KNOWN = { id: 1, created: 1, updated: 1, labels: 1, pinned: 1, source: 1, order: 1, page: 1 };
  function frontMatter(text) {
    var m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
    if (!m) return { body: text, props: {}, extra: [], tags: [] };
    var props = {}, extra = [], tags = [], key = null;
    m[1].split('\n').forEach(function (line) {
      var kv = /^([A-Za-z_][\w -]*?):\s*(.*)$/.exec(line);
      if (kv) {
        key = kv[1].trim().toLowerCase(); props[key] = kv[2].trim();
        if (key === 'tags' || key === 'tag') { tags = tags.concat(listOf(kv[2])); return; }
        if (key === 'excalidraw-plugin' || /^excalidraw-/.test(key) || key === 'cssclasses' || key === 'cssclass') return;
        var k = kv[1].trim().replace(/\s+/g, '-');
        extra.push((KNOWN[k.toLowerCase()] ? 'obsidian-' : '') + k + ': ' + kv[2]);
        return;
      }
      var item = /^\s+-\s*(.*)$/.exec(line);
      if (item && (key === 'tags' || key === 'tag')) { tags.push(item[1]); return; }
      if (key && /^excalidraw-/.test(key)) return;
      if (line.trim()) extra.push(line);
    });
    tags = tags.map(function (t) { return String(t).replace(/^["'#]+|["']+$/g, '').trim(); }).filter(function (t) { return t && t !== 'excalidraw'; });
    return { body: text.slice(m[0].length), props: props, extra: extra, tags: tags };
  }
  function listOf(v) {
    v = String(v || '').trim();
    if (!v) return [];
    return v.replace(/^\[|\]$/g, '').split(/[,\s]+/).map(function (s) { return s.replace(/^["'#]+|["']+$/g, ''); }).filter(Boolean);
  }
  function dateOf(v) {
    if (!v) return null;
    var d = new Date(String(v).replace(/^["']|["']$/g, ''));
    return isNaN(d) || d.getFullYear() < 1990 ? null : d.toISOString();
  }
  function header(f, title, fm, labels) {
    var daily = /^(\d{4}-\d{2}-\d{2})/.exec(base(f.path));
    var created = dateOf(fm.props.created) || dateOf(fm.props.date) || dateOf(fm.props['date created']) ||
      (daily ? dateOf(daily[1] + 'T09:00:00') : null) || new Date(f.mtime).toISOString();
    var updated = new Date(Math.max(f.mtime, Date.parse(created) || 0)).toISOString();
    var lines = ['---', 'id: ' + noteId(f.path), 'created: ' + created, 'updated: ' + updated, 'labels: ' + JSON.stringify(labels),
      'pinned: false', 'source: obsidian'].concat(fm.extra || [], ['obsidian-file: ' + JSON.stringify(f.path), '---', '', '# ' + title.replace(/\n/g, ' '), '']);
    return lines.join('\n') + '\n';
  }
  function labelsFrom(fm, ctx) {
    var seen = {}, out = [];
    fm.tags.concat(Object.keys(ctx.tags)).forEach(function (t) { var k = t.toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(t); } });
    return out;
  }

  function convertNote(f) {
    var fm = frontMatter(f.text), ctx = newCtx(), title = titleOf(f);
    var body = fm.body.replace(/^\n+/, '');
    var h1 = /^# (.*)\n?/.exec(body);
    if (h1 && h1[1].trim().toLowerCase() === title.toLowerCase()) body = body.slice(h1[0].length).replace(/^\n+/, '');
    body = convertText(body, f.path, ctx).replace(/\s+$/, '');
    return { kind: 'note', f: f, title: title, ctx: ctx, md: header(f, title, fm, labelsFrom(fm, ctx)) + '\n' + body + '\n' };
  }

  // ---------- Excalidraw drawings (Obsidian's .excalidraw.md) ----------
  function excalidrawParts(f) {
    var text = f.text, fm = frontMatter(text), body = fm.body, scene = null;
    if (extOf(f.path) === 'excalidraw') { try { scene = JSON.parse(text); } catch (e) {} return { fm: { props: {}, extra: [], tags: [] }, back: '', words: [], files: {}, links: {}, scene: scene }; }
    var cut = body.search(/^#+ Excalidraw Data\s*$/m);
    var back = (cut >= 0 ? body.slice(0, cut) : body.split(/^%%\s*$/m)[0]).split('\n')
      .filter(function (l) { return !/Switch to EXCALIDRAW VIEW|Decompress current Excalidraw file/.test(l); }).join('\n').replace(/^\s*%%\s*$/gm, '').trim();
    function section(name) {
      var m = new RegExp('^## ' + name + '\\s*\\n([\\s\\S]*?)(?=^## |^%%|^# |(?![\\s\\S]))', 'm').exec(body);
      return m ? m[1] : '';
    }
    var words = section('Text Elements').split(/\n\s*\n/).map(function (s) { return s.replace(/\s*\^[\w-]+\s*$/, '').trim(); }).filter(Boolean);
    var files = {};
    section('Embedded Files').split('\n').forEach(function (l) {
      var m = /^([0-9a-f]{20,}):\s*(.+?)\s*$/i.exec(l); if (m) files[m[1]] = m[2];
    });
    var links = {};
    section('Element Links').split('\n').forEach(function (l) { var m = /^([\w-]+):\s*(.+?)\s*$/.exec(l); if (m) links[m[1]] = m[2]; });
    var cj = /```compressed-json\n([\s\S]*?)\n```/.exec(body), js = /```json\n([\s\S]*?)\n```/.exec(body);
    try {
      if (cj) scene = JSON.parse(window.QNExcalidraw.lz.decompressFromBase64(cj[1].replace(/\s+/g, '')));
      else if (js) scene = JSON.parse(js[1]);
    } catch (e) { scene = null; }
    return { fm: fm, back: back, words: words, files: files, links: links, scene: scene };
  }
  function convertDrawing(f) {
    var P = excalidrawParts(f), ctx = newCtx();
    var text = [P.back ? convertText(P.back, f.path, ctx) : '']
      .concat(P.words.length ? ['**Words in this drawing**', P.words.map(function (w) { return convertText(w, f.path, ctx); }).join('\n\n')] : [])
      .concat(Object.keys(P.links).length ? [Object.keys(P.links).map(function (k) { return convertText(P.links[k], f.path, ctx); }).join(' · ')] : [])
      .filter(Boolean).join('\n\n');
    Object.keys(P.files).forEach(function (id) { var L = /\[\[([^\]]+)\]\]/.exec(P.files[id]); var g = L && resolve(splitAlias(L[1]).target, f.path); if (g) ctx.uses[g.path] = 1; });
    return { kind: 'drawing', f: f, title: titleOf(f), ctx: ctx, parts: P, fm: P.fm, text: text };
  }

  // ---------- Obsidian canvases (.canvas: cards and arrows as JSON) ----------
  function convertCanvas(f) {
    var data = null, ctx = newCtx();
    try { data = JSON.parse(f.text); } catch (e) {}
    var nodes = (data && data.nodes) || [], words = [];
    nodes.slice().sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); }).forEach(function (n) {
      if (n.type === 'text' && n.text) words.push(convertText(n.text, f.path, ctx));
      if (n.type === 'file' && n.file) { var g = resolve(n.file, ''); if (g) { ctx.uses[g.path] = 1; words.push(isNoteLike(g) ? '[' + mdLabel(titleOf(g)) + '](' + link(g.path) + ')' : g.kind === 'image' ? '' : '[📄 ' + mdLabel(base(g.path)) + '](' + attRef(g) + ')'); } }
      if (n.type === 'link' && n.url) words.push('<' + n.url + '>');
      if (n.type === 'group' && n.label) words.push('**' + n.label + '**');
    });
    return { kind: 'canvas', f: f, title: titleOf(f), ctx: ctx, data: data, fm: { props: {}, extra: [], tags: [] }, text: words.filter(Boolean).join('\n\n') };
  }

  // ---------- Pictures: an SVG turned into PNG tiles at a high resolution ----------
  // About 2 pixels per drawing unit; very big boards get fewer (at least ½), so no picture passes ~64 million pixels.
  // Tiles are at most 4096 px a side; each is placed on the note's page where it belongs.
  var TILE = 4096;
  function scaleFor(W, H, max) { return Math.max(Math.min(0.5, max || 2), Math.min(max || 2, Math.sqrt(64e6 / Math.max(1, W * H)))); }
  async function rasterize(svgText, vb, s, tileSize) {
    var T = tileSize || TILE, W = vb[2], H = vb[3], PW = Math.max(1, Math.ceil(W * s)), PH = Math.max(1, Math.ceil(H * s)), tiles = [];
    var TX = Math.ceil(PW / Math.ceil(PW / T)), TY = Math.ceil(PH / Math.ceil(PH / T)); // tiles of even size, no thin slivers
    for (var y = 0; y < PH; y += TY) for (var x = 0; x < PW; x += TX) {
      var tw = Math.min(TX, PW - x), th = Math.min(TY, PH - y);
      // The same picture each time, with its window moved to this tile and drawn at the tile's size.
      var src = svgText.replace(/^[\s\S]*?(?=<svg\b)/, ''), root = /^<svg\b[^>]*>/.exec(src)[0];
      var str = root.replace(/\s(width|height|viewBox)="[^"]*"/g, '').replace(/^<svg/, '<svg width="' + tw + '" height="' + th + '" viewBox="' +
        (vb[0] + x / s) + ' ' + (vb[1] + y / s) + ' ' + (tw / s) + ' ' + (th / s) + '"') + src.slice(root.length);
      // (A picture with HTML cards in it must be read from a data: address; from a blob: one Chrome won't let it be saved.)
      var fo = str.indexOf('<foreignObject') >= 0, url = fo ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str) : URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
      try {
        var img = new Image(); img.src = url; await img.decode();
        var cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
        var g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, tw, th); g.drawImage(img, 0, 0, tw, th);
        var blob = await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
        if (!blob) throw new Error('the picture is too big to make');
        tiles.push({ blob: blob, x: x / s, y: y / s, w: tw / s, h: th / s });
        cv.width = cv.height = 1;
      } finally { if (!fo) URL.revokeObjectURL(url); }
    }
    return { tiles: tiles, W: W, H: H, s: s };
  }
  function dataUrl(blob) { return new Promise(function (r, bad) { var fr = new FileReader(); fr.onload = function () { r(fr.result); }; fr.onerror = bad; fr.readAsDataURL(blob); }); }

  // A card picture for things a drawing points to that aren't pictures (a note, a PDF).
  function cardDataUrl(title, sub, w, h) {
    var cv = document.createElement('canvas'), k = 2; cv.width = Math.max(40, w * k); cv.height = Math.max(30, h * k);
    var g = cv.getContext('2d'); g.scale(k, k);
    g.fillStyle = '#fafafa'; g.strokeStyle = '#bbb'; g.lineWidth = 1.5; g.beginPath(); g.roundRect ? g.roundRect(1, 1, w - 2, h - 2, 10) : g.rect(1, 1, w - 2, h - 2); g.fill(); g.stroke();
    g.fillStyle = '#222'; g.font = '600 ' + Math.max(12, Math.min(28, h / 6)) + 'px system-ui, sans-serif'; g.textBaseline = 'top';
    g.fillText(title, 14, 14, w - 28);
    if (sub) { g.fillStyle = '#666'; g.font = Math.max(10, Math.min(18, h / 9)) + 'px system-ui, sans-serif'; wrap(g, sub, 14, 14 + Math.max(12, Math.min(28, h / 6)) * 1.6, w - 28, Math.max(10, Math.min(18, h / 9)) * 1.4, h - 20); }
    return cv.toDataURL('image/png');
  }
  function wrap(g, text, x, y, w, lh, maxY) {
    String(text).split('\n').forEach(function (para) {
      var line = '';
      para.split(/\s+/).forEach(function (word) {
        var t = line ? line + ' ' + word : word;
        if (g.measureText(t).width > w && line) { if (y + lh <= maxY) g.fillText(line, x, y); y += lh; line = word; } else line = t;
      });
      if (y + lh <= maxY) g.fillText(line, x, y); y += lh;
    });
  }

  // An Excalidraw drawing → SVG (the Excalidraw library itself draws it, with its own hand-drawn fonts).
  async function drawingSvg(conv, depth) {
    var P = conv.parts, X = window.QNExcalidraw;
    if (!P.scene || !P.scene.elements) throw new Error('no drawing data in this file');
    var els = P.scene.elements.filter(function (e) { return e && !e.isDeleted; });
    try { els = X.restoreElements(els, null, { refreshDimensions: false, repairBindings: true }); } catch (e) {} // older drawings: fill in what newer Excalidraw expects
    els = els.map(function (e) { // a line with the same point twice in a row can't be drawn (it vanished): drop the repeat
      if (!e.points || e.points.length < 3) return e;
      var pts = e.points.filter(function (p, i) { return !i || p[0] !== e.points[i - 1][0] || p[1] !== e.points[i - 1][1]; });
      return pts.length === e.points.length || pts.length < 2 ? e : Object.assign({}, e, { points: pts });
    });
    if (conv.only) els = conv.only(els);
    if (!els.length) els = [{ type: 'text', id: 'empty', x: 0, y: 0, width: 200, height: 25, text: '(empty drawing)', originalText: '(empty drawing)', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', strokeColor: '#999', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, angle: 0, seed: 1, version: 1, versionNonce: 1, isDeleted: false, groupIds: [], boundElements: null, link: null, locked: false, containerId: null, lineHeight: 1.25 }];
    var files = Object.assign({}, P.scene.files || {});
    var need = {}; els.forEach(function (e) { if (e.type === 'image' && e.fileId && !files[e.fileId]) need[e.fileId] = e; });
    for (var id in need) {
      var ref = P.files[id], e = need[id];
      if (!ref) continue;
      var dataURL = null, mt = 'image/png';
      var L = /\[\[([^\]]+)\]\]/.exec(ref);
      if (L) {
        var A = splitAlias(L[1]), g = resolve(A.target, conv.f.path);
        if (g && g.kind === 'image') { mt = mime(g.path); dataURL = await dataUrl(new Blob([await g.file.arrayBuffer()], { type: mt })); }
        else if (g && (g.kind === 'drawing') && depth < 2) {
          try {
            var sub = convertDrawing(g), grp = /group=([\w-]+)/.exec(A.part), area = /(?:area|frame|clippedframe)=([\w-]+)/.exec(A.part);
            if (grp || area) sub.only = function (all) {
              var key = (grp || area)[1], hit = all.filter(function (x) { return x.id === key; })[0];
              if (grp) { var gid = hit && hit.groupIds && hit.groupIds.length ? hit.groupIds[hit.groupIds.length - 1] : null; return all.filter(function (x) { return x.id === key || (gid && (x.groupIds || []).indexOf(gid) >= 0); }); }
              if (!hit) return all;
              return all.filter(function (x) { return x.id === key || x.frameId === key || (x.x >= hit.x && x.y >= hit.y && x.x + (x.width || 0) <= hit.x + hit.width && x.y + (x.height || 0) <= hit.y + hit.height); });
            };
            var sv = await drawingSvg(sub, depth + 1), r = await rasterize(sv.svg, sv.vb, Math.min(2, 2400 / Math.max(sv.vb[2], sv.vb[3])), 1e9);
            dataURL = await dataUrl(r.tiles[0].blob);
          } catch (err) { dataURL = null; }
        }
        if (!dataURL && g) dataURL = cardDataUrl(titleOf(g), g.kind === 'note' ? g.text.replace(/^---[\s\S]*?---\n/, '').slice(0, 400) : base(g.path), Math.max(120, e.width || 300), Math.max(60, e.height || 120));
        if (!dataURL) dataURL = cardDataUrl(A.target, 'not in the vault', Math.max(120, e.width || 300), Math.max(60, e.height || 120));
      } else if (/^https?:/.test(ref)) dataURL = cardDataUrl(ref.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60), 'picture from the web', Math.max(120, e.width || 300), Math.max(60, e.height || 120));
      else continue;
      files[id] = { id: id, mimeType: dataURL.slice(5, dataURL.indexOf(';')) || mt, dataURL: dataURL, created: 0 };
    }
    var app = Object.assign({}, P.scene.appState || {}, { exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false });
    if (!app.viewBackgroundColor || app.viewBackgroundColor === 'transparent') app.viewBackgroundColor = '#ffffff';
    var svg = await X.exportToSvg({ elements: els, appState: app, files: files, exportPadding: 24 });
    var vb = (svg.getAttribute('viewBox') || '0 0 ' + svg.getAttribute('width') + ' ' + svg.getAttribute('height')).split(/[\s,]+/).map(Number);
    return { svg: new XMLSerializer().serializeToString(svg), vb: vb };
  }

  // An Obsidian canvas → SVG: cards (Markdown shown as on the canvas), pictures, groups and arrows.
  var CCOL = { 1: '#fb464c', 2: '#e9973f', 3: '#e0de71', 4: '#44cf6e', 5: '#53dfdd', 6: '#a882ff' };
  function ccol(c) { return !c ? '#c8c8c8' : CCOL[c] || c; }
  async function canvasSvg(conv) {
    var D = conv.data || {}, nodes = (D.nodes || []).filter(function (n) { return isFinite(n.x) && isFinite(n.y) && n.width > 0 && n.height > 0; }), edges = D.edges || [];
    if (!nodes.length) nodes = [{ id: 'e', type: 'text', text: '(empty canvas)', x: 0, y: 0, width: 240, height: 60 }];
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height); });
    var pad = 40; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    var md = window.QNLib && window.QNLib.md, parts = [];
    function html(text) {
      var src = String(text || '').replace(/!\[\[([^\]\n]+)\]\]/g, function (a, i) { var L = splitAlias(i); return '[' + (L.alias || L.target) + ']'; })
        .replace(/\[\[([^\]\n]+)\]\]/g, function (a, i) { var L = splitAlias(i); return MK + 'u' + (L.alias || L.target) + MK; })
        .replace(/%%[\s\S]*?%%/g, '').replace(/==(?=\S)([^=\n]*?\S)==/g, MK + 'm$1' + MK);
      var out = md ? md.render(src) : '<p>' + esc(src).replace(/\n/g, '<br/>') + '</p>';
      return out.replace(new RegExp(MK + '([um])([^' + MK + ']*)' + MK, 'g'), function (a, k, t) { return k === 'u' ? '<u>' + t + '</u>' : '<mark>' + t + '</mark>'; }).replace(/<img[^>]*>/g, '').replace(/<br>/g, '<br/>').replace(/<hr>/g, '<hr/>').replace(/<input([^>]*)>/g, '<input$1/>');
    }
    function card(n, inner, fill) {
      var c = ccol(n.color);
      return '<g><rect x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" rx="8" fill="' + (fill || '#ffffff') + '" stroke="' + c + '" stroke-width="' + (n.color ? 2.5 : 1.5) + '"/>' +
        (n.color ? '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" rx="8" fill="' + c + '" fill-opacity="0.08"/>' : '') +
        '<foreignObject x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '"><div xmlns="http://www.w3.org/1999/xhtml" class="c">' + inner + '</div></foreignObject></g>';
    }
    // Groups first (behind), then edges, then cards.
    nodes.filter(function (n) { return n.type === 'group'; }).forEach(function (n) {
      var c = ccol(n.color);
      parts.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" rx="10" fill="' + c + '" fill-opacity="0.07" stroke="' + c + '" stroke-width="2"/>' +
        (n.label ? '<text x="' + (n.x + 4) + '" y="' + (n.y - 10) + '" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="#444">' + esc(n.label) + '</text>' : ''));
    });
    var ARROW = {};
    function side(n, s) {
      var cx = n.x + n.width / 2, cy = n.y + n.height / 2;
      return s === 'top' ? [cx, n.y, 0, -1] : s === 'bottom' ? [cx, n.y + n.height, 0, 1] : s === 'left' ? [n.x, cy, -1, 0] : s === 'right' ? [n.x + n.width, cy, 1, 0] : null;
    }
    function autoSide(a, b) {
      var dx = (b.x + b.width / 2) - (a.x + a.width / 2), dy = (b.y + b.height / 2) - (a.y + a.height / 2);
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
    }
    function head(x, y, ux, uy, c) {
      var L = 16, W = 7, bx = x - ux * L, by = y - uy * L;
      return '<path d="M' + x + ' ' + y + 'L' + (bx - uy * W) + ' ' + (by + ux * W) + 'L' + (bx + uy * W) + ' ' + (by - ux * W) + 'Z" fill="' + c + '"/>';
    }
    edges.forEach(function (e) {
      var a = byId[e.fromNode], b = byId[e.toNode]; if (!a || !b) return;
      var p = side(a, e.fromSide || autoSide(a, b)), q = side(b, e.toSide || autoSide(b, a)), c = ccol(e.color) === '#c8c8c8' ? '#999' : ccol(e.color);
      var d = Math.max(40, Math.min(200, Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
      var c1 = [p[0] + p[2] * d, p[1] + p[3] * d], c2 = [q[0] + q[2] * d, q[1] + q[3] * d];
      parts.push('<path d="M' + p[0] + ' ' + p[1] + 'C' + c1.join(' ') + ' ' + c2.join(' ') + ' ' + q[0] + ' ' + q[1] + '" fill="none" stroke="' + c + '" stroke-width="2.5"/>');
      if ((e.toEnd || 'arrow') === 'arrow') parts.push(head(q[0], q[1], -q[2], -q[3], c));
      if (e.fromEnd === 'arrow') parts.push(head(p[0], p[1], -p[2], -p[3], c));
      if (e.label) {
        var mx = (p[0] + 3 * c1[0] + 3 * c2[0] + q[0]) / 8, my = (p[1] + 3 * c1[1] + 3 * c2[1] + q[1]) / 8, w = Math.min(320, 14 + e.label.length * 8);
        parts.push('<rect x="' + (mx - w / 2) + '" y="' + (my - 14) + '" width="' + w + '" height="28" rx="6" fill="#fff" stroke="' + c + '"/>' +
          '<text x="' + mx + '" y="' + (my + 5) + '" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#333">' + esc(e.label) + '</text>');
      }
    });
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'group') continue;
      if (n.type === 'text') parts.push(card(n, html(n.text)));
      else if (n.type === 'link') parts.push(card(n, '<div class="t">🔗 Link</div><p class="u">' + esc(n.url || '') + '</p>'));
      else if (n.type === 'file') {
        var g = resolve(n.file || '', '');
        if (g && g.kind === 'image') {
          var u = await dataUrl(new Blob([await g.file.arrayBuffer()], { type: mime(g.path) }));
          parts.push('<image x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" preserveAspectRatio="xMidYMid meet" href="' + u + '"/>');
        } else if (g && g.kind === 'note') {
          var body = frontMatter(g.text).body.slice(0, 6000);
          parts.push(card(n, '<div class="t">' + esc(titleOf(g)) + '</div>' + html(body)));
        } else if (g && (g.kind === 'drawing' || g.kind === 'canvas')) {
          try {
            var sv = g.kind === 'drawing' ? await drawingSvg(convertDrawing(g), 1) : null;
            if (sv) {
              var r = await rasterize(sv.svg, sv.vb, Math.min(2, 2400 / Math.max(sv.vb[2], sv.vb[3])), 1e9);
              parts.push('<rect x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" rx="8" fill="#fff" stroke="#c8c8c8"/>' +
                '<image x="' + n.x + '" y="' + n.y + '" width="' + n.width + '" height="' + n.height + '" preserveAspectRatio="xMidYMid meet" href="' + await dataUrl(r.tiles[0].blob) + '"/>');
            } else parts.push(card(n, '<div class="t">' + esc(titleOf(g)) + '</div><p>Canvas</p>'));
          } catch (e) { parts.push(card(n, '<div class="t">' + esc(titleOf(g)) + '</div>')); }
        } else parts.push(card(n, '<div class="t">📄 ' + esc(g ? base(g.path) : n.file || 'File') + '</div>' + (g ? '' : '<p>Not in the vault</p>'), '#fafafa'));
      }
    }
    var css = '<style>.c{box-sizing:border-box;width:100%;height:100%;overflow:hidden;padding:12px 16px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#222;word-wrap:break-word}' +
      '.c p,.c ul,.c ol,.c pre,.c blockquote{margin:0 0 8px}.c h1,.c h2,.c h3,.c h4{margin:4px 0 8px;line-height:1.25}.c h1{font-size:24px}.c h2{font-size:20px}.c h3{font-size:17px}' +
      '.c ul,.c ol{padding-left:22px}.c code,.c pre{font-family:ui-monospace,Consolas,monospace;font-size:13px;background:#f3f3f3;border-radius:4px}.c pre{padding:8px;white-space:pre-wrap}' +
      '.c blockquote{border-left:3px solid #ccc;padding-left:10px;color:#555}.c mark{background:#fff3a3}.c a,.c u{color:#6c4bd8}.c .t{font-weight:600;font-size:16px;margin-bottom:6px}.c .u{color:#6c4bd8;word-break:break-all}' +
      '.c table{border-collapse:collapse}.c td,.c th{border:1px solid #ddd;padding:2px 6px}</style>';
    var W = x1 - x0, H = y1 - y0;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + W + '" height="' + H + '" viewBox="' + x0 + ' ' + y0 + ' ' + W + ' ' + H + '">' + css +
      '<rect x="' + x0 + '" y="' + y0 + '" width="' + W + '" height="' + H + '" fill="#ffffff"/>' + parts.join('') + '</svg>';
    return { svg: svg, vb: [x0, y0, W, H] };
  }
  async function picture(conv, preview) {
    var sv = conv.kind === 'canvas' ? await canvasSvg(conv) : await drawingSvg(conv, 0);
    var s = preview ? Math.min(2, 2400 / Math.max(sv.vb[2], sv.vb[3])) : scaleFor(sv.vb[2], sv.vb[3]);
    return rasterize(sv.svg, sv.vb, s, preview ? 1e9 : TILE);
  }

  // ---------- 4. Copying into Drive ----------
  async function hashName(blob, ext) {
    var dig = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return Array.prototype.map.call(dig.slice(0, 12), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('') + '.' + ext;
  }
  // Drive calls: a sign-in that runs out pauses the copy until Continue; Drive being busy (too many requests at once)
  // or a dropped connection is waited out and tried again a few times.
  async function withAuth(fn) {
    for (var tries = 0; ; tries++) {
      if (S.paused) await S.paused.promise;
      try { return await fn(); }
      catch (e) {
        if ((e.code === 'busy' || e.code === 'offline') && tries < 6) { await new Promise(function (r) { setTimeout(r, 1500 * Math.pow(2, tries)); }); continue; }
        if (e.code !== 'auth' && !/401/.test(e.message || '')) throw e;
        if (!S.paused) {
          var d = {}; d.promise = new Promise(function (r) { d.resolve = r; }); S.paused = d;
          $('pause').classList.remove('hidden');
        }
      }
    }
  }
  var lock = null, wantLock = false;
  async function holdScreen(on) {
    wantLock = on;
    try {
      if (on && navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', function () { lock = null; }); }
      if (!on && lock) { await lock.release(); lock = null; }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && wantLock) holdScreen(true); });

  // The plan: one item per note, drawing, canvas, and (if chosen) per file no note uses.
  function plan(opts) {
    var items = [], used = {};
    S.files.forEach(function (f) {
      try {
        if (f.kind === 'note') items.push(convertNote(f));
        else if (f.kind === 'drawing') items.push(convertDrawing(f));
        else if (f.kind === 'canvas') items.push(convertCanvas(f));
      } catch (e) { items.push({ kind: 'bad', f: f, title: titleOf(f), error: e.message || String(e), ctx: newCtx() }); }
    });
    items.forEach(function (c) { Object.keys(c.ctx.uses).forEach(function (p) { used[p] = 1; }); });
    var loose = S.files.filter(function (f) { return (f.kind === 'image' || f.kind === 'file') && !used[f.path]; });
    if (opts.loose) loose.forEach(function (f) { items.push({ kind: 'loose', f: f, title: base(f.path), ctx: newCtx() }); });
    // File names: the vault's own, made unique within each folder (the same every run, so a second run skips them).
    var taken = {};
    items.forEach(function (c) {
      var dir = dirOf(c.f.path), stem = c.title.replace(/[\\/]/g, '-') + (c.kind === 'canvas' ? '' : ''), name = stem + '.md', n = 2;
      while (taken[dir + '/' + name.toLowerCase()]) name = stem + (c.kind === 'canvas' && n === 2 ? ' (canvas)' : ' (' + n + ')') + '.md', n++;
      taken[dir + '/' + name.toLowerCase()] = 1;
      c.dir = dir ? dir.split('/') : []; c.fileName = name;
    });
    return { items: items, loose: loose, used: used };
  }

  function summarize() {
    var k = {}, bytes = 0, missing = {};
    S.files.forEach(function (f) { k[f.kind] = (k[f.kind] || 0) + 1; if (f.kind === 'image' || f.kind === 'file') bytes += f.size; });
    var P = plan({ loose: false }), looseBytes = 0, looseImg = 0;
    P.items.forEach(function (c) { Object.keys(c.ctx.missing).forEach(function (m) { missing[m] = 1; }); });
    P.loose.forEach(function (f) { looseBytes += f.size; if (f.kind === 'image') looseImg++; });
    var daily = S.files.filter(function (f) { return f.kind === 'note' && /^\d{4}-\d{2}-\d{2}/.test(base(f.path)); }).length;
    var folders = {}; S.files.forEach(function (f) { if (f.kind !== 'empty' && dirOf(f.path)) folders[dirOf(f.path).split('/')[0]] = 1; });
    var sk = S.skipped, skList = Object.keys(sk).map(function (w) { return esc(w) + (sk[w] > 1 ? ' (' + sk[w] + ')' : ''); });
    $('summary').innerHTML = '<h2>What\'s in “' + esc(S.rootName || 'the vault') + '”</h2><ul>' +
      '<li><b>' + (k.note || 0) + ' notes</b>' + (daily ? ', ' + daily + ' of them daily notes' : '') + ', in ' + Object.keys(folders).length + ' folders</li>' +
      '<li><b>' + (k.drawing || 0) + ' Excalidraw drawings</b> and <b>' + (k.canvas || 0) + ' canvases</b>: each comes in as a sharp picture, with its words below it for search</li>' +
      '<li>' + ((k.image || 0) + (k.file || 0) - P.loose.length) + ' pictures and files used in notes and drawings (saved once each in Attachments)</li>' +
      (P.loose.length ? '<li>' + P.loose.length + ' pictures and files no note uses (' + mb(looseBytes) + ')</li>' : '') +
      '</ul>' +
      '<p class="muted">Left out: ' + (skList.length ? skList.join(', ') + '; ' : '') + (k.empty ? k.empty + ' empty notes; ' : '') + 'nothing in the vault is changed.' +
      (Object.keys(missing).length ? ' ' + Object.keys(missing).length + ' links point to notes that aren\'t in the vault; they stay as plain words.' : '') + '</p>';
    $('looseRow').classList.toggle('hidden', !P.loose.length);
    $('looseCount').textContent = P.loose.length + ' (' + looseImg + ' pictures, ' + (P.loose.length - looseImg) + ' other files, ' + mb(looseBytes) + ')';
    $('step3').classList.remove('hidden');
  }

  async function run() {
    var opts = { loose: $('optLoose').checked };
    $('importBtn').disabled = true; $('pickBtn').disabled = true; S.stop = false;
    $('progress').classList.remove('hidden'); $('result').innerHTML = '';
    await holdScreen(true);
    var P = plan(opts), todo = P.items, log = [], done = 0, skipped = 0, files = 0, bytes = 0, t0 = Date.now();
    function show(now) {
      var n = done + skipped;
      $('bar').style.width = (todo.length ? Math.round(n / todo.length * 100) : 100) + '%';
      var left = n > 5 && done ? Math.round((Date.now() - t0) / done * (todo.length - n) / 60000) : null;
      $('count').textContent = n + ' of ' + todo.length + (skipped ? ' (' + skipped + ' were already there)' : '') + ' · ' + files + ' pictures and files saved, ' + mb(bytes) +
        (left != null && left > 0 ? ' · about ' + left + ' min left' : '');
      if (now) $('now').textContent = now;
    }
    try {
      $('now').textContent = 'Getting the folders ready…';
      var root = await withAuth(function () { return Drive.findRoot(); });
      var topF = (await withAuth(function () { return Drive.findExact(TOP, root.id, FOLDER); })) || await withAuth(function () { return Drive.createFolder(TOP, root.id); });
      var attF = (await withAuth(function () { return Drive.findExact('Attachments', root.id, FOLDER); })) || await withAuth(function () { return Drive.createFolder('Attachments', root.id); });
      var haveAtt = {};
      (await withAuth(function () { return Drive.list(attF.id); })).forEach(function (f) { haveAtt[f.name] = f.id; });
      async function names(id) { var o = {}; (await withAuth(function () { return Drive.list(id); })).forEach(function (f) { o[f.name] = f.id; }); return o; }
      var dirs = { '': { id: topF.id, have: await names(topF.id) } }, dirLock = Promise.resolve();
      function dirFor(parts) { var p = dirLock.then(function () { return makeDir(parts); }); dirLock = p.catch(function () {}); return p; }
      async function makeDir(parts) {
        var key = '';
        for (var i = 0; i < parts.length; i++) {
          var parent = dirs[key], next = key ? key + '/' + parts[i] : parts[i];
          if (!dirs[next]) {
            var hit = parent.have[parts[i]], name = parts[i];
            var f = hit ? { id: hit } : await withAuth(function () { return Drive.createFolder(name, parent.id); });
            parent.have[parts[i]] = f.id;
            dirs[next] = { id: f.id, have: hit ? await names(f.id) : {} };
          }
          key = next;
        }
        return dirs[key];
      }
      // A file from the vault, saved once in Attachments (named by what is in it).
      var hashOf = {};
      async function saveBlob(blob, ext) {
        var name = await hashName(blob, ext);
        if (!haveAtt[name]) {
          haveAtt[name] = 'busy';
          try { var made = await withAuth(function () { return Drive.upload(name, attF.id, blob, blob.type || mime(name)); }); haveAtt[name] = made.id; files++; bytes += blob.size; }
          catch (e) { delete haveAtt[name]; throw e; }
        }
        return name;
      }
      async function saveFile(f) {
        if (!hashOf[f.path]) hashOf[f.path] = (async function () {
          var ext = extOf(f.path) || 'bin', blob = new Blob([await f.file.arrayBuffer()], { type: mime(f.path) });
          return saveBlob(blob, ext);
        })().catch(function (e) { delete hashOf[f.path]; throw e; });
        return hashOf[f.path];
      }
      // Drawings are drawn one at a time (they can be big).
      var drawLock = Promise.resolve();
      function draw(fn) { var p = drawLock.then(fn); drawLock = p.catch(function () {}); return p; }
      var previewOf = {};
      async function savePreview(path) {
        if (!previewOf[path]) previewOf[path] = (async function () {
          var g = S.byPath[path], conv = g.kind === 'canvas' ? convertCanvas(g) : convertDrawing(g);
          var r = await draw(function () { return picture(conv, true); });
          return saveBlob(r.tiles[0].blob, 'png');
        })().catch(function (e) { delete previewOf[path]; throw e; });
        return previewOf[path];
      }
      async function fillRefs(md, c) {
        var refs = {}, re = new RegExp(MK + '([AP]):([^' + MK + ']+)' + MK, 'g'), m;
        while ((m = re.exec(md))) refs[m[1] + ':' + m[2]] = { k: m[1], path: m[2] };
        var map = {};
        for (var key in refs) {
          var r = refs[key];
          try { map[key] = 'Attachments/' + encodeURIComponent(r.k === 'P' ? await savePreview(r.path) : await saveFile(S.byPath[r.path])); }
          catch (e) { log.push(c.f.path + ': ' + base(r.path) + ' could not be saved (' + (e.message || e) + ')'); map[key] = ''; }
        }
        return md.replace(re, function (all, k, p) { return map[k + ':' + p]; });
      }
      function imageItem(name, x, y, w, h, extra) {
        var it = { id: 'i' + fnv(name + x + ',' + y), t: 'i', c: 'ink', src: 'Attachments/' + encodeURIComponent(name), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
        return Object.assign(it, extra || {});
      }
      function pageNote(c, items, text, below) {
        var labels = labelsFrom(c.fm || { tags: [] }, c.ctx);
        var md = header(c.f, c.title, c.fm || { props: {}, extra: [] }, labels) + '\n';
        if (text) md += '<!-- qn:box ' + JSON.stringify({ id: 'b1', x: 0, y: Math.round(below), w: null }) + ' -->\n' + text + '\n\n';
        md += '<!-- qn:ink\n' + JSON.stringify({ v: 2, layers: [{ id: 'Lvault', name: c.kind === 'canvas' ? 'Canvas' : c.kind === 'drawing' ? 'Drawing' : 'Layer 1', items: items }] }) + '\n-->\n';
        return md;
      }
      async function build(c) {
        if (c.kind === 'bad') throw new Error(c.error);
        if (c.kind === 'note') return fillRefs(c.md, c);
        if (c.kind === 'drawing' || c.kind === 'canvas') {
          var r = await draw(function () { return picture(c, false); }), items = [];
          for (var i = 0; i < r.tiles.length; i++) { var t = r.tiles[i]; items.push(imageItem(await saveBlob(t.blob, 'png'), t.x, t.y, t.w, t.h)); }
          return fillRefs(pageNote(c, items, c.text, r.H + 60), c);
        }
        // A file no note uses: on a page of its own.
        var name = await saveFile(c.f);
        if (c.f.kind === 'image') {
          var w = 800, h = 600;
          try { var bm = await createImageBitmap(c.f.file); w = bm.width; h = bm.height; bm.close(); }
          catch (e) { // an SVG: ask an <img> for its size
            var u = URL.createObjectURL(new Blob([c.f.file], { type: mime(c.f.path) }));
            try { var im = new Image(); im.src = u; await im.decode(); if (im.naturalWidth) { w = im.naturalWidth; h = im.naturalHeight; } } catch (e2) {}
            URL.revokeObjectURL(u);
          }
          var k = Math.min(1, 1600 / w); w *= k; h *= k;
          return pageNote(c, [imageItem(name, 0, 0, w, h)], '', 0);
        }
        var mk = /^audio\//.test(mime(c.f.path)) ? 'audio' : /^video\//.test(mime(c.f.path)) ? 'video' : 'file';
        return pageNote(c, [imageItem(name, 0, 0, mk === 'video' ? 640 : 340, mk === 'video' ? 360 : mk === 'audio' ? 96 : 76, { mk: mk, ttl: base(c.f.path) })], '', 0);
      }
      var queue = todo.slice();
      async function worker() {
        while (queue.length && !S.stop) {
          var c = queue.shift();
          try {
            var d = await dirFor(c.dir);
            if (d.have[c.fileName]) { skipped++; show(); continue; }
            show((c.kind === 'drawing' ? 'Drawing ' : c.kind === 'canvas' ? 'Drawing canvas ' : 'Copying ') + c.f.path);
            var md = await build(c);
            await withAuth(function () { return Drive.create(c.fileName, d.id, md); });
            d.have[c.fileName] = 1; done++;
          } catch (e) { log.push(c.f.path + ': ' + (e.message || e)); done++; }
          show();
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker));
      show(S.stop ? 'Stopped. Run it again any time to carry on where it stopped.' : 'Done.');
      var missing = {}, comments = 0;
      todo.forEach(function (c) { Object.keys(c.ctx.missing).forEach(function (m) { missing[m] = 1; }); comments += c.ctx.comments; });
      var ml = Object.keys(missing).sort();
      $('result').innerHTML = (S.stop ? '<p><b>Stopped.</b> Run the copy again to carry on; what is already there is skipped.</p>' :
        '<p><b>Copy finished.</b> Open Serendipity: the vault is in the folder “' + TOP + '”.</p>') +
        (log.length ? '<details open><summary>' + log.length + ' problem' + (log.length > 1 ? 's' : '') + '</summary><ul>' + log.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>' : '') +
        (ml.length ? '<details><summary>' + ml.length + ' links to notes that aren\'t in the vault (kept as plain words)</summary><ul>' + ml.slice(0, 300).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>' : '') +
        (comments ? '<p class="muted">' + comments + ' hidden %%comments%% were left out, as Obsidian hides them.</p>' : '') +
        '<p><a class="button" href="./">Open Serendipity</a></p>';
      S.log = log;
    } catch (e) { say(e.message || String(e), true); }
    await holdScreen(false);
    $('importBtn').disabled = false; $('pickBtn').disabled = false;
  }

  function say(t, bad) { $('status').textContent = t || ''; $('status').className = bad ? 'bad' : 'muted'; }

  // ---------- Page ----------
  async function useSource(src) {
    $('pickBtn').disabled = true; $('step3').classList.add('hidden');
    try {
      say('Looking through the vault…');
      var r = await readFolder(src);
      S.files = r.files; S.skipped = r.skipped; S.byPath = {};
      await classify(S.files);
      say('');
      summarize();
    } catch (e) { if (e.name !== 'AbortError') say(e.message || String(e), true); }
    $('pickBtn').disabled = false;
  }
  $('pickBtn').onclick = async function () {
    if (window.showDirectoryPicker) {
      try { var h = await window.showDirectoryPicker({ id: 'qn-vault', mode: 'read' }); } catch (e) { return; }
      return useSource({ handle: h });
    }
    $('dirInput').value = ''; $('dirInput').click();
  };
  $('dirInput').onchange = function () { if (this.files && this.files.length) useSource({ files: this.files }); };
  $('signInBtn').onclick = async function () { try { await Drive.signIn(); renderSignIn(); } catch (e) { say(e.message, true); } };
  $('importBtn').onclick = function () {
    if (!Drive.signedIn()) { say('Sign in with Google first.', true); return; }
    run();
  };
  $('stopBtn').onclick = function () { S.stop = true; $('now').textContent = 'Stopping after the notes being copied now…'; };
  $('continueBtn').onclick = async function () {
    try { await Drive.signIn(); } catch (e) { say(e.message, true); return; }
    $('pause').classList.add('hidden');
    var d = S.paused; S.paused = null; if (d) d.resolve();
  };
  function renderSignIn() {
    $('signedOut').classList.toggle('hidden', Drive.signedIn());
    $('demoNote').classList.toggle('hidden', !Drive.demo);
  }
  window.addEventListener('beforeunload', function (e) { if ($('importBtn').disabled && !S.stop) { e.preventDefault(); e.returnValue = ''; } });
  (async function () {
    if (Drive.demo) await Drive.signIn();
    renderSignIn();
  })();
  window.QNVault = { S: S, useSource: useSource, plan: plan, convertNote: convertNote, convertDrawing: convertDrawing, convertCanvas: convertCanvas, picture: picture, resolve: resolve, noteId: noteId, run: run };
})();
