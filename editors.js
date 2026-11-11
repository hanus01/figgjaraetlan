(() => {
  "use strict";

  const transactionTypes = [
    ["expense", "Útreiðsla"],
    ["income", "Inntøka"],
    ["refund", "Endurgjald"],
  ];
  const statusLabels = [
    ["active", "Í gongd"],
    ["completed", "Liðugur"],
    ["skipped", "Lopin um"],
  ];
  const budgetGroups = [
    { kind: "income", title: "Inntøkur", detail: "Løn og aðrar væntaðar inntøkur", add: "Legg inntøku afturat", placeholder: "T.d. Løn" },
    { kind: "fixed", title: "Fastar útreiðslur", detail: "Húsaleiga, hald og aðrar fastar útreiðslur", add: "Legg fasta útreiðslu afturat", placeholder: "T.d. Húsaleiga" },
    { kind: "variable", title: "Broytiligar útreiðslur", detail: "Mánaðarlig upphædd til hvønn bólk", add: "Legg bólk afturat", placeholder: "T.d. Matvørur" },
  ];
  const categoryCollator = new Intl.Collator("fo", { sensitivity: "base", numeric: true });

  function inputAmount(amountOre) {
    if (amountOre == null) return "";
    const cents = amountOre % 100;
    const whole = Math.floor(amountOre / 100);
    return cents ? `${whole},${String(cents).padStart(2, "0")}` : String(whole);
  }

  function monthRecord(state, month) {
    return state.months[month] ?? { status: "active", budget: null };
  }

  function withMonth(state, month, changes) {
    return { ...state, months: { ...state.months, [month]: { ...monthRecord(state, month), ...changes } } };
  }

  function categoryOptions(names, html) {
    return Array.from(names)
      .sort(([firstId, firstLabel], [secondId, secondLabel]) =>
        categoryCollator.compare(firstLabel, secondLabel) || categoryCollator.compare(firstId, secondId))
      .map(([id, label]) => `<option value="${html(id)}">${html(label)}</option>`).join("");
  }

  function dateLabel(date) {
    const [year, month, day] = date.split("-");
    return `${Number(day)}.${Number(month)}.${year}`;
  }

  function setError(field, message) {
    field.textContent = message;
    field.hidden = !message;
  }

  function sameSnapshot(first, second) {
    if (first === second) return true;
    if (!first || !second || typeof first !== "object" || typeof second !== "object"
      || Array.isArray(first) !== Array.isArray(second)) return false;
    const keys = Object.keys(first);
    return keys.length === Object.keys(second).length
      && keys.every(key => Object.hasOwn(second, key) && sameSnapshot(first[key], second[key]));
  }

  function draftConflict() {
    return `<div class="draft-conflict" data-draft-conflict hidden>
      <p role="status">Dáturnar eru broyttar, síðani tú skrivaði hetta uppskotið. Tú kanst avrita broytingarnar og síðani brúka nýggjastu dáturnar.</p>
      <button class="button secondary small" type="button" data-reset-draft>Brúka nýggjastu dátur</button>
    </div>`;
  }

  function renderTransactions(ctx) {
    const { root, state, month, commit, navigate, transactionId, drafts } = ctx;
    const { today, money, monthLabel, parseAmount, newId, isDate, categoryLabels } = globalThis.BudgetCore;
    const { html, icon } = globalThis.BudgetUI;
    const archivedIds = new Set(state.categories.filter(category => category.archived).map(category => category.id));
    const labelsByMonth = new Map();
    function namesFor(targetMonth) {
      if (!labelsByMonth.has(targetMonth)) labelsByMonth.set(targetMonth, categoryLabels(state, targetMonth));
      return labelsByMonth.get(targetMonth);
    }
    const transactions = state.transactions
      .slice().reverse()
      .sort((a, b) => b.date.localeCompare(a.date));
    const transactionsById = new Map(transactions.map(item => [item.id, item]));
    const initialFilter = ctx.transactionFilter ?? {};
    const unclassified = "@unclassified";

    root.innerHTML = `
      <div class="editor-grid">
        <section class="card transaction-editor" aria-labelledby="transaction-editor-title">
          <div class="card-header section-heading editor-heading">
            <div><h2 id="transaction-editor-title">Nýggj skráseting</h2><p>Skráset eitt keyp, eina inntøku ella eitt endurgjald.</p></div>
          </div>
          <div class="entry-switch" role="group" aria-label="Skráseting">
            <button class="button small secondary" type="button" data-entry-mode="regular" aria-pressed="true">Nýggjar skrásetingar</button>
            <button class="button small secondary" type="button" data-entry-mode="fixed" aria-pressed="false">Fastar útreiðslur</button>
          </div>
          <form class="editor-form" id="transaction-form">
            <div class="field-grid">
              <label class="field"><span>Slag</span><select class="input" name="type">
                ${transactionTypes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
              </select></label>
              <label class="field"><span>Upphædd (kr.)</span><input class="input" name="amount" type="text" inputmode="decimal" placeholder="0,00" required></label>
              <label class="field field-wide"><span>Lýsing</span><input class="input" name="description" placeholder="T.d. Bónus" maxlength="120" required></label>
              <label class="field" data-category-field><span>Bólkur</span><select class="input" name="category" required></select></label>
              <label class="field"><span>Dagfesting</span><input class="input" name="date" type="date" required></label>
            </div>
            <p class="form-error" role="alert" hidden></p>
            ${draftConflict()}
            <div class="form-actions">
              <button class="button primary" type="submit">${icon("check")} <span data-save-label>Goym skráseting</span></button>
              <button class="button secondary" type="button" data-cancel-edit hidden>Lat vera</button>
            </div>
          </form>
          <div class="editor-form" data-fixed-entry hidden>
            <div class="fixed-entry-list" data-fixed-list></div>
          </div>
        </section>
        <section class="card transaction-history" aria-labelledby="transaction-history-title">
          <div class="card-header section-heading editor-heading">
            <div><h2 id="transaction-history-title">Skrásetingar</h2><p data-history-period>${html(monthLabel(month))}</p></div>
            <span class="transaction-count" aria-live="polite"></span>
          </div>
          <div class="filter-grid">
            <label class="field filter-search"><span>Leita</span><input class="input" type="search" data-search placeholder="Leita eftir lýsing"></label>
            <label class="field"><span>Tíðarskeið</span><select class="input" data-filter-scope><option value="month">Hesin mánaður</option><option value="all">Allir mánaðir</option></select></label>
            <label class="field"><span>Bólkur</span><select class="input" data-filter-category></select></label>
            <label class="field"><span>Slag</span><select class="input" data-filter-type><option value="">Øll sløg</option>${transactionTypes.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
            <details class="history-date-filter field-wide" ${initialFilter.from || initialFilter.to ? "open" : ""}>
              <summary>Avmarka dagfesting</summary>
              <div class="field-grid">
                <label class="field"><span>Frá</span><input class="input" type="date" data-filter-from></label>
                <label class="field"><span>Til</span><input class="input" type="date" data-filter-to></label>
              </div>
            </details>
          </div>
          <div class="transaction-list" data-transaction-list></div>
        </section>
      </div>`;

    const form = root.querySelector("#transaction-form");
    const fields = form.elements;
    const categoryField = form.querySelector("[data-category-field]");
    const cancelButton = form.querySelector("[data-cancel-edit]");
    const error = form.querySelector(".form-error");
    const draftWarning = form.querySelector("[data-draft-conflict]");
    const saveButton = form.querySelector('button[type="submit"]');
    const list = root.querySelector("[data-transaction-list]");
    const search = root.querySelector("[data-search]");
    const filterCategory = root.querySelector("[data-filter-category]");
    const filterScope = root.querySelector("[data-filter-scope]");
    const filterType = root.querySelector("[data-filter-type]");
    const filterFrom = root.querySelector("[data-filter-from]");
    const filterTo = root.querySelector("[data-filter-to]");
    const regularMode = root.querySelector('[data-entry-mode="regular"]');
    const fixedMode = root.querySelector('[data-entry-mode="fixed"]');
    const fixedEntry = root.querySelector("[data-fixed-entry]");
    const fixedList = root.querySelector("[data-fixed-list]");
    const txFields = ["type", "amount", "description", "category", "date"];
    const pageSize = 60;
    let visibleLimit = pageSize;
    let editingId = null;
    let editingTransaction;
    let entryNames;
    let draftKey;
    let draftBase;
    let defaultValues;
    let staleDraft = false;
    let inFixedMode = false;
    let selectedFixedId = null;

    search.value = initialFilter.search ?? "";
    filterScope.value = initialFilter.allMonths ? "all" : "month";
    filterType.value = initialFilter.type ?? "";
    filterFrom.value = initialFilter.from ?? initialFilter.date ?? "";
    filterTo.value = initialFilter.to ?? initialFilter.date ?? "";
    const todayDate = today();
    const fixedDate = todayDate.startsWith(`${month}-`) ? todayDate : `${month}-01`;

    function scopeTransactions() {
      return filterScope.value === "all" ? transactions : transactions.filter(item => item.date.startsWith(`${month}-`));
    }

    function updateFilterCategories(selected = filterCategory.value) {
      const names = new Map(namesFor(month));
      for (const item of scopeTransactions()) {
        if (item.type === "income") continue;
        const key = item.categoryId ?? unclassified;
        if (!names.has(key)) names.set(key, namesFor(item.date.slice(0, 7)).get(item.categoryId) ?? "Óbólkað");
      }
      filterCategory.innerHTML = `<option value="">Allir bólkar</option>${categoryOptions(names, html)}`;
      filterCategory.value = selected === null ? unclassified : selected ?? "";
    }

    function canKeepUnclassified() {
      return editingTransaction?.type !== "income" && editingTransaction?.categoryId === null;
    }

    function updateCategoryOptions(selected = fields.category.value) {
      const entryMonth = isDate(fields.date.value) ? fields.date.value.slice(0, 7) : month;
      entryNames = new Map([...namesFor(entryMonth)].filter(([id]) => !archivedIds.has(id)));
      const previousId = editingTransaction?.categoryId;
      if (previousId && !entryNames.has(previousId)) {
        const previousNames = namesFor(editingTransaction.date.slice(0, 7));
        entryNames.set(previousId, namesFor(entryMonth).get(previousId) ?? previousNames.get(previousId) ?? "Óbólkað");
      }
      fields.category.innerHTML = `<option value="">${canKeepUnclassified() ? "Óbólkað" : "Vel bólk"}</option>${categoryOptions(entryNames, html)}`;
      fields.category.value = selected;
    }

    function updateCategoryVisibility() {
      const isIncome = fields.type.value === "income";
      categoryField.hidden = isIncome;
      fields.type.disabled = inFixedMode;
      fields.category.disabled = isIncome || inFixedMode;
      fields.category.required = !isIncome && !canKeepUnclassified();
    }

    function valuesForDraft() {
      return Object.fromEntries(txFields.map(name => [name, fields[name].value]));
    }

    function saveDraft() {
      if (!drafts) return;
      const values = valuesForDraft();
      if (!selectedFixedId && !staleDraft && sameSnapshot(values, defaultValues)) drafts.clear(draftKey);
      else drafts.write(draftKey, { base: draftBase, values, fixedCategoryId: selectedFixedId });
    }

    function setEditor(transaction, focus = false, missingId = null) {
      editingId = transaction?.id ?? (missingId && drafts?.read(`tx:${missingId}`) ? missingId : null);
      editingTransaction = transaction;
      selectedFixedId = null;
      draftKey = editingId ? `tx:${editingId}` : "tx:new";
      draftBase = transaction ?? null;
      fields.type.value = transaction?.type ?? "expense";
      fields.amount.value = inputAmount(transaction?.amountOre);
      fields.description.value = transaction?.description ?? "";
      fields.date.value = transaction?.date ?? today();
      updateCategoryOptions(transaction?.categoryId ?? "");
      defaultValues = valuesForDraft();
      const saved = drafts?.read(draftKey);
      staleDraft = false;
      if (saved?.values && txFields.every(name => typeof saved.values[name] === "string")) {
        staleDraft = !sameSnapshot(saved.base, draftBase);
        draftBase = saved.base;
        for (const name of txFields) if (name !== "category") fields[name].value = saved.values[name];
        updateCategoryOptions(saved.values.category);
      }
      draftWarning.hidden = !staleDraft;
      saveButton.disabled = staleDraft;
      root.querySelector("#transaction-editor-title").textContent = editingId ? "Broyt skráseting" : "Nýggj skráseting";
      form.querySelector("[data-save-label]").textContent = editingId ? "Goym broytingar" : "Goym skráseting";
      cancelButton.hidden = !editingId;
      setError(error, "");
      updateCategoryVisibility();
      if (focus) fields.amount.focus();
    }

    function setFixedEditor(line, date, saved) {
      selectedFixedId = line?.categoryId ?? saved.fixedCategoryId;
      editingId = null;
      editingTransaction = null;
      draftKey = "tx:fixed";
      draftBase = saved?.base ?? { month: date.slice(0, 7), line };
      const currentLine = fixedChoices(draftBase.month).find(item => item.categoryId === selectedFixedId);
      staleDraft = Boolean(saved && !sameSnapshot(draftBase.line, currentLine));
      fields.type.value = "expense";
      fields.date.value = date;
      fields.amount.value = saved?.values.amount ?? inputAmount(line.amountOre);
      fields.description.value = saved?.values.description ?? line.label;
      updateCategoryOptions(selectedFixedId);
      updateCategoryVisibility();
      root.querySelector("#transaction-editor-title").textContent = "Skráset fasta útreiðslu";
      form.querySelector("[data-save-label]").textContent = "Goym skráseting";
      cancelButton.hidden = false;
      draftWarning.hidden = !staleDraft;
      saveButton.disabled = staleDraft;
      setError(error, "");
      form.hidden = false;
      fixedEntry.hidden = true;
    }

    function renderList() {
      const term = search.value.trim().normalize("NFC").toLocaleLowerCase("fo");
      const from = filterFrom.value;
      const to = filterTo.value;
      const scoped = scopeTransactions();
      root.querySelector("[data-history-period]").textContent = filterScope.value === "all" ? "Allir mánaðir" : monthLabel(month);
      if (from && to && from > to) {
        root.querySelector(".transaction-count").textContent = "";
        list.innerHTML = '<p class="form-error" role="alert">Endadagurin skal vera sama dag ella seinni enn byrjanardagurin.</p>';
        return;
      }
      const categoryFilter = filterCategory.value;
      const filtered = scoped.filter(item =>
        item.description.normalize("NFC").toLocaleLowerCase("fo").includes(term)
        && (!categoryFilter || (categoryFilter === unclassified
          ? item.categoryId === null && item.type !== "income" : item.categoryId === categoryFilter))
        && (!filterType.value || item.type === filterType.value)
        && (!from || item.date >= from) && (!to || item.date <= to),
      );
      root.querySelector(".transaction-count").textContent = `${filtered.length} ${filtered.length === 1 ? "skráseting" : "skrásetingar"}`;
      if (!filtered.length) {
        list.innerHTML = `<div class="empty-state">${icon("receipt")}<p>${scoped.length ? "Ongin skráseting samsvarar við leitingina." : "Ongar skrásetingar í tíðarskeiðinum."}</p></div>`;
        return;
      }
      list.innerHTML = filtered.slice(0, visibleLimit).map(item => {
        const typeLabel = transactionTypes.find(([value]) => value === item.type)[1];
        const category = namesFor(item.date.slice(0, 7)).get(item.categoryId) ?? (item.type === "income" ? typeLabel : "Óbólkað");
        const sign = item.type === "expense" ? "−" : "+";
        const actionLabel = html(item.description);
        return `<div class="transaction-row">
          <div class="transaction-main"><div class="transaction-title">${html(item.description)}</div>
          <div class="transaction-meta">${html(category)}${item.type === "refund" ? " · Endurgjald" : ""} · ${html(dateLabel(item.date))}</div></div>
          <span class="transaction-amount ${item.type !== "expense" ? "positive" : ""}">${sign}${html(money(item.amountOre))}</span>
          <div class="transaction-actions">
            <button class="button small quiet icon-button" type="button" data-edit="${html(item.id)}" title="Broyt" aria-label="Broyt ${actionLabel}">${icon("edit")}</button>
            <button class="button small quiet danger icon-button" type="button" data-remove="${html(item.id)}" title="Strika" aria-label="Strika ${actionLabel}">${icon("trash")}</button>
          </div>
        </div>`;
      }).join("") + (filtered.length > visibleLimit
        ? '<button class="button secondary small" type="button" data-more-transactions>Vís fleiri</button>' : "");
    }

    function updateFilter() {
      visibleLimit = pageSize;
      ctx.setTransactionFilter?.({ allMonths: filterScope.value === "all", search: search.value,
        categoryId: filterCategory.value === unclassified ? null : filterCategory.value,
        type: filterType.value, from: filterFrom.value, to: filterTo.value });
      renderList();
    }

    function fixedChoices(fixedMonth = month) {
      return (state.months[fixedMonth]?.budget?.allocations ?? [])
        .filter(line => line.kind === "fixed" && line.amountOre > 0 && !archivedIds.has(line.categoryId));
    }

    function alreadyRecorded(categoryId, fixedMonth = month) {
      return transactions.some(item => item.type === "expense" && item.categoryId === categoryId
        && item.date.startsWith(`${fixedMonth}-`));
    }

    function renderFixed() {
      const choices = fixedChoices();
      fixedList.innerHTML = choices.map(line => {
        const recorded = alreadyRecorded(line.categoryId);
        return `<button type="button" class="button secondary fixed-entry-row" data-add-fixed="${html(line.categoryId)}" ${recorded ? "disabled" : ""}>
          <span>${html(line.label)}${recorded ? "<small>Longu skrásett</small>" : ""}</span><strong>${html(money(line.amountOre))}</strong>
        </button>`;
      }).join("") || `<p>Ongar fastar útreiðslur við upphædd eru í ætlanini.</p>
        <button class="button secondary small" type="button" data-open-fixed-budget>Vís fíggjarætlan fyri ${html(monthLabel(month))}</button>`;
    }

    function setEntryMode(fixed) {
      inFixedMode = fixed;
      regularMode.setAttribute("aria-pressed", String(!fixed));
      fixedMode.setAttribute("aria-pressed", String(fixed));
      ctx.setEntryMode?.(fixed);
      if (!fixed) {
        fixedEntry.hidden = true;
        form.hidden = false;
        return;
      }
      const saved = drafts?.read("tx:fixed");
      if (typeof saved?.fixedCategoryId === "string" && typeof saved?.base?.month === "string"
        && saved.values && txFields.every(name => typeof saved.values[name] === "string")) {
        setFixedEditor(null, saved.values.date, saved);
      } else {
        selectedFixedId = null;
        form.hidden = true;
        fixedEntry.hidden = false;
        root.querySelector("#transaction-editor-title").textContent = "Fastar útreiðslur";
        renderFixed();
      }
    }

    regularMode.addEventListener("click", () => {
      if (!inFixedMode) return;
      setEntryMode(false);
      setEditor(null);
    });
    fixedMode.addEventListener("click", () => setEntryMode(true));
    fixedList.addEventListener("click", event => {
      if (event.target.closest("[data-open-fixed-budget]")) {
        navigate("budget", month);
        return;
      }
      const button = event.target.closest("[data-add-fixed]");
      if (!button || button.disabled) return;
      const line = fixedChoices().find(item => item.categoryId === button.dataset.addFixed);
      if (!line || alreadyRecorded(line.categoryId)) return;
      setFixedEditor(line, fixedDate);
      saveDraft();
      fields.amount.focus();
    });

    fields.type.addEventListener("change", updateCategoryVisibility);
    fields.date.addEventListener("change", () => updateCategoryOptions(selectedFixedId ?? fields.category.value));
    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    cancelButton.addEventListener("click", () => {
      drafts?.clear(draftKey);
      if (inFixedMode) setEntryMode(true);
      else setEditor(null, true);
    });
    form.querySelector("[data-reset-draft]").addEventListener("click", () => {
      drafts?.clear(draftKey);
      if (inFixedMode) setEntryMode(true);
      else setEditor(editingTransaction, true);
    });
    search.addEventListener("input", updateFilter);
    filterScope.addEventListener("change", () => { updateFilterCategories(); updateFilter(); });
    for (const field of [filterCategory, filterType, filterFrom, filterTo]) field.addEventListener("change", updateFilter);
    list.addEventListener("click", event => {
      if (event.target.closest("[data-more-transactions]")) {
        visibleLimit += pageSize;
        renderList();
        return;
      }
      const button = event.target.closest("button[data-edit], button[data-remove]");
      if (!button) return;
      const id = button.dataset.edit ?? button.dataset.remove;
      const transaction = transactionsById.get(id);
      if (!transaction) return;
      if (button.dataset.edit) {
        setEntryMode(false);
        setEditor(transaction, true);
      } else if (globalThis.confirm(`Strika skrásetingina „${transaction.description}“?`)) {
        commit({ ...state, transactions: state.transactions.filter(item => item.id !== id) },
          "Skrásetingin er strikað.", { undoTransaction: transaction, draftKey: `tx:${id}` });
      }
    });

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (staleDraft || form.hidden) return;
      setError(error, "");
      const amountOre = parseAmount(fields.amount.value);
      if (amountOre == null || amountOre <= 0) {
        setError(error, "Skriva eina upphædd størri enn 0, t.d. 125,50.");
        fields.amount.focus();
        return;
      }
      const description = fields.description.value.trim();
      if (!description) {
        setError(error, "Skriva eina stutta lýsing.");
        fields.description.focus();
        return;
      }
      const date = fields.date.value;
      if (!isDate(date)) {
        setError(error, "Vel eina gilda dagfesting.");
        fields.date.focus();
        return;
      }
      const type = fields.type.value;
      updateCategoryOptions();
      const categoryId = type === "income" || (!fields.category.value && canKeepUnclassified()) ? null : fields.category.value;
      if (type !== "income" && categoryId !== null && !entryNames.has(categoryId)) {
        setError(error, "Vel ein bólk til skrásetingina.");
        fields.category.focus();
        return;
      }
      const targetMonth = date.slice(0, 7);
      if (inFixedMode && (categoryId !== selectedFixedId
        || !fixedChoices(targetMonth).some(line => line.categoryId === categoryId))) {
        setError(error, "Hesin kostnaðurin er ikki í føstu útreiðslunum fyri valda mánaðin.");
        return;
      }
      if (inFixedMode && alreadyRecorded(categoryId, targetMonth)) {
        setError(error, "Hesin kostnaðurin er longu skrásettur henda mánaðin.");
        return;
      }
      const item = { id: editingId ?? newId(), date, description, categoryId, type, amountOre };
      const updated = editingId
        ? state.transactions.map(transaction => transaction.id === editingId ? item : transaction)
        : [...state.transactions, item];
      const next = withMonth({ ...state, transactions: updated }, targetMonth, {});
      const message = editingId ? "Broytingarnar eru goymdar." : "Skrásetingin er goymd.";
      const saved = commit(next, message, { draftKey, fixedCost: inFixedMode });
      if ((typeof saved === "boolean" ? saved : await saved) && targetMonth !== month && filterScope.value !== "all") {
        navigate("transactions", targetMonth, { showFixedCosts: inFixedMode });
      }
    });

    updateFilterCategories(initialFilter.categoryId);
    const openFixed = !transactionId && Boolean(ctx.showFixedCosts);
    setEntryMode(openFixed);
    if (!openFixed) setEditor(transactionsById.get(transactionId), false, transactionId);
    renderList();
  }

  function renderBudget(ctx) {
    const { root, state, month, commit, navigate, drafts } = ctx;
    const { today, monthLabel, money, parseAmount, newId, sourceForBudget, createBudget, shiftMonth, summarize, categoryLabel } = globalThis.BudgetCore;
    const { html, icon } = globalThis.BudgetUI;
    const current = monthRecord(state, month);
    const planKey = `plan:${month}`;
    const statusKey = `status:${month}`;
    const candidateDraft = drafts?.read(planKey);
    const planDraft = candidateDraft?.rows && budgetGroups.every(({ kind }) =>
      Array.isArray(candidateDraft.rows[kind]) && candidateDraft.rows[kind].length <= 300
      && candidateDraft.rows[kind].every(row => row && ["id", "label", "amount"].every(key => typeof row[key] === "string")))
      ? candidateDraft : null;
    const stalePlan = Boolean(planDraft && !sameSnapshot(planDraft.base, current.budget));
    const budget = current.budget ?? (planDraft ? { copiedFrom: null, income: [], allocations: [] } : null);
    const source = sourceForBudget(state, month);
    const previous = shiftMonth(month, -1);
    const nextMonth = shiftMonth(month, 1);
    const renameFrom = shiftMonth(today().slice(0, 7), 1);
    const nextBudget = nextMonth !== month ? state.months[nextMonth]?.budget : null;
    const summary = summarize(state, month);
    const txCount = state.transactions.filter(item => item.date.startsWith(`${month}-`)).length;

    function lineMarkup(kind, line = {}) {
      const group = budgetGroups.find(item => item.kind === kind);
      const id = kind === "income" ? line.id : line.categoryId;
      return `<div class="budget-line" data-budget-line data-line-id="${html(id ?? "")}">
        <input class="input budget-line-label" type="text" data-line-label value="${html(line.label ?? "")}" placeholder="${group.placeholder}" maxlength="60" aria-label="${kind === "income" ? "Heiti á inntøku" : "Heiti á bólki"}">
        <input class="input budget-line-amount" type="text" data-line-amount value="${inputAmount(line.amountOre)}" placeholder="0,00" inputmode="decimal" aria-label="Upphædd í krónum">
        <button class="button small quiet danger icon-button" type="button" data-remove-budget-line title="Tak linju burtur" aria-label="Tak linju burtur">${icon("trash")}</button>
      </div>`;
    }

    function groupMarkup(group) {
      const lines = group.kind === "income" ? budget.income : budget.allocations.filter(line => line.kind === group.kind);
      return `<section class="card budget-card">
        <div class="card-header section-heading"><div><h2>${group.title}</h2><p>${group.detail}</p></div></div>
        <div class="budget-line-list" data-budget-lines="${group.kind}">${lines.map(line => lineMarkup(group.kind, line)).join("")}</div>
        <div class="budget-section-actions">
          <button class="button secondary small" type="button" data-add-budget-line="${group.kind}">${icon("add")} ${group.add}</button>
          ${group.kind === "fixed" ? '<button class="button secondary small" type="button" data-open-fixed-entry>Skráset fastar útreiðslur</button>' : ""}
        </div>
      </section>`;
    }

    const budgetEditor = budget ? `
      <form class="budget-stack editor-form" data-budget-form>
        ${budget.copiedFrom ? `<p class="budget-copy-note">${icon("copy")} <span>Avritað frá ${html(monthLabel(budget.copiedFrom))}. Broytingar her galda bert henda mánaðin.</span></p>` : ""}
        ${budgetGroups.map(groupMarkup).join("")}
        <p class="form-error" role="alert" hidden></p>
        ${draftConflict()}
        <div class="form-actions"><button class="button primary" type="submit">${icon("check")} Goym fíggjarætlan</button></div>
      </form>` : `
      <section class="card budget-start">
        <div class="empty-state">
          ${icon("copy")}<h2>Ger eina fíggjarætlan</h2>
          <p>${source === previous ? `Tú kanst avrita ætlanina fyri ${html(monthLabel(source))}.` : source ? `Undanfarni mánaður hevur onga ætlan. Seinasta ætlanin er fyri ${html(monthLabel(source))}.` : "Legg inn væntaðar inntøkur og útreiðslur fyri henda mánaðin."}</p>
          <div class="form-actions">
            ${source ? `<button class="button primary" type="button" data-budget-create="copy">${icon("copy")} Avrita fíggjarætlan</button>` : ""}
            <button class="button ${source ? "secondary" : "primary"}" type="button" data-budget-create="blank">${icon("add")} Byrja við ongum</button>
          </div>
        </div>
      </section>`;

    const categoryRows = state.categories.slice().sort((a, b) =>
      Number(Boolean(a.archived)) - Number(Boolean(b.archived))
      || categoryCollator.compare(categoryLabel(a, renameFrom), categoryLabel(b, renameFrom)));

    root.innerHTML = `
      <div class="budget-layout">
        <div class="budget-stack">${budgetEditor}</div>
        <aside class="budget-stack budget-sidebar">
          <section class="card budget-summary" aria-labelledby="budget-summary-title">
            <div class="card-header section-heading"><div><h2 id="budget-summary-title">Ætlan í tølum</h2><p>${html(monthLabel(month))}</p></div></div>
            <dl>
              <div class="budget-summary-row"><dt>Væntað inntøka</dt><dd data-plan-total="income">${budget ? "" : "—"}</dd></div>
              <div class="budget-summary-row"><dt>Fastar útreiðslur</dt><dd data-plan-total="fixed">${budget ? "" : "—"}</dd></div>
              <div class="budget-summary-row"><dt>Broytiligar útreiðslur</dt><dd data-plan-total="variable">${budget ? "" : "—"}</dd></div>
              <div class="budget-summary-row budget-summary-final"><dt>Óbýtt upphædd</dt><dd data-plan-total="remaining">${budget ? "" : "—"}</dd></div>
            </dl>
          </section>
          <section class="card budget-status" aria-labelledby="budget-status-title">
            <div class="card-header section-heading"><div><h2 id="budget-status-title">Støða hjá mánaðinum</h2><p>Hagtøl fyri farnar mánaðir brúka lidnar mánaðir.</p></div></div>
            <form class="editor-form" data-status-form>
              <label class="field"><span>Støða</span><select class="input" name="status">
                ${statusLabels.map(([value, label]) => `<option value="${value}"${current.status === value ? " selected" : ""}>${label}</option>`).join("")}
              </select></label>
              <p class="form-error" role="alert" hidden></p>
              ${draftConflict()}
              <button class="button secondary small" type="submit">Goym støðu</button>
            </form>
            <div class="budget-section-actions">
              <button class="button secondary small" type="button" data-open-month-review>${current.status === "completed" ? "Fyrireika næsta mánað" : "Enda mánaðin"}</button>
              <button class="button secondary small" type="button" data-open-category-manager>Umsit bólkar</button>
            </div>
          </section>
        </aside>
      </div>
      <dialog class="app-dialog" data-month-review aria-labelledby="month-review-title">
        <div class="dialog-heading"><h2 id="month-review-title">${html(monthLabel(month))}</h2>
          <button class="icon-button" type="button" data-editor-dialog-close aria-label="Lat aftur">×</button></div>
        <dl class="month-review-summary">
          <div class="budget-summary-row"><dt>Skrásetingar</dt><dd>${txCount}</dd></div>
          <div class="budget-summary-row"><dt>Skrásett inntøka</dt><dd>${summary.hasRecordedIncome ? html(money(summary.recordedIncome)) : "—"}</dd></div>
          <div class="budget-summary-row"><dt>Skrásettar útreiðslur</dt><dd>${html(money(summary.spent))}</dd></div>
        </dl>
        ${txCount === 0 ? '<p>Ongar skrásetingar eru henda mánaðin.</p>' : ""}
        ${nextMonth === month ? "" : `<p>${nextBudget ? `Ætlanin fyri ${html(monthLabel(nextMonth))} er longu stovnað.`
          : current.budget ? `Vit avrita goymdu ætlanina til ${html(monthLabel(nextMonth))}.`
            : `Tú kanst stovna eina ætlan fyri ${html(monthLabel(nextMonth))}.`}</p>`}
        <div class="dialog-actions"><button class="button secondary" type="button" data-editor-dialog-close>Lat aftur</button>
          <button class="button primary" type="button" data-complete-month>${current.status === "completed" ? "Far til næsta mánað" : nextMonth === month ? "Merk sum lidnan" : "Merk sum lidnan og far víðari"}</button></div>
      </dialog>
      <dialog class="app-dialog" data-category-manager aria-labelledby="category-manager-title">
        <div class="dialog-heading"><h2 id="category-manager-title">Bólkar</h2>
          <button class="icon-button" type="button" data-editor-dialog-close aria-label="Lat aftur">×</button></div>
        <p>Nýggj heiti verða brúkt í komandi ætlanum frá ${html(monthLabel(renameFrom))}. Tú kanst taka ein bólk úr vallistanum og taka hann fram aftur.</p>
        <form class="editor-form" data-category-form>
          <div class="category-editor-list">
            ${categoryRows.length ? categoryRows.map(category => `<div class="category-editor-row" data-managed-category="${html(category.id)}">
              <label class="field"><span>${category.kind === "fixed" ? "Fastur kostnaður" : "Broytiligur kostnaður"}</span>
                <input class="input" type="text" data-managed-label value="${html(categoryLabel(category, renameFrom))}" required maxlength="60"></label>
              <button class="button secondary small" type="button" data-toggle-archive aria-pressed="${Boolean(category.archived)}">${category.archived ? "Tak fram" : "Tak úr vallista"}</button>
            </div>`).join("") : "<p>Legg ein bólk afturat í fíggjarætlanini fyrst.</p>"}
          </div>
          <p class="form-error" role="alert" hidden></p>
          <div class="dialog-actions"><button class="button secondary" type="button" data-editor-dialog-close>Lat aftur</button>
            <button class="button primary" type="submit" ${categoryRows.length ? "" : "disabled"}>Goym bólkar</button></div>
        </form>
      </dialog>`;

    for (const button of root.querySelectorAll("[data-budget-create]")) {
      button.addEventListener("click", () => {
        const copy = button.dataset.budgetCreate === "copy";
        const plan = createBudget(state, month, copy ? source : null);
        commit(withMonth(state, month, { budget: plan }), copy ? "Fíggjarætlanin er avritað." : "Fíggjarætlanin er stovnað.");
      });
    }

    let hasUnsavedBudget = Boolean(planDraft);
    const statusForm = root.querySelector("[data-status-form]");
    const statusError = statusForm.querySelector(".form-error");
    const statusDraft = drafts?.read(statusKey);
    const staleStatus = Boolean(statusDraft && statusDraft.base !== current.status);
    if (statusDraft && statusLabels.some(([value]) => value === statusDraft.status)) {
      statusForm.elements.status.value = statusDraft.status;
    }
    statusForm.querySelector("[data-draft-conflict]").hidden = !staleStatus;
    statusForm.querySelector('button[type="submit"]').disabled = staleStatus;
    statusForm.querySelector("[data-reset-draft]").addEventListener("click", () => {
      drafts?.clear(statusKey);
      navigate("budget", month);
    });
    statusForm.elements.status.addEventListener("change", () => {
      const status = statusForm.elements.status.value;
      if (!staleStatus && status === current.status) drafts?.clear(statusKey);
      else drafts?.write(statusKey, { base: statusDraft?.base ?? current.status, status });
    });
    statusForm.addEventListener("submit", event => {
      event.preventDefault();
      if (staleStatus) return;
      if (hasUnsavedBudget) {
        setError(statusError, "Goym broytingarnar í fíggjarætlanini fyrst.");
        return;
      }
      setError(statusError, "");
      const status = statusForm.elements.status.value;
      if (status === "completed" && current.status !== "completed"
        && !state.transactions.some(item => item.date.slice(0, 7) === month)
        && !globalThis.confirm("Ongar skrásetingar eru henda mánaðin. Merk hann kortini sum lidnan?")) return;
      commit(withMonth(state, month, { status }), "Støðan er goymd.", { draftKey: statusKey });
    });

    const monthReview = root.querySelector("[data-month-review]");
    const categoryManager = root.querySelector("[data-category-manager]");
    for (const dialog of [monthReview, categoryManager]) {
      for (const button of dialog.querySelectorAll("[data-editor-dialog-close]")) {
        button.addEventListener("click", () => dialog.close());
      }
    }
    root.querySelector("[data-open-fixed-entry]")?.addEventListener("click", () => {
      navigate("transactions", month, { showFixedCosts: true });
    });
    root.querySelector("[data-open-month-review]").addEventListener("click", () => {
      if (hasUnsavedBudget) {
        setError(statusError, "Goym broytingarnar í fíggjarætlanini fyrst.");
        return;
      }
      setError(statusError, "");
      monthReview.showModal();
    });
    let completingMonth = false;
    monthReview.querySelector("[data-complete-month]").addEventListener("click", async () => {
      if (completingMonth) return;
      const needsNext = nextMonth !== month && !nextBudget && current.budget;
      let next = withMonth(state, month, { status: "completed" });
      if (needsNext) next = withMonth(next, nextMonth, { budget: createBudget(state, nextMonth, month) });
      completingMonth = true;
      try {
        const saved = current.status === "completed" && !needsNext
          ? true : commit(next, "Mánaðurin er liðugur.", { draftKey: statusKey });
        if (typeof saved === "boolean" ? saved : await saved) {
          monthReview.close();
          if (nextMonth !== month) navigate("budget", nextMonth);
        }
      } finally { completingMonth = false; }
    });

    const categoryForm = categoryManager.querySelector("[data-category-form]");
    const categoryError = categoryForm.querySelector(".form-error");
    const managedRows = new Map(Array.from(categoryForm.querySelectorAll("[data-managed-category]"))
      .map(row => [row.dataset.managedCategory, row]));
    function setArchived(button, archived) {
      button.setAttribute("aria-pressed", String(archived));
      button.textContent = archived ? "Tak fram" : "Tak úr vallista";
    }
    root.querySelector("[data-open-category-manager]").addEventListener("click", () => {
      for (const category of categoryRows) {
        const row = managedRows.get(category.id);
        row.querySelector("[data-managed-label]").value = categoryLabel(category, renameFrom);
        setArchived(row.querySelector("[data-toggle-archive]"), Boolean(category.archived));
      }
      setError(categoryError, "");
      categoryManager.showModal();
    });
    for (const button of categoryForm.querySelectorAll("[data-toggle-archive]")) {
      button.addEventListener("click", () => setArchived(button, button.getAttribute("aria-pressed") !== "true"));
    }
    categoryForm.addEventListener("submit", async event => {
      event.preventDefault();
      setError(categoryError, "");
      const categories = [];
      const names = new Map();
      for (const category of state.categories) {
        const row = managedRows.get(category.id);
        const input = row.querySelector("[data-managed-label]");
        const label = input.value.trim().normalize("NFC");
        if (!label || label.length > 60) {
          setError(categoryError, "Gev hvørjum bólki eitt heiti við í mesta lagi 60 teknum.");
          input.focus();
          return;
        }
        const archived = row.querySelector("[data-toggle-archive]").getAttribute("aria-pressed") === "true";
        const originalLabel = categoryLabel(category, renameFrom);
        const changed = label !== originalLabel || archived !== Boolean(category.archived);
        const key = `${category.kind}:${label.toLocaleLowerCase("fo")}`;
        if (!archived && names.has(key) && (changed || names.get(key))) {
          setError(categoryError, "Gev virknum bólkum hvør sítt heiti.");
          input.focus();
          return;
        }
        if (!archived) names.set(key, changed);
        if (!changed) { categories.push(category); continue; }
        const updated = { ...category };
        if (archived) updated.archived = true;
        else delete updated.archived;
        if (label !== originalLabel) {
          const renames = (category.renames ?? []).filter(rename => rename.from !== renameFrom);
          if (categoryLabel({ ...category, renames }, renameFrom) !== label) renames.push({ from: renameFrom, label });
          if (renames.length > 120) {
            setError(categoryError, "Hesin bólkurin hevur ov nógv eldri heiti.");
            return;
          }
          if (renames.length) updated.renames = renames.sort((a, b) => a.from.localeCompare(b.from));
          else delete updated.renames;
        }
        categories.push(updated);
      }
      const saved = commit({ ...state, categories }, "Bólkarnir eru goymdir.");
      if (typeof saved === "boolean" ? saved : await saved) categoryManager.close();
    });

    const form = root.querySelector("[data-budget-form]");
    if (!form) return;
    const error = form.querySelector(".form-error");
    const rowsFor = kind => Array.from(form.querySelectorAll(`[data-budget-lines="${kind}"] [data-budget-line]`));
    form.querySelector("[data-draft-conflict]").hidden = !stalePlan;
    form.querySelector('button[type="submit"]').disabled = stalePlan;
    form.querySelector("[data-reset-draft]").addEventListener("click", () => {
      drafts?.clear(planKey);
      navigate("budget", month);
    });
    if (planDraft) {
      for (const { kind } of budgetGroups) {
        const list = form.querySelector(`[data-budget-lines="${kind}"]`);
        list.innerHTML = planDraft.rows[kind].map(() => lineMarkup(kind)).join("");
        rowsFor(kind).forEach((row, index) => {
          const draft = planDraft.rows[kind][index];
          row.setAttribute("data-line-id", draft.id);
          row.querySelector("[data-line-label]").value = draft.label;
          row.querySelector("[data-line-amount]").value = draft.amount;
        });
      }
    }

    function savePlanDraft() {
      if (!drafts) return;
      const rows = Object.fromEntries(budgetGroups.map(({ kind }) => [kind, rowsFor(kind).map(row => ({
        id: row.dataset.lineId, label: row.querySelector("[data-line-label]").value,
        amount: row.querySelector("[data-line-amount]").value
      }))]));
      drafts.write(planKey, { base: planDraft?.base ?? current.budget, rows });
    }

    function updateTotals() {
      const totals = {};
      for (const { kind } of budgetGroups) {
        totals[kind] = rowsFor(kind).reduce((sum, row) => {
          const amount = parseAmount(row.querySelector("[data-line-amount]").value);
          return sum + (amount ?? 0);
        }, 0);
      }
      totals.remaining = totals.income - totals.fixed - totals.variable;
      for (const [kind, value] of Object.entries(totals)) {
        const target = root.querySelector(`[data-plan-total="${kind}"]`);
        target.textContent = Number.isSafeInteger(value) ? money(value) : "—";
        target.classList.toggle("negative", value < 0);
      }
    }

    form.addEventListener("input", event => {
      hasUnsavedBudget = true;
      if (event.target.matches("[data-line-amount]")) updateTotals();
      savePlanDraft();
    });
    form.addEventListener("click", event => {
      const add = event.target.closest("button[data-add-budget-line]");
      const remove = event.target.closest("button[data-remove-budget-line]");
      if (add) {
        hasUnsavedBudget = true;
        const kind = add.dataset.addBudgetLine;
        const list = form.querySelector(`[data-budget-lines="${kind}"]`);
        list.insertAdjacentHTML("beforeend", lineMarkup(kind));
        list.lastElementChild.querySelector("[data-line-label]").focus();
        savePlanDraft();
      } else if (remove) {
        hasUnsavedBudget = true;
        const row = remove.closest("[data-budget-line]");
        const kind = row.parentElement.dataset.budgetLines;
        row.remove();
        form.querySelector(`[data-add-budget-line="${kind}"]`).focus();
        updateTotals();
        savePlanDraft();
      }
    });

    form.addEventListener("submit", event => {
      event.preventDefault();
      if (stalePlan) return;
      setError(error, "");
      const income = [];
      const allocations = [];
      const categories = [...state.categories];
      const allocatedIds = new Set();
      const allocationNames = new Set();
      let totalOre = 0;
      for (const { kind } of budgetGroups) {
        for (const row of rowsFor(kind)) {
          const labelField = row.querySelector("[data-line-label]");
          const amountField = row.querySelector("[data-line-amount]");
          const label = labelField.value.trim().normalize("NFC");
          const amountText = amountField.value.trim();
          if (!label && !amountText && !row.dataset.lineId) continue;
          if (!label) {
            setError(error, "Gev hvørjari linju eitt heiti.");
            labelField.focus();
            return;
          }
          const amountOre = parseAmount(amountText);
          if (amountOre == null) {
            setError(error, "Skriva eina upphædd, t.d. 125,50 ella 0.");
            amountField.focus();
            return;
          }
          totalOre += amountOre;
          if (!Number.isSafeInteger(totalOre)) {
            setError(error, "Samlaða upphæddin er ov stór.");
            amountField.focus();
            return;
          }
          if (kind === "income") {
            income.push({ id: row.dataset.lineId || newId(), label, amountOre });
            continue;
          }
          const nameKey = label.toLocaleLowerCase("fo");
          const previousLine = budget.allocations.find(line => line.kind === kind && line.label.normalize("NFC").toLocaleLowerCase("fo") === nameKey);
          const match = categories.find(category => !category.archived && category.kind === kind
            && categoryLabel(category, month).normalize("NFC").toLocaleLowerCase("fo") === nameKey);
          const categoryId = row.dataset.lineId || previousLine?.categoryId || match?.id || newId();
          const allocationKey = `${kind}:${nameKey}`;
          if (allocatedIds.has(categoryId) || allocationNames.has(allocationKey)) {
            setError(error, "Hvør bólkur kann bert vera eina ferð í fíggjarætlanini.");
            labelField.focus();
            return;
          }
          if (!categories.some(category => category.id === categoryId)) categories.push({ id: categoryId, label, kind });
          allocatedIds.add(categoryId);
          allocationNames.add(allocationKey);
          allocations.push({ categoryId, label, kind, amountOre });
        }
      }
      const next = withMonth({ ...state, categories }, month, { budget: { ...budget, income, allocations } });
      commit(next, "Fíggjarætlanin er goymd.", { draftKey: planKey });
    });
    updateTotals();
  }

  globalThis.BudgetEditors = { renderTransactions, renderBudget };
})();
