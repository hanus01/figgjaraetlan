import '../budget-core.js';

const { isMonth, validateState } = globalThis.BudgetCore;
const maxBodyBytes = 1_000_000;
const maxChanges = 1_000;
const maxRestoreBytes = 2_000_000;
const maxRestoreChanges = 5_000;
// UTF-8 encodes at most three bytes per JavaScript code unit. Keep each
// bound JSON value comfortably below D1's two-million-byte limit.
const maxRecordChunkLength = 300_000;
const tooLarge = Symbol('payload too large');
const maxBudgetLines = 300;
const idPattern = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;
const recordKinds = { categories: 'category', months: 'month', transactions: 'transaction' };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && idPattern.test(value);
}

function shortText(value, length) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= length;
}

function category(value) {
  if (!isObject(value) || !isId(value.id) || !shortText(value.label, 60)) return null;
  const item = { id: value.id, label: value.label, kind: value.kind };
  if (Object.hasOwn(value, 'archived')) {
    if (value.archived !== true) return null;
    item.archived = true;
  }
  if (Object.hasOwn(value, 'renames')) {
    if (!Array.isArray(value.renames) || value.renames.length > 120) return null;
    item.renames = [];
    let previous = '';
    for (const rename of value.renames) {
      if (!isObject(rename) || !isMonth(rename.from) || rename.from <= previous || !shortText(rename.label, 60)) return null;
      item.renames.push({ from: rename.from, label: rename.label });
      previous = rename.from;
    }
  }
  return item;
}

function transaction(value) {
  if (!isObject(value) || !isId(value.id) || !shortText(value.description, 120)) return null;
  if (value.categoryId !== null && !isId(value.categoryId)) return null;
  if (value.type === 'income' && value.categoryId !== null) return null;
  return {
    id: value.id,
    date: value.date,
    description: value.description,
    categoryId: value.categoryId,
    type: value.type,
    amountOre: value.amountOre,
  };
}

function validTransaction(value) {
  const item = transaction(value);
  return item && validateState({ version: 1, categories: [], months: {}, transactions: [item] }) ? item : null;
}

function month(value) {
  if (!isObject(value) || !isObject(value.value) || !isMonth(value.key)) return null;
  const { status, budget } = value.value;
  if (budget === null) return { key: value.key, value: { status, budget } };

  if (!isObject(budget) || !Array.isArray(budget.income) || !Array.isArray(budget.allocations)) return null;
  if (budget.income.length + budget.allocations.length > maxBudgetLines) return null;
  if (budget.copiedFrom !== null && (!isMonth(budget.copiedFrom) || budget.copiedFrom >= value.key)) return null;

  const income = [];
  for (const line of budget.income) {
    if (!isObject(line) || !isId(line.id) || !shortText(line.label, 60)) return null;
    income.push({ id: line.id, label: line.label, amountOre: line.amountOre });
  }
  const allocations = [];
  for (const line of budget.allocations) {
    if (!isObject(line) || !isId(line.categoryId) || !shortText(line.label, 60)) return null;
    allocations.push({
      categoryId: line.categoryId,
      label: line.label,
      kind: line.kind,
      amountOre: line.amountOre,
    });
  }
  return {
    key: value.key,
    value: { status, budget: { copiedFrom: budget.copiedFrom, income, allocations } },
  };
}

