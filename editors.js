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

  function categoryNames(state, month) {
    const names = new Map(state.categories.map(category => [category.id, category.label]));
    for (const line of state.months[month]?.budget?.allocations ?? []) {
      names.set(line.categoryId, line.label);
    }
    return names;
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

  function renderTransactions(ctx) {
    const { root, state, month, commit, navigate, transactionId } = ctx;
    const { today, money, monthLabel, parseAmount, newId, isDate } = globalThis.BudgetCore;
    const { html, icon } = globalThis.BudgetUI;
    const names = categoryNames(state, month);
    const transactions = state.transactions
      .filter(transaction => transaction.date.slice(0, 7) === month)
      .reverse()
      .sort((a, b) => b.date.localeCompare(a.date));
    const filterNames = new Map(names);
    for (const transaction of transactions) {
      if (transaction.categoryId && !filterNames.has(transaction.categoryId)) filterNames.set(transaction.categoryId, "Óbólkað");
    }
    const categoryFilters = categoryOptions(filterNames, html);

    root.innerHTML = `
      <div class="editor-grid">
        <section class="card transaction-editor" aria-labelledby="transaction-editor-title">
          <div class="card-header section-heading editor-heading">
            <div><h2 id="transaction-editor-title">Nýggj skráseting</h2><p>Skráset eitt keyp, eina inntøku ella eitt endurgjald.</p></div>
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
            <div class="form-actions">
              <button class="button primary" type="submit">${icon("check")} <span data-save-label>Goym skráseting</span></button>
              <button class="button secondary" type="button" data-cancel-edit hidden>Lat vera</button>
            </div>
          </form>
        </section>
        <section class="card transaction-history" aria-labelledby="transaction-history-title">
          <div class="card-header section-heading editor-heading">
            <div><h2 id="transaction-history-title">Skrásetingar</h2><p>${html(monthLabel(month))}</p></div>
            <span class="transaction-count" aria-live="polite"></span>
          </div>
          <div class="filter-grid">
            <label class="field filter-search"><span>Leita</span><input class="input" type="search" data-search placeholder="Leita eftir lýsing"></label>
            <label class="field"><span>Bólkur</span><select class="input" data-filter-category><option value="">Allir bólkar</option>${categoryFilters}</select></label>
            <label class="field"><span>Dagur</span><input class="input" type="date" data-filter-date></label>
          </div>
          <div class="transaction-list" data-transaction-list></div>
        </section>
      </div>`;

    const form = root.querySelector("#transaction-form");
    const fields = form.elements;
    const categoryField = form.querySelector("[data-category-field]");
    const cancelButton = form.querySelector("[data-cancel-edit]");
    const error = form.querySelector(".form-error");
    const list = root.querySelector("[data-transaction-list]");
    const search = root.querySelector("[data-search]");
    const filterCategory = root.querySelector("[data-filter-category]");
    const filterDate = root.querySelector("[data-filter-date]");
    let editingId = null;
    let editingTransaction;
    let entryNames;

    function canKeepUnclassified() {
      return editingTransaction?.type !== "income" && editingTransaction?.categoryId === null;
    }

    function updateCategoryOptions(selected = fields.category.value) {
      const entryMonth = isDate(fields.date.value) ? fields.date.value.slice(0, 7) : month;
      entryNames = categoryNames(state, entryMonth);
      const previousId = editingTransaction?.categoryId;
      if (previousId && !entryNames.has(previousId)) {
        const previousNames = categoryNames(state, editingTransaction.date.slice(0, 7));
        entryNames.set(previousId, previousNames.get(previousId) ?? "Óbólkað");
      }
      fields.category.innerHTML = `<option value="">${canKeepUnclassified() ? "Óbólkað" : "Vel bólk"}</option>${categoryOptions(entryNames, html)}`;
      fields.category.value = selected;
    }

    function updateCategoryVisibility() {
      const isIncome = fields.type.value === "income";
      categoryField.hidden = isIncome;
      fields.category.disabled = isIncome;
      fields.category.required = !isIncome && !canKeepUnclassified();
    }

    function setEditor(transaction, focus = false) {
      editingId = transaction?.id ?? null;
      editingTransaction = transaction;
      fields.type.value = transaction?.type ?? "expense";
      fields.amount.value = inputAmount(transaction?.amountOre);
      fields.description.value = transaction?.description ?? "";
      fields.date.value = transaction?.date ?? today();
      updateCategoryOptions(transaction?.categoryId ?? "");
      root.querySelector("#transaction-editor-title").textContent = transaction ? "Broyt skráseting" : "Nýggj skráseting";
      form.querySelector("[data-save-label]").textContent = transaction ? "Goym broytingar" : "Goym skráseting";
      cancelButton.hidden = !transaction;
      setError(error, "");
      updateCategoryVisibility();
      if (focus) fields.amount.focus();
    }

    function renderList() {
      const term = search.value.trim().normalize("NFC").toLocaleLowerCase("fo");
      const filtered = transactions.filter(item =>
        item.description.normalize("NFC").toLocaleLowerCase("fo").includes(term)
        && (!filterCategory.value || item.categoryId === filterCategory.value)
        && (!filterDate.value || item.date === filterDate.value),
      );
      root.querySelector(".transaction-count").textContent = `${filtered.length} ${filtered.length === 1 ? "skráseting" : "skrásetingar"}`;
      if (!filtered.length) {
        list.innerHTML = `<div class="empty-state">${icon("receipt")}<p>${transactions.length ? "Ongin skráseting samsvarar við leitingina." : "Ongar skrásetingar henda mánaðin."}</p></div>`;
        return;
      }
      list.innerHTML = filtered.map(item => {
        const typeLabel = transactionTypes.find(([value]) => value === item.type)[1];
        const category = names.get(item.categoryId) ?? (item.type === "income" ? typeLabel : "Óbólkað");
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
      }).join("");
    }

    fields.type.addEventListener("change", updateCategoryVisibility);
    fields.date.addEventListener("change", () => updateCategoryOptions());
    cancelButton.addEventListener("click", () => setEditor(null, true));
    search.addEventListener("input", renderList);
    filterCategory.addEventListener("change", renderList);
    filterDate.addEventListener("change", renderList);
    list.addEventListener("click", event => {
      const button = event.target.closest("button[data-edit], button[data-remove]");
      if (!button) return;
      const id = button.dataset.edit ?? button.dataset.remove;
      const transaction = transactions.find(item => item.id === id);
      if (!transaction) return;
      if (button.dataset.edit) {
        setEditor(transaction, true);
      } else if (globalThis.confirm(`Strika skrásetingina „${transaction.description}“?`)) {
        commit({ ...state, transactions: state.transactions.filter(item => item.id !== id) }, "Skrásetingin er strikað.");
      }
    });

    form.addEventListener("submit", async event => {
      event.preventDefault();
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
      const item = { id: editingId ?? newId(), date, description, categoryId, type, amountOre };
      const updated = editingId
        ? state.transactions.map(transaction => transaction.id === editingId ? item : transaction)
        : [...state.transactions, item];
      const next = withMonth({ ...state, transactions: updated }, targetMonth, {});
      const message = editingId ? "Broytingarnar eru goymdar." : "Skrásetingin er goymd.";
      const saved = commit(next, message);
      if ((typeof saved === "boolean" ? saved : await saved) && targetMonth !== month) navigate("transactions", targetMonth);
    });

    setEditor(transactions.find(item => item.id === transactionId));
    renderList();
  }

  function renderBudget(ctx) {
    const { root, state, month, commit } = ctx;
    const { monthLabel, money, parseAmount, newId, sourceForBudget, createBudget, shiftMonth } = globalThis.BudgetCore;
    const { html, icon } = globalThis.BudgetUI;
    const current = monthRecord(state, month);
    const budget = current.budget;
    const source = sourceForBudget(state, month);
    const previous = shiftMonth(month, -1);

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
        <div class="budget-section-actions"><button class="button secondary small" type="button" data-add-budget-line="${group.kind}">${icon("add")} ${group.add}</button></div>
      </section>`;
    }

    const budgetEditor = budget ? `
      <form class="budget-stack editor-form" data-budget-form>
        ${budget.copiedFrom ? `<p class="budget-copy-note">${icon("copy")} <span>Avritað frá ${html(monthLabel(budget.copiedFrom))}. Broytingar her galda bert henda mánaðin.</span></p>` : ""}
        ${budgetGroups.map(groupMarkup).join("")}
        <p class="form-error" role="alert" hidden></p>
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
              <button class="button secondary small" type="submit">Goym støðu</button>
            </form>
          </section>
        </aside>
      </div>`;

    for (const button of root.querySelectorAll("[data-budget-create]")) {
      button.addEventListener("click", () => {
        const copy = button.dataset.budgetCreate === "copy";
        const plan = createBudget(state, month, copy ? source : null);
        commit(withMonth(state, month, { budget: plan }), copy ? "Fíggjarætlanin er avritað." : "Fíggjarætlanin er stovnað.");
      });
    }

    let hasUnsavedBudget = false;
    const statusForm = root.querySelector("[data-status-form]");
    const statusError = statusForm.querySelector(".form-error");
    statusForm.addEventListener("submit", event => {
      event.preventDefault();
      if (hasUnsavedBudget) {
        setError(statusError, "Goym broytingarnar í fíggjarætlanini fyrst.");
        return;
      }
      setError(statusError, "");
      const status = statusForm.elements.status.value;
      if (status === "completed" && current.status !== "completed"
        && !state.transactions.some(item => item.date.slice(0, 7) === month)
        && !globalThis.confirm("Ongar skrásetingar eru henda mánaðin. Merk hann kortini sum lidnan?")) return;
      commit(withMonth(state, month, { status }), "Støðan er goymd.");
    });

    const form = root.querySelector("[data-budget-form]");
    if (!form) return;
    const error = form.querySelector(".form-error");
    const rowsFor = kind => Array.from(form.querySelectorAll(`[data-budget-lines="${kind}"] [data-budget-line]`));

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
      } else if (remove) {
        hasUnsavedBudget = true;
        const row = remove.closest("[data-budget-line]");
        const kind = row.parentElement.dataset.budgetLines;
        row.remove();
        form.querySelector(`[data-add-budget-line="${kind}"]`).focus();
        updateTotals();
      }
    });

    form.addEventListener("submit", event => {
      event.preventDefault();
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
          const match = categories.find(category => category.kind === kind && category.label.normalize("NFC").toLocaleLowerCase("fo") === nameKey);
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
      commit(next, "Fíggjarætlanin er goymd.");
    });
    updateTotals();
  }

  globalThis.BudgetEditors = { renderTransactions, renderBudget };
})();
