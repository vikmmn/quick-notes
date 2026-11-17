// Serendipity sign-in helper: a Cloudflare Worker that keeps you signed in to Google Drive,
// and carries feedback from the app to the developer (and the developer's replies back).
//
// Google only gives a web page one-hour sign-ins. Signing in once through this helper gives a lasting
// permission (a "refresh token"). The helper seals it with your own secret key and hands the sealed copy to
// your phone; the phone can't read it, only send it back here to get a fresh one-hour sign-in, silently.
// Nothing is stored on Cloudflare.
//
// Settings (Worker › Settings › Variables and secrets):
//   CLIENT_ID      (text)   the app's Google client ID (the one in config.js)
//   CLIENT_SECRET  (secret) that client's secret, from Google Cloud Console › Clients
//   SEAL_KEY       (secret) any long random text; changing it signs every device out
//   ALLOWED_ORIGIN (text)   https://vikmmn.github.io
//
// Feedback (optional; without these the app saves feedback in the sender's own Drive only):
//   FEEDBACK_REPO  (text)   owner/name of a PRIVATE GitHub repository, e.g. vikmmn/quick-notes-feedback
//   FEEDBACK_TOKEN (secret) a fine-grained GitHub token for that repository only: Issues and Contents, read and write
// Each report becomes an issue there, with its picture saved in the repository's shots/ folder. Reply on the issue
// and the app shows the reply to the person who sent it. Each install has a random ID it keeps to itself; issues
// carry only a fingerprint of it (qnid), so only that install can read the replies.

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin !== env.ALLOWED_ORIGIN) return reply(403, { error: 'not_allowed' });
    if (request.method !== 'POST') return reply(405, { error: 'post_only' });

    let body;
    try { body = await request.json(); } catch (e) { return reply(400, { error: 'bad_request' }); }
    const path = new URL(request.url).pathname;

    // After "Sign in with Google": swap the one-time code for a sign-in and the sealed lasting permission.
    if (path === '/exchange') {
      if (!body.code || !String(body.redirect_uri || '').startsWith(env.ALLOWED_ORIGIN + '/')) return reply(400, { error: 'bad_request' });
      const t = await google(env, { grant_type: 'authorization_code', code: body.code, redirect_uri: body.redirect_uri });
      if (!t.access_token) return reply(400, { error: t.error || 'exchange_failed', error_description: t.error_description });
      if (!t.refresh_token) return reply(400, { error: 'no_lasting_permission', error_description: 'Google did not give a lasting permission. Remove Serendipity from myaccount.google.com/permissions, then sign in again.' });
      return reply(200, { access_token: t.access_token, expires_in: t.expires_in, refresh: await seal(env, t.refresh_token) });
    }

    if (path.startsWith('/feedback/')) return feedback(path, body, env, reply);

    // Whenever the one-hour sign-in runs out: a fresh one, no tap needed.
    if (path === '/refresh') {
      let rt;
      try { rt = await unseal(env, String(body.refresh || '')); } catch (e) { return reply(401, { error: 'invalid_grant' }); }
      const t = await google(env, { grant_type: 'refresh_token', refresh_token: rt });
      if (t.error === 'invalid_grant') return reply(401, { error: 'invalid_grant' }); // permission withdrawn: sign in again
      if (!t.access_token) return reply(502, { error: t.error || 'refresh_failed' });
      return reply(200, { access_token: t.access_token, expires_in: t.expires_in });
    }
    return reply(404, { error: 'not_found' });
  }
};

// ---------- Feedback: GitHub issues in a private repository ----------
const USER_MARK = '<!-- qn:from-app -->';
async function gh(env, method, path, data) {
  const r = await fetch('https://api.github.com/repos/' + env.FEEDBACK_REPO + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.FEEDBACK_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'quick-notes-helper', 'X-GitHub-Api-Version': '2022-11-28', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('github ' + r.status + ' ' + (j.message || ''));
  return j;
}
async function fingerprint(iid) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('qn-feedback:' + iid)));
  return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
