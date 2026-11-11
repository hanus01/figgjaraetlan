(() => {
  'use strict';

  const transactionFields = ['id', 'date', 'type', 'description', 'categoryId', 'amountOre'];

  function text(value) {
    const content = String(value ?? '');
    // Keep spreadsheet applications from interpreting user text as a formula.
    if (/^[\t\r\n]|^[\s\u0000-\u001f]*[=+@-]/u.test(content)) return "'" + content;
    return content;
  }

  function amount(ore) {
    const absolute = Math.abs(ore);
    const whole = Math.floor(absolute / 100);
    const fraction = String(absolute % 100).padStart(2, '0');
    return `${ore < 0 ? '-' : ''}${whole}.${fraction}`;
  }

  function encode(rows) {
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    return '\ufeff' + rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
  }

  function sameTransaction(left, right) {
    return transactionFields.every((field) => left[field] === right[field]);
  }

  function transactions(state, { pendingEntries = [], synced = false } = {}) {
    const pendingById = new Map(pendingEntries.map((entry) => [entry.transaction.id, entry]));
    const recordsById = new Map(state.transactions.map((entry) => [entry.id, entry]));
    const records = state.transactions.map((transaction) => {
      const pending = pendingById.get(transaction.id);
      const waiting = pending && sameTransaction(transaction, pending.transaction);
      return {
        transaction,
        status: waiting ? (pending.error ? 'needs_attention' : 'pending') : (synced ? 'synced' : 'local'),
        error: waiting ? pending.error : '',
      };
    });
    for (const pending of pendingEntries) {
      const existing = recordsById.get(pending.transaction.id);
      if (existing && sameTransaction(existing, pending.transaction)) continue;
      records.push({
        transaction: pending.transaction,
        status: pending.error ? 'needs_attention' : 'pending',
        error: pending.error ?? '',
      });
    }
    records.sort((a, b) => a.transaction.date.localeCompare(b.transaction.date)
      || a.transaction.id.localeCompare(b.transaction.id));
    const categories = new Map(state.categories.map((entry) => [entry.id, entry.label]));
    const rows = [[
      'transaction_id', 'date', 'month', 'type', 'description', 'category_id', 'category',
      'amount_ore', 'amount_dkk', 'net_expense_dkk', 'month_status', 'sync_status', 'sync_error',
    ]];
    for (const { transaction, status, error } of records) {
      const key = transaction.date.slice(0, 7);
      const month = state.months[key];
      const planned = month?.budget?.allocations.find((line) => line.categoryId === transaction.categoryId);
      let category = planned?.label ?? categories.get(transaction.categoryId) ?? 'Óbólkað';
      let netExpense = transaction.amountOre;
      if (transaction.type === 'income') {
        category = 'Inntøka';
        netExpense = 0;
      } else if (transaction.type === 'refund') netExpense = -netExpense;
      rows.push([
        text(transaction.id), transaction.date, key, transaction.type, text(transaction.description),
        text(transaction.categoryId), text(category), transaction.amountOre, amount(transaction.amountOre),
        amount(netExpense), month?.status ?? 'untracked', status, text(error),
      ]);
    }
    return encode(rows);
  }

  function budgets(state) {
    const rows = [[
      'month', 'month_status', 'section', 'line_id', 'category_id', 'category',
      'amount_ore', 'amount_dkk', 'copied_from',
    ]];
    for (const key of Object.keys(state.months).sort()) {
      const month = state.months[key];
      const plan = month.budget;
      if (!plan || (!plan.income.length && !plan.allocations.length)) {
        rows.push([key, month.status, plan ? 'empty_plan' : 'unplanned', '', '', '', '', '', plan?.copiedFrom ?? '']);
        continue;
      }
      for (const line of plan.income) {
        rows.push([key, month.status, 'income', text(line.id), '', text(line.label),
          line.amountOre, amount(line.amountOre), plan.copiedFrom ?? '']);
      }
      for (const line of plan.allocations) {
        rows.push([key, month.status, line.kind, text(line.categoryId), text(line.categoryId), text(line.label),
          line.amountOre, amount(line.amountOre), plan.copiedFrom ?? '']);
      }
    }
    return encode(rows);
  }

  globalThis.BudgetCSV = { transactions, budgets };
})();
