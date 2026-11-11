const assert = require('node:assert/strict');
const path = require('node:path');
const { loadApp, SimEvent } = require('./support/dom.cjs');

const source = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const collator = new Intl.Collator('fo', { sensitivity: 'base', numeric: true });
const checked = [];

function fixture() {
  const categories = [
    { id: 'zebra', label: 'Zebra', kind: 'variable' },
    { id: 'food', label: 'Matur', kind: 'variable' },
    { id: 'phone', label: 'Telefon', kind: 'fixed' },
    { id: 'other', label: 'Annað', kind: 'variable' },
    { id: 'adventure', label: 'Ævintýr', kind: 'variable' },
    { id: 'area', label: 'Øki', kind: 'variable' },
  ];
  const allocations = categories.map(category => ({ categoryId: category.id, label: category.label, kind: category.kind, amountOre: 100000 }));
  const prior = structuredClone(allocations);
  prior.find(line => line.categoryId === 'food').label = 'Matvørur';
  prior.push({ categoryId: 'legacy-books', label: 'Bøkur úr eldri ætlan', kind: 'variable', amountOre: 20000 });
  const current = structuredClone(allocations);
  current.find(line => line.categoryId === 'food').label = 'Matur og drekka';
  return { mode: 'personal', state: {
    version: 1,
    categories,
    months: {
      '2026-10': { status: 'completed', budget: { income: [], allocations: prior, copiedFrom: null } },
      '2026-11': { status: 'active', budget: { income: [], allocations: current, copiedFrom: '2026-10' } },
    },
    transactions: [
      { id: 'old-food', date: '2026-10-15', description: 'Gamalt keyp', categoryId: 'food', type: 'expense', amountOre: 2500 },
      { id: 'legacy-book-purchase', date: '2026-10-10', description: 'Eldri bók', categoryId: 'legacy-books', type: 'expense', amountOre: 1500 },
      { id: 'orphan-purchase', date: '2026-11-03', description: 'Gamalt keyp uttan bólkaskrá', categoryId: 'orphan-category', type: 'expense', amountOre: 1000 },
      { id: 'unclassified-purchase', date: '2026-11-04', description: 'Óbólkað eldri keyp', categoryId: null, type: 'expense', amountOre: 500 },
      { id: 'phone-purchase', date: '2026-11-02', description: 'Telefonrokning', categoryId: 'phone', type: 'expense', amountOre: 3000 },
    ],
  } };
}

function type(field, value) {
  field.value = value;
  field.dispatchEvent(new SimEvent('input', { bubbles: true }));
}

function chooseDate(app, value) {
  const date = app.get('#transaction-form').elements.date;
  date.value = value;
  date.dispatchEvent(new SimEvent('change', { bubbles: true }));
}

function options(select) {
  return select.options.filter(option => option.value).map(option => ({ id: option.value, label: option.textContent }));
}

function sorted(select) {
  const actual = options(select);
  const expected = [...actual].sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.id, b.id));
  assert.deepEqual(actual, expected);
}

function editButton(app, id) {
  return app.document.querySelectorAll('[data-edit]').find(button => button.dataset.edit === id);
}

function planLine(app, id) {
  return app.document.querySelectorAll('[data-budget-line]').find(row => row.dataset.lineId === id);
}

function test(label, check) {
  check();
  checked.push(label);
  console.log('PASS', label);
}

const app = loadApp(source, fixture());
const { click, get } = app;
const originalCatalog = structuredClone(app.ledger().state.categories);
const originalPriorBudget = structuredClone(app.ledger().state.months['2026-10'].budget);
let booksId;

