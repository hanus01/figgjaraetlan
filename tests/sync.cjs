const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
const coreCode = fs.readFileSync(path.join(source, "budget-core.js"), "utf8");
const syncCode = fs.readFileSync(path.join(source, "cloud", "sync.js"), "utf8");
const clone = structuredClone;

function fakeIndexedDB() {
  let queue = Promise.resolve();
  let created = false;
  let record = null;
  let storageFail = false;
  const database = {
    createObjectStore() {},
    close() {},
    transaction(_store, mode, options) {
      if (mode === "readwrite") assert.equal(options.durability, "strict");
      let aborted = false;
      let nextRecord;
      let get;
      let write = false;
      const tx = {
        abort() { aborted = true; },
        objectStore() {
          return {
            get(key) { assert.equal(key, "owner"); get = {}; return get; },
            put(value, key) { assert.equal(key, "owner"); nextRecord = clone(value); write = true; },
            delete(key) { assert.equal(key, "owner"); nextRecord = null; write = true; },
          };
        },
      };
      queue = queue.then(() => new Promise((resolve) => {
        setImmediate(() => {
          get.result = clone(record);
          get.onsuccess();
          if (storageFail && write) aborted = true;
          if (aborted) tx.onabort();
          else {
            if (write) record = nextRecord;
            tx.oncomplete();
          }
          resolve();
        });
      }));
      return tx;
    },
  };
  return {
    open() {
      const request = { result: database };
      setImmediate(() => {
        if (!created) { request.onupgradeneeded(); created = true; }
        request.onsuccess();
      });
      return request;
    },
    getRecord: () => clone(record),
    setFail(value) { storageFail = value; },
  };
}

function createServer() {
  const server = {
    state: { version: 1, categories: [{ id: "food", label: "Matvørur", kind: "variable" }], months: {}, transactions: [] },
    revision: 0,
    signedIn: true,
    ownerId: "123",
    configured: true,
    calls: [],
    receipts: new Set(),
    lostResponse: false,
    rejectAppend: null,
    pauseSession: undefined,
  };

  function response(status, data) {
    return { status, ok: status >= 200 && status < 300, json: async () => clone(data) };
  }

  server.fetch = async (url, { method, body, cache, credentials, headers }) => {
    assert.equal(cache, "no-store");
    assert.equal(credentials, "same-origin");
    const operation = body && JSON.parse(body);
    server.calls.push({ url, method, operation, headers });
    if (url === "/api/session") {
      if (server.pauseSession) await server.pauseSession;
      return response(200, server.signedIn
        ? { signedIn: true, ownerId: server.ownerId, configured: server.configured }
        : { signedIn: false, configured: server.configured });
    }
    if (!server.signedIn) return response(401, { code: "unauthorized" });
    if (url === "/auth/logout") {
      assert.equal(method, "POST");
      server.signedIn = false;
      return response(204, null);
    }
    assert.equal(url, "/api/ledger");
    const snapshot = () => response(200, { revision: server.revision, state: server.state });
    if (method === "GET") {
      if (headers["If-None-Match"] === '"' + server.revision + '"') {
        return { status: 304, ok: false, json() { throw new Error("304 must not read a JSON body"); } };
      }
      return snapshot();
    }
    assert.equal(method, "POST");
    if (server.receipts.has(operation.operationId)) return snapshot();
    if (operation.type === "append") {
      if (server.rejectAppend) return response(server.rejectAppend.status, { code: server.rejectAppend.code });
      server.state.transactions.push(operation.transaction);
      server.state.months[operation.transaction.date.slice(0, 7)] ??= { status: "active", budget: null };
    } else {
      assert.equal(operation.type, "patch");
      if (operation.baseRevision !== server.revision) return response(409, { code: "conflict" });
      assert.deepEqual(operation.changes.categories, { upsert: [], remove: [] });
      assert.deepEqual(operation.changes.months, { upsert: [], remove: [] });
      for (const item of operation.changes.transactions.upsert) {
        server.state.transactions = server.state.transactions.map(old => old.id === item.id ? item : old);
      }
    }
    server.revision++;
    server.receipts.add(operation.operationId);
    if (server.lostResponse) {
      server.lostResponse = false;
      throw new TypeError("Simulated disconnected response");
    }
    return snapshot();
  };

  return server;
}

function browser(server, indexedDB, online = true) {
  const events = new Map();
  const navigator = { onLine: online };
  const states = [];
  const context = vm.createContext({
    indexedDB, navigator, fetch: server.fetch, AbortController, TypeError, console,
    setTimeout, clearTimeout, setInterval() {},
    document: { hidden: false, addEventListener() {} },
    addEventListener(name, listener) { events.set(name, listener); },
  });
  context.window = context;
  vm.runInContext(coreCode, context);
  vm.runInContext(syncCode, context);
  const instance = context.BudgetSync.create({ onChange: snapshot => states.push(snapshot) });
  return {
    instance, events, navigator, states, snapshot: instance.getStatus,
    online(value) { navigator.onLine = value; },
  };
}

