const path = require('node:path');
const assert = require('node:assert/strict');
const { loadApp, createLedger, SimEvent } = require('./support/dom.cjs');
const source = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function run() {
  const original = createLedger();
  const app = loadApp(source, original);
  const { get, click, change, context } = app;
  const downloads = [];
  class CaptureBlob { constructor(parts, options) { this.content = parts.join(''); this.type = options.type; } }
  context.Blob = CaptureBlob;
  context.URL = { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} };
  click('#open-storage');
  click('#download-backup');
  const backup = JSON.parse(downloads.at(-1).content);
  assert.deepEqual(backup.state, original.state);
  click('#download-transactions-csv');
  assert.equal(downloads.at(-1).content, context.BudgetCSV.transactions(original.state, { pendingEntries: [], synced: false }));
  assert.equal(downloads.at(-1).type, 'text/csv;charset=utf-8');
  click('#download-budgets-csv');
  assert.equal(downloads.at(-1).content, context.BudgetCSV.budgets(original.state));
  assert.deepEqual(app.ledger(), original);
  console.log('PASS actual JSON and CSV download buttons export the ledger without modifying records');

  function selectFile(text) {
    get('#backup-file').files = [{ text: () => text instanceof Promise ? text : Promise.resolve(text) }];
    get('#backup-file').dispatchEvent(new SimEvent('change', { bubbles: true }));
  }
  selectFile('{bad JSON');
  await tick();
  assert.equal(get('#restore-backup').hidden, true);
  assert.deepEqual(app.ledger(), original);
  selectFile(JSON.stringify({ ...original, state: { ...original.state, transactions: [{ id: 'broken' }] } }));
  await tick();
  assert.equal(get('#restore-backup').hidden, true);
  assert.deepEqual(app.ledger(), original);
  const restored = structuredClone(original);
  restored.state.transactions[0].description = 'Restored <saved> text æ ø';
  selectFile(JSON.stringify(restored));
  await tick();
  assert.equal(get('#restore-backup').hidden, false);
  assert.match(get('#restore-notice').textContent, /Desember 1999 – November 2026/);
  assert.match(get('#restore-notice').textContent, /0 nýggjar · 1 broyttar · 0 strikaðar/);
  assert.deepEqual(app.ledger(), original, 'Choosing a backup must only preview it');
  assert.equal(get('#restore-backup').disabled, true);
  click('#download-restore-safety');
  assert.deepEqual(app.ledger(), original, 'Safety backup alone does not restore');
  assert.equal(get('#restore-backup').disabled, false);
  click('#restore-backup');
  await tick();
  assert.deepEqual(app.ledger(), restored);
  assert.deepEqual(JSON.parse(downloads.at(-1).content).state, original.state, 'Previous ledger is downloaded before restore');
  assert.equal(get('#restore-backup').hidden, true);
  assert.equal(get('#storage-dialog').hasAttribute('open'), false);
  console.log('PASS invalid backups are rejected and valid JSON restores exactly only after explicit restore');

  click('#open-storage');
  let resolveFirst;
  const delayed = new Promise(resolve => { resolveFirst = resolve; });
  selectFile(delayed);
  selectFile('{invalid second selection');
  await tick();
  resolveFirst(JSON.stringify(original));
  await tick();
  assert.equal(get('#restore-backup').hidden, true);
  assert.deepEqual(app.ledger(), restored);
  let resolveClosed;
  selectFile(new Promise(resolve => { resolveClosed = resolve; }));
  get('#storage-dialog').close();
  resolveClosed(JSON.stringify(original));
  await tick();
  click('#open-storage');
  assert.equal(get('#restore-backup').hidden, true);
  assert.deepEqual(app.ledger(), restored);
  console.log('PASS late backup reads cannot replace a newer selection or resurrect a closed restore dialog');

  get('#storage-dialog').close();
  click('#open-month');
  change('#pick-year', '1');
  change('#pick-month', '01');
  get('#month-form').requestSubmit();
  assert.equal(get('#previous-month').disabled, true);
  assert.ok(get('#page-eyebrow').textContent.includes('1'));
  click('#open-month');
  change('#pick-year', '9999');
  change('#pick-month', '12');
  get('#month-form').requestSubmit();
  assert.equal(get('#next-month').disabled, true);
  click('#home');
  assert.ok(get('#page-eyebrow').textContent.includes('November 2026'));
  console.log('PASS month picker respects calendar boundaries and Home returns to the current month');

  click('#tab-transactions');
  const draft = get('#transaction-form').elements;
  draft.description.value = 'Draft saved across app close';
  draft.description.dispatchEvent(new SimEvent('input', { bubbles: true }));
  draft.amount.value = '18,25';
  draft.amount.dispatchEvent(new SimEvent('input', { bubbles: true }));
  draft.category.value = 'phone';
  draft.category.dispatchEvent(new SimEvent('change', { bubbles: true }));
  const reopened = loadApp(source, original, { storage: app.storage });
  assert.equal(reopened.get('#draft-notice').hidden, false);
  reopened.click('#resume-draft');
  const resumed = reopened.get('#transaction-form');
  assert.equal(resumed.elements.description.value, 'Draft saved across app close');
  assert.equal(resumed.elements.amount.value, '18,25');
  resumed.requestSubmit();
  const recorded = reopened.ledger().state.transactions.find(({ description }) => description === 'Draft saved across app close');
  assert.equal(recorded.amountOre, 1825);
  reopened.click('#tab-overview');
  assert.equal(reopened.get('#draft-notice').hidden, true, 'A successfully saved draft clears before rendering again');
  console.log('PASS an unfinished purchase survives a new app session and is removed as a draft after save');

  reopened.click('#tab-transactions');
  const remove = reopened.document.querySelectorAll('[data-remove]').find(button => button.dataset.remove === recorded.id);
  assert.ok(remove, 'Recorded transaction can be removed');
  remove.click();
  assert.ok(!reopened.ledger().state.transactions.some(({ id }) => id === recorded.id));
  reopened.click('#undo-delete');
  assert.deepEqual(reopened.ledger().state.transactions.find(({ id }) => id === recorded.id), recorded);
  console.log('PASS Undo restores the exact transaction and ID after deletion');

}
run().catch(error => { console.error(error); process.exitCode = 1; });
