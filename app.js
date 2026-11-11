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
  const draftStore = globalThis.BudgetDraftStore.create(`${storageKey}-drafts`);
  const get = (id) => document.getElementById(id);
  const view = get('view');
  const tabs = get('tabs');
  const monthDialog = get('month-dialog');
  const storageDialog = get('storage-dialog');
  let month = core.today().slice(0, 7);
  let tab = 'overview';
  let transactionId;
  let transactionFilter;
  let showFixedCosts = false;
  let toastTimer;
  let lastDeletion;
  let draftToResume;
  let draftStorageUnavailable = false;
  const visibleDraftKeys = new Set();
  let backupToRestore;
  let backupPreviewState;
  let safetyCopyState;
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

  function draftScope() {
    if (!ledger) return null;
    if (cloud) return cloudStatus.ownerId ? `owner:${cloudStatus.ownerId}` : null;
    return `file:${ledger.mode}`;
  }

  function paintDraftNotice() {
    const notice = get('draft-notice');
    const scope = draftScope();
    draftToResume = draftStore.entries(scope).find(([key, { meta }]) => !visibleDraftKeys.has(key)
      && ['transactions', 'budget'].includes(meta.tab) && core.isMonth(meta.month));
    notice.hidden = !draftToResume && !draftStorageUnavailable;
    const [key, record] = draftToResume ?? [];
    const missing = record?.meta.transactionId && !ledger?.state.transactions.some(({ id }) => id === record.meta.transactionId);
    get('draft-message').textContent = draftStorageUnavailable
      ? 'Kagin kann ikki varðveita kladdur, tá ið appin verður latin aftur.'
      : missing ? 'Ein kladda er eftir fyri eina skráseting, sum er strikað.'
        : record ? `Ógoymd kladda · ${record.meta.tab === 'budget' ? 'Fíggjarætlan' : 'Skráseting'} · ${core.monthLabel(record.meta.month)}` : '';
    get('resume-draft').hidden = !key || Boolean(missing);
    get('discard-draft').hidden = !key;
  }

  function editorDrafts(scope, targetTab, targetMonth) {
    function markVisible(key) {
      if (key.startsWith('tx:')) {
        for (const current of visibleDraftKeys) if (current.startsWith('tx:')) visibleDraftKeys.delete(current);
      }
      visibleDraftKeys.add(key);
    }
    return {
      read(key) {
        markVisible(key);
        const data = draftStore.read(scope, key);
        if (data !== undefined) editorDraft = true;
        return data;
      },
      write(key, data, meta = {}) {
        if (scope !== draftScope()) return;
        markVisible(key);
        editorDraft = true;
        const id = key.startsWith('tx:edit:') ? key.slice(8)
          : key.startsWith('tx:') && !['tx:new', 'tx:fixed'].includes(key) ? key.slice(3) : undefined;
        draftStorageUnavailable = !draftStore.write(scope, key, data, {
          tab: targetTab,
          month: core.isMonth(meta.month) ? meta.month : targetMonth,
          transactionId: meta.transactionId ?? id,
          showFixedCosts: key === 'tx:fixed' || Boolean(meta.showFixedCosts),
        });
        paintDraftNotice();
      },
      clear(key) {
        if (scope !== draftScope()) return;
        draftStore.discard(scope, key);
        visibleDraftKeys.delete(key);
        paintDraftNotice();
      },
    };
  }

  function toast(message, undo = false) {
    const notice = get('toast');
    notice.innerHTML = `${icon('info')}<span>${html(message)}</span>${undo ? ' <button class="text-button" type="button" id="undo-delete">Angra</button>' : ''}`;
    if (undo) get('undo-delete').addEventListener('click', () => void undoDeletion());
    notice.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { notice.hidden = true; }, undo ? 16000 : 4000);
  }

  function save(nextLedger, message, replace = false, expectedState = ledger?.state, options = {}) {
    if (!validLedger(nextLedger)) {
      toast('Broytingin kundi ikki goymast. Kanna upplýsingarnar.');
      return false;
    }
    const scope = draftScope();
    function committed(result) {
      if (options.draftKey) draftStore.discard(scope, options.draftKey);
      if (replace) lastDeletion = undefined;
      if (!options.undoTransaction || (cloud && !result?.operationId)) return false;
      lastDeletion = { scope, transaction: options.undoTransaction, operationId: result?.operationId };
      return true;
    }
    if (cloud) return runCloudMutation(() => cloud.save(nextLedger.state, {
      expectedState, replace, fixedCost: options.fixedCost === true,
    }), message, committed);
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
    const undo = committed();
    ledger = nextLedger;
    storageReadError = false;
    render();
    if (message) toast(message, undo);
    return true;
  }

  async function undoDeletion() {
    if (!lastDeletion || savingCloud || !ledger || lastDeletion.scope !== draftScope()) return;
    const deletion = lastDeletion;
    const { transaction, operationId } = deletion;
    if (cloud) {
      await runCloudMutation(() => cloud.undoDelete(operationId), 'Skrásetingin er sett inn aftur.', () => {
        if (lastDeletion === deletion) lastDeletion = undefined;
      }, true);
      return;
    }
    if (ledger.state.transactions.some(({ id }) => id === transaction.id)) {
      toast('Skrásetingin er longu í roknskapinum.');
      return;
    }
    if (save({ ...ledger, state: { ...ledger.state, transactions: [...ledger.state.transactions, transaction] } }, 'Skrásetingin er sett inn aftur.')) lastDeletion = undefined;
  }

  async function runCloudMutation(action, message, committed, retryUndo = false) {
    if (savingCloud) return false;
    savingCloud = true;
    const controls = Array.from(document.querySelectorAll('#view input, #view select, #view textarea, #view button, #tabs button, #heading-actions button, #home, #open-storage, #undo-delete, #restore-backup'));
    const disabledStates = controls.map((control) => control.disabled);
    for (const control of controls) control.disabled = true;
    view.setAttribute('aria-busy', 'true');
    try {
      const result = await action();
      if (!result.ok) {
        toast(result.message, retryUndo && lastDeletion?.scope === draftScope());
        return false;
      }
      const undo = committed?.(result) ?? false;
      if (ledger) render();
      if (message) toast(cloudStatus.pending ? 'Goymt á hesi eindini. Bíðar eftir samstilling.' : message, undo);
      return true;
    } catch {
      toast('Broytingin kundi ikki goymast. Royn aftur.', retryUndo && lastDeletion?.scope === draftScope());
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
    get('cloud-review-pending').hidden = !(cloudStatus.pendingTransactions ?? []).some(({ error }) => error);
  }

  function updateCloud(next) {
    const ownerChanged = Boolean(ledger && cloudStatus.ownerId && cloudStatus.ownerId !== next.ownerId);
    cloudStatus = next;
    if (ownerChanged) {
      visibleDraftKeys.clear();
      transactionId = undefined;
      transactionFilter = undefined;
      showFixedCosts = false;
      tab = 'overview';
      month = core.today().slice(0, 7);
      lastDeletion = undefined;
      draftStorageUnavailable = false;
      clearRestoreSelection();
      if (storageDialog.open) storageDialog.close();
      get('toast').hidden = true;
    }
    if (!next.state) {
      ledger = null;
      view.replaceChildren();
      visibleDraftKeys.clear();
      paintDraftNotice();
      if (storageDialog.open) storageDialog.close();
    } else {
      const previous = ledger?.state;
      ledger = { mode: 'personal', state: next.state };
      if (ownerChanged) render();
      else if (previous !== next.state) {
        if (previous && (editorDraft || savingCloud || view.querySelector('[data-category-manager]')?.open)) draftIsStale = true;
        else render();
      }
    }
    paintCloudStatus();
    if (storageDialog.open) paintPendingEntries();
  }

  function navigate(nextTab, nextMonth = month, options = {}) {
    if (!ledger || savingCloud) return;
    if (!Object.hasOwn(labels, nextTab) || !core.isMonth(nextMonth)) return;
    if (nextTab === 'transactions') {
      if (Object.hasOwn(options, 'transactionFilter')) transactionFilter = options.transactionFilter;
      else if (nextMonth !== month) transactionFilter = undefined;
      if (Object.hasOwn(options, 'showFixedCosts')) showFixedCosts = options.showFixedCosts;
      if (options.transactionId) showFixedCosts = false;
    }
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
    get('quick-add')?.addEventListener('click', () => navigate('transactions', month, { focusView: true, scroll: true, showFixedCosts: false, transactionFilter: null }));
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
      <div class="category-line"><button class="text-button category-name" type="button" data-category-history="${html(entry.categoryId ?? '')}" aria-label="Vís skrásetingar í ${html(entry.label)}">${html(entry.label)} ${icon('arrow-right')}</button><span class="category-amount">${remainingText}</span></div>
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
    const categories = core.categoryLabels?.(state, month) ?? new Map(state.categories.map((entry) => [entry.id, entry.label]));
    if (!core.categoryLabels) for (const line of budget?.allocations ?? []) categories.set(line.categoryId, line.label);
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
    for (const button of view.querySelectorAll('[data-category-history]')) {
      button.addEventListener('click', () => navigate('transactions', month, {
        transactionFilter: { categoryId: button.dataset.categoryHistory || null, allMonths: false },
        showFixedCosts: false, focusView: true, scroll: true,
      }));
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
    visibleDraftKeys.clear();
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
      transactionFilter,
      setTransactionFilter: (filter) => { transactionFilter = filter; },
      showFixedCosts,
      setEntryMode: (fixed) => { showFixedCosts = Boolean(fixed); },
      drafts: editorDrafts(draftScope(), tab, month),
      commit: (state, message, options) => ledger ? save({ ...ledger, state }, message, false, currentState, options) : false,
      toast,
      navigate,
    };
    transactionId = undefined;
    if (tab === 'overview') renderOverview();
    else if (tab === 'stats') renderStats();
    else if (tab === 'transactions') editors.renderTransactions(context);
    else editors.renderBudget(context);
    paintDraftNotice();
    if (cloud) paintCloudStatus();
  }

  function clearRestoreSelection() {
    restoreRead += 1;
    backupToRestore = undefined;
    backupPreviewState = undefined;
    safetyCopyState = undefined;
    get('backup-file').value = '';
    get('restore-notice').hidden = true;
    get('restore-actions').hidden = true;
    get('restore-backup').hidden = true;
    get('restore-backup').disabled = true;
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

  function showBackupPreview() {
    const current = ledger.state;
    const incoming = backupToRestore.state;
    backupPreviewState = current;
    safetyCopyState = undefined;
    const dates = [...Object.keys(incoming.months), ...incoming.transactions.map(({ date }) => date.slice(0, 7))].sort();
    const first = dates[0];
    const last = dates.at(-1);
    const period = first ? (first === last ? core.monthLabel(first) : `${core.monthLabel(first)} – ${core.monthLabel(last)}`) : 'Ongin mánaður í avritinum';
    const older = new Map(current.transactions.map((entry) => [entry.id, entry]));
    const newer = new Map(incoming.transactions.map((entry) => [entry.id, entry]));
    const removed = current.transactions.filter(({ id }) => !newer.has(id));
    const added = incoming.transactions.filter(({ id }) => !older.has(id));
    const changed = incoming.transactions.filter((entry) => {
      const previous = older.get(entry.id);
      return previous && ['date', 'categoryId', 'description', 'type', 'amountOre'].some((field) => previous[field] !== entry[field]);
    });
    const plans = (state) => Object.values(state.months).filter(({ budget }) => budget).length;
    const examples = [
      ...removed.map((entry) => ['Verður strikað', entry]),
      ...changed.map((entry) => ['Verður broytt', entry]),
      ...added.map((entry) => ['Verður løgd afturat', entry]),
    ];
    const notice = get('restore-notice');
    notice.innerHTML = `<div class="restore-preview">
      <strong>${html(period)}</strong>
      <p>${incoming.transactions.length} skrásetingar og ${plans(incoming)} fíggjarætlanir í avritinum.</p>
      <p>${added.length} nýggjar · ${changed.length} broyttar · ${removed.length} strikaðar skrásetingar.</p>
      <p>Fíggjarætlanir: ${plans(current)} → ${plans(incoming)}. Bólkar: ${current.categories.length} → ${incoming.categories.length}.</p>
      ${examples.length ? `<details><summary>Vís broytingar í skrásetingum</summary><ul>${examples.slice(0, 12).map(([action, entry]) =>
        `<li>${html(action)} · ${html(entry.date)} · ${html(entry.description)} · ${html(core.money(entry.amountOre))}</li>`).join('')}</ul>${examples.length > 12 ? `<p>Vísir 12 av ${examples.length} broytingum.</p>` : ''}</details>` : ''}
      <p>Tak fyrst eitt JSON-avrit av verandi dátum. Kanna at fílan er goymd, áðrenn tú setur valda avritið inn.</p>
    </div>`;
    notice.hidden = false;
    get('restore-actions').hidden = false;
    get('restore-backup').hidden = false;
    get('restore-backup').disabled = true;
  }

  function pendingLabel(kind) {
    return ({ append: 'Nýggj skráseting', edit: 'Broytt skráseting', delete: 'Striking', undo: 'Angra striking' })[kind] ?? 'Skráseting';
  }

  function pendingRecord(transaction) {
    return transaction ? `${transaction.date} · ${transaction.description} · ${core.money(transaction.amountOre)}` : 'Skrásetingin er strikað.';
  }

  function paintPendingEntries() {
    const panel = get('cloud-pending-entries');
    const entries = cloudStatus.pendingTransactions ?? [];
    panel.hidden = !entries.length;
    if (!entries.length) {
      panel.replaceChildren();
      return;
    }
    panel.innerHTML = `<h3>Broytingar, ið bíða</h3>
      <button type="button" class="text-button" data-download-pending>Tak bíðandi broytingar niður</button>
      ${entries.filter(({ error }) => error).map((entry) => `<div class="cloud-pending-problem">
        <strong>${html(pendingLabel(entry.kind))} · ${html(pendingRecord(entry.transaction))}</strong>
        <p class="muted">${html(entry.error)}</p>
        ${entry.conflict ? `<p><strong>Samstillað:</strong> ${html(pendingRecord(entry.current))}</p>` : ''}
        <div class="cloud-actions">
          ${entry.canKeepMine ? `<button class="button secondary small" type="button" data-keep-pending="${html(entry.operationId)}">Brúka mína broyting</button>` : ''}
          <button class="text-button" type="button" data-discard-pending="${html(entry.operationId)}">${entry.conflict ? 'Brúka samstilldu dátur' : 'Tak úr bíðirøð'}</button>
        </div>
      </div>`).join('')}`;
    panel.querySelector('[data-download-pending]').addEventListener('click', () => {
      downloadJson({ version: 2, transactions: entries.filter(({ kind }) => kind !== 'delete').map(({ transaction }) => transaction), pending: entries }, `figgjaraetlan-bidandi-${core.today()}.json`);
    });
    for (const button of panel.querySelectorAll('[data-keep-pending], [data-discard-pending]')) {
      button.addEventListener('click', async () => {
        const keep = button.dataset.keepPending;
        const operationId = keep ?? button.dataset.discardPending;
        const entry = entries.find((item) => item.operationId === operationId);
        if (!keep && !entry?.conflict && !window.confirm('Tak fyrst eitt avrit niður. Vilt tú taka hesa broytingina úr bíðirøðini?')) return;
        button.disabled = true;
        try {
          const result = keep ? await cloud.keepPending(operationId, entry.current) : await cloud.discardPending(operationId);
          if (!result.ok) toast(result.message);
        } catch {
          toast('Broytingin kundi ikki goymast. Royn aftur.');
        } finally {
          button.disabled = false;
        }
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
  get('resume-draft').addEventListener('click', () => {
    const meta = draftToResume?.[1].meta;
    if (!meta) return;
    navigate(meta.tab, meta.month, { transactionId: meta.transactionId, showFixedCosts: meta.showFixedCosts, focusView: true, scroll: true });
  });
  get('discard-draft').addEventListener('click', () => {
    if (!draftToResume || !window.confirm('Vilt tú strika hesa kladduna?')) return;
    draftStore.discard(draftScope(), draftToResume[0]);
    paintDraftNotice();
  });
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
      showBackupPreview();
    } catch {
      if (read !== restoreRead) return;
      notice.textContent = 'Fílan er ikki eitt gilt trygdaravrit fyri Fíggjarætlan.';
    }
    notice.hidden = false;
  });
  storageDialog.addEventListener('close', clearRestoreSelection);
  function canRestore() {
    if (!backupToRestore || !ledger || savingCloud) return false;
    if (cloudStatus.pending) {
      toast('Samstilla bíðandi broytingarnar, áðrenn tú setur avritið inn.');
      return false;
    }
    if (ledger.state !== backupPreviewState) {
      showBackupPreview();
      toast('Dáturnar eru broyttar. Kanna nýggja yvirlitið.');
      return false;
    }
    return true;
  }
  get('download-restore-safety').addEventListener('click', () => {
    if (!canRestore()) return;
    try {
      downloadJson({ ...ledger, exportedAt: new Date().toISOString() }, `figgjaraetlan-adrenn-endurstadan-${core.today()}.json`);
    } catch {
      toast('Trygdaravritið kundi ikki takast niður. Royn aftur.');
      return;
    }
    safetyCopyState = ledger.state;
    get('restore-backup').disabled = false;
  });
  get('restore-backup').addEventListener('click', async () => {
    if (!canRestore() || ledger.state !== safetyCopyState) return;
    if (await save(backupToRestore, 'Trygdaravritið er sett inn.', true, backupPreviewState)) storageDialog.close();
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
    get('cloud-review-pending').addEventListener('click', openStorage);
    get('cloud-refresh-draft').addEventListener('click', () => {
      render();
    });
    get('cloud-logout').addEventListener('click', async () => {
      const scope = draftScope();
      if (draftStore.entries(scope).length && !window.confirm('Kladdur á hesi eindini verða strikaðar, tá ið tú ritar út. Vilt tú halda fram?')) return;
      const result = await cloud.signOut();
      if (!result.ok) toast(result.message);
      else {
        draftStore.clear(scope);
        lastDeletion = undefined;
        draftStorageUnavailable = false;
      }
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
