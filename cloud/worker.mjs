import { handleLedger } from './ledger.mjs';

const sessionCookie = '__Host-fj-session';
const oauthCookie = '__Host-fj-oauth';
const sessionAge = 30 * 24 * 60 * 60;
const oauthAge = 10 * 60;
const encoder = new TextEncoder();

function privateHeaders() {
  return new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
}

function json(body, status = 200, headers = privateHeaders()) {
  return Response.json(body, { status, headers });
}

function error(code, status) {
  const descriptions = { unauthorized: 'Sign in to view the ledger.', forbidden: 'This request is not allowed.',
    method: 'This method is not allowed.', setup: 'Connect the private account before signing in.',
    unavailable: 'The private ledger is temporarily unavailable.', missing: 'Page not found.' };
  return json({ code, error: descriptions[code] }, status);
}

function redirect(location, cookies = []) {
  const headers = privateHeaders();
  headers.set('Location', location);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function cookie(name, value, age) {
  return `${name}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  return request.headers.get('Cookie')?.split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function isToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function configured(env) {
  return Boolean(env.DB && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    && /^[1-9]\d*$/.test(env.OWNER_GITHUB_ID ?? '') && env.APP_ORIGIN?.startsWith('https://'));
}

async function session(request, env) {
  const token = readCookie(request, sessionCookie);
  if (!isToken(token)) return null;
  const hash = await digest(token);
  const row = await env.DB.prepare('SELECT owner_id FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(hash, Date.now()).first();
  return row?.owner_id === env.OWNER_GITHUB_ID ? { ownerId: row.owner_id, hash } : null;
}

async function beginSignIn(env) {
  const state = randomToken();
  const verifier = randomToken();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.APP_ORIGIN}/auth/callback`,
    state,
    code_challenge: await digest(verifier),
    code_challenge_method: 'S256',
    allow_signup: 'false',
  });
  return redirect(authorize.href, [cookie(oauthCookie, `${state}.${verifier}.${Date.now()}`, oauthAge)]);
}

async function finishSignIn(request, env, url, providerFetch) {
  const clear = cookie(oauthCookie, '', 0);
  const [state, verifier, createdAt] = (readCookie(request, oauthCookie) ?? '').split('.');
  const code = url.searchParams.get('code');
  const age = Date.now() - Number(createdAt);
  if (!isToken(state) || !isToken(verifier) || url.searchParams.get('state') !== state
    || !Number.isFinite(age) || age < 0 || age > oauthAge * 1000 || !code || code.length > 256) {
    return redirect('/?signIn=retry', [clear]);
  }

  const tokenResponse = await providerFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: `${env.APP_ORIGIN}/auth/callback`,
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) return redirect('/?signIn=retry', [clear]);
  const token = await tokenResponse.json();
  if (typeof token.access_token !== 'string') return redirect('/?signIn=retry', [clear]);

  const profileResponse = await providerFetch('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'Figgjaraetlan' },
  });
  if (!profileResponse.ok) return redirect('/?signIn=retry', [clear]);
  const profile = await profileResponse.json();
  if (!Number.isSafeInteger(profile.id) || String(profile.id) !== env.OWNER_GITHUB_ID) return redirect('/?signIn=denied', [clear]);

  const value = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
      .bind(await digest(value), env.OWNER_GITHUB_ID, now + sessionAge * 1000),
  ]);
  return redirect('/', [clear, cookie(sessionCookie, value, sessionAge)]);
}

export function createWorker(providerFetch = (...args) => fetch(...args)) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const { pathname } = url;
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/auth/')) return env.ASSETS.fetch(request);
      if (!configured(env)) {
        if (pathname === '/api/session' && request.method === 'GET') return json({ signedIn: false, configured: false });
        if (pathname === '/auth/login' && request.method === 'GET') return redirect('/?signIn=setup');
        return error('setup', 503);
      }
      if (url.origin !== env.APP_ORIGIN) return error('missing', 404);
      if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) return error('forbidden', 403);

      try {
        if (pathname === '/auth/login') return request.method === 'GET' ? await beginSignIn(env) : error('method', 405);
        if (pathname === '/auth/callback') return request.method === 'GET' ? await finishSignIn(request, env, url, providerFetch) : error('method', 405);
        const user = await session(request, env);
        if (pathname === '/api/session') {
          if (request.method !== 'GET') return error('method', 405);
          return json(user ? { signedIn: true, ownerId: user.ownerId } : { signedIn: false });
        }
        if (pathname === '/auth/logout') {
          if (request.method !== 'POST') return error('method', 405);
          if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.hash).run();
          const headers = privateHeaders();
          headers.append('Set-Cookie', cookie(sessionCookie, '', 0));
          return json({ signedIn: false }, 200, headers);
        }
        if (pathname !== '/api/ledger') return error('missing', 404);
        if (!user) return error('unauthorized', 401);
        const result = await handleLedger(request, env.DB);
        const headers = new Headers(result.headers);
        for (const [name, value] of privateHeaders()) headers.set(name, value);
        return new Response(result.body, { status: result.status, headers });
      } catch {
        if (pathname === '/auth/callback') return redirect('/?signIn=retry', [cookie(oauthCookie, '', 0)]);
        return error('unavailable', 503);
      }
    },
  };
}

export default createWorker();
