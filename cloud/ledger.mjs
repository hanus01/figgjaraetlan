import '../budget-core.js';

const { isDate, isMonth, validateState } = globalThis.BudgetCore;
const maxBodyBytes = 1_000_000;
const maxChanges = 1_000;
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
  return { id: value.id, label: value.label, kind: value.kind };
}

function transaction(value) {
  if (!isObject(value) || !isId(value.id) || !isDate(value.date) || !shortText(value.description, 120)) return null;
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
    const item = transaction(payload.transaction);
    if (!item || !validateState({ version: 1, categories: [], months: {}, transactions: [item] })) return null;
    return { type, operationId, transaction: item };
  }

  if (type !== 'patch' || !Number.isSafeInteger(payload.baseRevision) || payload.baseRevision < 0
    || !isObject(payload.changes)) return null;

  const changes = {};
  const state = { version: 1, categories: [], months: {}, transactions: [] };
  const transforms = { categories: category, months: month, transactions: transaction };
  let count = 0;
  for (const [name, transform] of Object.entries(transforms)) {
    const group = payload.changes[name];
    if (!isObject(group) || !Array.isArray(group.upsert) || !Array.isArray(group.remove)) return null;
    count += group.upsert.length + group.remove.length;
    if (count > maxChanges) return null;

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
  if (type !== 'application/json' || Number(request.headers.get('Content-Length')) > maxBodyBytes || !request.body) {
    return null;
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function toRecords(operation) {
  if (operation.type === 'append') {
    return [
      { kind: 'transaction', key: operation.transaction.id, value: operation.transaction },
      {
        kind: 'month',
        key: operation.transaction.date.slice(0, 7),
        value: { status: 'active', budget: null },
        createOnly: true,
      },
    ];
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
const appendReceipt = receiptInsert + `
  WHERE NOT EXISTS (
    SELECT 1 FROM ledger_records WHERE kind = 'transaction' AND record_key = ?
  ) AND NOT EXISTS (
    SELECT 1 FROM ledger_records
    WHERE kind = 'month' AND record_key = ? AND record_json IS NULL
  )
  ON CONFLICT (operation_id) DO NOTHING
`;

const activeAttempt = `
  EXISTS (
    SELECT 1 FROM ledger_operations WHERE operation_id = ? AND attempt_token = ?
  )
`;

const applyRecords = `
  INSERT INTO ledger_records (kind, record_key, record_json)
  SELECT incoming.value ->> '$.kind', incoming.value ->> '$.key',
    json_extract(incoming.value, '$.value')
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
  ON CONFLICT (kind, record_key) DO UPDATE SET record_json = excluded.record_json
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

function snapshot([meta, records]) {
  const state = { version: 1, categories: [], months: {}, transactions: [] };
  for (const row of records.results) {
    const item = JSON.parse(row.record_json);
    if (row.kind === 'category') state.categories.push(item);
    else if (row.kind === 'month') state.months[row.record_key] = item;
    else state.transactions.push(item);
  }
  return { revision: meta.results[0].revision, state };
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

async function applyMutation(db, operation) {
  const hash = await fingerprint(operation);
  const attempt = crypto.randomUUID();
  const operationArgs = [operation.operationId, hash, attempt];
  const append = operation.type === 'append';
  const records = toRecords(operation);
  const register = append
    ? db.prepare(appendReceipt).bind(...operationArgs, records[0].key, records[1].key)
    : db.prepare(patchReceipt).bind(...operationArgs, operation.baseRevision);
  const attemptArgs = [operation.operationId, attempt];

  // Each statement is part of one D1 transaction. Only the request that
  // inserted this receipt can change rows or bump the revision.
  const [, , , receipt, collision, ...current] = await db.batch([
    register,
    db.prepare(applyRecords).bind(JSON.stringify(records), ...attemptArgs),
    db.prepare(`UPDATE ledger_meta SET revision = revision + 1 WHERE singleton = 1 AND ${activeAttempt}`).bind(...attemptArgs),
    db.prepare('SELECT request_hash FROM ledger_operations WHERE operation_id = ?').bind(operation.operationId),
    db.prepare('SELECT 1 FROM ledger_records WHERE kind = \'transaction\' AND record_key = ?').bind(append ? records[0].key : ''),
    ...snapshotQueries(db),
  ]);

  const accepted = receipt.results[0];
  if (accepted?.request_hash === hash) return json(snapshot(current));
  if (accepted || (append && collision.results.length)) {
    return failure(409, 'duplicate', 'This operation or transaction ID is already in use.');
  }
  return failure(409, 'conflict', append ? 'This month was deleted.' : 'The ledger has changed.');
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
    return json(snapshot(await db.batch(snapshotQueries(db))));
  }
  if (request.method !== 'POST') return failure(405, 'method', 'This method is not supported.');
  const operation = mutation(await readPayload(request));
  if (!operation) return failure(400, 'invalid', 'Invalid ledger operation.');
  return applyMutation(db, operation);
}
