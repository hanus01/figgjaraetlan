import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundled = await build({
  entryPoints: [new URL('../cloud/worker.mjs', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'browser', write: false,
});
const origin = 'https://budget.example.invalid';
const mf = new Miniflare({
  host: '127.0.0.1', port: 0, cf: false,
  telemetry: { enabled: false },
  workers: [{ config: {
    name: 'private-budget', compatibilityDate: '2026-11-10',
    manifest: { mainModule: 'worker.mjs', modules: {
      'worker.mjs': { type: 'esm', contents: bundled.outputFiles[0].text },
    } },
    env: {
      DB: { type: 'd1', id: 'local-check' },
      APP_ORIGIN: { type: 'text', value: origin },
      GITHUB_CLIENT_ID: { type: 'text', value: 'test-client' },
      GITHUB_CLIENT_SECRET: { type: 'text', value: 'test-secret' },
      OWNER_GITHUB_ID: { type: 'text', value: '123456' },
    },
  } }],
});
try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'private-budget');
  for (const name of ['0001_ledger.sql', '0002_sessions.sql']) {
    const migration = readFileSync(new URL('../cloud/migrations/' + name, import.meta.url), 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  const send = (path, init) => mf.dispatchFetch(origin + path, init);
  assert.equal((await send('/api/ledger')).status, 401);
  assert.equal((await (await send('/api/session')).json()).signedIn, false);
  const token = Buffer.alloc(32, 7).toString('base64url');
  const hash = createHash('sha256').update(token).digest('base64url');
  await db.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)')
    .bind(hash, '123456', Date.now() + 60000).run();
  const headers = { Cookie: '__Host-fj-session=' + token, Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await (await send('/api/session', { headers })).json()).signedIn, true);
  const initial = await (await send('/api/ledger', { headers })).json();
  assert.equal(initial.revision, 0);
  const append = { type: 'append', operationId: 'runtime-purchase', transaction: {
    id: 'runtime-entry', date: '2026-11-11', description: 'Test purchase',
    categoryId: 'groceries', type: 'expense', amountOre: 12550,
  } };
  const post = (body, requestHeaders = headers) => send('/api/ledger', { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) });
  assert.equal((await post(append, { ...headers, Origin: 'https://other.invalid' })).status, 403);
  const first = await (await post(append)).json();
  assert.equal(first.revision, 1);
  assert.equal(first.state.transactions.length, 1);
  const retry = await (await post(append)).json();
  assert.equal(retry.revision, 1);
  assert.equal(retry.state.transactions.length, 1);
  const unchanged = await send('/api/ledger', { headers: { ...headers, 'If-None-Match': '"1"' } });
  assert.equal(unchanged.status, 304);
  const patch = (operationId, label) => ({ type: 'patch', operationId, baseRevision: 1, changes: {
    categories: { upsert: [{ id: 'groceries', label, kind: 'variable' }], remove: [] },
    months: { upsert: [], remove: [] }, transactions: { upsert: [], remove: [] },
  } });
  const simultaneous = await Promise.all([post(patch('runtime-a', 'Food A')), post(patch('runtime-b', 'Food B'))]);
  assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 409]);
  assert.equal((await send('/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await send('/api/ledger', { headers })).status, 401);
  console.log('Cloudflare runtime checks passed for D1 migrations, private access, exact money, retry deduplication, conditional polling, conflicting updates, and logout.');
} finally {
  await mf.dispose();
}
