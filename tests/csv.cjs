const assert = require('node:assert/strict');
require('../csv-export.js');
const csv = globalThis.BudgetCSV;
const expense = { id: 'expense-1', date: '2026-11-02', type: 'expense', description: 'Coffee, "Bónus"\r\nreceipt', categoryId: 'food', amountOre: 12550 };
const refund = { ...expense, id: 'refund-1', type: 'refund', description: '=SUM(1,2)', amountOre: 5000 };
const income = { ...expense, id: 'income-1', type: 'income', categoryId: null, description: 'Løn', amountOre: 2200000 };
const state = {
  version: 1,
  categories: [{ id: 'food', label: 'Current name', kind: 'variable' }],
  months: {
    '2026-10': { status: 'skipped', budget: null },
    '2026-11': { status: 'active', budget: {
      income: [{ id: 'salary', label: 'Løn', amountOre: 2200000 }],
      allocations: [{ categoryId: 'food', label: 'Historical food', kind: 'variable', amountOre: 0 }], copiedFrom: '2026-10',
    } },
  },
  transactions: [income, expense, refund],
};
const before = JSON.stringify(state);
const exported = csv.transactions(state, { synced: true });
assert(exported.startsWith('\ufeff"transaction_id"'));
assert(exported.includes('"Coffee, ""Bónus""\r\nreceipt"'));
assert(exported.includes('"Historical food","12550","125.50","125.50"'));
assert(exported.includes('"5000","50.00","-50.00"'));
assert(exported.includes('"2200000","22000.00","0.00"'));
assert(exported.includes('"\'=SUM(1,2)"'));
assert(exported.includes('"active","synced"'));
const queued = { ...expense, id: 'queued-1', description: '\t@unsafe' };
const waiting = csv.transactions(state, { synced: true, pendingEntries: [
  { transaction: expense }, { transaction: queued, error: 'Rejected' },
] });
assert.equal((waiting.match(/"expense-1"/g) ?? []).length, 1);
assert(waiting.includes('"\'\t@unsafe"'));
assert(waiting.includes('"needs_attention","Rejected"'));
assert(waiting.includes('"active","pending"'));
const conflict = csv.transactions(state, { synced: true, pendingEntries: [
  { transaction: { ...expense, amountOre: 9000 }, error: 'Collision' },
] });
assert.equal((conflict.match(/"expense-1"/g) ?? []).length, 2);
assert(conflict.includes('"9000","90.00","90.00"'));
assert(conflict.includes('"active","synced"'));
assert(conflict.includes('"needs_attention","Collision"'));
const budgets = csv.budgets(state);
assert(budgets.includes('"2026-10","skipped","unplanned"'));
assert(budgets.includes('"income","salary","","Løn","2200000","22000.00","2026-10"'));
assert(budgets.includes('"Historical food","0","0.00","2026-10"'));
assert.equal(csv.transactions({ ...state, transactions: [] }).split('\r\n').length, 2);
assert.equal(JSON.stringify(state), before);
console.log('CSV checks passed for exact money, refunds, historical labels, quotes/newlines, spreadsheet formulas, pending records and conflicting IDs.');