function mutation(payload) {
  if (!isObject(payload) || !isId(payload.operationId)) return null;
  const { operationId, type } = payload;
  if (type === 'append') {
    const item = validTransaction(payload.transaction);
    if (!item) return null;
    const fixedCost = payload.fixedCost;
    if (Object.hasOwn(payload, 'fixedCost') && (fixedCost !== true || item.type !== 'expense' || !item.categoryId)) return null;
    return { type, operationId, transaction: item, ...(fixedCost ? { fixedCost } : {}) };
  }

  if (type === 'correction') {
    const before = validTransaction(payload.before);
    const after = validTransaction(payload.after);
    if (payload.before === null && after && isId(payload.undoOf)) {
      return { type, operationId, before: null, after, undoOf: payload.undoOf };
    }
    if (!before || (payload.after !== null && (!after || before.id !== after.id))
      || Object.hasOwn(payload, 'undoOf')) return null;
    return { type, operationId, before, after };
  }

  if (!['patch', 'restore'].includes(type) || !Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0
    || !isObject(payload.changes)) return null;

  const changes = {};
  const state = { version: 1, categories: [], months: {}, transactions: [] };
  const transforms = { categories: category, months: month, transactions: transaction };
  let count = 0;
  for (const [name, transform] of Object.entries(transforms)) {
    const group = payload.changes[name];
    if (!isObject(group) || !Array.isArray(group.upsert) || !Array.isArray(group.remove)) return null;
    count += group.upsert.length + group.remove.length;
    if (count > (type === 'restore' ? maxRestoreChanges : maxChanges)) return tooLarge;

    const upsert = group.upsert.map(transform);
    if (upsert.includes(null) || !group.remove.every(name === 'months' ? isMonth : isId)) return null;
    const recordIds = new Set(upsert.map((item) => name === 'months' ? item.key : item.id));
    if (recordIds.size !== upsert.length) return null;
    for (const id of group.remove) {
      if (recordIds.has(id)) return null;
      recordIds.add(id);
    }
    changes[name] = { upsert, remove: group.remove };
    state[name] = name === 'months' ? Object.fromEntries(upsert.map((item) => [item.key, item.value])) : upsert;
  }
  if (!validateState(state)) return null;
  return { type, operationId, baseRevision: payload.baseRevision, changes };
}

