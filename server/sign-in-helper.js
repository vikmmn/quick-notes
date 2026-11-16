// Quick Notes sign-in helper: a Cloudflare Worker that keeps you signed in to Google Drive.
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
      if (!t.refresh_token) return reply(400, { error: 'no_lasting_permission', error_description: 'Google did not give a lasting permission. Remove Quick Notes from myaccount.google.com/permissions, then sign in again.' });
      return reply(200, { access_token: t.access_token, expires_in: t.expires_in, refresh: await seal(env, t.refresh_token) });
    }

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
