// Quick Notes: send feedback. Touching the small feedback button takes a picture of the whole app at that instant;
// you draw on it in place, double-tap to write notes where you want them, and tap the button again to send. It is
// saved as a note in "Feedback" (with the picture and the
// details needed to fix it: version, device, what was on screen, the last things tapped and any errors).
// Loads first, to catch early errors.
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
    '.qn-bugbtn{position:fixed;z-index:90;width:38px;height:38px;border-radius:50%;border:0;display:grid;place-items:center;padding:0;min-height:0;' +
    'background:var(--accent,#00796b);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.5;touch-action:none;cursor:grab;transition:opacity .2s,left .2s}' +
    '.qn-bugbtn:hover,.qn-bugbtn.held{opacity:.95;transition:opacity .2s}' +
    '.qn-bugbtn svg{width:21px;height:21px}' +
    '.qn-bugbtn.dot{opacity:1}.qn-bugbtn.dot::after{content:"";position:absolute;top:-1px;right:-1px;width:12px;height:12px;border-radius:50%;background:#d93025;border:2px solid var(--paper,#fff)}' +
    '.qn-bugbtn.send{z-index:99;opacity:1;width:52px;height:52px;box-shadow:0 0 0 6px rgba(0,121,107,.3),0 4px 14px rgba(0,0,0,.4)}' +
    '.qn-bugbtn.send svg{width:26px;height:26px}' +
    '.qn-bugview{position:fixed;inset:0;z-index:95;background:#000;touch-action:none;overflow:hidden}' +
    '.qn-bugview canvas{position:absolute;left:0;top:0;width:100vw;height:100vh;touch-action:none}' +
    '.qn-bugview .bt{position:absolute;top:calc(8px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:6px 8px;' +
    'background:rgba(32,33,36,.92);border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.4);white-space:nowrap}' +
    '.qn-bugview .bt button{min-height:34px;padding:5px 12px;font-size:14px;border-radius:10px;color:#fff;background:transparent;border:1px solid rgba(255,255,255,.18)}' +
    '.qn-bugview .bt button[aria-pressed=true]{background:rgba(95,196,181,.3);border-color:#5fc4b5}' +
    '.qn-bugview .bt .c{width:26px;height:26px;padding:0;min-height:0;border-radius:50%;border:2px solid rgba(255,255,255,.3)}' +
    '.qn-bugview .bt .c[aria-pressed=true]{border-color:#fff;box-shadow:0 0 0 2px #5fc4b5}' +
    '.qn-bugview .bt i{width:1px;align-self:stretch;background:rgba(255,255,255,.2);margin:0 2px}' +
    '.qn-bugview .hint{position:absolute;left:50%;top:calc(64px + env(safe-area-inset-top));transform:translateX(-50%);background:rgba(32,33,36,.9);color:#fff;' +
    'font:14px/1.35 var(--font,system-ui);padding:8px 14px;border-radius:12px;pointer-events:none;transition:opacity .6s;text-align:center;max-width:90vw}' +
    '.qn-bugview .tn{position:absolute;min-width:160px;max-width:min(320px,70vw);background:#fff8c4;color:#202124;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.45);padding:2px}' +
    '.qn-bugview .tn textarea{display:block;width:100%;box-sizing:border-box;border:0;outline:0;background:transparent;color:#202124;font:15px/1.35 var(--font,system-ui);padding:6px 8px;resize:none;overflow:hidden;min-height:34px}' +
    '.qn-bugview .busy{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:15px var(--font,system-ui);background:rgba(0,0,0,.5)}';
  document.head.appendChild(css);

  var ICON_FB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z" fill="currentColor" fill-opacity=".2"/><path d="M12 8v4M12 14.5v.01"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-7z" fill="currentColor" fill-opacity=".25"/><path d="M11 13l9-9"/></svg>';
  var btn = null, shotP = null;
  function makeButton() {
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'qn-bugbtn qn-bug-ui'; btn.setAttribute('aria-label', 'Send feedback'); btn.title = 'Send feedback (drag to move)';
    btn.innerHTML = ICON_FB;
    var pos = null;
    try { pos = JSON.parse(localStorage.getItem('qn-bugpos') || 'null'); } catch (e) {}
    function place(x, y) {
      x = Math.max(2, Math.min(innerWidth - 40, x)); y = Math.max(60, Math.min(innerHeight - 120, y));
      btn.style.left = x + 'px'; btn.style.top = y + 'px'; return [x, y];
    }
    place(pos ? (pos[0] + 19 < innerWidth / 2 ? 2 : innerWidth - 40) : 2, pos ? pos[1] : Math.round(innerHeight * 0.42));
    // The picture is taken the moment the button is touched, before anything else reacts to the touch, so open
    // menus, pop-ups and the keyboard's formatting bar are in it. (This listener runs before the app's own.)
    var d = null;
    window.addEventListener('pointerdown', function (e) {
      if (!btn || !(e.target === btn || btn.contains(e.target))) return;
      e.stopPropagation(); e.preventDefault();
      d = { x: e.clientX, y: e.clientY, l: btn.offsetLeft, t: btn.offsetTop, moved: false };
      btn.classList.add('held');
      try { btn.setPointerCapture(e.pointerId); } catch (x) {}
      if (!view) { shotP = capture(); shotP.catch(function () {}); }
    }, true);
    btn.addEventListener('pointermove', function (e) {
      if (!d || view) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6) d.moved = true;
      if (d.moved) place(d.l + e.clientX - d.x, d.t + e.clientY - d.y);
    });
    btn.addEventListener('pointerup', function (e) {
      if (!d) return;
      var moved = d.moved; d = null; e.stopPropagation(); btn.classList.remove('held');
      if (view) { send(); return; }
      if (moved) {
        shotP = null;
        var side = btn.offsetLeft + 19 < innerWidth / 2 ? 2 : innerWidth - 40;
        var at = place(side, btn.offsetTop);
        try { localStorage.setItem('qn-bugpos', JSON.stringify(at)); } catch (x) {}
        return;
      }
      open(shotP);
    });
    btn.addEventListener('click', function (e) { e.stopPropagation(); });
    window.addEventListener('resize', function () { if (!view) place(btn.offsetLeft, btn.offsetTop); });
    document.body.appendChild(btn);
  }
  function showButton(on) {
    if (on && !btn) makeButton();
    if (btn) btn.style.display = on ? '' : 'none';
  }

  // ---- A picture of the whole app, exactly as it is on screen ----
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

  // ---- The feedback screen: the picture lies exactly over the app; draw on it, double-tap to write a note there,
  // and tap the feedback button again to send. ----
  var view = null, sendFn = null;
  async function open(p) {
    if (view) return;
    var ctx = (QNBug.context && QNBug.context()) || {};
    var shot = null, failed = null;
    try { shot = await (p || capture()); } catch (e) { failed = e; }
    view = document.createElement('div'); view.className = 'qn-bugview qn-bug-ui';
    view.innerHTML = '<canvas></canvas>' +
      '<div class="bt"><button type="button" data-t="pen" aria-pressed="true">Pen</button><button type="button" data-t="box" aria-pressed="false">Box</button>' +
      ['#d93025', '#f9ab00', '#1a73e8', '#ffffff'].map(function (c, i) { return '<button type="button" class="c" data-c="' + c + '" style="background:' + c + '" aria-pressed="' + !i + '" aria-label="Colour"></button>'; }).join('') +
      '<i></i><button type="button" data-b="undo">Undo</button><button type="button" data-b="clear">Clear</button><button type="button" data-b="cancel">Cancel</button></div>' +
      '<div class="hint">' + (failed ? 'Couldn’t take a picture of the screen (' + String(failed.message || failed) + '). Double-tap to write what happened.' :
        'Draw on the screen to point at things. Double-tap anywhere to write a note there.<br>Tap the round button again to send.') +
      '<br><small style="opacity:.75">The picture and app details (version, device, recent taps and errors) go to the developer.</small></div>';
    document.body.appendChild(view);
    if (btn) { btn.classList.add('send'); btn.innerHTML = ICON_SEND; btn.setAttribute('aria-label', 'Send this feedback'); btn.title = 'Send'; }
    var hint = view.querySelector('.hint');
    setTimeout(function () { if (hint) hint.style.opacity = '0'; }, 5000);
    var cv = view.querySelector('canvas'), g = cv.getContext('2d');
    var w = shot ? shot.width : Math.round(innerWidth * 2), h = shot ? shot.height : Math.round(innerHeight * 2);
    cv.width = w; cv.height = h; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; // exactly over the app, even when the keyboard opens
    var marks = [], notes = [], cur = null, tool = 'pen', color = '#d93025', lastTap = null;
    function paint(withNotes) {
      g.clearRect(0, 0, w, h);
      if (shot) g.drawImage(shot, 0, 0); else { g.fillStyle = '#202124'; g.fillRect(0, 0, w, h); }
      marks.concat(cur ? [cur] : []).forEach(function (m) {
        g.strokeStyle = m.c; g.lineWidth = Math.max(3, w / 300); g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        if (m.t === 'box') { var a = m.p[0], b = m.p[m.p.length - 1]; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
        else m.p.forEach(function (q, i) { if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
        g.stroke();
      });
      if (withNotes) notes.forEach(drawNote);
    }
    // A written note, drawn into the picture where it was placed.
    function drawNote(n) {
      var text = n.ta.value.trim(); if (!text) return;
      var k = w / innerWidth, fs = 15 * k, pad = 8 * k, maxW = Math.min(320, innerWidth * 0.7) * k - 2 * pad;
      g.font = fs + 'px system-ui, sans-serif';
      var lines = [];
      text.split('\n').forEach(function (para) {
        var line = '';
        para.split(/\s+/).forEach(function (word) {
          var t = line ? line + ' ' + word : word;
          if (g.measureText(t).width > maxW && line) { lines.push(line); line = word; } else line = t;
        });
        lines.push(line);
      });
      var lw = Math.max.apply(null, lines.map(function (l) { return g.measureText(l).width; })), lh = fs * 1.35;
      var x = n.x * k, y = n.y * k, bw = lw + 2 * pad, bh = lines.length * lh + 2 * pad;
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x + 2 * k, y + 3 * k, bw, bh);
      g.fillStyle = '#fff8c4'; g.fillRect(x, y, bw, bh);
      g.fillStyle = '#202124'; g.textBaseline = 'top';
      lines.forEach(function (l, i) { g.fillText(l, x + pad, y + pad + i * lh + fs * 0.1); });
    }
    paint();
    function pt(e) { var r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * w / r.width, (e.clientY - r.top) * h / r.height]; }
    function addNote(x, y) {
      var n = { x: Math.min(x, innerWidth - 170), y: Math.min(y, innerHeight - 60) };
      n.el = document.createElement('div'); n.el.className = 'tn';
      n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px';
      n.el.innerHTML = '<textarea rows="1" placeholder="Type here"></textarea>';
      n.ta = n.el.firstChild;
      n.ta.addEventListener('input', function () { n.ta.style.height = 'auto'; n.ta.style.height = n.ta.scrollHeight + 'px'; });
      n.ta.addEventListener('blur', function () { setTimeout(function () { if (!n.ta.value.trim() && view) { n.el.remove(); notes.splice(notes.indexOf(n), 1); } }, 150); });
      n.el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      view.appendChild(n.el); notes.push(n);
      setTimeout(function () { n.ta.focus(); }, 30);
    }
    cv.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') document.activeElement.blur();
      if (hint) hint.style.opacity = '0';
      var now = Date.now();
      if (lastTap && now - lastTap.t < 380 && Math.abs(e.clientX - lastTap.x) < 30 && Math.abs(e.clientY - lastTap.y) < 30) {
        lastTap = null; cur = null; addNote(e.clientX, e.clientY); return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      cur = { t: tool, c: color, p: [pt(e)] }; cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) { if (cur) { cur.p.push(pt(e)); paint(); } });
    cv.addEventListener('pointerup', function () {
      if (cur && cur.p.length > 2) { marks.push(cur); lastTap = null; }
      cur = null; paint();
    });
    var busy = false;
    view.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || busy) return;
      if (b.dataset.t) { tool = b.dataset.t; view.querySelectorAll('[data-t]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
      if (b.dataset.c) { color = b.dataset.c; view.querySelectorAll('[data-c]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
      var act = b.dataset.b;
      if (act === 'undo') { if (marks.length) marks.pop(); else if (notes.length) { notes.pop().el.remove(); } paint(); }
      if (act === 'clear') { marks = []; notes.forEach(function (n) { n.el.remove(); }); notes = []; paint(); }
      if (act === 'cancel') close();
    });
    view.querySelector('.bt').addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    sendFn = async function () {
      if (busy) return;
      var texts = notes.map(function (n) { return n.ta.value.trim(); }).filter(Boolean);
      if (!texts.length && !marks.length) {
        hint.innerHTML = 'Draw on the screen or double-tap to write something first.'; hint.style.opacity = '1';
        setTimeout(function () { hint.style.opacity = '0'; }, 3000); return;
      }
      busy = true; btn.style.opacity = '.5';
      paint(true);
      var report = await build(texts.join('\n\n'), ctx, cv, !!shot);
      try { await QNBug.save(report); close(); }
      catch (err) { alert('Could not save the feedback: ' + (err.message || err)); paint(); }
      busy = false; if (btn) btn.style.opacity = '';
    };
  }
  function send() { if (sendFn) sendFn(); }
  function close() {
    if (view) { view.remove(); view = null; }
    sendFn = null; shotP = null;
    if (btn && btn.dataset.tmp) { delete btn.dataset.tmp; btn.style.display = 'none'; }
    if (btn) { btn.classList.remove('send'); btn.innerHTML = ICON_FB; btn.setAttribute('aria-label', 'Send feedback'); btn.title = 'Send feedback (drag to move)'; }
  }

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
  var QNBug = window.QNBug = {
    show: showButton, open: function () { if (!btn) makeButton(); if (btn.style.display === 'none') { btn.dataset.tmp = '1'; btn.style.display = ''; } open(); },
    context: null, save: null,
    note: function (what) { push(actions, 30, what); },
    badge: function (on) { if (btn) { btn.classList.toggle('dot', !!on); btn.title = on ? 'The developer answered your feedback (Settings › Your feedback and replies)' : 'Send feedback (drag to move)'; } }
  };
})();