test('A saved new budget category appears alphabetically in entry and filter before spending, then records through to overview', () => {
  click('#tab-budget');
  click('[data-add-budget-line="variable"]');
  const row = get('[data-budget-lines="variable"]').lastElementChild;
  type(row.querySelector('[data-line-label]'), 'Bøkur');
  type(row.querySelector('[data-line-amount]'), '500');
  get('[data-budget-form]').requestSubmit();
  const saved = app.ledger().state;
  const books = saved.categories.filter(category => category.label === 'Bøkur');
  assert.equal(books.length, 1);
  booksId = books[0].id;
  assert.deepEqual(saved.categories.slice(0, originalCatalog.length), originalCatalog);
  click('#tab-transactions');
  const form = get('#transaction-form');
  const entry = form.elements.category;
  const filter = get('[data-filter-category]');
  assert(options(entry).some(option => option.id === booksId && option.label === 'Bøkur'));
  assert(options(filter).some(option => option.id === booksId && option.label === 'Bøkur'));
  sorted(entry);
  sorted(filter);
  type(form.elements.amount, '125,50');
  type(form.elements.description, 'Nýggj bók');
  form.elements.category.value = booksId;
  form.requestSubmit();
  const purchase = app.ledger().state.transactions.find(item => item.description === 'Nýggj bók');
  assert.equal(purchase.categoryId, booksId);
  assert.equal(purchase.amountOre, 12550);
  click('#tab-overview');
  const overview = app.document.querySelectorAll('.category-row').find(row => row.querySelector('.category-name').textContent.trim() === 'Bøkur');
  assert(overview);
  assert(overview.textContent.includes(app.context.BudgetCore.money(37450)));
  assert(overview.textContent.includes(app.context.BudgetCore.money(12550)));
});

test('Renaming a month label preserves stable category identity, catalog order, and the previous month snapshot', () => {
  click('#tab-budget');
  type(planLine(app, 'food').querySelector('[data-line-label]'), 'Dagligvørur');
  get('[data-budget-form]').requestSubmit();
  const saved = app.ledger().state;
  assert.equal(saved.months['2026-11'].budget.allocations.find(line => line.categoryId === 'food').label, 'Dagligvørur');
  assert.deepEqual(saved.months['2026-10'].budget, originalPriorBudget);
  assert.deepEqual(saved.categories.slice(0, originalCatalog.length), originalCatalog);
  assert.equal(saved.transactions.find(item => item.id === 'old-food').categoryId, 'food');
  click('#tab-transactions');
  const select = get('#transaction-form').elements.category;
  assert(options(select).some(option => option.id === 'food' && option.label === 'Dagligvørur'));
  sorted(select);
});

test('Backdating resolves the destination month labels, preserves the selected category ID, and sorts again', () => {
  const form = get('#transaction-form');
  form.elements.category.value = 'food';
  chooseDate(app, '2026-10-20');
  assert.equal(form.elements.category.value, 'food');
  assert(options(form.elements.category).some(option => option.id === 'food' && option.label === 'Matvørur'));
  assert(options(form.elements.category).some(option => option.id === 'legacy-books' && option.label === 'Bøkur úr eldri ætlan'));
  sorted(form.elements.category);
  type(form.elements.amount, '20');
  type(form.elements.description, 'Afturskrásett keyp');
  form.requestSubmit();
  assert.equal(get('#open-month').textContent.includes('Oktober 2026'), true);
  const saved = app.ledger().state.transactions.find(item => item.description === 'Afturskrásett keyp');
  assert.equal(saved.categoryId, 'food');
  assert.equal(saved.date, '2026-10-20');
  assert(get('.transaction-list').textContent.includes('Matvørur'));
  assert.equal(get('#transaction-form').elements.date.value, '2026-11-10');
  assert(options(get('#transaction-form').elements.category).some(option => option.id === 'food' && option.label === 'Dagligvørur'));
  sorted(get('[data-filter-category]'));
});

