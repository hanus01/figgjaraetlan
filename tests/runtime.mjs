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
  for (const name of ['0001_ledger.sql', '0002_sessions.sql', '0003_ledger_record_receipts.sql']) {
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
  const changed = { ...append.transaction, amountOre: 27550, date: '2026-12-03' };
  const edit = { type: 'correction', operationId: 'edit-entry', before: append.transaction, after: changed };
  const edited = await (await post(edit)).json();
  assert.equal(edited.revision, 3);
  assert.deepEqual(edited.state.transactions, [changed]);
  assert.deepEqual(edited.state.months['2026-12'], { status: 'active', budget: null });
  assert.deepEqual(await (await post(edit)).json(), edited);

  const staleDelete = await post({ type: 'correction', operationId: 'stale-delete', before: append.transaction, after: null });
  assert.equal(staleDelete.status, 409);
  assert.equal(staleDelete.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual((await staleDelete.json()).state.transactions, [changed]);
  const deletion = { type: 'correction', operationId: 'delete-entry', before: changed, after: null };
  const removed = await (await post(deletion)).json();
  assert.equal(removed.revision, 4);
  assert.equal(removed.state.transactions.length, 0);

  const undo = { type: 'correction', operationId: 'undo-entry', before: null, after: changed, undoOf: deletion.operationId };
  assert.equal((await post({ ...undo, operationId: 'invalid-undo', after: { ...changed, amountOre: 1 } })).status, 409);
  const undone = await (await post(undo)).json();
  assert.equal(undone.revision, 5);
  assert.deepEqual(undone.state.transactions, [changed]);
  assert.deepEqual(await (await post(deletion)).json(), undone);
  assert.deepEqual(await (await post(undo)).json(), undone);
  const newerDeletion = await (await post({ ...deletion, operationId: 'newer-deletion' })).json();
  assert.equal(newerDeletion.revision, 6);
  assert.equal((await post({ ...undo, operationId: 'stale-undo' })).status, 409);
  assert.deepEqual((await (await post(undo)).json()).state.transactions, []);

  const fixed = (id) => ({
    type: 'append', operationId: id + '-operation', fixedCost: true,
    transaction: { ...append.transaction, id, categoryId: 'rent', amountOre: 250000 },
  });
  const fixedAttempts = await Promise.all([post(fixed('fixed-one')), post(fixed('fixed-two'))]);
  assert.deepEqual(fixedAttempts.map(response => response.status).sort(), [200, 409]);
  assert.equal((await fixedAttempts.find(response => response.status === 409).json()).code, 'fixedAlreadyRecorded');
  const singleFixed = await fixedAttempts.find(response => response.status === 200).json();
  assert.equal(singleFixed.state.transactions.length, 1);
  const fixedItem = singleFixed.state.transactions[0];
  const named = {
    id: 'rent', label: 'Húsaleiga', kind: 'fixed', archived: true,
    renames: [{ from: '2026-12', label: 'Leiga' }, { from: '2027-02', label: 'Íbúð' }],
  };

  const oldHistory = Array.from({ length: 4995 }, (_, index) => ({
    ...append.transaction, id: 'backup-' + index, description: 'Æ'.repeat(120),
    date: '2025-02-02', amountOre: 101 + index,
  }));
  const restore = { type: 'restore', operationId: 'large-restore', baseRevision: singleFixed.revision, changes: {
    categories: { upsert: [named], remove: [] },
    months: { upsert: [{ key: '2025-02', value: { status: 'completed', budget: null } }], remove: ['2026-11', '2026-12'] },
    transactions: { upsert: oldHistory, remove: [fixedItem.id] },
  } };
  assert.ok(Buffer.byteLength(JSON.stringify(restore)) > 1_000_000);
  assert.equal((await post({ ...restore, type: 'patch', operationId: 'large-patch' })).status, 413);
  const tooMany = structuredClone(restore);
  tooMany.operationId = 'too-many';
  tooMany.changes.transactions.upsert.push({ ...oldHistory[0], id: 'one-extra-row' });
  assert.equal((await post(tooMany)).status, 413);
  assert.equal((await post({ ...restore, operationId: 'stale-restore', baseRevision: restore.baseRevision - 1 })).status, 409);
  const invalidRestore = structuredClone(restore);
  invalidRestore.operationId = 'invalid-restore';
  invalidRestore.changes.transactions.upsert.at(-1).date = '2025-02-30';
  assert.equal((await post(invalidRestore)).status, 400);
  assert.deepEqual(await (await send('/api/ledger', { headers })).json(), singleFixed);
  const restored = await (await post(restore)).json();
  assert.equal(restored.revision, singleFixed.revision + 1);
  assert.deepEqual(restored.state.transactions, oldHistory);
  assert.deepEqual(restored.state.categories.find(({ id }) => id === 'rent'), named);
  assert.deepEqual(restored.state.months, { '2025-02': { status: 'completed', budget: null } });
  assert.deepEqual(await (await post(restore)).json(), restored);
  assert.equal((await send('/api/ledger', { headers: { ...headers, 'If-None-Match': '"' + restored.revision + '"' } })).status, 304);

  assert.equal((await send('/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await send('/api/ledger', { headers })).status, 401);
  console.log('Cloudflare runtime checks passed for private access, offline corrections and guarded Undo, fixed-cost deduplication, category history, and atomic 5,000-record restore over 1 MB.');
} finally {
  await mf.dispose();
}
