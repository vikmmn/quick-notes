// Quick Notes: report a bug. A small bug button takes a picture of the screen, lets you draw on it and say what
// went wrong, and saves it as a note in "Bug reports" (with the picture and the details needed to fix it:
// version, device, what was on screen, the last things tapped and any errors). Loads first, to catch early errors.
(function () {
  'use strict';
  var CFG = window.APP_CONFIG || {};
  var actions = [], errors = [];
  function stamp() { var d = new Date(); return d.toTimeString().slice(0, 8); }
  function push(list, max, v) { list.push(stamp() + '  ' + v); if (list.length > max) list.shift(); }
  function short(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 160); }

  // ---- What happened before the report: errors, and what was tapped ----
  window.addEventListener('error', function (e) { push(errors, 20, 'Error: ' + short(e.message) + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')); });
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; push(errors, 20, 'Promise: ' + short(r && (r.message || r))); });
  ['error', 'warn'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      try { push(errors, 20, k + ': ' + short(Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : typeof a === 'object' ? JSON.stringify(a) : a; }).join(' '))); } catch (x) {}
      return orig.apply(console, arguments);
    };
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var t = e.target.closest('button, a, [role=button], .card, .nm, [data-tool], [data-label], [data-open], input[type=checkbox]');
    if (!t || t.closest('.qn-bug-ui')) return;
    var name = t.getAttribute('aria-label') || t.getAttribute('title') || t.dataset.tool || (t.classList.contains('card') ? 'a note card' : t.textContent);
    push(actions, 30, 'tap “' + short(name).slice(0, 50) + '”');
  }, true);
  window.addEventListener('popstate', function () { push(actions, 30, 'back button'); });

  // ---- The button ----
  var css = document.createElement('style');
  css.textContent =
    '.qn-bugbtn{position:fixed;z-index:90;width:44px;height:44px;border-radius:50%;border:0;display:grid;place-items:center;padding:0;min-height:0;' +
    'background:#d93025;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.85;touch-action:none;cursor:grab}' +
    '.qn-bugbtn svg{width:24px;height:24px}' +
    '.qn-bugview{position:fixed;inset:0;z-index:95;background:var(--paper,#fff);display:flex;flex-direction:column;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}' +
    '.qn-bugview .bh{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--rule,#ddd)}' +
    '.qn-bugview .bh b{flex:1;font:500 17px/1.2 var(--font,system-ui)}' +
    '.qn-bugview .bt{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;background:var(--field,#f1f3f4)}' +
    '.qn-bugview .bt button{min-height:34px;padding:5px 12px;font-size:14px;border-radius:8px;color:var(--ink,#222)}' +
    '.qn-bugview .bt button[aria-pressed=true]{background:var(--accent-soft,#d8efec)}' +
    '.qn-bugview .bt .c{width:28px;height:28px;padding:0;min-height:0;border-radius:50%;border:2px solid var(--rule,#ddd)}' +
    '.qn-bugview .bt .c[aria-pressed=true]{border-color:var(--ink,#222)}' +
    '.qn-bugview .bs{flex:1;min-height:0;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#808080;touch-action:none}' +
    '.qn-bugview .bs canvas{max-width:100%;max-height:100%;box-shadow:0 2px 12px rgba(0,0,0,.35);touch-action:none;background:#fff}' +
    '.qn-bugview .bf{padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--rule,#ddd)}' +
    '.qn-bugview textarea{font:16px/1.4 var(--font,system-ui);color:var(--ink,#222);background:var(--surface,#fff);border:1px solid var(--rule,#ddd);border-radius:12px;padding:10px 12px;min-height:76px;resize:vertical}' +
    '.qn-bugview .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}' +
    '.qn-bugview .busy{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:15px var(--font,system-ui)}';
  document.head.appendChild(css);

  var btn = null;
  function makeButton() {
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'qn-bugbtn qn-bug-ui'; btn.setAttribute('aria-label', 'Report a bug'); btn.title = 'Report a bug (drag to move)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="7.5" y="7" width="9" height="12" rx="4.5" fill="currentColor" fill-opacity=".25"/><path d="M12 7v12M9 4.5l1.5 2.5M15 4.5L13.5 7M7.5 11H4M7.5 15H4M16.5 11H20M16.5 15H20M8 18.5l-2.5 2M16 18.5l2.5 2"/></svg>';
    var pos = null;
    try { pos = JSON.parse(localStorage.getItem('qn-bugpos') || 'null'); } catch (e) {}
    function place(x, y) {
      x = Math.max(4, Math.min(innerWidth - 48, x)); y = Math.max(60, Math.min(innerHeight - 120, y));
      btn.style.left = x + 'px'; btn.style.top = y + 'px'; return [x, y];
    }
    place(pos ? pos[0] : 6, pos ? pos[1] : Math.round(innerHeight * 0.42));
    // Drag it anywhere; a tap opens the report.
    var d = null;
    btn.addEventListener('pointerdown', function (e) { d = { x: e.clientX, y: e.clientY, l: btn.offsetLeft, t: btn.offsetTop, moved: false }; btn.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('pointermove', function (e) {
      if (!d) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6) d.moved = true;
      if (d.moved) place(d.l + e.clientX - d.x, d.t + e.clientY - d.y);
    });
    btn.addEventListener('pointerup', function (e) {
      if (!d) return;
      var moved = d.moved; d = null; e.stopPropagation();
      if (moved) { try { localStorage.setItem('qn-bugpos', JSON.stringify([btn.offsetLeft, btn.offsetTop])); } catch (x) {} return; }
      open();
    });
    window.addEventListener('resize', function () { place(btn.offsetLeft, btn.offsetTop); });
    document.body.appendChild(btn);
  }
  function showButton(on) {
    if (on && !btn) makeButton();
    if (btn) btn.style.display = on ? '' : 'none';
  }

  // ---- A picture of the screen ----
  async function capture() {
    if (!window.htmlToImage) {
      await new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = 'screenshot.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
    }
    var W = innerWidth, H = innerHeight, sx = scrollX, sy = scrollY;
    var bg = getComputedStyle(document.body).backgroundColor;
    var opts = {
      width: W, height: H, pixelRatio: Math.min(2, window.devicePixelRatio || 1), backgroundColor: bg, skipFonts: true, cacheBust: false,
      filter: function (n) { return !(n.classList && n.classList.contains('qn-bug-ui')); },
      style: sx || sy ? { transform: 'translate(' + (-sx) + 'px,' + (-sy) + 'px)' } : undefined
    };
    var timeout = new Promise(function (ok, bad) { setTimeout(function () { bad(new Error('timed out')); }, 9000); });
    return Promise.race([window.htmlToImage.toCanvas(document.body, opts), timeout]);
  }

  // ---- The report screen: draw on the picture, say what went wrong ----
  var view = null;
  async function open() {
    if (view) return;
    var ctx = (QNBug.context && QNBug.context()) || {};
    btn.style.visibility = 'hidden';
    var shot = null, failed = null;
    try { shot = await capture(); } catch (e) { failed = e; }
    btn.style.visibility = '';
    view = document.createElement('div'); view.className = 'qn-bugview qn-bug-ui';
    view.innerHTML = '<div class="bh"><button type="button" data-b="cancel">Cancel</button><b>Report a bug</b><button type="button" class="primary" data-b="save">Save report</button></div>' +
      '<div class="bt"><button type="button" data-t="pen" aria-pressed="true">Pen</button><button type="button" data-t="box" aria-pressed="false">Box</button>' +
      ['#d93025', '#f9ab00', '#1a73e8', '#111111'].map(function (c, i) { return '<button type="button" class="c" data-c="' + c + '" style="background:' + c + '" aria-pressed="' + !i + '" aria-label="Colour"></button>'; }).join('') +
      '<span style="flex:1"></span><button type="button" data-b="undo">Undo</button><button type="button" data-b="clear">Clear</button></div>' +
      '<div class="bs"><canvas></canvas>' + (failed ? '<div class="busy">Couldn’t take a picture of the screen (' + String(failed.message || failed) + '). You can still describe the bug.</div>' : '') + '</div>' +
      '<div class="bf"><textarea placeholder="What went wrong? What did you expect to happen? (Draw on the picture to point at it.)"></textarea>' +
      '<div class="row"><button type="button" data-b="share">Share…</button></div></div>';
    document.body.appendChild(view);
    var cv = view.querySelector('canvas'), g = cv.getContext('2d');
    var w = shot ? shot.width : Math.round(innerWidth * 2), h = shot ? shot.height : Math.round(innerHeight * 2);
    cv.width = w; cv.height = h;
    var marks = [], cur = null, tool = 'pen', color = '#d93025';
    function paint() {
      g.clearRect(0, 0, w, h);
      if (shot) g.drawImage(shot, 0, 0); else { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
      marks.concat(cur ? [cur] : []).forEach(function (m) {
        g.strokeStyle = m.c; g.lineWidth = Math.max(3, w / 140); g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        if (m.t === 'box') { var a = m.p[0], b = m.p[m.p.length - 1]; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
        else m.p.forEach(function (q, i) { if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
        g.stroke();
      });
    }
    paint();
    function pt(e) { var r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * w / r.width, (e.clientY - r.top) * h / r.height]; }
    cv.addEventListener('pointerdown', function (e) { cur = { t: tool, c: color, p: [pt(e)] }; cv.setPointerCapture(e.pointerId); e.preventDefault(); });
    cv.addEventListener('pointermove', function (e) { if (cur) { cur.p.push(pt(e)); paint(); } });
    cv.addEventListener('pointerup', function () { if (cur && cur.p.length > 1) marks.push(cur); cur = null; paint(); });
    var busy = false;
    view.addEventListener('click', async function (e) {
      var b = e.target.closest('button'); if (!b || busy) return;
      if (b.dataset.t) { tool = b.dataset.t; view.querySelectorAll('[data-t]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
      if (b.dataset.c) { color = b.dataset.c; view.querySelectorAll('[data-c]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
      var act = b.dataset.b;
      if (act === 'undo') { marks.pop(); paint(); }
      if (act === 'clear') { marks = []; paint(); }
      if (act === 'cancel') close();
      if (act === 'save' || act === 'share') {
        var text = view.querySelector('textarea').value.trim();
        if (!text && !marks.length) { view.querySelector('textarea').focus(); view.querySelector('textarea').placeholder = 'Say a few words about the bug first.'; return; }
        busy = true; b.textContent = act === 'save' ? 'Saving…' : 'Preparing…';
        var report = await build(text, ctx, cv, !!shot);
        try {
          if (act === 'share') await share(report);
          else { await QNBug.save(report); close(); }
        } catch (err) { if (err && err.name !== 'AbortError') alert('Could not ' + act + ' the report: ' + (err.message || err)); }
        busy = false; b.textContent = act === 'save' ? 'Save report' : 'Share…';
      }
    });
    setTimeout(function () { view.querySelector('textarea').focus(); }, 300);
  }
  function close() { if (view) { view.remove(); view = null; } }

  async function build(text, ctx, cv, hasShot) {
    var png = hasShot ? await new Promise(function (ok) { cv.toBlob(ok, 'image/png'); }) : null;
    // A smaller copy, kept inside the note when there's no connection to upload the picture.
    var small = null;
    if (hasShot) {
      var k = Math.min(1, 900 / cv.width), c2 = document.createElement('canvas');
      c2.width = Math.round(cv.width * k); c2.height = Math.round(cv.height * k);
      c2.getContext('2d').drawImage(cv, 0, 0, c2.width, c2.height);
      small = c2.toDataURL('image/jpeg', 0.72);
    }
    var lines = [
      'Quick Notes ' + (CFG.VERSION || '?') + ' · ' + new Date().toString().slice(0, 24),
      'Device: ' + navigator.userAgent,
      'Screen: ' + innerWidth + '×' + innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x · ' +
        (matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser tab') + ' · ' + (navigator.onLine ? 'online' : 'offline') +
        ' · ' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') + ' theme'
    ];
    Object.keys(ctx).forEach(function (k) { if (ctx[k] !== undefined && ctx[k] !== '') lines.push(k + ': ' + ctx[k]); });
    lines.push('', 'Last taps:'); lines = lines.concat(actions.length ? actions.slice(-20) : ['(none)']);
    lines.push('', 'Errors:'); lines = lines.concat(errors.length ? errors.slice(-15) : ['(none)']);
    return { text: text, png: png, small: small, details: lines.join('\n') };
  }
  async function share(r) {
    var body = (r.text || 'Bug report') + '\n\n' + r.details;
    var files = r.png ? [new File([r.png], 'quick-notes-bug.png', { type: 'image/png' })] : [];
    if (navigator.share && (!files.length || (navigator.canShare && navigator.canShare({ files: files })))) return navigator.share({ title: 'Quick Notes bug', text: body, files: files });
    await navigator.clipboard.writeText(body);
    alert('Copied the report text. Paste it where you want to send it.');
  }

  var QNBug = window.QNBug = {
    show: showButton, open: function () { if (!btn) makeButton(); open(); },
    context: null, save: null,
    note: function (what) { push(actions, 30, what); }
  };
})();