test('Changing a new purchase date removes snapshot-only choices that do not exist in the destination month', () => {
  const form = get('#transaction-form');
  chooseDate(app, '2026-10-21');
  form.elements.category.value = 'legacy-books';
  assert.equal(form.elements.category.value, 'legacy-books');
  chooseDate(app, '2026-11-10');
  assert.equal(options(form.elements.category).some(option => option.id === 'legacy-books'), false);
  assert.equal(form.elements.category.value, '');
  sorted(form.elements.category);
  const count = app.ledger().state.transactions.length;
  type(form.elements.amount, '10');
  type(form.elements.description, 'Requires a new category selection');
  form.requestSubmit();
  assert.equal(app.ledger().state.transactions.length, count);
  assert.equal(form.querySelector('.form-error').hidden, false);
});

test('A purchase entered from a past-month view defaults to today and opens its actual month after save', () => {
  const target = loadApp(source, fixture());
  target.click('#tab-transactions');
  target.click('#previous-month');
  const form = target.get('#transaction-form');
  assert.equal(form.elements.date.value, '2026-11-10');
  assert(options(form.elements.category).some(option => option.id === 'food' && option.label === 'Matur og drekka'));
  type(form.elements.amount, '12,50');
  type(form.elements.description, 'Today from an older view');
  form.elements.category.value = 'food';
  form.requestSubmit();
  assert(target.get('#open-month').textContent.includes('November 2026'));
  assert(target.get('.transaction-list').textContent.includes('Today from an older view'));
  assert.equal(target.ledger().state.transactions.find(item => item.description === 'Today from an older view').date, '2026-11-10');
});

test('Existing older purchases and snapshot-only category IDs remain editable without changing their identity', () => {
  editButton(app, 'legacy-book-purchase').click();
  const form = get('#transaction-form');
  assert.equal(form.elements.category.value, 'legacy-books');
  assert(options(form.elements.category).some(option => option.id === 'legacy-books' && option.label === 'Bøkur úr eldri ætlan'));
  type(form.elements.amount, '16,25');
  form.requestSubmit();
  const transaction = app.ledger().state.transactions.find(item => item.id === 'legacy-book-purchase');
  assert.equal(transaction.categoryId, 'legacy-books');
  assert.equal(transaction.amountOre, 1625);
  assert.equal(app.ledger().state.categories.some(category => category.id === 'legacy-books'), false);
  assert.deepEqual(app.ledger().state.months['2026-10'].budget, originalPriorBudget);
});

test('Removing a monthly allowance keeps catalog/history readable and the category selectable as unbudgeted', () => {
  click('#next-month');
  click('#tab-budget');
  planLine(app, booksId).querySelector('[data-remove-budget-line]').click();
  get('[data-budget-form]').requestSubmit();
  const saved = app.ledger().state;
  assert.equal(saved.months['2026-11'].budget.allocations.some(line => line.categoryId === booksId), false);
  assert(saved.categories.some(category => category.id === booksId));
  assert(saved.transactions.some(item => item.categoryId === booksId));
  click('#tab-transactions');
  assert(options(get('#transaction-form').elements.category).some(option => option.id === booksId));
  sorted(get('#transaction-form').elements.category);
  sorted(get('[data-filter-category]'));
  click('#tab-overview');
  const row = app.document.querySelectorAll('.category-row').find(item => item.querySelector('.category-name').textContent.trim() === 'Bøkur');
  assert(row);
  assert(row.textContent.includes('Ongin játtan'));
});

test('Older orphaned and unclassified transactions can be corrected without inventing a new category', () => {
  click('#tab-transactions');
  editButton(app, 'orphan-purchase').click();
  let form = get('#transaction-form');
  assert.equal(form.elements.category.value, 'orphan-category');
  assert(options(form.elements.category).some(option => option.id === 'orphan-category' && option.label === 'Óbólkað'));
  type(form.elements.amount, '11');
  form.requestSubmit();
  assert.equal(app.ledger().state.transactions.find(item => item.id === 'orphan-purchase').categoryId, 'orphan-category');
  editButton(app, 'unclassified-purchase').click();
  form = get('#transaction-form');
  assert.equal(form.elements.category.value, '');
  assert.equal(form.elements.category.required, false);
  type(form.elements.amount, '6');
  form.requestSubmit();
  const unclassified = app.ledger().state.transactions.find(item => item.id === 'unclassified-purchase');
  assert.equal(unclassified.categoryId, null);
  assert.equal(unclassified.amountOre, 600);
});

