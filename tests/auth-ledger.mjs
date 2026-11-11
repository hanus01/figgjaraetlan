import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSqliteD1 } from './sqlite-d1.mjs';
import { createWorker } from '../cloud/worker.mjs';

const { db, close } = createSqliteD1();
const origin = 'https://budget.example.invalid';
const codes = new Map();
let nextCode = 1;
let providerCalls = 0;
const groups = [];
const sha = (value) => createHash('sha256').update(value).digest('base64url');
const env = {
  DB: db,
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  OWNER_GITHUB_ID: '123456',
  APP_ORIGIN: origin,
  ASSETS: { fetch: async () => new Response('Public app shell') },
};
const mockProvider = async (input, init) => {
  providerCalls += 1;
  if (input === 'https://github.com/login/oauth/access_token') {
    assert.equal(init.method, 'POST');
    const fields = new URLSearchParams(init.body);
    assert.equal(fields.get('client_id'), env.GITHUB_CLIENT_ID);
    assert.equal(fields.get('client_secret'), env.GITHUB_CLIENT_SECRET);
    assert.equal(fields.get('redirect_uri'), origin + '/auth/callback');
    const issued = codes.get(fields.get('code'));
    codes.delete(fields.get('code'));
    if (!issued || sha(fields.get('code_verifier')) !== issued.challenge) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return Response.json({ access_token: String(issued.ownerId) });
  }
  assert.equal(input, 'https://api.github.com/user');
  assert.ok(init.headers['User-Agent']);
  return Response.json({ id: Number(init.headers.Authorization.slice('Bearer '.length)), login: 'display-name-is-irrelevant' });
};
const worker = createWorker(mockProvider);

