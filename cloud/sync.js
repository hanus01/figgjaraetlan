(() => {
  'use strict';

  const databaseName = 'figgjaraetlan-private-sync-v1';
  const storeName = 'ledger';
  const recordKey = 'owner';
  const notModified = Symbol('not modified');
  const messages = {
    offline: 'Sambandið er burtur. Nýggjar skrásetingar verða sendar, tá ið sambandið kemur aftur.',
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
    pending: 'Send skrásetingarnar, ið bíða, áðrenn tú gert hesa broytingina.',
    signOutPending: 'Send skrásetingarnar, ið bíða, áðrenn tú ritar út.',
    otherOwner: 'Skrásetingar hjá einum øðrum brúkara bíða á hesi eindini. Rita inn við rætta brúkaranum fyri at senda tær.',
    uncertain: 'Ikki bar til at vátta, um broytingin varð goymd. Kanna dáturnar, áðrenn tú roynir aftur.',
  };

  class SyncError extends Error {
    constructor(code, status = 0) {
      super(messages[code] ?? messages.unavailable);
      this.code = code;
      this.status = status;
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
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
    const timeout = setTimeout(() => controller.abort(), 7500);
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
        const code = data?.code === 'duplicate' ? 'duplicate' : response.status === 409 ? 'conflict' : 'unavailable';
        throw new SyncError(code, response.status);
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

  function appendTransaction(expected, changes) {
    const { categories, months, transactions } = changes;
    if (categories.upsert.length || categories.remove.length || months.remove.length
      || transactions.remove.length || transactions.upsert.length !== 1) return null;
    const [transaction] = transactions.upsert;
    if (expected.transactions.some(({ id }) => id === transaction.id)) return null;
    const key = transaction.date.slice(0, 7);
    const [month] = months.upsert;
    if (month && (months.upsert.length !== 1 || month.key !== key || expected.months[key]
      || month.value.status !== 'active' || month.value.budget !== null)) return null;
    return transaction;
  }

  function visibleState({ server, outbox }) {
    if (!outbox.length) return server.state;
    const transactionIds = new Set(server.state.transactions.map(({ id }) => id));
    const months = { ...server.state.months };
    const transactions = [...server.state.transactions];
    for (const { transaction } of outbox) {
      if (transactionIds.has(transaction.id)) continue;
      const key = transaction.date.slice(0, 7);
      months[key] ??= { status: 'active', budget: null };
      transactions.push(transaction);
      transactionIds.add(transaction.id);
    }
    return { ...server.state, months, transactions };
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
      const version = visible ? JSON.stringify([record.ownerId, record.server.revision, record.outbox.map(({ operationId }) => operationId)]) : null;
      const state = version === shownVersion ? snapshot.state : visible ? visibleState(record) : null;
      shownVersion = version;
      shownOwner = visible ? record.ownerId : undefined;
      shownRevision = visible ? record.server.revision : undefined;
      if (state) snapshotOwners.set(state, shownOwner);
      const details = pendingTransactions.map(({ operationId, transaction, error: problem }) => ({ operationId, transaction, error: problem }));
      const changed = state !== snapshot.state || pending !== snapshot.pending || phase !== snapshot.phase
        || error !== snapshot.error || configured !== snapshot.configured
        || JSON.stringify(details) !== JSON.stringify(snapshot.pendingTransactions);
      snapshot = { state, pending, phase, error, configured, pendingTransactions: details };
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
            return { ...stored, problem: null, outbox: stored.outbox.map(({ operationId, transaction }) => ({ operationId, transaction })) };
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
          await accessStorage();
          if (!record || record.ownerId !== ownerId || !record.offlineAllowed) throw new SyncError('signedOut');
          const operation = record.outbox.find((item) => !item.error);
          if (!operation) break;
          const { operationId, transaction } = operation;
          try {
            const data = await request('/api/ledger', { method: 'POST', body: { type: 'append', operationId, transaction } });
            await cacheServer(ownerId, data, operationId);
          } catch (error) {
            if (![400, 404, 409, 413, 422].includes(error.status)) throw error;
            const problem = error.code === 'duplicate' ? messages.duplicate : messages.rejected;
            await accessStorage((stored) => {
              if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
              return { ...stored, outbox: stored.outbox.map((item) => item.operationId === operationId ? { ...item, error: problem } : item) };
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

    async function save(nextState, { expectedState = snapshot.state, replace = false } = {}) {
      if (!expectedState || !snapshot.state) return { ok: false, message: messages.signedOut };
      const ownerId = snapshotOwners.get(expectedState);
      if (!ownerId || ownerId !== shownOwner || record?.ownerId !== ownerId || !record.offlineAllowed) {
        return { ok: false, message: messages.stale };
      }
      if (!core.validateState(nextState)) return { ok: false, message: messages.invalid };
      const changes = changesBetween(expectedState, nextState);
      const transaction = replace ? null : appendTransaction(expectedState, changes);
      if (transaction) {
        try {
          const operationId = core.newId();
          await accessStorage((stored) => {
            if (stored?.ownerId !== ownerId || !stored.offlineAllowed) throw new SyncError('signedOut');
            if (!stored.server) throw new SyncError('stale');
            if (stored.server.state.transactions.some(({ id }) => id === transaction.id)
              || stored.outbox.some((item) => item.transaction.id === transaction.id)) throw new SyncError('duplicate');
            return { ...stored, outbox: [...stored.outbox, { operationId, transaction }] };
          });
          publish();
          if (navigator.onLine !== false) {
            if (background) refreshAgain = true;
            else void refresh();
          }
          return { ok: true };
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
          const key = JSON.stringify([ownerId, baseRevision, changes]);
          if (uncertainPatch?.key !== key) uncertainPatch = { key, operationId: core.newId() };
          const operationId = uncertainPatch.operationId;
          const data = await request('/api/ledger', { method: 'POST', body: { type: 'patch', operationId, baseRevision, changes } });
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
          if (stored.outbox.some((operation) => operation.operationId === operationId && !operation.error)) throw new SyncError('pending');
          return { ...stored, outbox: stored.outbox.filter((operation) => operation.operationId !== operationId || !operation.error) };
        });
        publish();
        return { ok: true };
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

    return { start, save, retry: () => refresh(true), signOut, discardPending, getStatus: () => snapshot };
  }

  globalThis.BudgetSync = { create };
})();
