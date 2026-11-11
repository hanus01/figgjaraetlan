(() => {
  'use strict';

  const core = globalThis.BudgetCore;
  const editors = globalThis.BudgetEditors;
  const stats = globalThis.BudgetStats;
  const syncEngine = globalThis.BudgetSync;
  const icons = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
    transactions: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8m-4-4h8"/>',
    budget: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM8 5V3m8 2V3M4 9h16m-12 4h3m-3 3h6"/>',
    stats: '<path d="M4 19h16M7 15v-4m5 4V6m5 9V9"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M13.5 6.5l4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
    'arrow-right': '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    'arrow-up': '<path d="M12 18V6m-5 5 5-5 5 5"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 4v4m8-4v4M4 11h16"/>',
    download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
    'chevron-left': '<path d="m14 6-6 6 6 6"/>',
    'chevron-right': '<path d="m10 6 6 6-6 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    receipt: '<path d="M5 3l3 2 4-2 4 2 3-2v18l-3-2-4 2-4-2-3 2V3zm4 6h6m-6 4h6"/>',
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ''}</svg>`;
  }

  function html(value) {
    const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (character) => escapes[character]);
  }

  globalThis.BudgetUI = { html, icon };

  const labels = {
    overview: ['Yvirlit', 'Sí, hvat tú hevur brúkt, og hvat er eftir í fíggjarætlanini.'],
    transactions: ['Skráset', 'Skráset keyp og inntøkur, og finn tað, tú hevur skrásett fyrr.'],
    budget: ['Fíggjarætlan', 'Legg eina ætlan fyri inntøkur og útreiðslur í mánaðinum.'],
    stats: ['Hagtøl', 'Samanber inntøkur og útreiðslur og sí broytingar yvir tíð.'],
  };
  const statuses = { active: 'Virkin', completed: 'Liðugur', skipped: 'Lopin um' };
  const storageKey = 'figgjaraetlan-ledger-v1';
  const get = (id) => document.getElementById(id);
  const view = get('view');
  const tabs = get('tabs');
  const monthDialog = get('month-dialog');
  const storageDialog = get('storage-dialog');
  let month = core.today().slice(0, 7);
  let tab = 'overview';
  let transactionId;
  let toastTimer;
  let backupToRestore;
  let restoreRead = 0;
  let storageAvailable = true;
  let storageReadError = false;
  let storedSnapshot = null;
  let ledger = syncEngine ? null : { mode: 'demo', state: core.seedState() };
  let cloud;
  let cloudStatus = { phase: 'checking', pending: 0 };
  let savingCloud = false;
  let editorDraft = false;
  let draftIsStale = false;

  function validLedger(candidate) {
    return candidate && ['demo', 'personal'].includes(candidate.mode) && core.validateState(candidate.state);
  }

  function loadLedger() {
    try {
      storedSnapshot = localStorage.getItem(storageKey);
      if (storedSnapshot !== null) {
        const parsed = JSON.parse(storedSnapshot);
        if (validLedger(parsed)) ledger = parsed;
        else storageReadError = true;
      }
    } catch (error) {
      if (error instanceof SyntaxError) storageReadError = true;
      else storageAvailable = false;
    }
    if (!storageAvailable) return;
    try {
      const probe = `${storageKey}-probe`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
    } catch {
      storageAvailable = false;
    }
  }

  function toast(message) {
    const notice = get('toast');
    notice.innerHTML = `${icon('info')}<span>${html(message)}</span>`;
    notice.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { notice.hidden = true; }, 4000);
  }

  function save(nextLedger, message, replace = false, expectedState = ledger?.state) {
    if (!validLedger(nextLedger)) {
      toast('Broytingin kundi ikki goymast. Kanna upplýsingarnar.');
      return false;
    }
    if (cloud) return saveToCloud(nextLedger.state, message, replace, expectedState);
    if (storageReadError && !replace) {
      toast('Lat Dátur upp og vel eitt trygdaravrit ella byrja av nýggjum.');
      return false;
    }
    if (storageAvailable) {
      try {
        if (localStorage.getItem(storageKey) !== storedSnapshot) {
          toast('Dáturnar eru broyttar í einum øðrum flipa. Les síðuna inn av nýggjum.');
          return false;
        }
        const snapshot = JSON.stringify(nextLedger);
        localStorage.setItem(storageKey, snapshot);
        storedSnapshot = snapshot;
      } catch {
        toast('Goymslan er full ella óvirkin. Broytingin varð ikki goymd.');
        return false;
      }
    }
    ledger = nextLedger;
    storageReadError = false;
    render();
    if (message) toast(message);
    return true;
  }

  async function saveToCloud(nextState, message, replace, expectedState) {
    if (savingCloud) return false;
    savingCloud = true;
    const controls = Array.from(document.querySelectorAll('#view input, #view select, #view textarea, #view button, #tabs button, #heading-actions button, #home, #open-storage'));
    const disabledStates = controls.map((control) => control.disabled);
    for (const control of controls) control.disabled = true;
    view.setAttribute('aria-busy', 'true');
    try {
      const result = await cloud.save(nextState, { expectedState, replace });
      if (!result.ok) {
        toast(result.message);
        return false;
      }
      if (ledger) render();
      toast(cloudStatus.pending ? 'Goymt á hesi eindini. Bíðar eftir samstilling.' : message);
      return true;
    } catch {
      toast('Broytingin kundi ikki goymast. Royn aftur.');
      return false;
    } finally {
      savingCloud = false;
      view.removeAttribute('aria-busy');
      for (const [index, control] of controls.entries()) control.disabled = disabledStates[index];
    }
  }

  function paintCloudStatus() {
    const { phase, pending, error, configured } = cloudStatus;
    const ready = Boolean(ledger);
    get('main').hidden = !ready;
    tabs.closest('nav').hidden = !ready;
    get('open-storage').hidden = !ready;
    get('cloud-gate').hidden = ready;
    if (!ready) {
      const signIn = new URLSearchParams(location.search).get('signIn');
      const gateMessage = error ?? (configured === false || signIn === 'setup'
        ? 'Samstillingin er ikki sett upp enn.'
        : phase === 'signed-out'
          ? (signIn === 'denied' ? 'Hesin GitHub-brúkarin hevur ikki atgongd. Rita inn við rætta brúkaranum.'
            : signIn === 'retry' ? 'Innritanin miseydnaðist. Royn aftur.' : 'Rita inn fyri at fáa atgongd til tín roknskap.')
          : phase === 'offline' ? 'Set teg á netið og rita inn fyri at gera appina klára.' : 'Kannar innritan…');
      get('cloud-gate-message').textContent = pending ? `${gateMessage} ${pending} skráseting(ar) bíða eftir samstilling.` : gateMessage;
      get('cloud-login').hidden = phase !== 'signed-out' || configured === false;
      get('cloud-gate-retry').hidden = phase === 'checking' || (phase === 'signed-out' && configured !== false);
      return;
    }
    const status = get('cloud-sync');
    status.hidden = false;
    status.dataset.phase = phase;
    const statusMessage = error ?? (phase === 'offline' ? 'Uttan netsamband.'
      : phase === 'pending' ? 'Skrásetingar verða samstillaðar.' : 'Samstillað.');
    const queueMessage = pending ? ` ${pending} ${pending === 1 ? 'skráseting bíðar' : 'skrásetingar bíða'}.` : '';
    const draftMessage = draftIsStale ? ' Nýggjar dátur eru tøkar. Broytingarnar í oyðublaðnum eru varðveittar her.' : '';
    const text = `${statusMessage}${queueMessage}${draftMessage}`;
    if (get('cloud-sync-message').textContent !== text) get('cloud-sync-message').textContent = text;
    get('cloud-reconnect').hidden = phase !== 'signed-out';
    get('cloud-sync-retry').hidden = phase !== 'error' && phase !== 'offline' && !pending;
    get('cloud-refresh-draft').hidden = !draftIsStale;
  }

  function updateCloud(next) {
    cloudStatus = next;
    if (!next.state) {
      ledger = null;
      view.replaceChildren();
      if (storageDialog.open) storageDialog.close();
    } else {
      const previous = ledger?.state;
      ledger = { mode: 'personal', state: next.state };
      if (previous !== next.state) {
        if (previous && (editorDraft || savingCloud)) draftIsStale = true;
        else render();
      }
    }
    paintCloudStatus();
    if (storageDialog.open) paintPendingEntries();
  }

  function navigate(nextTab, nextMonth = month, options = {}) {
    if (!ledger || savingCloud) return;
    if (!Object.hasOwn(labels, nextTab) || !core.isMonth(nextMonth)) return;
    tab = nextTab;
    month = nextMonth;
    transactionId = options.transactionId;
    render();
    if (options.focusTab) get(`tab-${tab}`).focus({ preventScroll: true });
    else if (options.focusView) view.focus({ preventScroll: true });
    if (options.scroll) window.scrollTo(0, 0);
  }

  function renderTabs() {
    for (const button of tabs.querySelectorAll('[role="tab"]')) {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    view.setAttribute('aria-labelledby', `tab-${tab}`);
  }

  function renderHeading() {
    const [title, description] = labels[tab];
    const monthStatus = ledger.state.months[month]?.status;
    get('page-eyebrow').innerHTML = tab === 'stats'
      ? 'YVIR TÍÐ'
      : `<span>${html(core.monthLabel(month))}</span>${monthStatus ? ` <span class="status-pill" data-status="${monthStatus}">${statuses[monthStatus]}</span>` : ''}`;
    get('page-title').textContent = title;
    get('page-subtitle').textContent = description;
    const actions = get('heading-actions');
    if (tab === 'stats') {
      stats.renderControls(actions, ledger.state, renderStats);
      return;
    }
    actions.innerHTML = `
      <div class="month-control" role="group" aria-label="Vel mánað">
        <button class="icon-button" type="button" id="previous-month" aria-label="Undanfarni mánaður" ${month === '0001-01' ? 'disabled' : ''}>${icon('chevron-left')}</button>
        <button class="month-display" type="button" id="open-month" aria-haspopup="dialog">${icon('calendar')}<span>${html(core.monthLabel(month))}</span></button>
        <button class="icon-button" type="button" id="next-month" aria-label="Næsti mánaður" ${month === '9999-12' ? 'disabled' : ''}>${icon('chevron-right')}</button>
      </div>
      ${tab === 'overview' ? `<button class="button primary" type="button" id="quick-add">${icon('add')} Skráset keyp</button>` : ''}`;
    for (const [id, offset] of [['previous-month', -1], ['next-month', 1]]) {
      get(id).addEventListener('click', () => {
        navigate(tab, core.shiftMonth(month, offset));
        (get(id).disabled ? get('open-month') : get(id)).focus({ preventScroll: true });
      });
    }
    get('open-month').addEventListener('click', () => {
      get('pick-year').value = month.slice(0, 4);
      get('pick-month').value = month.slice(5);
      monthDialog.showModal();
    });
    get('quick-add')?.addEventListener('click', () => navigate('transactions', month, { focusView: true, scroll: true }));
  }

  function amount(ore) {
    return html(core.money(ore));
  }

  function metric(label, value, tone = '') {
    return `<div class="metric-card card"><span>${html(label)}</span><strong class="${tone}">${value === null ? '—' : amount(value)}</strong></div>`;
  }

  function categoryRow(entry) {
    const { allowance, spent } = entry;
    const remaining = allowance === null ? null : allowance - spent;
    const over = remaining !== null && remaining < 0;
    const progress = allowance > 0 ? Math.max(0, Math.min(100, spent / allowance * 100)) : spent > 0 ? 100 : 0;
    const planText = allowance === null ? 'Ongin játtan' : `${amount(spent)} av ${amount(allowance)}`;
    const remainingText = allowance === null ? amount(spent) : `${amount(Math.abs(remaining))} ${over ? 'ov nógv' : 'eftir'}`;
    return `<div class="category-row${over ? ' over' : ''}${allowance === null ? ' unplanned' : ''}">
      <div class="category-line"><strong class="category-name">${html(entry.label)}</strong><span class="category-amount">${remainingText}</span></div>
      ${allowance === null ? '' : `<div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${progress}%"></div></div>`}
      <p class="category-meta">${planText}${entry.kind === 'fixed' ? ' · Føst útreiðsla' : ''}</p>
    </div>`;
  }

  function activityRow(transaction, category) {
    const incoming = transaction.type !== 'expense';
    const detail = transaction.type === 'income' ? 'Inntøka' : category ?? 'Óflokkað';
    return `<button type="button" class="activity-row" data-edit="${html(transaction.id)}">
      <span class="activity-mark${incoming ? ' incoming' : ''}">${icon(incoming ? 'arrow-up' : 'receipt')}</span>
      <span class="activity-copy"><strong>${html(transaction.description)}</strong><span>${html(transaction.date.slice(8).replace(/^0/, ''))}. ${html(core.monthLabel(month, true))} · ${html(detail)}</span></span>
      <strong class="activity-amount${incoming ? ' positive' : ''}">${incoming ? '+' : '−'}${amount(transaction.amountOre)}</strong>
    </button>`;
  }

  function renderOverview() {
    const state = ledger.state;
    const summary = core.summarize(state, month);
    const budget = state.months[month]?.budget;
    const balance = summary.plannedExpenses - summary.spent;
    const recent = state.transactions.filter((entry) => entry.date.startsWith(month)).reverse().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    const categories = new Map(state.categories.map((entry) => [entry.id, entry.label]));
    for (const line of budget?.allocations ?? []) categories.set(line.categoryId, line.label);
    const rows = summary.categories.filter((entry) => entry.allowance !== null || entry.spent !== 0);
    view.innerHTML = `
      <div class="overview-top">
        <section class="hero-card${balance < 0 && budget ? ' negative' : ''}" aria-label="Støðan í mánaðinum">
          <div class="hero-copy">
            <p class="hero-label">${budget && balance < 0 ? 'Meira brúkt enn ætlað' : 'Eftir í fíggjarætlanini'}</p>
            <strong class="hero-amount">${budget ? amount(Math.abs(balance)) : '—'}</strong>
            <p class="hero-caption">${budget ? `${amount(summary.spent)} brúkt av ${amount(summary.plannedExpenses)} ætlaðum` : 'Ongin fíggjarætlan er stovnað fyri henda mánaðin.'}</p>
            ${budget ? '' : '<button type="button" class="button secondary small" data-go="budget">Stovna fíggjarætlan</button>'}
          </div>
          <div class="hero-detail">
            <div class="hero-detail-row"><span>Óbýtt í ætlanini</span><strong>${budget ? amount(summary.unallocated) : '—'}</strong></div>
            <div class="hero-detail-row"><span>Skrásettur munur</span><strong>${summary.hasRecordedIncome ? amount(summary.surplus) : '—'}</strong></div>
          </div>
        </section>
        <div class="metrics-grid">
          ${metric('Væntaðar inntøkur', budget ? summary.plannedIncome : null)}
          ${metric('Fastar útreiðslur í ætlanini', budget ? summary.plannedFixed : null)}
          ${metric('Skiftandi útreiðslur í ætlanini', budget ? summary.plannedVariable : null)}
          ${metric('Skrásettar útreiðslur', summary.spent)}
        </div>
      </div>
      <div class="overview-bottom">
        <section class="card category-card">
          <div class="section-heading"><div><p class="section-kicker">Fíggjarætlanin</p><h2>Útreiðslur eftir bólki</h2></div><button type="button" class="text-button" data-go="budget">Vís ætlan ${icon('arrow-right')}</button></div>
          <div class="category-list">${rows.length ? rows.map(categoryRow).join('') : '<p class="empty-state">Her síggjast bólkarnir, tá ið tú hevur stovnað eina ætlan ella skrásett eitt keyp.</p>'}</div>
        </section>
        <section class="card activity-card">
          <div class="section-heading"><div><p class="section-kicker">Hesin mánaður</p><h2>Seinast skrásett</h2></div></div>
          <div class="activity-list">${recent.length ? recent.map((entry) => activityRow(entry, categories.get(entry.categoryId))).join('') : '<p class="empty-state">Einki er skrásett henda mánaðin enn.</p>'}</div>
          <button type="button" class="text-button" data-go="transactions">Sí allar skrásetingar ${icon('arrow-right')}</button>
        </section>
      </div>`;
    for (const button of view.querySelectorAll('[data-go]')) {
      button.addEventListener('click', () => navigate(button.dataset.go, month, { focusView: true, scroll: true }));
    }
    for (const button of view.querySelectorAll('[data-edit]')) {
      button.addEventListener('click', () => navigate('transactions', month, { transactionId: button.dataset.edit, focusView: true, scroll: true }));
    }
  }

  function renderStats() {
    stats.render({ root: view, state: ledger.state, navigate, metric });
  }

  function render() {
    editorDraft = false;
    draftIsStale = false;
    renderTabs();
    renderHeading();
    const notice = get('storage-notice');
    notice.hidden = storageAvailable && !storageReadError;
    notice.textContent = storageReadError
      ? 'Goymdu dáturnar kundu ikki lesast. Lat Dátur upp fyri at seta eitt trygdaravrit inn.'
      : 'Kagin kann ikki goyma broytingar her. Tak eitt trygdaravrit niður, áðrenn tú letur síðuna aftur.';
    get('open-storage').innerHTML = `${icon('info')} <span>${ledger.mode === 'demo' ? 'Royndardátur' : 'Dátur'}</span>`;
    get('open-storage').setAttribute('aria-label', ledger.mode === 'demo' ? 'Royndardátur og trygdaravrit' : 'Dátur og trygdaravrit');
    view.replaceChildren();
    const currentState = ledger.state;
    const context = {
      root: view,
      state: currentState,
      month,
      transactionId,
      commit: (state, message) => ledger ? save({ ...ledger, state }, message, false, currentState) : false,
      toast,
      navigate,
    };
    transactionId = undefined;
    if (tab === 'overview') renderOverview();
    else if (tab === 'stats') renderStats();
    else if (tab === 'transactions') editors.renderTransactions(context);
    else editors.renderBudget(context);
    if (cloud) paintCloudStatus();
  }

  function clearRestoreSelection() {
    restoreRead += 1;
    backupToRestore = undefined;
    get('backup-file').value = '';
    get('restore-notice').hidden = true;
    get('restore-backup').hidden = true;
  }

  function openStorage() {
    if (!ledger) return;
    clearRestoreSelection();
    get('storage-description').textContent = cloud ? 'Dátur verða samstillaðar á tínum eindum. Tekur tú trygdaravrit, kanst tú eisini taka skrásetingar, ið bíða, niður fyri seg.' : ledger.mode === 'demo'
      ? 'Tú ert í eini royndarútgávu við dømisdátum. Broytingarnar verða goymdar í hesum kaganum, um goymsla er tøk.'
      : 'Dátur verða goymdar í hesum kaganum, um goymsla er tøk.';
    get('switch-ledger').textContent = ledger.mode === 'demo' ? 'Byrja við tómum roknskapi' : 'Skift til royndardátur';
    get('switch-ledger').hidden = Boolean(cloud);
    get('cloud-logout').hidden = !cloud;
    paintPendingEntries();
    storageDialog.showModal();
  }

  function downloadFile(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadJson(data, filename) {
    downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
  }

  function paintPendingEntries() {
    const panel = get('cloud-pending-entries');
    const entries = cloudStatus.pendingTransactions ?? [];
    panel.hidden = !entries.length;
    if (!entries.length) {
      panel.replaceChildren();
      return;
    }
    panel.innerHTML = `<h3>Skrásetingar, ið bíða</h3>
      <button type="button" class="text-button" data-download-pending>Tak bíðandi skrásetingar niður</button>
      ${entries.filter(({ error }) => error).map(({ operationId, transaction, error }) => `<div class="cloud-pending-problem">
        <strong>${html(transaction.description)} · ${html(core.money(transaction.amountOre))}</strong><p class="muted">${html(error)}</p>
        <button class="text-button" type="button" data-discard-pending="${html(operationId)}">Tak úr bíðirøð</button>
      </div>`).join('')}`;
    panel.querySelector('[data-download-pending]').addEventListener('click', () => {
      downloadJson({ version: 1, transactions: entries.map(({ transaction }) => transaction) }, `figgjaraetlan-bidandi-${core.today()}.json`);
    });
    for (const button of panel.querySelectorAll('[data-discard-pending]')) {
      button.addEventListener('click', async () => {
        if (!window.confirm('Tak fyrst eitt avrit niður. Vilt tú taka hesa skrásetingina úr bíðirøðini?')) return;
        const result = await cloud.discardPending(button.dataset.discardPending);
        if (!result.ok) toast(result.message);
      });
    }
  }

  tabs.innerHTML = Object.entries(labels).map(([key, [label]]) => `<button type="button" class="nav-tab" id="tab-${key}" data-tab="${key}" role="tab" aria-controls="view">${icon(key)}<span>${label}</span></button>`).join('');
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) navigate(button.dataset.tab, month, { scroll: true });
  });
  tabs.addEventListener('keydown', (event) => {
    const keys = Object.keys(labels);
    const index = keys.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight') next = keys[(index + 1) % keys.length];
    if (event.key === 'ArrowLeft') next = keys[(index + keys.length - 1) % keys.length];
    if (event.key === 'Home') next = keys[0];
    if (event.key === 'End') next = keys[keys.length - 1];
    if (next) {
      event.preventDefault();
      navigate(next, month, { focusTab: true });
    }
  });
  get('home').addEventListener('click', () => navigate('overview', core.today().slice(0, 7), { scroll: true }));
  get('pick-month').innerHTML = Array.from({ length: 12 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return `<option value="${number}">${html(core.monthLabel(`2000-${number}`).replace(/\s*2000$/, ''))}</option>`;
  }).join('');
  get('month-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const nextMonth = `${String(get('pick-year').valueAsNumber).padStart(4, '0')}-${get('pick-month').value}`;
    if (!core.isMonth(nextMonth)) return;
    monthDialog.close();
    navigate(tab, nextMonth);
    get('open-month').focus({ preventScroll: true });
  });
  get('go-current-month').addEventListener('click', () => {
    monthDialog.close();
    navigate(tab, core.today().slice(0, 7));
    get('open-month').focus({ preventScroll: true });
  });
  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  get('open-storage').addEventListener('click', openStorage);
  get('footer-storage').addEventListener('click', openStorage);
  get('download-backup').addEventListener('click', () => {
    if (ledger) downloadJson({ ...ledger, exportedAt: new Date().toISOString() }, `figgjaraetlan-${core.today()}.json`);
  });
  get('download-transactions-csv').addEventListener('click', () => {
    if (!ledger) return;
    const content = globalThis.BudgetCSV.transactions(ledger.state, {
      pendingEntries: cloudStatus.pendingTransactions ?? [],
      synced: Boolean(cloud),
    });
    downloadFile(content, `figgjaraetlan-transactions-${core.today()}.csv`, 'text/csv;charset=utf-8');
  });
  get('download-budgets-csv').addEventListener('click', () => {
    if (!ledger) return;
    downloadFile(globalThis.BudgetCSV.budgets(ledger.state), `figgjaraetlan-budgets-${core.today()}.csv`, 'text/csv;charset=utf-8');
  });
  get('choose-backup').addEventListener('click', () => get('backup-file').click());
  get('backup-file').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    clearRestoreSelection();
    const read = restoreRead;
    const notice = get('restore-notice');
    try {
      const parsed = JSON.parse(await file.text());
      if (read !== restoreRead) return;
      if (!validLedger(parsed)) throw new Error('Invalid backup');
      backupToRestore = { mode: parsed.mode, state: parsed.state };
      notice.textContent = `${parsed.state.transactions.length} skrásetingar í avritinum. Vel knøttin niðanfyri fyri at skifta verandi dátur út.`;
      get('restore-backup').hidden = false;
    } catch {
      if (read !== restoreRead) return;
      notice.textContent = 'Fílan er ikki eitt gilt trygdaravrit fyri Fíggjarætlan.';
    }
    notice.hidden = false;
  });
  storageDialog.addEventListener('close', clearRestoreSelection);
  get('restore-backup').addEventListener('click', async () => {
    if (backupToRestore && await save(backupToRestore, 'Trygdaravritið er sett inn.', true)) storageDialog.close();
  });
  get('switch-ledger').addEventListener('click', () => {
    if (!window.confirm('Verandi dátur verða skiftar út. Vilt tú halda fram?')) return;
    const sample = core.seedState();
    const next = ledger.mode === 'demo'
      ? { mode: 'personal', state: { ...sample, months: {}, transactions: [] } }
      : { mode: 'demo', state: sample };
    if (save(next, 'Dáturnar eru skiftar út.', true)) storageDialog.close();
  });

  if (syncEngine) {
    cloud = syncEngine.create({ onChange: updateCloud });
    for (const id of ['cloud-gate-retry', 'cloud-sync-retry']) {
      get(id).addEventListener('click', () => void cloud.retry());
    }
    get('cloud-refresh-draft').addEventListener('click', () => {
      if (window.confirm('Ógoymdar broytingar í oyðublaðnum hvørva. Vilt tú vísa nýggjastu dáturnar?')) render();
    });
    get('cloud-logout').addEventListener('click', async () => {
      const result = await cloud.signOut();
      if (!result.ok) toast(result.message);
    });
    function trackDraft(event) {
      if (event.target.closest('#transaction-form, [data-budget-form], [data-status-form]')) editorDraft = true;
    }
    view.addEventListener('input', trackDraft);
    view.addEventListener('change', trackDraft);
    view.addEventListener('click', (event) => {
      if (event.target.closest('[data-add-budget-line], [data-remove-budget-line]')) editorDraft = true;
    });
    paintCloudStatus();
    void cloud.start();
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
        toast('Appin fekk ikki gjørt seg klára at lata upp uttan netsamband.');
      });
    }
  } else {
    loadLedger();
    render();
  }
})();