test('Removing and readding a renamed snapshot line reuses its category ID', () => {
  click('#tab-budget');
  const categoryCount = app.ledger().state.categories.length;
  planLine(app, 'food').querySelector('[data-remove-budget-line]').click();
  click('[data-add-budget-line="variable"]');
  const row = get('[data-budget-lines="variable"]').lastElementChild;
  type(row.querySelector('[data-line-label]'), 'Dagligvørur');
  type(row.querySelector('[data-line-amount]'), '300');
  get('[data-budget-form]').requestSubmit();
  const saved = app.ledger().state;
  assert.equal(saved.categories.length, categoryCount);
  assert.equal(saved.months['2026-11'].budget.allocations.find(line => line.label === 'Dagligvørur').categoryId, 'food');
});

test('All-month search combines date, category and transaction type filters and edits an older result in place', () => {
  const target = loadApp(source, fixture());
  target.click('#tab-transactions');
  assert.equal(editButton(target, 'old-food'), undefined);
  target.change('[data-filter-scope]', 'all');
  target.change('[data-filter-from]', '2026-10-01');
  target.change('[data-filter-to]', '2026-10-31');
  target.change('[data-filter-type]', 'expense');
  target.change('[data-filter-category]', 'food');
  type(target.get('[data-search]'), 'gamalt');
  assert(editButton(target, 'old-food'));
  assert.equal(editButton(target, 'legacy-book-purchase'), undefined);
  assert.equal(editButton(target, 'orphan-purchase'), undefined);
  editButton(target, 'old-food').click();
  const form = target.get('#transaction-form');
  assert.equal(form.elements.date.value, '2026-10-15');
  type(form.elements.amount, '31,50');
  form.requestSubmit();
  assert.equal(target.ledger().state.transactions.find(item => item.id === 'old-food').amountOre, 3150);
  assert.equal(target.get('[data-filter-scope]').value, 'all');
  assert.equal(target.get('[data-filter-category]').value, 'food');
  assert(editButton(target, 'old-food'));
});

test('Overview category opens matching records for the selected month', () => {
  const target = loadApp(source, fixture());
  target.click('[data-category-history="phone"]');
  assert.equal(target.get('[data-filter-category]').value, 'phone');
  assert(editButton(target, 'phone-purchase'));
  assert.equal(editButton(target, 'orphan-purchase'), undefined);
});

test('Fixed-cost entry opens a prefilled draft, records only on Save and prevents a second shortcut entry', () => {
  const ledger = fixture();
  const rent = { id: 'rent', label: 'Húsaleiga', kind: 'fixed' };
  ledger.state.categories.push(rent);
  ledger.state.months['2026-11'].budget.allocations.push({ categoryId: rent.id, label: rent.label, kind: rent.kind, amountOre: 600000 });
  const target = loadApp(source, ledger);
  target.click('#tab-budget');
  target.click('[data-open-fixed-entry]');
  assert.equal(target.get('[data-entry-mode="fixed"]').getAttribute('aria-pressed'), 'true');
  assert.equal(target.get('[data-add-fixed="phone"]').disabled, true);
  target.click('[data-add-fixed="rent"]');
  let form = target.get('#transaction-form');
  assert.equal(form.hidden, false);
  assert.equal(form.elements.category.value, 'rent');
  assert.equal(form.elements.description.value, 'Húsaleiga');
  assert.equal(form.elements.amount.value, '6000');
  assert.equal(target.ledger().state.transactions.length, ledger.state.transactions.length);
  target.click('[data-entry-mode="regular"]');
  assert.equal(target.get('#transaction-form').elements.amount.value, '');
  type(target.get('#transaction-form').elements.description, 'Vanlig óliðug skráseting');
  target.click('[data-entry-mode="fixed"]');
  form = target.get('#transaction-form');
  assert.equal(form.elements.amount.value, '6000');
  form.requestSubmit();
  const entries = target.ledger().state.transactions.filter(item => item.categoryId === 'rent');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountOre, 600000);
  assert.equal(entries[0].date, '2026-11-10');
  assert.equal(target.get('[data-add-fixed="rent"]').disabled, true);
  target.click('[data-entry-mode="regular"]');
  assert.equal(target.get('#transaction-form').elements.description.value, 'Vanlig óliðug skráseting');
});