function makeTransaction(id, amountOre = 12550) {
  return { id, date: "2026-11-01", description: "Bónus", categoryId: "food", type: "expense", amountOre };
}

function add(browser, item, state = browser.snapshot().state) {
  return browser.instance.save({
    ...state,
    months: { ...state.months, "2026-11": state.months["2026-11"] ?? { status: "active", budget: null } },
    transactions: [...state.transactions, item],
  }, { expectedState: state });
}

async function run() {
  const server = createServer();
  const idb = fakeIndexedDB();
  const a = browser(server, idb);
  await a.instance.start();
  assert.equal(a.snapshot().phase, "synced");
  const pristine = a.snapshot().state;
  await a.instance.retry();
  assert.equal(a.snapshot().state, pristine);
  const polls = server.calls.filter(call => call.url === "/api/ledger" && call.method === "GET");
  assert.equal(polls[0].headers["If-None-Match"], undefined);
  assert.equal(polls[1].headers["If-None-Match"], '"0"');
  console.log("PASS authenticated startup and HTTP 304 refresh keep a stable ledger reference");

  a.online(false);
  a.events.get("offline")();
  const first = makeTransaction("first");
  assert.equal((await add(a, first)).ok, true);
  assert.equal(a.snapshot().pending, 1);
  assert.equal(a.snapshot().phase, "offline");
  assert.equal(server.state.transactions.length, 0);
  assert.equal(idb.getRecord().outbox[0].transaction.id, first.id);
  assert.equal((await a.instance.signOut()).ok, false);

  const b = browser(server, idb, false);
  await b.instance.start();
  assert.equal(b.snapshot().phase, "offline");
  assert.equal(b.snapshot().pending, 1);
  assert.equal(b.snapshot().state.transactions[0].id, first.id);
  assert.equal(b.snapshot().state.months["2026-11"].status, "active");
  console.log("PASS durable offline purchase appears in restarted browser, blocks premature sign-out");

  b.online(true);
  server.lostResponse = true;
  await b.instance.retry();
  assert.equal(server.state.transactions.length, 1);
  assert.equal(b.snapshot().pending, 1);
  assert.equal(b.snapshot().phase, "offline");
  await b.instance.retry();
  assert.equal(server.state.transactions.length, 1);
  assert.equal(b.snapshot().pending, 0);
  assert.equal(b.snapshot().phase, "synced");
  const writes = server.calls.filter(call => call.operation?.type === "append");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].operation.operationId, writes[1].operation.operationId);
  console.log("PASS lost append response retries with stable ID and no duplicated purchase");

  let expected = b.snapshot().state;
  let changed = { ...expected, transactions: expected.transactions.map(item => ({ ...item, amountOre: 20000 })) };
  server.revision++;
  server.state.transactions.push(makeTransaction("remote", 2000));
  assert.equal((await b.instance.save(changed, { expectedState: expected })).ok, false);
  for (let spin = 0; spin < 10 && b.snapshot().state.transactions.length !== 2; spin++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(b.snapshot().state.transactions.length, 2);
  assert.equal(b.snapshot().phase, "error");
  assert.match(b.snapshot().error, /aðrari eind/);
  assert.equal(server.state.transactions[0].amountOre, 12550);
  assert.equal((await b.instance.save(changed, { expectedState: expected })).ok, false);
  await b.instance.retry();
  expected = b.snapshot().state;
  changed = { ...expected, transactions: expected.transactions.map(item => item.id === first.id ? { ...item, amountOre: 20000 } : item) };
  assert.equal((await b.instance.save(changed, { expectedState: expected })).ok, true);
  assert.equal(server.state.transactions[0].amountOre, 20000);
  assert.equal(server.state.transactions.length, 2);
  console.log("PASS concurrent revision rejects stale patch durably; fresh editor patch succeeds");

  b.online(false);
  b.events.get("offline")();
  const before = b.snapshot().state;
  assert.equal((await b.instance.save({ ...before, transactions: [] }, { expectedState: before })).ok, false);
  assert.equal(server.state.transactions.length, 2);
  idb.setFail(true);
  assert.equal((await add(b, makeTransaction("write-fail"))).ok, false);
  assert.equal(b.snapshot().pending, 0);
  idb.setFail(false);
  assert.equal((await add(b, makeTransaction("blocked"))).ok, true);
  b.online(true);
  server.rejectAppend = { status: 409, code: "duplicate" };
  await b.instance.retry();
  assert.equal(b.snapshot().pending, 1);
  assert.equal(b.snapshot().phase, "error");
  assert.match(b.snapshot().pendingTransactions[0].error, /eyðmerki/);
  const blockedOperation = b.snapshot().pendingTransactions[0].operationId;
  assert.equal(idb.getRecord().outbox[0].error, b.snapshot().pendingTransactions[0].error);
  const c = browser(server, idb, false);
  await c.instance.start();
  assert.equal(c.snapshot().phase, "error");
  assert.equal(c.snapshot().pending, 1);
  assert.equal(c.snapshot().state.transactions.length, 3);
  c.online(true);
  server.rejectAppend = null;
  let releaseSession;
  server.pauseSession = new Promise(resolve => { releaseSession = resolve; });
  c.events.get("online")();
  await new Promise(resolve => setImmediate(resolve));
  const forcedRetry = c.instance.retry();
  server.pauseSession = undefined;
  releaseSession();
  await forcedRetry;
  assert.equal(c.snapshot().pending, 0);
  assert.equal(server.state.transactions.at(-1).id, "blocked");
  assert.ok(server.receipts.has(blockedOperation));
  console.log("PASS offline edits rejected, failed IDB write never acknowledged, durable blocked op retried while a refresh was active");

  c.online(false);
  c.events.get("offline")();
  assert.equal((await add(c, makeTransaction("discard"))).ok, true);
  c.online(true);
  server.rejectAppend = { status: 422, code: "invalid" };
  await c.instance.retry();
  assert.equal(c.snapshot().phase, "error");
  assert.equal((await c.instance.discardPending(c.snapshot().pendingTransactions[0].operationId)).ok, true);
  assert.equal(c.snapshot().pending, 0);
  assert.ok(!c.snapshot().state.transactions.some(item => item.id === "discard"));
  assert.equal((await c.instance.signOut()).ok, true);
  assert.equal(c.snapshot().phase, "signed-out");
  assert.equal(c.snapshot().state, null);
  assert.equal(idb.getRecord(), null);
  const d = browser(server, idb, false);
  await d.instance.start();
  assert.equal(d.snapshot().state, null);
  console.log("PASS explicit discard of a rejected local entry and sign-out clear private cache");

  server.configured = false;
  d.online(true);
  await d.instance.retry();
  assert.equal(d.snapshot().configured, false);
  assert.equal(d.snapshot().phase, "signed-out");
  assert.equal(d.snapshot().error, "Samstillingin er ikki sett upp enn.");
  console.log("PASS hosted setup state is distinct from sign-in");

  const staleServer = createServer();
  const staleDb = fakeIndexedDB();
  const e = browser(staleServer, staleDb);
  await e.instance.start();
  const oldState = e.snapshot().state;
  staleServer.revision++;
  staleServer.state.transactions.push(makeTransaction("other-device"));
  staleServer.state.months["2026-11"] = { status: "completed", budget: null };
  await e.instance.retry();
  assert.notEqual(e.snapshot().state, oldState);
  assert.equal((await add(e, makeTransaction("stale-new-draft"), oldState)).ok, true);
  await e.instance.retry();
  assert.equal(staleServer.state.months["2026-11"].status, "completed");
  assert.deepEqual(staleServer.state.transactions.map(item => item.id), ["other-device", "stale-new-draft"]);
  assert.equal((await add(e, makeTransaction("other-device"), oldState)).ok, false);

  const f = browser(staleServer, staleDb);
  await f.instance.start();
  const cacheBehind = f.snapshot().state;
  await add(e, makeTransaction("another-local-tab"));
  await e.instance.retry();
  assert.notEqual(staleDb.getRecord().server.revision, 1);
  assert.equal((await add(f, makeTransaction("older-tab-draft"), cacheBehind)).ok, true);
  await f.instance.retry();
  assert.equal(staleServer.state.transactions.length, 4);
  console.log("PASS a stale new-purchase draft appends without reverting a newer remote budget/status or duplicating another record");

  const g = browser(staleServer, staleDb, false);
  await g.instance.start();
  assert.equal((await add(g, makeTransaction("owner-secret"))).ok, true);
  staleServer.ownerId = "456";
  g.online(true);
  await g.instance.retry();
  assert.equal(g.snapshot().state, null);
  assert.equal(g.snapshot().pendingTransactions.length, 0);
  assert.equal(staleDb.getRecord().outbox[0].transaction.id, "owner-secret");
  assert.equal(staleServer.state.transactions.length, 4);
  const h = browser(staleServer, staleDb, false);
  await h.instance.start();
  assert.equal(h.snapshot().state, null);
  console.log("PASS owner mismatch hides cache and prevents queued purchase being uploaded to a different owner");

  const authServer = createServer();
  const authDb = fakeIndexedDB();
  const j = browser(authServer, authDb);
  await j.instance.start();
  j.online(false);
  j.events.get("offline")();
  assert.equal((await add(j, makeTransaction("renew-session"))).ok, true);
  authServer.signedIn = false;
  j.online(true);
  await j.instance.retry();
  assert.equal(j.snapshot().phase, "signed-out");
  assert.equal(j.snapshot().state, null);
  assert.equal(j.snapshot().pending, 1);
  assert.equal(authDb.getRecord().offlineAllowed, false);
  const k = browser(authServer, authDb, false);
  await k.instance.start();
  assert.equal(k.snapshot().state, null);
  assert.equal(k.snapshot().pending, 1);
  authServer.signedIn = true;
  k.online(true);
  await k.instance.retry();
  assert.equal(k.snapshot().phase, "synced");
  assert.equal(k.snapshot().pending, 0);
  assert.equal(authServer.state.transactions[0].id, "renew-session");
  console.log("PASS expired session hides cached data and retains pending record until same owner signs in again");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
