(() => {
  'use strict';

  const databaseName = 'figgjaraetlan-private-sync-v1';
  const storeName = 'ledger';
  const recordKey = 'owner';
  const notModified = Symbol('not modified');
  const maxRestoreChanges = 5_000;
  const maxRestoreBytes = 2_000_000;
  const messages = {
    offline: 'Sambandið er burtur. Skrásetingar og rættingar verða sendar, tá ið sambandið kemur aftur.',
    onlineOnly: 'Far á netið fyri at goyma hesa broytingina.',
    signedOut: 'Rita inn fyri at samstilla dáturnar.',
    setup: 'Samstillingin er ikki sett upp enn.',
    unavailable: 'Samstillingin er ikki tøk beint nú. Royn aftur um eina løtu.',
    storage: 'Kagin fekk ikki goymt dáturnar á hesi eindini.',
    stale: 'Dáturnar eru broyttar, síðani tú lat hesa síðuna upp. Kanna nýggju dáturnar, áðrenn tú roynir aftur.',
    conflict: 'Dáturnar eru broyttar á einari aðrari eind. Broytingin varð ikki goymd. Kanna nýggju dáturnar.',
    duplicate: 'Ein onnur skráseting hevur sama eyðmerki. Henda skrásetingin er framvegis á hesi eindini.',
    rejected: 'Ein skráseting kundi ikki sendast. Hon er framvegis á hesi eindini.',
    invalid: 'Broytingin er ikki gild.',
    tooLarge: 'Broytingin er ov stór til eina samstilling.',
    correctionConflict: 'Skrásetingin er broytt ella strikað á einari aðrari eind. Vel, hvør broyting skal varðveitast.',
    fixedAlreadyRecorded: 'Henda fasta útreiðslan er longu skrásett í mánaðinum.',
    undoUnavailable: 'Henda strikingin kann ikki longur angrað.',
    pending: 'Send skrásetingarnar, ið bíða, áðrenn tú gert hesa broytingina.',
    signOutPending: 'Send skrásetingarnar, ið bíða, áðrenn tú ritar út.',
    otherOwner: 'Skrásetingar hjá einum øðrum brúkara bíða á hesi eindini. Rita inn við rætta brúkaranum fyri at senda tær.',
    uncertain: 'Ikki bar til at vátta, um broytingin varð goymd. Kanna dáturnar, áðrenn tú roynir aftur.',
  };

  class SyncError extends Error {
    constructor(code, status = 0, data) {
      super(messages[code] ?? messages.unavailable);
      this.code = code;
      this.status = status;
      this.data = data;
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      // Version 2 preserves the existing store and prevents an old app window
      // from treating queued corrections as if they were new purchases.
      const request = indexedDB.open(databaseName, 2);
      let blocked = false;
      request.onupgradeneeded = ({ oldVersion }) => {
        if (oldVersion === 0) request.result.createObjectStore(storeName);
      };
      request.onblocked = () => {
        blocked = true;
        reject(new SyncError('storage'));
      };
      request.onerror = () => reject(new SyncError('storage'));
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
  }

  function accessRecord(database, change) {
    return new Promise((resolve, reject) => {
      const transaction = change
        ? database.transaction(storeName, 'readwrite', { durability: 'strict' })
        : database.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(recordKey);
      let result;
      let failed;
      request.onsuccess = () => {
        const existing = request.result ?? null;
        try {
          result = change ? change(existing) : existing;
          if (change && result !== existing) {
            if (result === null) store.delete(recordKey);
            else store.put(result, recordKey);
          }
        } catch (error) {
          failed = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failed ?? new SyncError('storage'));
    });
  }

  async function request(path, { body, method = 'GET', expectJson = true, revision } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), body?.type === 'restore' ? 30_000 : 7500);
    try {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (revision !== undefined) headers['If-None-Match'] = `"${revision}"`;
      const response = await fetch(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (revision !== undefined && response.status === 304) return notModified;
      if (response.status === 401 || response.status === 403) throw new SyncError('signedOut', response.status);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const code = ['duplicate', 'fixedAlreadyRecorded'].includes(data?.code) ? data.code
          : response.status === 409 ? 'conflict'
          : response.status === 413 ? 'tooLarge' : 'unavailable';
        throw new SyncError(code, response.status, data);
      }
      return expectJson ? await response.json() : undefined;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (error instanceof TypeError || error?.name === 'AbortError') throw new SyncError('offline');
      throw new SyncError('unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  function changesBetween(expected, next) {
    function diff(before, after, key) {
      const previous = new Map(before.map((value) => [key(value), value]));
      const current = new Set(after.map(key));
      return {
        upsert: after.filter((value) => {
          const old = previous.get(key(value));
          return old !== value && JSON.stringify(old) !== JSON.stringify(value);
        }),
        remove: before.map(key).filter((id) => !current.has(id)),
      };
    }
    const months = (state) => Object.entries(state.months).map(([key, value]) => ({ key, value }));
    return {
      categories: diff(expected.categories, next.categories, (item) => item.id),
      months: diff(months(expected), months(next), (item) => item.key),
      transactions: diff(expected.transactions, next.transactions, (item) => item.id),
    };
  }

  function sameTransaction(first, second) {
    return first === second || (first && second
      && first.id === second.id && first.date === second.date
      && first.description === second.description && first.categoryId === second.categoryId
      && first.type === second.type && first.amountOre === second.amountOre);
  }

  function queuedTransaction(expected, changes) {
    const { categories, months, transactions } = changes;
    if (categories.upsert.length || categories.remove.length || months.remove.length
      || transactions.remove.length + transactions.upsert.length !== 1) return null;
    if (transactions.remove.length) {
      if (months.upsert.length) return null;
      const transaction = expected.transactions.find(({ id }) => id === transactions.remove[0]);
      return transaction ? { kind: 'delete', transaction, before: transaction } : null;
    }

    const [transaction] = transactions.upsert;
    const key = transaction.date.slice(0, 7);
    const [month] = months.upsert;
    if (month && (months.upsert.length !== 1 || month.key !== key || expected.months[key]
      || month.value.status !== 'active' || month.value.budget !== null)) return null;
    const before = expected.transactions.find(({ id }) => id === transaction.id);
    return before ? { kind: 'edit', transaction, before } : { transaction };
  }

  function kindOf(operation) {
    return operation.kind ?? 'append';
  }

  function nextTransaction(current, operation) {
    switch (kindOf(operation)) {
      case 'append': return current ?? (operation.fixedCost && operation.error ? null : operation.transaction);
      case 'undo': return !operation.error && !current ? operation.transaction : current;
      case 'edit': return !operation.error && sameTransaction(current, operation.before) ? operation.transaction : current;
      case 'delete': return !operation.error && sameTransaction(current, operation.before) ? null : current;
      default: return current;
    }
  }

  function visibleTransaction(record, id) {
    let item = record.server.state.transactions.find((entry) => entry.id === id);
    for (const operation of record.outbox) {
      if (operation.transaction.id !== id) continue;
      item = nextTransaction(item, operation);
      if (operation.error) break;
    }
    return item;
  }

  function hasFixedExpense(transactions, transaction) {
    const month = transaction.date.slice(0, 7);
    for (const entry of transactions) {
      if (entry.id !== transaction.id && entry.type === 'expense'
        && entry.categoryId === transaction.categoryId && entry.date.slice(0, 7) === month) return true;
    }
    return false;
  }

  function visibleState({ server, outbox }) {
    if (!outbox.length) return server.state;
    const transactions = new Map(server.state.transactions.map((item) => [item.id, item]));
    const months = { ...server.state.months };
    const blocked = new Set();
    for (const operation of outbox) {
      const { id } = operation.transaction;
      if (blocked.has(id)) continue;
      const current = transactions.get(id);
      if (!current && operation.fixedCost && hasFixedExpense(transactions.values(), operation.transaction)) {
        blocked.add(id);
        continue;
      }
      const next = nextTransaction(current, operation);
      if (next) {
        months[next.date.slice(0, 7)] ??= { status: 'active', budget: null };
        transactions.set(id, next);
      } else transactions.delete(id);
      if (operation.error) blocked.add(id);
    }
    return { ...server.state, months, transactions: [...transactions.values()] };
  }

  function mutationFor(operation) {
    const { operationId, transaction, before, undoOf, fixedCost } = operation;
    const kind = kindOf(operation);
    if (kind === 'append') return { type: 'append', operationId, transaction, ...(fixedCost ? { fixedCost } : {}) };
    if (kind === 'undo') return { type: 'correction', operationId, before: null, after: transaction, undoOf };
    return { type: 'correction', operationId, before, after: kind === 'delete' ? null : transaction };
  }

  function sendableOperation(outbox) {
    const blocked = new Set();
    for (const operation of outbox) {
      const { id } = operation.transaction;
      if (!operation.error && !blocked.has(id)) return operation;
      blocked.add(id);
    }
    return null;
  }

  function create({ onChange = () => {} } = {}) {
    const core = globalThis.BudgetCore;
    let record = null;
    let access = 'checking';
    let configured;
    let currentError;
    let snapshot = { state: null, pending: 0, phase: 'checking', pendingTransactions: [] };
    let shownVersion;
    let shownOwner;
    let shownRevision;
    const snapshotOwners = new WeakMap();
    const undoDeletes = new Map();
    let database;
    let storageWork = Promise.resolve();
    let networkWork = Promise.resolve();
    let background;
    let refreshAgain = false;
    let started;
    let uncertainPatch;

    function accessStorage(change) {
      const operation = storageWork.then(async () => {
        try {
          database ??= openDatabase();
          record = await accessRecord(await database, change);
          return record;
        } catch (error) {
          if (error instanceof SyncError) throw error;
          throw new SyncError('storage');
        }
      });
      storageWork = operation.catch(() => {});
      return operation;
    }

    function enqueueNetwork(task) {
      const operation = networkWork.then(task);
      networkWork = operation.catch(() => {});
      return operation;
    }

    function publish() {
      const visible = (access === 'authorized' || (access === 'offline' && record?.offlineAllowed)) && record?.server;
      const pending = record?.outbox.length ?? 0;
      const pendingTransactions = visible ? record.outbox : [];
      const error = currentError ?? (visible ? record.problem ?? record.outbox.find((operation) => operation.error)?.error : undefined);
      const phase = access === 'signed-out' ? 'signed-out'
        : error ? 'error'
        : access === 'offline' ? 'offline'
        : !visible ? 'checking'
        : pending ? 'pending' : 'synced';
      const version = visible ? JSON.stringify([record.ownerId, record.server.revision,
        record.outbox.map(({ operationId, error: problem }) => [operationId, Boolean(problem)])]) : null;
      const state = version === shownVersion ? snapshot.state : visible ? visibleState(record) : null;
      const ownerId = visible ? record.ownerId : undefined;
      if (ownerId !== shownOwner) undoDeletes.clear();
      shownVersion = version;
      shownOwner = ownerId;
      shownRevision = visible ? record.server.revision : undefined;
      if (state) snapshotOwners.set(state, shownOwner);
      const details = pendingTransactions.map((operation) => {
        const { operationId, transaction, error: problem, conflict } = operation;
        const kind = kindOf(operation);
        const detail = { operationId, transaction, kind, error: problem };
        if (conflict) {
          detail.conflict = true;
          detail.current = record.server.state.transactions.find(({ id }) => id === transaction.id) ?? null;
          detail.canKeepMine = Boolean(detail.current && (kind === 'edit' || kind === 'delete')
            && !sameTransaction(detail.current, operation.before)
            && !record.outbox.some((item) => item.undoOf === operationId));
        }
        return detail;
      });
      const changed = state !== snapshot.state || pending !== snapshot.pending || phase !== snapshot.phase
        || error !== snapshot.error || configured !== snapshot.configured
        || JSON.stringify(details) !== JSON.stringify(snapshot.pendingTransactions);
      snapshot = { state, ownerId, pending, phase, error, configured, pendingTransactions: details };
      if (changed) onChange(snapshot);
    }

    function validServer(data) {
      if (!Number.isSafeInteger(data?.revision) || data.revision < 0 || !core.validateState(data.state)) {
        throw new SyncError('unavailable');
      }
      return { revision: data.revision, state: data.state };
    }

    async function cacheServer(ownerId, data, acknowledgedId, clearProblem = false) {
      const next = validServer(data);
      await accessStorage((stored) => {
        if (!stored || stored.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
        const server = !stored.server || next.revision > stored.server.revision ? next : stored.server;
        const outbox = acknowledgedId ? stored.outbox.filter(({ operationId }) => operationId !== acknowledgedId) : stored.outbox;
        if (server === stored.server && outbox === stored.outbox && !clearProblem) return stored;
        return { ...stored, server, outbox, problem: clearProblem ? null : stored.problem };
      });
      access = 'authorized';
      currentError = undefined;
      publish();
    }

    async function lockCache() {
      access = 'signed-out';
      publish();
      await accessStorage((stored) => stored?.offlineAllowed ? { ...stored, offlineAllowed: false } : stored);
      publish();
    }

    async function handleError(error) {
      if (error.code === 'signedOut') {
        currentError = undefined;
        try { await lockCache(); } catch { currentError = messages.storage; }
      } else if (error.code === 'offline') {
        access = 'offline';
        currentError = undefined;
      } else currentError = error instanceof SyncError ? error.message : messages.unavailable;
      publish();
    }

    async function synchronize(force) {
      try {
        await accessStorage();
        if (navigator.onLine === false) {
          access = 'offline';
          currentError = undefined;
          publish();
          return;
        }
        const session = await request('/api/session');
        configured = session?.configured !== false;
        if (session?.signedIn === false) {
          currentError = configured ? undefined : messages.setup;
          await lockCache();
          return;
        }
        if (session?.signedIn !== true || typeof session.ownerId !== 'string' || !session.ownerId) {
          throw new SyncError('unavailable');
        }
        const ownerId = session.ownerId;
        await accessStorage((stored) => {
          if (stored?.ownerId !== ownerId) {
            if (stored?.outbox.length) return { ...stored, offlineAllowed: false };
            return { ownerId, server: null, outbox: [], problem: null, offlineAllowed: true };
          }
          return stored.offlineAllowed ? stored : { ...stored, offlineAllowed: true };
        });
        if (record.ownerId !== ownerId) {
          currentError = messages.otherOwner;
          access = 'signed-out';
          publish();
          return;
        }
        if (force && (record.problem || record.outbox.some((operation) => operation.error))) {
          await accessStorage((stored) => {
            if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
            return { ...stored, problem: null, outbox: stored.outbox.map((item) => {
              if (!item.error || item.conflict) return item;
              const { error: _error, ...pending } = item;
              return pending;
            }) };
          });
        }
        const data = await request('/api/ledger', { revision: record.server?.revision });
        if (data === notModified) {
          await accessStorage();
          if (!record?.server || record.ownerId !== ownerId || !record.offlineAllowed) throw new SyncError('signedOut');
          access = 'authorized';
          currentError = undefined;
          publish();
        } else await cacheServer(ownerId, data);
        for (;;) {
          let operation;
          await accessStorage((stored) => {
            if (!stored || stored.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
            operation = sendableOperation(stored.outbox);
            if (!operation || operation.attempted !== false) return stored;
            // Mark it before sending so another tab cannot rewrite the same
            // operation while its original payload may already reach the server.
            return { ...stored, outbox: stored.outbox.map((item) => item === operation ? { ...item, attempted: true } : item) };
          });
          if (!operation) break;
          const { operationId } = operation;
          try {
            const data = await request('/api/ledger', { method: 'POST', body: mutationFor(operation) });
            await cacheServer(ownerId, data, operationId);
          } catch (error) {
            if (![400, 404, 409, 413, 422].includes(error.status)) throw error;
            const conflict = kindOf(operation) !== 'append' && error.code === 'conflict';
            const problem = conflict ? messages.correctionConflict
              : messages[error.code === 'unavailable' || error.code === 'conflict' ? 'rejected' : error.code];
            const server = error.data?.state ? validServer(error.data) : null;
            await accessStorage((stored) => {
              if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
              return {
                ...stored, server: server?.revision > stored.server.revision ? server : stored.server,
                outbox: stored.outbox.map((item) => item.operationId === operationId ? { ...item, error: problem, conflict } : item),
              };
            });
            publish();
          }
        }
        publish();
      } catch (error) {
        await handleError(error);
      }
    }

    function refresh(force = false) {
      if (background) {
        return force ? background.then(() => refresh(true)) : background;
      }
      background = enqueueNetwork(() => synchronize(force)).finally(() => {
        background = undefined;
        if (refreshAgain) {
          refreshAgain = false;
          void refresh();
        }
      });
      return background;
    }

    function start() {
      if (!started) {
        window.addEventListener('online', () => void refresh());
        window.addEventListener('offline', () => {
          if (access === 'authorized') access = 'offline';
          currentError = undefined;
          publish();
        });
        window.addEventListener('focus', () => { if (!document.hidden) void refresh(); });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
        setInterval(() => { if (!document.hidden && navigator.onLine !== false) void refresh(); }, 30_000);
        started = refresh();
      }
      return started;
    }

    function flushWhenOnline() {
      if (navigator.onLine !== false) {
        if (background) refreshAgain = true;
        else void refresh();
      }
    }

    async function queueTransaction(ownerId, operation) {
      let cancelledAppend;
      const { transaction, operationId, before } = operation;
      const kind = kindOf(operation);
      await accessStorage((stored) => {
        if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
        if (!stored.server) throw new SyncError('stale');
        const pending = stored.outbox.filter((item) => item.transaction.id === transaction.id);
        if (kind === 'append') {
          if (pending.length || visibleTransaction(stored, transaction.id)) throw new SyncError('duplicate');
          if (operation.fixedCost && hasFixedExpense(visibleState(stored).transactions, transaction)) {
            throw new SyncError('fixedAlreadyRecorded');
          }
        } else if (pending.some((item) => item.error)
          || !sameTransaction(visibleTransaction(stored, transaction.id), before)) throw new SyncError('stale');

        const [first] = pending;
        if (pending.length === 1 && kindOf(first) === 'append' && first.attempted === false) {
          if (kind === 'delete') {
            cancelledAppend = first;
            return { ...stored, outbox: stored.outbox.filter((item) => item !== first) };
          }
          const preserveFixedCost = first.fixedCost && first.transaction.categoryId === transaction.categoryId
            && first.transaction.date.slice(0, 7) === transaction.date.slice(0, 7) && transaction.type === 'expense';
          const editedAppend = { operationId, transaction, attempted: false, ...(preserveFixedCost ? { fixedCost: true } : {}) };
          return { ...stored, outbox: stored.outbox.map((item) => item === first ? editedAppend : item) };
        }
        return { ...stored, outbox: [...stored.outbox, operation] };
      });
      if (kind === 'delete') {
        undoDeletes.set(operationId, { ownerId, transaction, cancelledAppend });
        if (undoDeletes.size > 32) undoDeletes.delete(undoDeletes.keys().next().value);
      }
      publish();
      flushWhenOnline();
      return { ok: true, operationId };
    }

    async function save(nextState, { expectedState = snapshot.state, replace = false, fixedCost = false } = {}) {
      if (!expectedState || !snapshot.state) return { ok: false, message: messages.signedOut };
      const ownerId = snapshotOwners.get(expectedState);
      if (!ownerId || ownerId !== shownOwner || record?.ownerId !== ownerId || !record.offlineAllowed) {
        return { ok: false, message: messages.stale };
      }
      if (!core.validateState(nextState)) return { ok: false, message: messages.invalid };
      const changes = changesBetween(expectedState, nextState);
      const queued = replace ? null : queuedTransaction(expectedState, changes);
      if (fixedCost && (!queued || kindOf(queued) !== 'append' || queued.transaction.type !== 'expense'
        || !queued.transaction.categoryId)) return { ok: false, message: messages.invalid };
      if (queued) {
        try {
          return await queueTransaction(ownerId, {
            ...queued, operationId: core.newId(), attempted: false, ...(fixedCost ? { fixedCost: true } : {}),
          });
        } catch (error) {
          return { ok: false, message: error.message };
        }
      }
      if (expectedState !== snapshot.state || record.server?.revision !== shownRevision) {
        return { ok: false, message: messages.stale };
      }
      if (Object.values(changes).every(({ upsert, remove }) => !upsert.length && !remove.length)) return { ok: true };
      const baseRevision = shownRevision;
      if (access !== 'authorized' || navigator.onLine === false) return { ok: false, message: messages.onlineOnly };
      if (snapshot.pending) return { ok: false, message: messages.pending };
      return enqueueNetwork(async () => {
        try {
          await accessStorage();
          if (record?.ownerId !== ownerId || !record.offlineAllowed) throw new SyncError('signedOut');
          if (record.server.revision !== baseRevision) throw new SyncError('stale');
          if (record.outbox.length) throw new SyncError('pending');
          const type = replace ? 'restore' : 'patch';
          const key = JSON.stringify([type, ownerId, baseRevision, changes]);
          if (uncertainPatch?.key !== key) uncertainPatch = { key, operationId: core.newId() };
          const operationId = uncertainPatch.operationId;
          const body = { type, operationId, baseRevision, changes };
          if (replace && (Object.values(changes).reduce((total, group) => total + group.upsert.length + group.remove.length, 0) > maxRestoreChanges
            || new TextEncoder().encode(JSON.stringify(body)).byteLength > maxRestoreBytes)) throw new SyncError('tooLarge');
          const data = await request('/api/ledger', { method: 'POST', body });
          uncertainPatch = undefined;
          await cacheServer(ownerId, data, undefined, true);
          return { ok: true };
        } catch (error) {
          if (error.code === 'conflict' || error.code === 'offline') {
            const problem = error.code === 'conflict' ? messages.conflict : messages.uncertain;
            try {
              await accessStorage((stored) => stored?.ownerId === ownerId ? { ...stored, problem } : stored);
            } catch {
              currentError = problem;
            }
            if (error.code === 'offline') access = 'offline';
            else uncertainPatch = undefined;
            publish();
            if (navigator.onLine !== false) void refresh();
            return { ok: false, message: problem };
          }
          if (error.code === 'stale') publish();
          else if (error.code !== 'pending') await handleError(error);
          return { ok: false, message: error.message };
        }
      });
    }

    async function discardPending(operationId) {
      if (!snapshot.state) return { ok: false, message: messages.signedOut };
      const ownerId = record.ownerId;
      try {
        await accessStorage((stored) => {
          if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
          const rejected = stored.outbox.find((operation) => operation.operationId === operationId);
          if (!rejected) throw new SyncError('stale');
          if (!rejected.error) throw new SyncError('pending');
          return { ...stored, outbox: stored.outbox.filter((operation) => operation.transaction.id !== rejected.transaction.id) };
        });
        publish();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }

    async function keepPending(operationId, current = snapshot.pendingTransactions.find((item) => item.operationId === operationId)?.current) {
      if (!snapshot.state) return { ok: false, message: messages.signedOut };
      if (!current) return { ok: false, message: messages.stale };
      const ownerId = record.ownerId;
      try {
        await accessStorage((stored) => {
          if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
          const rejected = stored.outbox.find((item) => item.operationId === operationId);
          if (!rejected?.conflict || !['edit', 'delete'].includes(kindOf(rejected))
            || stored.outbox.some((item) => item.undoOf === operationId)) throw new SyncError('stale');
          const latest = stored.server.state.transactions.find(({ id }) => id === rejected.transaction.id);
          if (!sameTransaction(latest, current)) throw new SyncError('stale');
          const { error: _error, conflict: _conflict, ...operation } = rejected;
          const retry = {
            ...operation, before: latest, operationId: core.newId(), attempted: false,
            transaction: kindOf(operation) === 'delete' ? latest : operation.transaction,
          };
          return { ...stored, outbox: stored.outbox.map((item) => item === rejected ? retry : item) };
        });
        undoDeletes.delete(operationId);
        publish();
        flushWhenOnline();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }

    async function undoDelete(operationId) {
      if (!snapshot.state) return { ok: false, message: messages.signedOut };
      const deletion = undoDeletes.get(operationId);
      if (!deletion || deletion.ownerId !== shownOwner) return { ok: false, message: messages.undoUnavailable };
      const { ownerId, transaction, cancelledAppend } = deletion;
      const undoId = core.newId();
      try {
        await accessStorage((stored) => {
          if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
          if (undoDeletes.get(operationId) !== deletion || visibleTransaction(stored, transaction.id)
            || stored.outbox.some((item) => item.transaction.id === transaction.id && item.error)) {
            throw new SyncError('undoUnavailable');
          }
          const operation = { operationId: undoId, transaction, attempted: false };
          if (!cancelledAppend) Object.assign(operation, { kind: 'undo', undoOf: operationId });
          else if (cancelledAppend.fixedCost) {
            if (hasFixedExpense(visibleState(stored).transactions, transaction)) throw new SyncError('fixedAlreadyRecorded');
            operation.fixedCost = true;
          }
          return { ...stored, outbox: [...stored.outbox, operation] };
        });
        undoDeletes.delete(operationId);
        publish();
        flushWhenOnline();
        return { ok: true, operationId: undoId };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    }

    function signOut() {
      return enqueueNetwork(async () => {
        try {
          await accessStorage();
          if (record?.outbox.length) return { ok: false, message: messages.signOutPending };
          if (navigator.onLine === false) return { ok: false, message: messages.onlineOnly };
          await request('/auth/logout', { method: 'POST', expectJson: false });
          access = 'signed-out';
          currentError = undefined;
          publish();
          await accessStorage((stored) => stored?.outbox.length ? { ...stored, offlineAllowed: false } : null);
          uncertainPatch = undefined;
          publish();
          return { ok: true };
        } catch (error) {
          await handleError(error);
          return { ok: false, message: error.message };
        }
      });
    }

    return { start, save, retry: () => refresh(true), signOut, discardPending, keepPending, undoDelete, getStatus: () => snapshot };
  }

  globalThis.BudgetSync = { create };
})();