test('Category management renames future copies and hides archived items from new entry without altering history', () => {
  const ledger = fixture();
  const target = loadApp(source, ledger);
  target.click('#tab-budget');
  target.click('[data-open-category-manager]');
  type(target.get('[data-managed-category="food"] [data-managed-label]'), 'Dagligvørur');
  target.click('[data-managed-category="phone"] [data-toggle-archive]');
  target.get('[data-category-form]').requestSubmit();
  const saved = target.ledger().state;
  assert.equal(saved.categories.find(category => category.id === 'phone').archived, true);
  assert.deepEqual(saved.categories.find(category => category.id === 'food').renames, [{ from: '2026-12', label: 'Dagligvørur' }]);
  assert.deepEqual(saved.months, ledger.state.months);
  assert.deepEqual(saved.transactions, ledger.state.transactions);
  const next = target.context.BudgetCore.createBudget(saved, '2026-12');
  assert.equal(next.allocations.find(line => line.categoryId === 'food').label, 'Dagligvørur');
  assert.equal(next.allocations.some(line => line.categoryId === 'phone'), false);
  const existingDecember = { ...saved, months: { ...saved.months,
    '2026-12': { status: 'active', budget: ledger.state.months['2026-11'].budget } } };
  assert.equal(target.context.BudgetCore.createBudget(existingDecember, '2027-01').allocations
    .find(line => line.categoryId === 'food').label, 'Dagligvørur');
  target.click('#tab-transactions');
  assert(!options(target.get('#transaction-form').elements.category).some(option => option.id === 'phone'));
  assert(options(target.get('[data-filter-category]')).some(option => option.id === 'phone'));
  editButton(target, 'phone-purchase').click();
  assert.equal(target.get('#transaction-form').elements.category.value, 'phone');
});

test('Month review completes the current month and prepares an independent next budget', () => {
  const ledger = fixture();
  const target = loadApp(source, ledger);
  target.click('#tab-budget');
  target.click('[data-open-month-review]');
  assert(target.get('[data-month-review]').hasAttribute('open'));
  target.click('[data-complete-month]');
  const saved = target.ledger().state;
  assert.equal(saved.months['2026-11'].status, 'completed');
  assert.deepEqual(saved.months['2026-11'].budget, ledger.state.months['2026-11'].budget);
  assert.deepEqual(saved.months['2026-12'].budget, { ...ledger.state.months['2026-11'].budget, copiedFrom: '2026-11' });
  assert(target.get('#open-month').textContent.includes('Desember 2026'));
});

test('An unfinished budget line survives changing tabs without changing the saved plan', () => {
  const ledger = fixture();
  const target = loadApp(source, ledger);
  target.click('#tab-budget');
  target.click('[data-add-budget-line="fixed"]');
  let row = target.get('[data-budget-lines="fixed"]').lastElementChild;
  type(row.querySelector('[data-line-label]'), 'Ógoymt hald');
  type(row.querySelector('[data-line-amount]'), '199,50');
  target.click('#tab-overview');
  target.click('#tab-budget');
  row = target.get('[data-budget-lines="fixed"]').lastElementChild;
  assert.equal(row.querySelector('[data-line-label]').value, 'Ógoymt hald');
  assert.equal(row.querySelector('[data-line-amount]').value, '199,50');
  assert.deepEqual(target.ledger().state.months['2026-11'].budget, ledger.state.months['2026-11'].budget);
});

console.log(`Passed ${checked.length} category and editor regression cases.`);
