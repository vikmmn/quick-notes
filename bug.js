// Serendipity: send feedback. Touching the small feedback button takes a picture of the whole app at that instant;
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
  window.addEventListener('popstate', function (e) {
    // While the feedback screen is open the back gesture (an edge swipe while drawing, or pressing Send near the edge)
    // must not leave the note behind it (3.24.1): it is kept here instead. This listener runs before the app's own.
    if (guardBack > 0) { guardBack--; e.stopImmediatePropagation(); return; }
    push(actions, 30, 'back button');
    if (view) { e.stopImmediatePropagation(); try { history.pushState({ v: 'bug' }, ''); } catch (x) {} if (sayFn) sayFn('Back is paused while you write feedback. Tap Cancel to leave, or the round button to send.', 3500); }
  });

  // ---- The button ----
  var css = document.createElement('style');
  css.textContent =
    '.qn-bugbtn{position:fixed;z-index:90;width:38px;height:38px;border-radius:50%;border:0;display:grid;place-items:center;padding:0;min-height:0;' +
    'background:var(--accent,#c4432b);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.5;touch-action:none;cursor:grab;transition:opacity .2s,transform .12s}' +
    '.qn-bugbtn.docked{position:relative;left:auto!important;top:auto!important;width:34px;height:34px;opacity:1;box-shadow:none;margin:0 4px;cursor:pointer;flex:none}' +
    '.qn-bugbtn:hover,.qn-bugbtn.held{opacity:.95}' +
    '.qn-bugbtn.press{transform:scale(.86)}' +
    '.qn-bugbtn svg{width:20px;height:20px}' +
    '.qn-bugbtn.busy::before{content:"";position:absolute;inset:-4px;border-radius:50%;border:3px solid transparent;border-top-color:var(--accent,#c4432b);border-right-color:var(--accent,#c4432b);animation:qnspin .7s linear infinite}' +
    '.qn-bugbtn.sent{animation:qnpop .6s ease-out}' +
    '@keyframes qnspin{to{transform:rotate(360deg)}}' +
    '@keyframes qnpop{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(0,121,107,.6)}40%{transform:scale(1.25)}100%{transform:scale(1);box-shadow:0 0 0 18px rgba(0,121,107,0)}}' +
    '.qn-bugbtn.send{position:fixed;z-index:99;opacity:1;width:52px;height:52px;box-shadow:0 0 0 6px rgba(0,121,107,.3),0 4px 14px rgba(0,0,0,.4);' +
    'left:auto!important;right:14px!important;top:calc(68px + env(safe-area-inset-top))!important}' + // always the same place, under the ribbon, in any turn of the phone (3.24.1)
    '.qn-bugbtn.send svg{width:26px;height:26px}' +
    '.qn-bugbtn.dot{opacity:1}.qn-bugbtn.dot::after{content:"";position:absolute;top:-1px;right:-1px;width:11px;height:11px;border-radius:50%;background:#d93025;border:2px solid var(--paper,#fff)}' +
    '.qn-bugview{position:fixed;inset:0;z-index:95;background:#202124;touch-action:none;overflow:hidden;animation:qnfade .15s ease-out}' +
    '@keyframes qnfade{from{opacity:0}to{opacity:1}}' +
    '.qn-bugview canvas{position:absolute;left:0;top:0;touch-action:none}' +
    '.qn-bugview .stg{position:absolute;left:0;top:0;transform-origin:0 0}' +
    '.qn-bugview .kbgap{position:absolute;left:0;right:0;bottom:0;display:none;place-items:center;text-align:center;padding:16px;box-sizing:border-box;color:rgba(255,255,255,.6);font:13px var(--font,system-ui);background:repeating-linear-gradient(135deg,#1b1c1f 0 10px,#222327 10px 20px);pointer-events:none}' +
    '.qn-bugview .bt{position:absolute;top:calc(8px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:6px 8px;' +
    'background:rgba(32,33,36,.94);border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.4);white-space:nowrap;max-width:calc(100vw - 16px);overflow-x:auto}' +
    '.qn-bugview .bt button{min-height:34px;padding:5px 12px;font-size:14px;border-radius:10px;color:#fff;background:transparent;border:1px solid rgba(255,255,255,.18)}' +
    '.qn-bugview .bt button[aria-pressed=true]{background:rgba(242,177,52,.3);border-color:#f2b134}' +
    '.qn-bugview .bt .c{width:26px;height:26px;padding:0;min-height:0;border-radius:50%;border:2px solid rgba(255,255,255,.3)}' +
    '.qn-bugview .bt .c[aria-pressed=true]{border-color:#fff;box-shadow:0 0 0 2px #f2b134}' +
    '.qn-bugview .bt .sz{width:30px;height:34px;padding:0;display:grid;place-items:center}' +
    '.qn-bugview .bt .sz i{display:block;border-radius:50%;background:#fff}' +
    '.qn-bugview .bt b{width:1px;align-self:stretch;background:rgba(255,255,255,.2);margin:0 2px}' +
    '.qn-bugview .hint{position:absolute;left:50%;top:calc(64px + env(safe-area-inset-top));transform:translateX(-50%);background:rgba(32,33,36,.92);color:#fff;' +
    'font:14px/1.4 var(--font,system-ui);padding:8px 14px;border-radius:12px;pointer-events:none;transition:opacity .6s;text-align:center;max-width:90vw}' +
    '.qn-bugview .wait{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:15px var(--font,system-ui);pointer-events:none}' +
    '.qn-bugview .wait span{display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.55);padding:10px 16px;border-radius:12px}' +
    '.qn-bugview .wait span::before{content:"";width:18px;height:18px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:qnspin .7s linear infinite}' +
    '.qn-bugview .tn{position:absolute;min-width:160px;max-width:min(320px,70vw);background:#fff8c4;color:#202124;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,.45);padding:2px}' +
    '.qn-bugview .tn:not(:focus-within) textarea{-webkit-user-select:none;user-select:none}' +
    '.qn-bugview .tn{touch-action:none}.qn-bugview .tn.lifting{transform:scale(1.04);box-shadow:0 10px 24px rgba(0,0,0,.5);cursor:move}' +
    '.qn-bugbtn.floating:not(.send){z-index:90}' +
    '.qn-bugview .tn textarea{display:block;width:100%;box-sizing:border-box;border:0;outline:0;background:transparent;color:#202124;font:15px/1.35 var(--font,system-ui);padding:6px 8px;resize:none;overflow:hidden;min-height:34px}';
  document.head.appendChild(css);

  var ICON_FB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z" fill="currentColor" fill-opacity=".2"/><path d="M12 8v4M12 14.5v.01"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-3-7z" fill="currentColor" fill-opacity=".25"/><path d="M11 13l9-9"/></svg>';
  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var btn = null, shotP = null, dockEl = null, place = null, guardBack = 0, sayFn = null;
  function setLook(kind) {
    if (!btn) return;
    btn.innerHTML = kind === 'send' ? ICON_SEND : kind === 'ok' ? ICON_OK : ICON_FB;
    btn.setAttribute('aria-label', kind === 'send' ? 'Send this feedback' : 'Send feedback');
    btn.title = kind === 'send' ? 'Send' : 'Send feedback';
  }
  function makeButton() {
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'qn-bugbtn qn-bug-ui';
    setLook('fb');
    var pos = null;
    try { pos = JSON.parse(localStorage.getItem('qn-bugpos') || 'null'); } catch (e) {}
    place = function (x, y) {
      x = Math.max(2, Math.min(innerWidth - 40, x)); y = Math.max(60, Math.min(innerHeight - 120, y));
      btn.style.left = x + 'px'; btn.style.top = y + 'px'; return [x, y];
    };
    place(pos ? (pos[0] + 19 < innerWidth / 2 ? 2 : innerWidth - 40) : 2, pos ? pos[1] : Math.round(innerHeight * 0.42));
    // The picture is taken the moment the button is touched, before anything else reacts to the touch, so open
    // menus, pop-ups and the keyboard's formatting bar are in it. (This listener runs before the app's own.)
    var d = null;
    window.addEventListener('pointerdown', function (e) {
      if (!btn || !(e.target === btn || btn.contains(e.target))) return;
      e.stopPropagation(); e.preventDefault();
      d = { x: e.clientX, y: e.clientY, l: btn.offsetLeft, t: btn.offsetTop, moved: false };
      btn.classList.add('held', 'press');
      try { btn.setPointerCapture(e.pointerId); } catch (x) {}
      // One frame first, so the button visibly reacts before the (busy) picture-taking starts.
      if (!view) { shotP = new Promise(function (ok) { requestAnimationFrame(function () { setTimeout(ok, 0); }); }).then(capture); shotP.catch(function () {}); btn.classList.add('busy'); }
    }, true);
    btn.addEventListener('pointermove', function (e) {
      if (!d || view || dockEl) return; // a button in a bar stays put
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6) d.moved = true;
      if (d.moved) place(d.l + e.clientX - d.x, d.t + e.clientY - d.y);
    });
    btn.addEventListener('pointerup', function (e) {
      if (!d) return;
      var moved = d.moved; d = null; e.stopPropagation(); btn.classList.remove('held', 'press');
      if (view) { send(); return; }
      if (moved) {
        shotP = null; btn.classList.remove('busy');
        var side = btn.offsetLeft + 19 < innerWidth / 2 ? 2 : innerWidth - 40;
        var at = place(side, btn.offsetTop);
        try { localStorage.setItem('qn-bugpos', JSON.stringify(at)); } catch (x) {}
        return;
      }
      open(shotP);
    });
    btn.addEventListener('pointercancel', function () { d = null; btn.classList.remove('held', 'press'); });
    btn.addEventListener('click', function (e) { e.stopPropagation(); });
    window.addEventListener('resize', function () { if (!view && !dockEl) place(btn.offsetLeft, btn.offsetTop); });
    if (dockEl) dock(dockEl); else document.body.appendChild(btn);
  }
  // A fixed place for the button in a bar of the app (so it covers nothing and is never under the hand), or
  // floating at the side when there is no bar.
  function dock(el) {
    dockEl = el || null;
    if (!btn || view) return;
    if (dockEl) { dockEl.appendChild(btn); btn.classList.add('docked'); }
    else { document.body.appendChild(btn); btn.classList.remove('docked'); }
  }
  // A sheet, a menu or What's new over the bar: the button comes out of the bar to stay on top and usable (3.21).
  setInterval(function () {
    if (!btn || view || !dockEl || btn.style.display === 'none') return;
    var over = document.querySelector('.sheet-back:not(.hidden), .wn:not(.hidden), .drawer-back:not(.hidden)');
    if (over && btn.parentNode !== document.body) {
      var r = btn.getBoundingClientRect(); if (!r.width) return;
      document.body.appendChild(btn); btn.classList.remove('docked'); btn.classList.add('floating');
      btn.style.left = Math.round(r.left) + 'px'; btn.style.top = Math.round(r.top) + 'px';
    } else if (!over && btn.classList.contains('floating')) { btn.classList.remove('floating'); btn.style.left = btn.style.top = ''; dock(dockEl); }
  }, 300);
  function lift() { // above the feedback screen, where it was, as the Send button
    document.body.appendChild(btn); btn.classList.remove('docked', 'floating'); btn.classList.add('send'); // (3.22: 'floating' kept it under the feedback screen)
    btn.style.left = btn.style.top = ''; // its place now comes from the style sheet: top right, under the ribbon
  }
  function settle() {
    btn.classList.remove('send', 'busy');
    if (dockEl) dock(dockEl);
    else { var pos = null; try { pos = JSON.parse(localStorage.getItem('qn-bugpos') || 'null'); } catch (e) {} place(pos ? pos[0] : 2, pos ? pos[1] : Math.round(innerHeight * 0.42)); }
  }
  function showButton(on) {
    if (on && !btn) makeButton();
    if (btn) btn.style.display = on ? '' : 'none';
  }

  // ---- A picture of the whole app, exactly as it is on screen ----
  // Only what is on screen is copied (a long list or a big page can have thousands of parts out of view), at
  // the screen's own size, so it is quick even on a slower tablet.
  async function capture() {
    if (!window.htmlToImage) {
      await new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = 'screenshot.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
    }
    var W = innerWidth, H = innerHeight, sx = scrollX, sy = scrollY;
    var bg = getComputedStyle(document.body).backgroundColor;
    var opts = {
      width: W, height: H, pixelRatio: 1, backgroundColor: bg, skipFonts: true, cacheBust: false,
      filter: function (n) {
        if (!n.classList) return true;
        if (n.classList.contains('qn-bug-ui')) return false;
        if (!n.getBoundingClientRect) return true;
        var r = n.getBoundingClientRect();
        if (!r.width && !r.height) return true; // no box of its own (its children may still show)
        return !(r.bottom < -40 || r.right < -40 || r.top > H + 40 || r.left > W + 40);
      },
      style: sx || sy ? { transform: 'translate(' + (-sx) + 'px,' + (-sy) + 'px)' } : undefined
    };
    var timeout = new Promise(function (ok, bad) { setTimeout(function () { bad(new Error('it took too long')); }, 20000); });
    return Promise.race([window.htmlToImage.toCanvas(document.body, opts), timeout]);
  }

  // ---- The feedback screen: the picture lies exactly over the app. Draw on it (pen or finger), Text or a
  // finger double-tap writes a note there; two fingers double-tap to undo, three to redo; the button sends. ----
  var view = null, sendFn = null;
  async function open(p) {
    if (view) return;
    var ctx = (QNBug.context && QNBug.context()) || {};
    view = document.createElement('div'); view.className = 'qn-bugview qn-bug-ui';
    var COLORS = ['#d93025', '#f9ab00', '#1a73e8', '#ffffff'], SIZES = [2, 4, 8];
    view.innerHTML = '<canvas></canvas>' +
      '<div class="bt"><button type="button" data-t="pen" aria-pressed="true">Pen</button><button type="button" data-t="box" aria-pressed="false">Box</button><button type="button" data-t="text" aria-pressed="false">Text</button><b></b>' +
      COLORS.map(function (c, i) { return '<button type="button" class="c" data-c="' + c + '" style="background:' + c + '" aria-pressed="' + !i + '" aria-label="Colour"></button>'; }).join('') + '<b></b>' +
      SIZES.map(function (s, i) { return '<button type="button" class="sz" data-s="' + s + '" aria-pressed="' + (i === 0) + '" aria-label="Pen size"><i style="width:' + (s + 3) + 'px;height:' + (s + 3) + 'px"></i></button>'; }).join('') + '<b></b>' +
      '<button type="button" data-b="undo">Undo</button><button type="button" data-b="clear">Clear</button><button type="button" data-b="cancel">Cancel</button></div>' +
      '<div class="wait"><span>Taking a picture of the screen…</span></div>' +
      '<div class="hint" style="opacity:0"></div>';
    document.body.appendChild(view); view._w0 = innerWidth; view._h0 = innerHeight; // the size of the app the picture is of
    try { history.pushState({ v: 'bug' }, ''); } catch (x) {} // one step for the back gesture to use up
    if (btn) { lift(); setLook('send'); btn.classList.add('busy'); }
    var hint = view.querySelector('.hint'), wait = view.querySelector('.wait');
    function say(html, ms) { hint.innerHTML = html; hint.style.opacity = '1'; clearTimeout(say.t); say.t = setTimeout(function () { hint.style.opacity = '0'; }, ms || 3500); }
    sayFn = say;
    var shot = null, failed = null;
    try { shot = await (p || capture()); } catch (e) { failed = e; }
    if (!view) return; // cancelled while waiting
    wait.remove(); if (btn) btn.classList.remove('busy');
    say(failed ? 'Couldn’t take a picture of the screen (' + String(failed.message || failed) + '). You can still draw and write what happened.' :
      'Draw to point at things. Text (or a finger double-tap) writes a note. Two fingers double-tap: undo · three: redo.<br>Tap the round button again to send.' +
      '<br><small style="opacity:.75">The picture and app details (version, device, recent taps and errors) go to the developer.</small>', failed ? 7000 : 5000);
    var cv = view.querySelector('canvas'), g = cv.getContext('2d');
    var w = shot ? shot.width : innerWidth, h = shot ? shot.height : innerHeight;
    // The picture and the notes sit on a stage the size of the screen at the start (exactly over the app, even when the
    // keyboard opens). Turn the phone and the stage shrinks or grows to fit, so drawings and notes stay on what they point at (3.24.1).
    var W0 = view._w0, H0 = view._h0, sc = 1, ox = 0, oy = 0, lastW = innerWidth;
    var stg = document.createElement('div'); stg.className = 'stg'; stg.style.width = W0 + 'px'; stg.style.height = H0 + 'px';
    view.insertBefore(stg, view.firstChild); stg.appendChild(cv);
    cv.width = w; cv.height = h; cv.style.width = W0 + 'px'; cv.style.height = H0 + 'px';
    var k = w / W0;
    // (3.27.1, #79) The picture was taken with the keyboard up; once it goes down, its place is empty (a screen
    // picture can't include the keyboard). Say so there instead of leaving a blank strip.
    var gap = document.createElement('div'); gap.className = 'kbgap'; gap.textContent = 'The keyboard was here (a screen picture can\u2019t include it).';
    view.appendChild(gap);
    function showGap() { var bot = oy + H0 * sc, rest = innerHeight - bot; gap.style.display = rest > 80 ? 'grid' : 'none'; gap.style.height = Math.max(0, rest) + 'px'; }
    function fit() {
      sc = Math.min(innerWidth / W0, innerHeight / H0); ox = (innerWidth - W0 * sc) / 2; oy = (innerHeight - H0 * sc) / 2;
      stg.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + sc + ')';
      showGap();
    }
    var onTurn = function () { if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; fit(); } else showGap(); }; // (the keyboard changes only the height)
    fit(); window.addEventListener('resize', onTurn); view._off = function () { window.removeEventListener('resize', onTurn); };
    var marks = [], notes = [], done = [], undone = [], cur = null, tool = 'pen', color = COLORS[0], size = 2, lastTap = null, lastMulti = null;
    function paint(withNotes) {
      g.clearRect(0, 0, w, h);
      if (shot) g.drawImage(shot, 0, 0); else { g.fillStyle = '#202124'; g.fillRect(0, 0, w, h); }
      marks.concat(cur ? [cur] : []).forEach(function (m) {
        g.strokeStyle = m.c; g.lineWidth = m.s * k; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath();
        if (m.t === 'box') { var a = m.p[0], b = m.p[m.p.length - 1]; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
        else m.p.forEach(function (q, i) { if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); });
        g.stroke();
      });
      if (withNotes) notes.forEach(drawNote);
    }
    // A written note, drawn into the picture exactly where and as it shows on screen: same place, width, font and
    // line breaks. (Before 3.21 it was drawn at a fixed size, so the sent picture showed it smaller, wider or cut off,
    // and while sending both showed at once.)
    function drawNote(n) {
      var text = n.ta.value.replace(/\s+$/, ''); if (!text.trim()) return;
      var cr = cv.getBoundingClientRect(), r = n.el.getBoundingClientRect(), cs = getComputedStyle(n.ta);
      var fs = parseFloat(cs.fontSize) * k, lh = (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35) * k;
      var padX = (parseFloat(cs.paddingLeft) + 2) * k, padY = (parseFloat(cs.paddingTop) + 2) * k, maxW = (n.ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) * k;
      g.font = (cs.fontWeight || '400') + ' ' + fs + 'px ' + cs.fontFamily;
      var lines = [];
      text.split('\n').forEach(function (para) {
        var line = '';
        para.split(/(\s+)/).forEach(function (word) {
          if (!word) return;
          var t = line + word;
          if (g.measureText(t.trimEnd()).width > maxW && line.trim()) { lines.push(line.trimEnd()); line = word.trimStart(); }
          else line = t;
          while (g.measureText(line).width > maxW && line.length > 1) { // one long word: broken like the screen does
            var cut = line.length; while (cut > 1 && g.measureText(line.slice(0, cut)).width > maxW) cut--;
            lines.push(line.slice(0, cut)); line = line.slice(cut);
          }
        });
        lines.push(line.trimEnd());
      });
      var x = (r.left - cr.left) / sc * k, y = (r.top - cr.top) / sc * k, bw = r.width / sc * k, bh = Math.max(r.height / sc * k, lines.length * lh + 2 * padY);
      if (y + bh > h) y = Math.max(0, h - bh); if (x + bw > w) x = Math.max(0, w - bw); // all of it inside the picture
      var rad = 10 * k;
      var rr = function (ox, oy) { g.beginPath(); if (g.roundRect) g.roundRect(x + ox, y + oy, bw, bh, rad); else g.rect(x + ox, y + oy, bw, bh); };
      g.fillStyle = 'rgba(0,0,0,.35)'; rr(2 * k, 3 * k); g.fill();
      g.fillStyle = '#fff8c4'; rr(0, 0); g.fill();
      g.fillStyle = '#202124'; g.textBaseline = 'top';
      lines.forEach(function (l, i) { g.fillText(l, x + padX, y + padY + i * lh + (lh - fs) / 2); });
    }
    paint();
    function pt(e) { var r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * w / r.width, (e.clientY - r.top) * h / r.height]; }
    function noteEl(n) {
      n.el = document.createElement('div'); n.el.className = 'tn';
      n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px';
      n.el.innerHTML = '<textarea rows="1" placeholder="Type here"></textarea>';
      n.ta = n.el.firstChild;
      // Moving a note (3.22.x): press and hold it, then drag. A quick tap types in it, as before.
      var gs = null;
      n.el.addEventListener('pointerdown', function (e) {
        var focused = document.activeElement === n.ta;
        if (!focused) e.preventDefault(); // no keyboard or text selection until we know it is a tap
        e.stopPropagation();
        gs = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y, focused: focused, held: false, moved: false, id: e.pointerId };
        gs.t = setTimeout(function () {
          if (!gs || gs.moved) return;
          gs.held = true; n.el.classList.add('lifting'); if (navigator.vibrate) navigator.vibrate(12);
          try { n.el.setPointerCapture(gs.id); } catch (er) {}
        }, 320);
      });
      n.el.addEventListener('pointermove', function (e) {
        if (!gs) return;
        var dx = (e.clientX - gs.x) / sc, dy = (e.clientY - gs.y) / sc;
        if (!gs.held) {
          if (Math.hypot(dx, dy) * sc <= 10) return;
          if (gs.focused) { gs.moved = true; clearTimeout(gs.t); return; } // typing in it: a drag selects text, as usual
          // not being typed in: a plain press and drag moves it (3.24.1; before, it had to be held first)
          clearTimeout(gs.t); gs.held = true; gs.moved = true; n.el.classList.add('lifting');
          try { n.el.setPointerCapture(gs.id); } catch (er) {}
        }
        e.preventDefault();
        n.x = Math.max(0, Math.min(W0 - 60, gs.nx + dx)); n.y = Math.max(0, Math.min(H0 - 40, gs.ny + dy));
        n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px';
      });
      var endMove = function () {
        if (!gs) return; clearTimeout(gs.t); n.el.classList.remove('lifting');
        if (!gs.held && !gs.moved && !gs.focused) n.ta.focus(); // a quick tap: type
        gs = null;
      };
      n.el.addEventListener('pointerup', endMove); n.el.addEventListener('pointercancel', endMove);
      n.ta.addEventListener('input', function () { n.ta.style.height = 'auto'; n.ta.style.height = n.ta.scrollHeight + 'px'; });
      n.ta.addEventListener('blur', function () { setTimeout(function () { if (view && !n.ta.value.trim() && notes.indexOf(n) > -1) { n.el.remove(); notes.splice(notes.indexOf(n), 1); done.splice(done.indexOf(n), 1); } }, 150); });
      n.el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    }
    function addNote(x, y) {
      var n = { kind: 'note', x: Math.min(x, W0 - 170), y: Math.min(y, H0 - 60) };
      noteEl(n); stg.appendChild(n.el); notes.push(n); done.push(n); undone = [];
      setTimeout(function () { n.ta.focus(); }, 30);
    }
    function undo() {
      var it = done.pop(); if (!it) return;
      if (it.kind === 'note') { it.el.remove(); notes.splice(notes.indexOf(it), 1); } else marks.splice(marks.indexOf(it), 1);
      undone.push(it); paint();
    }
    function redo() {
      var it = undone.pop(); if (!it) return;
      if (it.kind === 'note') { stg.appendChild(it.el); notes.push(it); } else marks.push(it);
      done.push(it); paint();
    }
    // Fingers: one draws (or double-taps for a note), two double-tap to undo, three to redo.
    var touches = {}, multi = null;
    function nTouch() { return Object.keys(touches).length; }
    cv.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') document.activeElement.blur();
      hint.style.opacity = '0';
      if (e.pointerType === 'touch') {
        touches[e.pointerId] = [e.clientX, e.clientY];
        if (nTouch() > 1) { // a gesture, not drawing
          cur = null; paint();
          if (!multi) multi = { n: 0, t: Date.now(), moved: false };
          multi.n = Math.max(multi.n, nTouch());
          return;
        }
      }
      if (multi) return;
      var now = Date.now(), fingerish = e.pointerType !== 'pen';
      if (tool === 'text' || (fingerish && lastTap && now - lastTap.t < 380 && Math.abs(e.clientX - lastTap.x) < 30 && Math.abs(e.clientY - lastTap.y) < 30)) {
        lastTap = null; cur = null; paint(); addNote((e.clientX - ox) / sc, (e.clientY - oy) / sc); return;
      }
      lastTap = fingerish ? { t: now, x: e.clientX, y: e.clientY } : null;
      cur = { kind: 'mark', t: tool, c: color, s: size, p: [pt(e)] }; cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) {
      if (touches[e.pointerId] && multi) {
        var o = touches[e.pointerId];
        if (Math.abs(e.clientX - o[0]) + Math.abs(e.clientY - o[1]) > 12) multi.moved = true;
        return;
      }
      if (cur) { cur.p.push(pt(e)); paint(); }
    });
    function up(e) {
      if (touches[e.pointerId]) delete touches[e.pointerId];
      if (multi) {
        if (!nTouch()) {
          if (!multi.moved && Date.now() - multi.t < 450) { // a double tap: two fingers undo, three redo
            var tn = Math.min(3, multi.n), tnow = Date.now();
            if (lastMulti && lastMulti.n === tn && tnow - lastMulti.t < 500) { lastMulti = null; if (tn === 2) { undo(); say('Undone', 900); } else { redo(); say('Redone', 900); } }
            else lastMulti = { n: tn, t: tnow };
          }
          multi = null;
        }
        return;
      }
      if (cur && cur.p.length > 2) { marks.push(cur); done.push(cur); undone = []; lastTap = null; }
      cur = null; paint();
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    var busy = false;
    view.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || busy) return;
      if (b.dataset.t) { tool = b.dataset.t; view.querySelectorAll('[data-t]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); if (tool === 'text') say('Tap where the note should go.', 2000); return; }
      if (b.dataset.c) { color = b.dataset.c; view.querySelectorAll('[data-c]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
      if (b.dataset.s) { size = +b.dataset.s; view.querySelectorAll('[data-s]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); }); return; }
      var act = b.dataset.b;
      if (act === 'undo') undo();
      if (act === 'clear') { marks = []; notes.forEach(function (n) { n.el.remove(); }); notes = []; done = []; undone = []; paint(); }
      if (act === 'cancel') close();
    });
    view.querySelector('.bt').addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    sendFn = async function () {
      if (busy) return;
      var texts = notes.map(function (n) { return n.ta.value.trim(); }).filter(Boolean);
      if (!texts.length && !marks.length) { say('Draw on the screen or write a note first.', 3000); return; }
      busy = true; if (btn) btn.classList.add('busy');
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      paint(true);
      notes.forEach(function (n) { n.el.style.visibility = 'hidden'; }); // now in the picture: not shown twice
      var report = await build(texts.join('\n\n'), ctx, cv, !!shot);
      try {
        await QNBug.save(report);
        close();
        if (btn) { setLook('ok'); btn.classList.remove('sent'); void btn.offsetWidth; btn.classList.add('sent'); setTimeout(function () { if (!view) setLook('fb'); btn.classList.remove('sent'); }, 1600); }
      } catch (err) { say('Could not save the feedback: ' + (err.message || err), 5000); paint(); notes.forEach(function (n) { n.el.style.visibility = ''; }); }
      busy = false; if (btn) btn.classList.remove('busy');
    };
  }
  function send() { if (sendFn) sendFn(); }
  function close() {
    if (view) { if (view._off) view._off(); view.remove(); view = null; try { if (history.state && history.state.v === 'bug') { guardBack++; history.back(); } } catch (x) {} }
    sayFn = null;
    sendFn = null; shotP = null;
    if (btn) { settle(); setLook('fb'); }
    if (btn && btn.dataset.tmp) { delete btn.dataset.tmp; btn.style.display = 'none'; }
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
      'Serendipity ' + (CFG.VERSION || '?') + ' · ' + new Date().toString().slice(0, 24),
      'Device: ' + navigator.userAgent,
      'Screen: ' + innerWidth + '×' + innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x · ' +
        (matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser tab') + ' · ' + (navigator.onLine ? 'online' : 'offline') +
        ' · ' + (document.documentElement.dataset.skin || 'paper') + ' look, ' + (document.documentElement.dataset.shade || (matchMedia('(prefers-color-scheme: dark)').matches ? 'auto grey' : 'auto light')) + ', motion ' + (document.documentElement.dataset.motion || 'gentle')
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
    dock: dock,
    badge: function (on) { if (btn) { btn.classList.toggle('dot', !!on); btn.title = on ? 'The developer answered your feedback (Settings › Your feedback and replies)' : 'Send feedback'; } }
  };
})();
