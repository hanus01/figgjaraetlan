(() => {
  'use strict';

  const core = globalThis.BudgetCore;
  const presetLengths = [3, 6, 12];
  const pageSize = 12;
  const detailPageSize = 20;
  const monthStatuses = { active: 'Virkin', skipped: 'Lopin um' };
  let selection = '3';
  let includeCurrent = false;
  let customRange;
  let monthPage = 0;
  let selectedCategory;
  let evidenceMonths;

  function activeMonth(state) {
    const current = core.today().slice(0, 7);
    return state.months[current]?.status === 'active' ? current : undefined;
  }

  function presetRange(state, length) {
    const current = core.today().slice(0, 7);
    const end = state.months[current]?.status === 'completed' || (includeCurrent && activeMonth(state))
      ? current : core.shiftMonth(current, -1);
    return { start: core.shiftMonth(end, 1 - length), end };
  }

  function monthCount(start, end) {
    const index = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5));
    return index(end) - index(start) + 1;
  }

  function rangeLabel({ start, end }) {
    return start === end ? core.monthLabel(start) : `${core.monthLabel(start)} – ${core.monthLabel(end)}`;
  }

  function resetCharts() {
    monthPage = 0;
    selectedCategory = undefined;
    evidenceMonths = undefined;
  }

  function renderControls(root, state, refresh) {
    root.innerHTML = `<div class="stats-controls"><label class="period-control">Tíðarskeið<select id="stats-period">
      ${presetLengths.map((length) => `<option value="${length}"${selection === String(length) ? ' selected' : ''}>Seinastu ${length} mánaðir</option>`).join('')}
      <option value="custom"${selection === 'custom' ? ' selected' : ''}>Vel tíðarskeið</option>
    </select></label>${activeMonth(state) ? `<label class="check-control"><input type="checkbox" id="stats-include-current" ${includeCurrent ? 'checked' : ''}> ${selection === 'custom' ? 'Tak henda mánaðin við, um hann er í tíðarskeiðinum' : 'Tak henda mánaðin við'}</label>` : ''}</div>`;
    root.querySelector('#stats-include-current')?.addEventListener('change', ({ target }) => {
      includeCurrent = target.checked;
      resetCharts();
      refresh();
    });
    root.querySelector('#stats-period').addEventListener('change', ({ target }) => {
      if (target.value === 'custom' && !customRange) customRange = presetRange(state, Number(selection));
      selection = target.value;
      resetCharts();
      refresh();
    });
  }

  function rangeForm(range) {
    const { html, icon } = globalThis.BudgetUI;
    function endpoint(key, label, value) {
      const months = Array.from({ length: 12 }, (_, index) => {
        const month = String(index + 1).padStart(2, '0');
        const name = core.monthLabel(`2000-${month}`).replace(/\s*2000$/, '');
        return `<option value="${month}"${value.slice(5) === month ? ' selected' : ''}>${html(name)}</option>`;
      }).join('');
      return `<fieldset class="range-endpoint"><legend>${label}</legend><div class="range-endpoint-fields">
        <label class="field"><span>Mánaður</span><select class="input" name="${key}Month">${months}</select></label>
        <label class="field"><span>Ár</span><input class="input" type="number" min="1" max="9999" step="1" inputmode="numeric" name="${key}Year" value="${Number(value.slice(0, 4))}" required></label>
      </div></fieldset>`;
    }
    return `<form class="stats-range card" id="stats-range-form" aria-labelledby="stats-range-title">
      <div class="section-heading"><div><h2 id="stats-range-title">Vel mánaðir</h2><p class="muted">Báðir valdu mánaðirnir eru við í tíðarskeiðinum.</p></div></div>
      <div class="stats-range-fields">${endpoint('start', 'Frá', range.start)}${endpoint('end', 'Til og við', range.end)}
        <button class="button primary" type="submit">${icon('calendar')} Vís hagtøl</button>
      </div>
      <p class="form-error" data-range-error role="alert" hidden></p>
    </form>`;
  }

  function collect(state, range, partialMonth) {
    const months = Object.keys(state.months).filter((key) => range.start <= key && key <= range.end).sort();
    const transactionsByMonth = new Map(months.filter((key) => key === partialMonth || state.months[key].status === 'completed').map((key) => [key, []]));
    for (const transaction of state.transactions) {
      transactionsByMonth.get(transaction.date.slice(0, 7))?.push(transaction);
    }
    const included = Array.from(transactionsByMonth, ([key, transactions]) => ({
      key,
      summary: core.summarize({ ...state, transactions }, key),
    }));
    const completed = included.filter(({ key }) => key !== partialMonth);
    const summaries = new Map(included.map(({ key, summary }) => [key, summary]));
    const categories = new Map();
    for (const [key, transactions] of transactionsByMonth) {
      const monthLabels = new Map(summaries.get(key).categories.map((entry) => [entry.categoryId, entry.label]));
      for (const transaction of transactions) {
        if (transaction.type === 'income') continue;
        const id = transaction.categoryId;
        if (!categories.has(id)) categories.set(id, { id, label: 'Óbólkað', spent: 0, transactions: [] });
        const category = categories.get(id);
        category.spent += transaction.type === 'refund' ? -transaction.amountOre : transaction.amountOre;
        category.transactions.push(transaction);
      }
      for (const [id, label] of monthLabels) {
        const category = categories.get(id);
        if (category) category.label = label;
      }
    }
    const categoryRows = Array.from(categories.values()).sort((a, b) => b.spent - a.spent || a.label.localeCompare(b.label, 'fo'));
    return { months, included, completed, summaries, categoryRows };
  }

  function chartMonths(state, range, trackedMonths) {
    if (monthCount(range.start, range.end) <= pageSize) {
      return Array.from({ length: monthCount(range.start, range.end) }, (_, index) => {
        const key = core.shiftMonth(range.start, index);
        return { key, status: state.months[key]?.status };
      });
    }
    const rows = [];
    let next = range.start;
    for (const key of trackedMonths) {
      if (next < key) rows.push({ gap: { start: next, end: core.shiftMonth(key, -1) } });
      rows.push({ key, status: state.months[key].status });
      next = key === range.end ? null : core.shiftMonth(key, 1);
    }
    if (next) rows.push({ gap: { start: next, end: range.end } });
    return rows;
  }

  function barPosition(value, minimum, maximum) {
    const span = maximum - minimum;
    const zero = -minimum / span * 100;
    const width = Math.abs(value) / span * 100;
    const start = Math.max(0, zero - (value < 0 ? width : 0));
    return { zero, width, start };
  }

  function renderMonthlyChart(section, rows, included, summaries, navigate, partialMonth, focus = false) {
    const { html, icon } = globalThis.BudgetUI;
    let minimum = 0;
    let maximum = 1;
    for (const { summary } of included) {
      minimum = Math.min(minimum, summary.spent);
      maximum = Math.max(maximum, summary.recordedIncome, summary.spent);
    }
    const pages = Math.ceil(rows.length / pageSize);
    monthPage = Math.min(monthPage, pages - 1);
    const end = rows.length - monthPage * pageSize;
    const visible = rows.slice(Math.max(0, end - pageSize), end);
    function bar(value, type) {
      const { zero, width, start } = barPosition(value, minimum, maximum);
      return `<span class="chart-track" style="--chart-zero:${zero}%"><span class="chart-bar ${type}" style="width:${width}%;margin-inline-start:${start}%"></span></span>`;
    }
    section.innerHTML = `
      <div class="section-heading"><div><p class="section-kicker">Mánað fyri mánað</p><h2 id="stats-monthly-title" tabindex="-1">Inntøkur og útreiðslur</h2></div></div>
      <p class="muted">Trýst á ein mánað við tølum fyri at síggja skrásetingarnar.</p>
      <div class="chart-legend"><span><i class="legend-dot income"></i> Inntøkur</span><span><i class="legend-dot expense"></i> Útreiðslur</span></div>
      <div class="chart-rows">${visible.map(({ key, status, gap }) => {
        const label = html(gap ? rangeLabel(gap) : core.monthLabel(key));
        const summary = summaries.get(key);
        if (!summary) {
          const gapText = gap && gap.start !== gap.end ? `${monthCount(gap.start, gap.end)} mánaðir uttan dátur` : 'Ongar dátur';
          return `<div class="chart-row gap"><span class="chart-label">${label}</span><span class="chart-tracks">${monthStatuses[status] ?? gapText}</span><span class="chart-value">—</span></div>`;
        }
        const income = summary.hasRecordedIncome ? html(core.money(summary.recordedIncome)) : '—';
        const expenses = html(core.money(summary.spent));
        const partial = key === partialMonth;
        return `<button type="button" class="chart-row" data-chart-month="${key}" aria-label="${label}${partial ? ' higartil' : ''}. Inntøkur ${income}. Útreiðslur ${expenses}. Vís skrásetingar.">
          <span class="chart-label">${label}${partial ? '<small class="chart-partial">Higartil</small>' : ''}</span>
          <span class="chart-tracks" aria-hidden="true">${bar(summary.recordedIncome, 'income')}${bar(summary.spent, 'expense')}</span>
          <span class="chart-value"><span>${income}</span><span>${expenses}</span></span>
        </button>`;
      }).join('')}</div>
      ${pages > 1 ? `<div class="stats-chart-controls" aria-label="Blaða í mánaðum">
        <button class="button secondary small" type="button" data-chart-page="older" ${monthPage + 1 === pages ? 'disabled' : ''}>${icon('chevron-left')} Eldri</button>
        <span class="stats-page-number">Síða ${monthPage + 1} av ${pages}</span>
        <button class="button secondary small" type="button" data-chart-page="newer" ${monthPage === 0 ? 'disabled' : ''}>Nýggjari ${icon('chevron-right')}</button>
      </div>` : ''}`;
    for (const button of section.querySelectorAll('[data-chart-month]')) {
      button.addEventListener('click', () => navigate('transactions', button.dataset.chartMonth, { focusView: true, scroll: true }));
    }
    for (const button of section.querySelectorAll('[data-chart-page]')) {
      button.addEventListener('click', () => {
        monthPage += button.dataset.chartPage === 'older' ? 1 : -1;
        renderMonthlyChart(section, rows, included, summaries, navigate, partialMonth, true);
      });
    }
    if (focus) section.querySelector('#stats-monthly-title').focus({ preventScroll: true });
  }

  function categoryChart(categories, partialMonth) {
    const { html, icon } = globalThis.BudgetUI;
    const maximum = categories.reduce((max, category) => Math.max(max, category.spent), 1);
    const minimum = categories.reduce((min, category) => Math.min(min, category.spent), 0);
    return `<section class="card category-stats-chart" aria-labelledby="stats-category-title">
      <div class="section-heading"><div><p class="section-kicker">${partialMonth ? 'Við hesum mánaðinum higartil' : 'Lidnir mánaðir'}</p><h2 id="stats-category-title">Nýtsla eftir bólki</h2></div></div>
      ${categories.length ? `<p class="muted">Útreiðslur eftir endurgjøld. Trýst á ein bólk fyri at síggja skrásetingarnar.</p>
        <div class="stats-category-list">${categories.map((category, index) => {
          const { zero, width, start } = barPosition(category.spent, minimum, maximum);
          return `<button class="stats-category-row${category.spent < 0 ? ' credit' : ''}" type="button" data-stats-category="${index}" aria-expanded="${selectedCategory === category.id}" aria-controls="stats-category-detail">
            <strong class="stats-category-label">${html(category.label)}</strong>
            <span class="stats-category-value">${html(core.money(category.spent))} ${icon('chevron-right')}</span>
            <span class="stats-category-track" style="--chart-zero:${zero}%" aria-hidden="true"><span class="stats-category-bar" style="width:${width}%;margin-inline-start:${start}%"></span></span>
          </button>`;
        }).join('')}</div>` : '<p class="empty-state">Ongar útreiðslur eru skrásettar í mánaðunum, ið telja við.</p>'}
      <div class="stats-detail" id="stats-category-detail" hidden></div>
    </section>`;
  }

  function insightsMarkup(insights, categoryRows, completedCount) {
    const { html, icon } = globalThis.BudgetUI;
    const empty = completedCount < 2
      ? 'Tað krevur fleiri lidnar mánaðir at samanbera broytingar.'
      : 'Ongar týðiligar broytingar ella frávik eru í dátunum fyri hetta tíðarskeiðið.';
    return `<section class="card stats-insights" aria-labelledby="stats-insights-title">
      <div class="section-heading"><div><p class="section-kicker">Úr tínum dátum</p><h2 id="stats-insights-title">Eygleiðingar</h2></div></div>
      ${insights.length ? `<div class="insight-list">${insights.map((insight) => {
        const category = categoryRows.findIndex(({ id }) => id === insight.categoryId);
        return `<article class="stats-insight"><h3>${html(insight.title)}</h3><p>${html(insight.detail)}</p>
          <details class="insight-evidence"><summary>Vís grundarlagið</summary><p>${html(insight.basis)}</p>
            <div class="insight-month-links">
              ${insight.months.map((key) => `<button type="button" class="button secondary small" data-insight-month="${html(key)}">${html(core.monthLabel(key, true))}</button>`).join('')}
              ${category < 0 ? '' : `<button type="button" class="button secondary small" data-insight-category="${category}" data-insight-months="${html(insight.months.join(','))}">${html(categoryRows[category].label)} ${icon('arrow-right')}</button>`}
            </div>
          </details>
        </article>`;
      }).join('')}</div>` : `<p class="empty-state">${empty}</p>`}
    </section>`;
  }

  function attachDrilldown(root, categories, navigate) {
    const { html, icon } = globalThis.BudgetUI;
    const panel = root.querySelector('#stats-category-detail');
    const buttons = Array.from(root.querySelectorAll('[data-stats-category]'));
    let transactions = [];
    let limit = detailPageSize;

    function renderDetail(focus = false) {
      const category = categories.find(({ id }) => id === selectedCategory);
      for (const [index, button] of buttons.entries()) {
        button.setAttribute('aria-expanded', String(categories[index] === category));
      }
      panel.hidden = !category;
      if (!category) {
        panel.replaceChildren();
        return;
      }
      panel.innerHTML = `
        <div class="stats-detail-heading"><h3 tabindex="-1">${html(category.label)}</h3><span>${transactions.length} skrásetingar</span></div>
        ${evidenceMonths ? '<p class="muted">Mánaðirnir í eygleiðingini. <button class="text-button" type="button" data-stats-show-all>Vís alt tíðarskeiðið</button></p>' : ''}
        <div class="stats-detail-list">${transactions.slice(0, limit).map((transaction, index) => {
          const [year, month, day] = transaction.date.split('-');
          const amount = `${transaction.type === 'refund' ? '+' : '−'}${core.money(transaction.amountOre)}`;
          return `<button class="stats-detail-row" type="button" data-stats-transaction="${index}">
            <span><strong>${html(transaction.description)}</strong><small>${Number(day)}.${Number(month)}.${year}${transaction.type === 'refund' ? ' · Endurgjald' : ''}</small></span>
            <span>${html(amount)} ${icon('chevron-right')}</span>
          </button>`;
        }).join('') || '<p class="empty-state">Ongar skrásetingar í hesum mánaðum.</p>'}</div>
        ${transactions.length > limit ? '<button class="button secondary small" type="button" data-stats-more>Vís fleiri</button>' : ''}`;
      for (const button of panel.querySelectorAll('[data-stats-transaction]')) {
        button.addEventListener('click', () => {
          const transaction = transactions[Number(button.dataset.statsTransaction)];
          navigate('transactions', transaction.date.slice(0, 7), { transactionId: transaction.id, focusView: true, scroll: true });
        });
      }
      panel.querySelector('[data-stats-more]')?.addEventListener('click', () => {
        const firstNew = limit;
        limit += detailPageSize;
        renderDetail();
        panel.querySelector(`[data-stats-transaction="${firstNew}"]`).focus();
      });
      panel.querySelector('[data-stats-show-all]')?.addEventListener('click', () => show(categories.indexOf(category), false, true));
      if (focus) panel.querySelector('h3').focus();
    }

    function show(index, toggle, focus, includedMonths) {
      const category = categories[index];
      const collapse = toggle && category.id === selectedCategory && !evidenceMonths;
      selectedCategory = collapse ? undefined : category.id;
      evidenceMonths = includedMonths;
      transactions = category.transactions
        .filter(({ date }) => !evidenceMonths || evidenceMonths.has(date.slice(0, 7)))
        .reverse().sort((a, b) => b.date.localeCompare(a.date));
      limit = detailPageSize;
      renderDetail(focus && selectedCategory !== undefined);
    }

    for (const [index, button] of buttons.entries()) button.addEventListener('click', () => show(index, true, true));
    for (const button of root.querySelectorAll('[data-insight-category]')) {
      button.addEventListener('click', () => show(Number(button.dataset.insightCategory), false, true, new Set(button.dataset.insightMonths.split(','))));
    }
    for (const button of root.querySelectorAll('[data-insight-month]')) {
      button.addEventListener('click', () => navigate('transactions', button.dataset.insightMonth, { focusView: true, scroll: true }));
    }
    const remembered = categories.findIndex(({ id }) => id === selectedCategory);
    if (remembered >= 0) show(remembered, false, false, evidenceMonths);
  }

  function render({ root, state, navigate, metric }) {
    const { html } = globalThis.BudgetUI;
    const range = selection === 'custom' ? customRange : presetRange(state, Number(selection));
    const count = monthCount(range.start, range.end);
    const active = activeMonth(state);
    const partialMonth = includeCurrent && active && range.start <= active && active <= range.end ? active : undefined;
    const { months, included, completed, summaries, categoryRows } = collect(state, range, partialMonth);
    const incomeComplete = included.length > 0 && included.every(({ summary }) => summary.hasRecordedIncome);
    const income = included.reduce((sum, { summary }) => sum + summary.recordedIncome, 0);
    const spent = included.reduce((sum, { summary }) => sum + summary.spent, 0);
    const completedSpent = completed.reduce((sum, { summary }) => sum + summary.spent, 0);
    const insights = globalThis.BudgetInsights.generate(completed, range);

    root.innerHTML = `<div class="stats-page">
      ${selection === 'custom' ? rangeForm(range) : ''}
      <p class="stats-coverage" tabindex="-1"><strong>${html(rangeLabel(range))}</strong> <span>${completed.length} av ${count} lidnir mánaðir${partialMonth ? ' · hesin mánaður higartil' : ''}</span></p>
      <div class="stats-top metrics-grid">
        ${metric('Skrásettar inntøkur', incomeComplete ? income : null)}
        ${metric('Skrásettar útreiðslur', included.length ? spent : null)}
        ${metric('Miðal útreiðslur', completed.length ? Math.round(completedSpent / completed.length) : null)}
        ${metric('Skrásettur munur', incomeComplete ? income - spent : null)}
      </div>
      ${insightsMarkup(insights, categoryRows, completed.length)}
      <section class="card stats-chart" aria-labelledby="stats-monthly-title"></section>
      ${categoryChart(categoryRows, partialMonth)}
      <p class="stats-footnote muted">${partialMonth ? 'Hesin mánaður telur við higartil. Miðaltøl og eygleiðingar brúka bert lidnar mánaðir.' : 'Einans lidnir mánaðir telja við.'} Eru inntøkur ikki skrásettar í einum mánaði, ið telur við, verða samlaða inntøkan og munurin víst sum ein strika.</p>
    </div>`;

    root.querySelector('#stats-range-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const fields = event.currentTarget.elements;
      const monthKey = (year, month) => `${String(Number(year)).padStart(4, '0')}-${month}`;
      const start = monthKey(fields.startYear.value, fields.startMonth.value);
      const end = monthKey(fields.endYear.value, fields.endMonth.value);
      if (!core.isMonth(start) || !core.isMonth(end) || start > end) {
        const error = root.querySelector('[data-range-error]');
        error.textContent = 'Vel tveir gildir mánaðir. Frá-mánaðurin kann ikki koma aftan á til-mánaðin.';
        error.hidden = false;
        return;
      }
      customRange = { start, end };
      resetCharts();
      render({ root, state, navigate, metric });
      root.querySelector('.stats-coverage').focus({ preventScroll: true });
    });
    renderMonthlyChart(root.querySelector('.stats-chart'), chartMonths(state, range, months), included, summaries, navigate, partialMonth);
    attachDrilldown(root, categoryRows, navigate);
  }

  globalThis.BudgetStats = { renderControls, render };
})();
