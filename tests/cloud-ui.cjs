const path = require("node:path");
const assert = require('node:assert/strict');
const { loadApp, createLedger, SimEvent } = require('./support/dom.cjs');

const source = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
const ledger = createLedger();
let status = { phase: 'synced', pending: 0, state: ledger.state, pendingTransactions: [] };
let onChange;
const saves = [];
const sync = {
  create(options) {
    onChange = options.onChange;
    return {
      start() { onChange(status); return Promise.resolve(); },
      save(nextState, options) {
        return new Promise((resolve, reject) => saves.push({ nextState, options, resolve, reject }));
      },
      getStatus() { return status; },
      retry() { return Promise.resolve(); },
      signOut() { return Promise.resolve({ ok: true }); },
    };
  },
};
const app = loadApp(source, ledger, { sync });
const { get, click } = app;
const tick = () => new Promise(resolve => setImmediate(resolve));
const publish = state => { status = { ...status, state }; onChange(status); };
const input = (field, value) => {
  field.value = value;
  field.dispatchEvent(new SimEvent('input', { bubbles: true }));
};

async function run() {
  click('#tab-transactions');
  const form = get('#transaction-form');
  const draft = {
    description: 'Independent stale purchase draft', amount: '333,44', category: 'phone', date: '2026-11-10',
  };
  for (const [key, value] of Object.entries(draft)) input(form.elements[key], value);
  const remote = { ...ledger.state, transactions: [...ledger.state.transactions,
    { id: 'remote-new', date: '2026-11-09', description: 'Arrived from phone', categoryId: 'phone', type: 'expense', amountOre: 1234 }],
  };
  publish(remote);
  assert.equal(get('#transaction-form'), form);
  assert.equal(form.elements.description.value, draft.description);
  assert.equal(get('#cloud-refresh-draft').hidden, false);
  form.requestSubmit();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].options.expectedState, ledger.state);
  assert.equal(get('#view').getAttribute('aria-busy'), 'true');
  assert.equal(form.elements.amount.disabled, true);
  assert.equal(get('#tab-stats').disabled, true);
  assert.equal(get('#next-month').disabled, true);
  const whileSaving = { ...remote, transactions: [...remote.transactions,
    { id: 'remote-second', date: '2026-11-09', description: 'Another remote purchase', categoryId: 'phone', type: 'expense', amountOre: 2345 }],
  };
  publish(whileSaving);
  assert.equal(get('#transaction-form'), form);
  assert.equal(form.elements.amount.value, draft.amount);
  assert.equal(form.elements.amount.disabled, true);
  const created = saves[0].nextState.transactions.find(item => item.description === draft.description);
  assert.equal(created.amountOre, 33344);
  publish({ ...whileSaving, transactions: [...whileSaving.transactions, created] });
  saves[0].resolve({ ok: true });
  await tick();
  assert.notEqual(get('#transaction-form'), form);
  assert.equal(get('#transaction-form').elements.description.value, '');
  assert.equal(get('#transaction-form').elements.amount.disabled, false);
  assert.equal(get('#tab-stats').disabled, false);
  assert.equal(get('#next-month').disabled, false);
  assert.equal(get('#view').hasAttribute('aria-busy'), false);
  assert.ok(get('.transaction-list').textContent.includes(draft.description));
  console.log('PASS remote refresh keeps new purchase draft and original expected snapshot; in-flight save freezes controls, keeps form, and unlocks/reset on success');

  const edit = app.document.querySelectorAll('[data-edit]').find(button => button.getAttribute('aria-label')?.includes(draft.description));
  edit.click();
  const editingForm = get('#transaction-form');
  input(editingForm.elements.amount, '444,55');
  editingForm.requestSubmit();
  assert.equal(saves.length, 2);
  assert.equal(editingForm.elements.amount.disabled, true);
  const newest = structuredClone(status.state);
  newest.transactions.find(item => item.id === created.id).amountOre = 55566;
  publish(newest);
  assert.equal(get('#transaction-form'), editingForm);
  saves[1].resolve({ ok: false, message: 'Conflict was preserved' });
  await tick();
  assert.equal(get('#transaction-form'), editingForm);
  assert.equal(editingForm.elements.amount.value, '444,55');
  assert.equal(editingForm.elements.amount.disabled, false);
  assert.equal(get('#cloud-refresh-draft').hidden, false);
  assert.ok(get('#toast').textContent.includes('Conflict was preserved'));
  assert.equal(get('#view').hasAttribute('aria-busy'), false);
  console.log('PASS conflict during save preserves entered amount and restores controls without replaying stale data');

  editingForm.requestSubmit();
  assert.equal(saves.length, 3);
  saves[2].reject(new Error('network failed'));
  await tick();
  assert.equal(get('#transaction-form'), editingForm);
  assert.equal(editingForm.elements.amount.value, '444,55');
  assert.equal(editingForm.elements.amount.disabled, false);
  assert.equal(get('#tab-overview').disabled, false);
  assert.ok(get('#toast').textContent.includes('Broytingin kundi ikki goymast'));
  console.log('PASS unexpected save failure preserves draft and unlocks controls');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