async function readPayload(request) {
  const type = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' || !request.body) return null;
  if (Number(request.headers.get('Content-Length')) > maxRestoreBytes) return tooLarge;

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxRestoreBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    const payload = JSON.parse(parts.join(''));
    return size > maxBodyBytes && payload?.type !== 'restore' ? tooLarge : payload;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function emptyMonthFor(item) {
  return { kind: 'month', key: item.date.slice(0, 7), value: { status: 'active', budget: null }, createOnly: true };
}

function toRecords(operation) {
  if (operation.type === 'append') {
    return [
      { kind: 'transaction', key: operation.transaction.id, value: operation.transaction },
      emptyMonthFor(operation.transaction),
    ];
  }
  if (operation.type === 'correction') {
    const item = operation.after ?? operation.before;
    const records = [{ kind: 'transaction', key: item.id, value: operation.after }];
    if (operation.after) records.push(emptyMonthFor(operation.after));
    return records;
  }

  return Object.entries(operation.changes).flatMap(([name, group]) => {
    const kind = recordKinds[name];
    return [
      ...group.upsert.map((item) => kind === 'month'
        ? { kind, key: item.key, value: item.value }
        : { kind, key: item.id, value: item }),
      ...group.remove.map((key) => ({ kind, key, value: null })),
    ];
  });
}

const receiptInsert = `
  INSERT INTO ledger_operations (operation_id, request_hash, attempt_token)
  SELECT ?, ?, ?
`;
const patchReceipt = receiptInsert + `
  WHERE (SELECT revision FROM ledger_meta WHERE singleton = 1) = ?
  ON CONFLICT (operation_id) DO NOTHING
`;
const openMonth = `NOT EXISTS (
  SELECT 1 FROM ledger_records
  WHERE kind = 'month' AND record_key = ? AND record_json IS NULL
)`;

const fixedExpense = `kind = 'transaction' AND record_json IS NOT NULL
  AND record_json ->> '$.type' = 'expense'
  AND record_json ->> '$.categoryId' = ?
  AND substr(record_json ->> '$.date', 1, 7) = ?`;

const appendReceipt = receiptInsert + `
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_records WHERE kind = 'transaction' AND record_key = ?
  ) AND ${openMonth}
    AND (? = 0 OR NOT EXISTS (SELECT 1 FROM ledger_records WHERE ${fixedExpense}))
  ON CONFLICT (operation_id) DO NOTHING
`;

const correctionReceipt = receiptInsert + `
  WHERE EXISTS (
    SELECT 1 FROM ledger_records WHERE kind = 'transaction' AND record_key = ?
      AND record_json IS NOT NULL
      AND record_json ->> '$.date' = ? AND record_json ->> '$.description' = ?
      AND record_json ->> '$.categoryId' IS ? AND record_json ->> '$.type' = ?
      AND record_json ->> '$.amountOre' = ?
  ) AND ${openMonth}
  ON CONFLICT (operation_id) DO NOTHING
`;

const undoReceipt = receiptInsert + `
  WHERE EXISTS (
    SELECT 1 FROM ledger_records WHERE kind = 'transaction' AND record_key = ?
      AND record_json IS NULL AND last_operation = ?
  ) AND EXISTS (
    SELECT 1 FROM ledger_operations WHERE operation_id = ? AND request_hash = ?
  ) AND ${openMonth}
  ON CONFLICT (operation_id) DO NOTHING
`;

const activeAttempt = `
  EXISTS (
    SELECT 1 FROM ledger_operations WHERE operation_id = ? AND attempt_token = ?
  )
`;

const applyRecords = `
  INSERT INTO ledger_records (kind, record_key, record_json, last_operation)
  SELECT incoming.value ->> '$.kind', incoming.value ->> '$.key',
    json_extract(incoming.value, '$.value'), ?
  FROM json_each(?) AS incoming
  WHERE ${activeAttempt}
    AND (
      json_extract(incoming.value, '$.createOnly') IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM ledger_records AS existing
        WHERE existing.kind = incoming.value ->> '$.kind'
          AND existing.record_key = incoming.value ->> '$.key'
      )
    )
  ON CONFLICT (kind, record_key) DO UPDATE
    SET record_json = excluded.record_json, last_operation = excluded.last_operation
`;

function snapshotQueries(db) {
  return [
    revisionQuery(db),
    db.prepare('SELECT kind, record_key, record_json FROM ledger_records WHERE record_json IS NOT NULL ORDER BY rowid'),
  ];
}

function revisionQuery(db) {
  return db.prepare('SELECT revision FROM ledger_meta WHERE singleton = 1');
}

function snapshotResponse([meta, records], problem) {
  const revision = meta.results[0].revision;
  const categories = [], months = [], transactions = [];
  // D1's record_json constraint and the mutation validator guarantee that
  // these values are JSON. Assemble the response without parsing every row
  // and serializing it again, which matters for years of transaction history.
  for (const row of records.results) {
    if (row.kind === 'category') categories.push(row.record_json);
    else if (row.kind === 'month') months.push(`${JSON.stringify(row.record_key)}:${row.record_json}`);
    else transactions.push(row.record_json);
  }
  const error = problem ? `,"code":${JSON.stringify(problem.code)},"error":${JSON.stringify(problem.error)}` : '';
  const state = `"state":{"version":1,"categories":[${categories.join(',')}],"months":{${months.join(',')}},"transactions":[${transactions.join(',')}]}`;
  const headers = { ...ledgerHeaders(revision), 'Content-Type': 'application/json' };
  return new Response(`{"revision":${revision},${state}${error}}`, { status: problem ? 409 : 200, headers });
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ledgerTag(revision) {
  return `"${revision}"`;
}

function ledgerHeaders(revision) {
  const headers = { 'Cache-Control': 'no-store' };
  if (revision !== undefined) headers.ETag = ledgerTag(revision);
  return headers;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: ledgerHeaders(value.revision) });
}

function failure(status, code, error) {
  return json({ error, code }, status);
}

function recordChunks(records) {
  const chunks = [];
  let parts = [];
  let size = 2;
  for (const record of records) {
    const text = JSON.stringify(record);
    if (parts.length && size + text.length + 1 > maxRecordChunkLength) {
      chunks.push(`[${parts.join(',')}]`);
      parts = [];
      size = 2;
    }
    parts.push(text);
    size += text.length + 1;
  }
  if (parts.length) chunks.push(`[${parts.join(',')}]`);
  return chunks;
}