function cookieValue(response, name) {
  const setCookies = response.headers.getSetCookie();
  return setCookies.find((item) => item.startsWith(name + '='))?.split(';')[0];
}
function cookiePart(pair) {
  return pair?.slice(pair.indexOf('=') + 1);
}
async function request(path, options = {}) {
  const response = await worker.fetch(new Request(origin + path, options), env);
  if (path.startsWith('/api/') || path.startsWith('/auth/')) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
  return response;
}
async function start(ownerId = Number(env.OWNER_GITHUB_ID)) {
  const response = await request('/auth/login');
  assert.equal(response.status, 303);
  const authorize = new URL(response.headers.get('location'));
  assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/auth/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('allow_signup'), 'false');
  assert.equal(authorize.searchParams.has('scope'), false);
  const pair = cookieValue(response, '__Host-fj-oauth');
  const [state, verifier, created] = cookiePart(pair).split('.');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sha(verifier), authorize.searchParams.get('code_challenge'));
  assert.ok(Date.now() - Number(created) < 1000);
  const header = response.headers.getSetCookie()[0];
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(attribute));
  assert.ok(!header.includes('Domain='));
  const code = 'one-time-' + nextCode++;
  codes.set(code, { ownerId, challenge: authorize.searchParams.get('code_challenge') });
  return { pair, state, verifier, created, code };
}
async function finish(login, pair = login.pair, state = login.state) {
  return request('/auth/callback?state=' + encodeURIComponent(state) + '&code=' + login.code, {
    headers: { Cookie: pair },
  });
}
async function signedIn() {
  const login = await start();
  const response = await finish(login);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const pair = cookieValue(response, '__Host-fj-session');
  assert.ok(pair);
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-fj-oauth=;') && cookie.includes('Max-Age=0')));
  return pair;
}
function post(body, session, requestOrigin = origin) {
  const headers = { 'Content-Type': 'application/json', Cookie: session };
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

function patch(operationId, baseRevision, changes) {
  return {
    type: 'patch', operationId, baseRevision,
    changes: {
      categories: { upsert: [], remove: [] },
      months: { upsert: [], remove: [] },
      transactions: { upsert: [], remove: [] },
      ...changes,
    },
  };
}

async function writeLedger(body, session, expectedStatus = 200) {
  const response = await request('/api/ledger', post(body, session));
  assert.equal(response.status, expectedStatus);
  return response.json();
}

try {
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/ledger')).status, 401);
  assert.equal((await request('/api/ledger', { headers: { Cookie: '__Host-fj-session=garbage' } })).status, 401);
  assert.deepEqual(await (await request('/api/session')).json(), { signedIn: false });
  assert.equal((await worker.fetch(new Request('https://elsewhere.invalid/api/ledger'), env)).status, 404);
  const incomplete = { ...env, GITHUB_CLIENT_SECRET: undefined };
  assert.equal((await worker.fetch(new Request(origin + '/api/ledger'), incomplete)).status, 503);
  assert.deepEqual(await (await worker.fetch(new Request(origin + '/api/session'), incomplete)).json(), {
    signedIn: false, configured: false,
  });
  groups.push('anonymous access and configuration');

  let login = await start();
  let callsBefore = providerCalls;
  let response = await finish(login, login.pair, 'wrong-state');
  assert.equal(response.headers.get('location'), '/?signIn=retry');
  assert.equal(providerCalls, callsBefore);
  response = await finish(login, '');
  assert.equal(response.headers.get('location'), '/?signIn=retry');
  assert.equal(providerCalls, callsBefore);
  for (const created of [Date.now() - 601_000, Date.now() + 60_000]) {
    response = await finish(login, '__Host-fj-oauth=' + [login.state, login.verifier, created].join('.'));
    assert.equal(response.headers.get('location'), '/?signIn=retry');
    assert.equal(providerCalls, callsBefore);
  }
  const wrongVerifier = 'A'.repeat(43);
  response = await finish(login, '__Host-fj-oauth=' + [login.state, wrongVerifier, login.created].join('.'));
  assert.equal(response.headers.get('location'), '/?signIn=retry');
  assert.equal(providerCalls, callsBefore + 1);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count'), 0);
  groups.push('state, time bounds, and PKCE');

  login = await start(654321);
  response = await finish(login);
  assert.equal(response.headers.get('location'), '/?signIn=denied');
  assert.equal(cookieValue(response, '__Host-fj-session'), undefined);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count'), 0);
  groups.push('numeric owner allowlist');

  const session = await signedIn();
  const sessionHash = sha(cookiePart(session));
  const stored = await db.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(sessionHash).first();
  assert.equal(stored.owner_id, env.OWNER_GITHUB_ID);
  assert.notEqual(stored.token_hash, cookiePart(session));
  assert.ok(stored.expires_at > Date.now());
  assert.deepEqual(await (await request('/api/session', { headers: { Cookie: session } })).json(), {
    signedIn: true, ownerId: env.OWNER_GITHUB_ID,
  });
  assert.equal((await worker.fetch(new Request(origin + '/api/ledger', { headers: { Cookie: session } }), {
    ...env, OWNER_GITHUB_ID: '654321',
  })).status, 401);
  groups.push('private sessions and hashed credentials');

  const operation = {
    type: 'append', operationId: 'e2e-purchase-1', transaction: {
      id: 'purchase-1', date: '2026-11-11', description: 'Bónus',
      categoryId: 'groceries', type: 'expense', amountOre: 29550,
    },
  };
  for (const requestOrigin of ['https://attacker.invalid', null, 'null']) {
    response = await request('/api/ledger', post(operation, session, requestOrigin));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'forbidden');
  }
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { Cookie: session } })).status, 403);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count'), 1);
  groups.push('CSRF protections');

  response = await request('/api/ledger', { headers: { Cookie: session } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"0"');
  let snapshot = await response.json();
  assert.equal(snapshot.state.transactions.length, 0);
  response = await request('/api/ledger', { headers: { Cookie: session, 'If-None-Match': '"0"' } });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('etag'), '"0"');
  assert.equal(await response.text(), '');
  const attempts = await Promise.all([
    request('/api/ledger', post(operation, session)),
    request('/api/ledger', post(operation, session)),
  ]);
  for (const attempt of attempts) {
    assert.equal(attempt.status, 200);
    assert.equal(attempt.headers.get('etag'), '"1"');
    snapshot = await attempt.json();
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.state.transactions, [operation.transaction]);
    assert.deepEqual(snapshot.state.months['2026-11'], { status: 'active', budget: null });
  }
  response = await request('/api/ledger', post({ ...operation, transaction: { ...operation.transaction, amountOre: 1 } }, session));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'duplicate');
  response = await request('/api/ledger', { headers: { Cookie: session, 'If-None-Match': '"0"' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"1"');
  assert.equal((await response.json()).state.transactions.length, 1);
  assert.equal((await request('/api/ledger', { headers: { Cookie: session, 'If-None-Match': '"1"' } })).status, 304);
  groups.push('ledger mutation, retry idempotence, and ETag');

  const originalPlan = {
    income: [{ id: 'salary', label: 'Løn', amountOre: 2000000 }],
    allocations: [{ categoryId: 'groceries', label: 'Matvørur', kind: 'variable', amountOre: 180000 }],
    copiedFrom: null,
  };
  snapshot = await writeLedger(patch('october-plan', 1, {
    months: { upsert: [{ key: '2026-10', value: { status: 'completed', budget: originalPlan } }], remove: [] },
  }), session);
  const copiedPlan = globalThis.BudgetCore.createBudget(snapshot.state, '2026-11');
  assert.deepEqual(copiedPlan, { ...originalPlan, copiedFrom: '2026-10' });
  snapshot = await writeLedger(patch('november-copy', snapshot.revision, {
    months: { upsert: [{ key: '2026-11', value: { status: 'skipped', budget: copiedPlan } }], remove: [] },
  }), session);
  const correctedPlan = structuredClone(originalPlan);
  correctedPlan.allocations[0].amountOre = 220000;
  snapshot = await writeLedger(patch('historical-plan-correction', snapshot.revision, {
    months: { upsert: [{ key: '2026-10', value: { status: 'completed', budget: correctedPlan } }], remove: [] },
  }), session);
  assert.equal(snapshot.state.months['2026-10'].budget.allocations[0].amountOre, 220000);
  assert.deepEqual(snapshot.state.months['2026-11'].budget, copiedPlan);
  const skippedPurchase = {
    type: 'append', operationId: 'skipped-month-purchase', transaction: {
      ...operation.transaction, id: 'purchase-in-skipped-month', amountOre: 15000,
    },
  };
  snapshot = await writeLedger(skippedPurchase, session);
  assert.equal(snapshot.state.months['2026-11'].status, 'skipped');
  assert.deepEqual(snapshot.state.months['2026-11'].budget, copiedPlan);
  assert.equal(snapshot.state.transactions.length, 2);
  groups.push('historical budget copy independence and skipped-month entry');

  const beforeDeletion = snapshot;
  const deletion = patch('delete-november', snapshot.revision, {
    months: { upsert: [], remove: ['2026-11'] },
    transactions: { upsert: [], remove: snapshot.state.transactions.map(({ id }) => id) },
  });
  snapshot = await writeLedger(deletion, session);
  const deletedRevision = snapshot.revision;
  assert.equal(snapshot.state.months['2026-11'], undefined);
  assert.deepEqual(snapshot.state.transactions, []);
  snapshot = await writeLedger(skippedPurchase, session);
  assert.equal(snapshot.revision, deletedRevision);
  assert.equal(snapshot.state.months['2026-11'], undefined);
  assert.deepEqual(snapshot.state.transactions, []);
  const delayed = await writeLedger({
    ...skippedPurchase, operationId: 'delayed-new-purchase',
    transaction: { ...skippedPurchase.transaction, id: 'delayed-entry' },
  }, session, 409);
  assert.equal(delayed.code, 'conflict');
  snapshot = await writeLedger(patch('restore-november', deletedRevision, {
    months: { upsert: [{ key: '2026-11', value: { status: 'completed', budget: copiedPlan } }], remove: [] },
    transactions: { upsert: beforeDeletion.state.transactions, remove: [] },
  }), session);
  const restored = snapshot;
  snapshot = await writeLedger(deletion, session);
  assert.deepEqual(snapshot, restored);
  const staleMonthEdit = await writeLedger(patch('stale-device-status-edit', deletedRevision, {
    months: { upsert: [{ key: '2026-11', value: { status: 'skipped', budget: null } }], remove: [] },
  }), session, 409);
  assert.equal(staleMonthEdit.code, 'conflict');
  assert.deepEqual(await (await request('/api/ledger', { headers: { Cookie: session } })).json(), restored);
  groups.push('month deletion, restore, delayed replay fences, and stale status edits');

  const otherSession = await signedIn();
  response = await request('/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: session } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { signedIn: false });
  assert.ok(response.headers.getSetCookie()[0].includes('Max-Age=0'));
  assert.equal((await request('/api/ledger', { headers: { Cookie: session } })).status, 401);
  assert.equal((await request('/api/ledger', { headers: { Cookie: otherSession } })).status, 200);
  await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(Date.now() - 1, sha(cookiePart(otherSession))).run();
  assert.equal((await request('/api/ledger', { headers: { Cookie: otherSession } })).status, 401);
  groups.push('session revocation and expiry');

  console.log('Worker end-to-end mock checks passed: ' + groups.join(', ') + '.');
} finally {
  close();
}
