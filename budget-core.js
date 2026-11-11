(function () {
  "use strict";

  const monthNames = [
    "januar", "februar", "mars", "apríl", "mai", "juni",
    "juli", "august", "september", "oktober", "november", "desember"
  ];
  const shortMonthNames = [
    "jan", "feb", "mar", "apr", "mai", "jun",
    "jul", "aug", "sep", "okt", "nov", "des"
  ];
  const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/u;
  const maxAmountOre = 99_999_999_999;
  const wholeKronerFormat = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
  const fractionalKronerFormat = new Intl.NumberFormat("da-DK", {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  let fallbackId = 0;

  function today() {
    const now = new Date();
    return [
      String(now.getFullYear()).padStart(4, "0"),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
  }

  function isMonth(value) {
    return typeof value === "string" && monthPattern.test(value) && !value.startsWith("0000");
  }

  function isDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !isMonth(value.slice(0, 7))) {
      return false;
    }
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function shiftMonth(month, offset) {
    if (!isMonth(month) || !Number.isSafeInteger(offset)) return month;

    const [year, monthNumber] = month.split("-").map(Number);
    const index = year * 12 + monthNumber - 1 + offset;
    const newYear = Math.floor(index / 12);
    if (newYear < 1 || newYear > 9999) return month;

    return String(newYear).padStart(4, "0") + "-" + String(index % 12 + 1).padStart(2, "0");
  }

  function monthLabel(month, short = false) {
    if (!isMonth(month)) return month;
    const [year, monthNumber] = month.split("-");
    const name = (short ? shortMonthNames : monthNames)[Number(monthNumber) - 1];
    return name[0].toUpperCase() + name.slice(1) + " " + Number(year);
  }

  function money(ore) {
    const format = ore % 100 === 0 ? wholeKronerFormat : fractionalKronerFormat;
    return format.format(ore / 100) + "\u00a0kr.";
  }

  function isAmount(ore) {
    return Number.isSafeInteger(ore) && ore >= 0 && ore <= maxAmountOre;
  }

  function parseAmount(text) {
    if (typeof text !== "string") return null;

    const input = text.trim();
    const danish = /^(\d+|\d{1,3}(?:[. \u00a0\u202f]\d{3})+)(?:,(\d{1,2}))?$/u.exec(input);
    const decimal = danish ?? /^(\d*)[.,](\d{1,2})$/u.exec(input);
    if (!decimal) return null;

    const whole = decimal[1].replace(/[. \u00a0\u202f]/gu, "");
    const fraction = (decimal[2] ?? "").padEnd(2, "0");
    const ore = Number(whole + fraction);
    return isAmount(ore) ? ore : null;
  }

  function newId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    fallbackId += 1;
    return "local-" + Date.now().toString(36) + "-" + fallbackId.toString(36) +
      "-" + Math.random().toString(36).slice(2);
  }

  function sourceForBudget(state, month) {
    const previous = shiftMonth(month, -1);
    if (previous !== month && state.months[previous]?.budget) return previous;

    return Object.keys(state.months)
      .filter((candidate) => candidate < month && state.months[candidate].budget)
      .sort()
      .at(-1) ?? null;
  }

  function categoryLabel(category, month) {
    if (!category) return undefined;
    return category.renames?.findLast(rename => rename.from <= month)?.label ?? category.label;
  }

  function categoryLabels(state, month) {
    const names = new Map(state.categories.map(category => [category.id, categoryLabel(category, month)]));
    for (const line of state.months[month]?.budget?.allocations ?? []) names.set(line.categoryId, line.label);
    return names;
  }

  function createBudget(state, month, sourceMonth = sourceForBudget(state, month)) {
    const source = isMonth(sourceMonth) && sourceMonth < month
      ? state.months[sourceMonth]?.budget
      : null;

    if (source) {
      const catalog = new Map(state.categories.map(category => [category.id, category]));
      const allocations = [];
      for (const line of source.allocations) {
        const category = catalog.get(line.categoryId);
        if (category?.archived) continue;
        const renamed = category?.renames?.some(rename => rename.from <= month);
        allocations.push({ ...line, label: renamed ? categoryLabel(category, month) : line.label });
      }
      return {
        income: source.income.map((line) => ({ ...line })),
        allocations,
        copiedFrom: sourceMonth
      };
    }

    return {
      income: [],
      allocations: state.categories.filter(category => !category.archived).map(category => ({
        categoryId: category.id, label: categoryLabel(category, month), kind: category.kind, amountOre: 0
      })),
      copiedFrom: null
    };
  }

  function summarize(state, month) {
    const budget = state.months[month]?.budget;
    const categories = new Map();
    let plannedFixed = 0;
    let plannedVariable = 0;
    let spent = 0;
    let recordedIncome = 0;
    let hasRecordedIncome = false;

    for (const line of budget?.allocations ?? []) {
      if (line.kind === "fixed") {
        plannedFixed += line.amountOre;
      } else {
        plannedVariable += line.amountOre;
      }
      categories.set(line.categoryId, {
        categoryId: line.categoryId,
        label: line.label,
        kind: line.kind,
        allowance: line.amountOre,
        spent: 0
      });
    }

    const catalog = new Map(state.categories.map((category) => [category.id, category]));
    for (const transaction of state.transactions) {
      if (transaction.date.slice(0, 7) !== month) continue;
      if (transaction.type === "income") {
        recordedIncome += transaction.amountOre;
        hasRecordedIncome = true;
        continue;
      }

      const amount = transaction.type === "refund" ? -transaction.amountOre : transaction.amountOre;
      const categoryId = transaction.categoryId;
      let category = categories.get(categoryId);
      if (!category) {
        const definition = catalog.get(categoryId);
        category = {
          categoryId,
          label: categoryLabel(definition, month) ?? "Óbólkað",
          kind: definition?.kind ?? "variable",
          allowance: null,
          spent: 0
        };
        categories.set(categoryId, category);
      }
      spent += amount;
      category.spent += amount;
    }

    const plannedIncome = (budget?.income ?? []).reduce((total, line) => total + line.amountOre, 0);
    const plannedExpenses = plannedFixed + plannedVariable;
    return {
      plannedIncome,
      plannedFixed,
      plannedVariable,
      plannedExpenses,
      spent,
      recordedIncome,
      hasRecordedIncome,
      unallocated: plannedIncome - plannedExpenses,
      surplus: recordedIncome - spent,
      categories: [...categories.values()]
    };
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isText(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function isKind(value) {
    return value === "fixed" || value === "variable";
  }

  function hasUniqueValues(items, field) {
    return new Set(items.map((item) => item[field])).size === items.length;
  }

  function validBudget(budget) {
    if (budget === null) return true;
    return isRecord(budget) &&
      (budget.copiedFrom === null || isMonth(budget.copiedFrom)) &&
      Array.isArray(budget.income) &&
      budget.income.every((line) =>
        isRecord(line) && isText(line.id) && isText(line.label) && isAmount(line.amountOre)) &&
      hasUniqueValues(budget.income, "id") &&
      Array.isArray(budget.allocations) &&
      budget.allocations.every((line) =>
        isRecord(line) && isText(line.categoryId) && isText(line.label) &&
        isKind(line.kind) && isAmount(line.amountOre)) &&
      hasUniqueValues(budget.allocations, "categoryId");
  }

  function validCategory(category) {
    if (!isRecord(category) || !isText(category.id) || !isText(category.label) || !isKind(category.kind)) return false;
    if (category.archived !== undefined && category.archived !== true) return false;
    if (category.renames === undefined) return true;
    return Array.isArray(category.renames) && category.renames.length <= 120 &&
      category.renames.every((rename, index, renames) =>
        isRecord(rename) && isMonth(rename.from) && isText(rename.label) && rename.label.length <= 60 &&
        (index === 0 || renames[index - 1].from < rename.from));
  }

  function validateState(state) {
    return isRecord(state) &&
      state.version === 1 &&
      Array.isArray(state.categories) &&
      state.categories.every(validCategory) &&
      hasUniqueValues(state.categories, "id") &&
      isRecord(state.months) &&
      Object.entries(state.months).every(([key, month]) =>
        isMonth(key) && isRecord(month) && ["active", "completed", "skipped"].includes(month.status) &&
        validBudget(month.budget)) &&
      Array.isArray(state.transactions) &&
      state.transactions.every((transaction) =>
        isRecord(transaction) && isText(transaction.id) && isDate(transaction.date) &&
        isText(transaction.description) &&
        (transaction.categoryId === null || isText(transaction.categoryId)) &&
        ["expense", "refund", "income"].includes(transaction.type) &&
        isAmount(transaction.amountOre) && transaction.amountOre > 0) &&
      hasUniqueValues(state.transactions, "id");
  }

  function seedState() {
    const date = today();
    const current = date.slice(0, 7);
    const day = Number(date.slice(8));
    const categories = [
      { id: "rent", label: "Húsaleiga", kind: "fixed" },
      { id: "phone", label: "Telefon", kind: "fixed" },
      { id: "utilities", label: "El og hiti", kind: "fixed" },
      { id: "subscriptions", label: "Hald", kind: "fixed" },
      { id: "groceries", label: "Matvørur", kind: "variable" },
      { id: "transport", label: "Ferðsla", kind: "variable" },
      { id: "dining", label: "Matstovur", kind: "variable" },
      { id: "household", label: "Húsarhald", kind: "variable" },
      { id: "leisure", label: "Frítíð", kind: "variable" },
      { id: "gifts", label: "Gávur", kind: "variable" },
      { id: "other", label: "Annað", kind: "variable" }
    ];
    const allowances = {
      rent: 780000, phone: 19900, utilities: 70000, subscriptions: 32900,
      groceries: 240000, transport: 85000, dining: 80000, household: 55000,
      leisure: 110000, gifts: 40000, other: 55000
    };
    const state = { version: 1, categories, months: {}, transactions: [] };

    for (let offset = -3; offset <= 0; offset += 1) {
      const month = shiftMonth(current, offset);
      const active = offset === 0;
      const budget = createBudget(state, month);
      if (offset === -3) {
        budget.income.push({ id: "demo-salary", label: "Løn", amountOre: 2200000 });
        for (const line of budget.allocations) line.amountOre = allowances[line.categoryId];
      }
      state.months[month] = { status: active ? "active" : "completed", budget };

      const records = [
        [1, "Løn", null, 2200000, "income"],
        [1, "Húsaleiga", "rent", 780000],
        [2, "Bónus", "groceries", 41275],
        [3, "Telefonrokning", "phone", 19900],
        [4, "Kaffihúsið", "dining", 21400],
        [5, "Effo", "transport", 35000],
        [6, "Elrokning", "utilities", 61200],
        [7, "Miklagarður", "groceries", 51850],
        [7, "Matstova", "dining", 63500],
        [8, "Spotify", "subscriptions", 10900],
        [9, "Matvørur", "groceries", 32725],
        [9, "Heim og hús", "household", 27650]
      ];
      if (!active) {
        records.push(
          [12, "Bónus", "groceries", 46200 + (offset + 3) * 3800],
          [16, "Frítíð", "leisure", 58500 + (offset + 3) * 16500],
          [18, "Effo", "transport", 42000],
          [20, "Bónus", "groceries", 41400],
          [22, "Gáva", "gifts", 19000 + (offset + 3) * 17000],
          [23, "Matstova", "dining", 20000 + (offset + 3) * 38000],
          [26, "Smákeyp", "other", 34000]
        );
      }

      records.forEach(([dateDay, description, categoryId, amountOre, type = "expense"], index) => {
        state.transactions.push({
          id: "demo-" + month + "-" + index,
          date: month + "-" + String(active ? Math.min(day, dateDay) : dateDay).padStart(2, "0"),
          description, categoryId, type, amountOre
        });
      });
    }
    return state;
  }

  globalThis.BudgetCore = {
    today, isMonth, isDate, shiftMonth, monthLabel, money, parseAmount, newId,
    seedState, summarize, sourceForBudget, createBudget, categoryLabel, categoryLabels, validateState
  };
})();