async function receiptStatement(db, operation, args) {
  if (operation.type === 'append') {
    const item = operation.transaction;
    const month = item.date.slice(0, 7);
    return db.prepare(appendReceipt).bind(...args, item.id, month, operation.fixedCost ? 1 : 0, item.categoryId, month);
  }
  if (operation.type !== 'correction') return db.prepare(patchReceipt).bind(...args, operation.baseRevision);

  const destination = operation.after?.date.slice(0, 7) ?? null;
  if (operation.undoOf) {
    const deleteHash = await fingerprint({
      type: 'correction', operationId: operation.undoOf, before: operation.after, after: null,
    });
    return db.prepare(undoReceipt).bind(...args, operation.after.id, operation.undoOf, operation.undoOf, deleteHash, destination);
  }
  const { id, date, description, categoryId, type, amountOre } = operation.before;
  return db.prepare(correctionReceipt).bind(...args, id, date, description, categoryId, type, amountOre, destination);
}

async function applyMutation(db, operation) {
  const hash = await fingerprint(operation);
  const attempt = crypto.randomUUID();
  const attemptArgs = [operation.operationId, attempt];
  const append = operation.type === 'append';
  const register = await receiptStatement(db, operation, [operation.operationId, hash, attempt]);

  // All chunks and the receipt commit together. The revision guard remains
  // effective for an entire restore, including one spanning multiple statements.
  const results = await db.batch([
    register,
    ...recordChunks(toRecords(operation)).map((chunk) => db.prepare(applyRecords).bind(operation.operationId, chunk, ...attemptArgs)),
    db.prepare(`UPDATE ledger_meta SET revision = revision + 1 WHERE singleton = 1 AND ${activeAttempt}`).bind(...attemptArgs),
    db.prepare('SELECT request_hash FROM ledger_operations WHERE operation_id = ?').bind(operation.operationId),
    db.prepare("SELECT 1 FROM ledger_records WHERE kind = 'transaction' AND record_key = ?").bind(append ? operation.transaction.id : ''),
    operation.fixedCost
      ? db.prepare(`SELECT 1 FROM ledger_records WHERE ${fixedExpense} LIMIT 1`)
        .bind(operation.transaction.categoryId, operation.transaction.date.slice(0, 7))
      : db.prepare('SELECT 0 WHERE 0'),
    ...snapshotQueries(db),
  ]);
  const [receipt, collision, fixedCollision, ...current] = results.slice(-5);
  const accepted = receipt.results[0];
  if (accepted?.request_hash === hash) return snapshotResponse(current);
  if (accepted || (append && collision.results.length)) {
    return failure(409, 'duplicate', 'This operation or transaction ID is already in use.');
  }
  if (fixedCollision.results.length) {
    return snapshotResponse(current, { code: 'fixedAlreadyRecorded', error: 'This fixed expense is already recorded for the month.' });
  }
  const reason = append ? 'This month was deleted.' : operation.type === 'correction'
    ? 'The transaction or its month has changed.' : 'The ledger has changed.';
  // Keep the conflict response at a consistent revision without exposing any
  // ledger data outside the already authenticated, private endpoint.
  if (operation.type === 'correction') return snapshotResponse(current, { code: 'conflict', error: reason });
  return failure(409, 'conflict', reason);
}

export async function handleLedger(request, db) {
  if (request.method === 'GET') {
    const tag = request.headers.get('If-None-Match');
    if (tag && /^"(?:0|[1-9][0-9]{0,15})"$/u.test(tag)) {
      const [meta] = await db.batch([revisionQuery(db)]);
      const { revision } = meta.results[0];
      if (tag === ledgerTag(revision)) {
        return new Response(null, { status: 304, headers: ledgerHeaders(revision) });
      }
    }
    return snapshotResponse(await db.batch(snapshotQueries(db)));
  }
  if (request.method !== 'POST') return failure(405, 'method', 'This method is not supported.');
  const payload = await readPayload(request);
  const operation = payload === tooLarge ? tooLarge : mutation(payload);
  if (operation === tooLarge) return failure(413, 'tooLarge', 'This change contains too many records.');
  if (!operation) return failure(400, 'invalid', 'Invalid ledger operation.');
  return applyMutation(db, operation);
}