async function owned(env, iid, n) { // the issue, if it was sent by this install
  const issue = await gh(env, 'GET', '/issues/' + n);
  return String(issue.body || '').includes('qnid:' + await fingerprint(iid)) ? issue : null;
}
async function feedback(path, body, env, reply) {
  if (!env.FEEDBACK_REPO || !env.FEEDBACK_TOKEN) return reply(501, { error: 'feedback_not_set_up' });
  const iid = String(body.iid || '');
  if (!/^[a-f0-9]{32,64}$/.test(iid)) return reply(400, { error: 'bad_request' });
  try {
    // A new report: the picture into shots/, then an issue with the words, the picture and the details.
    if (path === '/feedback/send') {
      const fp = await fingerprint(iid), stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let img = '';
      const png = String(body.image || '');
      if (png && png.length < 6000000 && /^[A-Za-z0-9+/=]+$/.test(png)) {
        const ext = body.imageType === 'jpeg' ? 'jpg' : 'png';
        const file = 'shots/' + stamp + '-' + fp.slice(0, 6) + '.' + ext;
        await gh(env, 'PUT', '/contents/' + file, { message: 'Picture for feedback ' + stamp, content: png });
        img = '![picture](https://github.com/' + env.FEEDBACK_REPO + '/blob/main/' + file + '?raw=true)\n\n';
      }
      const text = clip(body.text, 8000).trim();
      const issue = await gh(env, 'POST', '/issues', {
        title: clip(body.title || 'Feedback', 120),
        body: (text || '_(only a drawing)_') + '\n\n' + img + '<details><summary>Details</summary>\n\n```\n' + clip(body.details, 6000) + '\n```\n</details>\n\n<sub>qnid:' + fp + '</sub>'
      });
      return reply(200, { issue: issue.number });
    }
    // The conversations of this install: its issues with the developer's replies and its own follow-ups.
    if (path === '/feedback/inbox') {
      const nums = (Array.isArray(body.issues) ? body.issues : []).map(Number).filter((n) => n > 0).slice(-20);
      const out = [];
      for (const n of nums) {
        const issue = await owned(env, iid, n).catch(() => null);
        if (!issue) continue;
        const comments = issue.comments ? await gh(env, 'GET', '/issues/' + n + '/comments?per_page=100') : [];
        out.push({ issue: n, title: issue.title, state: issue.state, at: issue.created_at,
          messages: comments.map((c) => ({ from: String(c.body || '').includes(USER_MARK) ? 'me' : 'dev', text: String(c.body || '').replace(USER_MARK, '').trim(), at: c.created_at })) });
      }
      return reply(200, { conversations: out });
    }
    // The sender answers the developer from the app.
    if (path === '/feedback/reply') {
      const n = Number(body.issue), text = clip(body.text, 4000).trim();
      if (!n || !text) return reply(400, { error: 'bad_request' });
      const issue = await owned(env, iid, n);
      if (!issue) return reply(404, { error: 'not_found' });
      await gh(env, 'POST', '/issues/' + n + '/comments', { body: USER_MARK + '\n' + text });
      if (issue.state === 'closed') await gh(env, 'PATCH', '/issues/' + n, { state: 'open' });
      return reply(200, { ok: true });
    }
  } catch (e) {
    return reply(502, { error: 'feedback_failed', error_description: String(e.message || e) });
  }
  return reply(404, { error: 'not_found' });
}

async function google(env, fields) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, ...fields })
  });
  return r.json();
}

// AES-GCM with a key made from SEAL_KEY.
async function key(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SEAL_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text)));
  return b64(iv) + '.' + b64(ct);
}
async function unseal(env, sealed) {
  const [iv, ct] = sealed.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(ct));
  return new TextDecoder().decode(pt);
}
