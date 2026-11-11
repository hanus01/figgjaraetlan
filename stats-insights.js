(function () {
  "use strict";

  const minimumChange = 25_000;
  const relativeChange = 0.20;
  const percentFormat = new Intl.NumberFormat("da-DK", {
    style: "percent",
    maximumFractionDigits: 0
  });

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function material(before, after) {
    const difference = Math.abs(after - before);
    return difference >= minimumChange && (before <= 0 || difference / before >= relativeChange);
  }

  function monthKeys(rows) {
    return rows.map(({ key }) => key);
  }

  function consecutive(rows) {
    const { shiftMonth } = globalThis.BudgetCore;
    return rows.every((row, index) => index === 0 || row.key === shiftMonth(rows[index - 1].key, 1));
  }

  function latestWindow(rows, size) {
    for (let end = rows.length; end >= size; end -= 1) {
      const window = rows.slice(end - size, end);
      if (consecutive(window)) return window;
    }
    return [];
  }

  function rangeText(rows) {
    const { monthLabel } = globalThis.BudgetCore;
    if (rows.length === 1) return monthLabel(rows[0].key);
    return monthLabel(rows[0].key) + " – " + monthLabel(rows.at(-1).key);
  }

  function categoryHistory(rows) {
    const history = new Map();
    for (const row of rows) {
      for (const category of row.summary.categories) {
        if (category.categoryId === null) continue;
        const entries = history.get(category.categoryId) ?? [];
        entries.push({ key: row.key, ...category });
        history.set(category.categoryId, entries);
      }
    }
    return history;
  }

  function direction(before, after) {
    return after > before ? "meira" : "minni";
  }

  function changeText(before, after) {
    const { money } = globalThis.BudgetCore;
    const difference = Math.abs(after - before);
    const percentage = before > 0 ? " (" + percentFormat.format(difference / before) + ")" : "";
    return money(Math.round(difference)) + " " + direction(before, after) + percentage;
  }

  function spendingComparison(rows) {
    const { money } = globalThis.BudgetCore;
    const window = latestWindow(rows, 6);
    if (!window.length) return null;

    const earlier = window.slice(0, 3);
    const later = window.slice(3);
    const before = sum(earlier.map(({ summary }) => summary.spent)) / 3;
    const after = sum(later.map(({ summary }) => summary.spent)) / 3;
    if (!material(before, after)) return null;

    const earlierMonths = new Set(monthKeys(earlier));
    const change = after - before;
    let driver;
    for (const [categoryId, history] of categoryHistory(window)) {
      const contribution = sum(history.map(({ key, spent }) => earlierMonths.has(key) ? -spent : spent)) / 3;
      if (Math.sign(contribution) === Math.sign(change)
        && Math.abs(contribution) >= Math.max(15_000, Math.abs(change) * 0.30)
        && (!driver || Math.abs(contribution) > Math.abs(driver.contribution))) {
        driver = { categoryId, label: history.at(-1).label, contribution };
      }
    }
    const driverText = driver
      ? ` Í bólkinum „${driver.label}“ var mánaðarmiðaltalið ${money(Math.round(Math.abs(driver.contribution)))} ${direction(0, driver.contribution)}.`
      : "";
    return {
      driverId: driver?.categoryId,
      insight: {
        title: after > before ? "Útreiðslurnar eru øktar" : "Útreiðslurnar eru minkaðar",
        detail: `Mánaðarmiðaltalið var ${changeText(before, after)}.${driverText}`,
        basis: `${rangeText(later)}: ${money(Math.round(after))} um mánaðin. ${rangeText(earlier)}: ${money(Math.round(before))} um mánaðin. Allir seks mánaðirnir eru lidnir.`,
        months: monthKeys(window),
        categoryId: driver?.categoryId
      }
    };
  }

  function strongestBudgetOverrun(history, excludedCategories) {
    let strongest;
    for (const [categoryId, entries] of history) {
      if (excludedCategories.has(categoryId)) continue;
      const budgeted = entries.filter(({ allowance }) => allowance !== null);
      const above = budgeted.filter(({ spent, allowance }) => spent > allowance).length;
      if (above < 2) continue;
      const allowed = sum(budgeted.map(({ allowance }) => allowance));
      const spent = sum(budgeted.map((entry) => entry.spent));
      const difference = spent - allowed;
      if (spent > allowed && material(allowed, spent) && (!strongest || difference > strongest.difference)) {
        strongest = { categoryId, entries: budgeted, above, allowed, spent, difference };
      }
    }
    if (!strongest) return null;

    const { money } = globalThis.BudgetCore;
    const { categoryId, entries, above, allowed, spent, difference } = strongest;
    const { label } = entries.at(-1);
    return {
      title: `Yvir játtanina í bólkinum „${label}“`,
      detail: `Tú brúkti meira enn ætlað í ${above} av ${entries.length} mánaðum við játtan. Tilsamans var munurin ${money(difference)}`,
      basis: `${rangeText(entries)}. ${entries.length} lidnir mánaðir við játtan: ${money(spent)} brúkt av ${money(allowed)} ætlaðum.`,
      months: monthKeys(entries),
      categoryId
    };
  }

  function strongestCategoryStreak(rows, excludedCategories) {
    const window = latestWindow(rows, 3);
    if (!window.length) return null;

    let strongest;
    for (const [categoryId, entries] of categoryHistory(window)) {
      if (excludedCategories.has(categoryId) || entries.length !== 3) continue;

      const [first, middle, last] = entries.map(({ spent }) => spent);
      const rising = first < middle && middle < last;
      const falling = first > middle && middle > last;
      const difference = Math.abs(last - first);
      if ((rising || falling) && material(first, last) && (!strongest || difference > strongest.difference)) {
        strongest = { categoryId, entries, first, last, difference, rising };
      }
    }
    if (!strongest) return null;

    const { monthLabel, money } = globalThis.BudgetCore;
    const { categoryId, entries, first, last, rising } = strongest;
    const { label } = entries.at(-1);
    return {
      title: `${rising ? "Meira" : "Minni"} brúkt í bólkinum „${label}“`,
      detail: `Útreiðslurnar ${rising ? "hækkaðu" : "lækkaðu"} úr mánaði í mánað. Seinasta mánaðin brúkti tú ${changeText(first, last)} enn tann fyrsta.`,
      basis: entries.map(({ key, spent }) => `${monthLabel(key)}: ${money(spent)}`).join(" · "),
      months: monthKeys(entries),
      categoryId
    };
  }

  function spendingOutlier(rows) {
    if (rows.length < 7) return null;
    const { monthLabel, money } = globalThis.BudgetCore;
    const current = rows.at(-1);
    const baseline = rows.slice(-13, -1);
    const previousAmounts = baseline.map(({ summary }) => summary.spent);
    const typical = median(previousAmounts);
    const spread = median(previousAmounts.map((amount) => Math.abs(amount - typical)));
    const actual = current.summary.spent;
    if (!material(typical, actual) || Math.abs(actual - typical) <= 3 * 1.4826 * spread) return null;

    return {
      title: actual > typical ? "Óvanliga høgar útreiðslur" : "Óvanliga lágar útreiðslur",
      detail: `Í ${monthLabel(current.key)} brúkti tú ${changeText(typical, actual)} enn vanligt.`,
      basis: `${money(actual)} í ${monthLabel(current.key)}. Miðvirðið fyri ${baseline.length} undanfarandi lidnar mánaðir í ${rangeText(baseline)} var ${money(Math.round(typical))}. Mánaðirnir eru ikki neyðturviliga samanhangandi.`,
      months: monthKeys([...baseline, current])
    };
  }

  function strongestAdherence(history, excludedCategories) {
    let strongest;
    for (const [categoryId, entries] of history) {
      if (excludedCategories.has(categoryId)) continue;
      const budgeted = entries.filter(({ allowance, kind }) => allowance !== null && kind === "variable");
      const within = budgeted.filter(({ allowance, spent }) => spent <= allowance).length;
      const spent = sum(budgeted.map((entry) => entry.spent));
      if (budgeted.length >= 3 && within / budgeted.length >= 0.8 && spent >= minimumChange
        && (!strongest || spent > strongest.spent)) {
        strongest = { categoryId, entries: budgeted, within, spent };
      }
    }
    if (!strongest) return null;

    const { categoryId, entries, within } = strongest;
    return {
      title: `Innan fyri játtanina í bólkinum „${entries.at(-1).label}“`,
      detail: `Tú helt teg innan fyri játtanina í ${within} av ${entries.length} mánaðum.`,
      basis: `${rangeText(entries)}. Bert lidnir mánaðir við játtan í hesum bólki telja við.`,
      months: monthKeys(entries),
      categoryId
    };
  }

  function generate(completedRows, range) {
    const rows = completedRows.filter(({ key }) => key >= range.start && key <= range.end);
    if (!rows.length) return [];

    const history = categoryHistory(rows);
    const comparison = spendingComparison(rows);
    const usedCategories = new Set([comparison?.driverId]);
    const overrun = strongestBudgetOverrun(history, usedCategories);
    usedCategories.add(overrun?.categoryId);
    const streak = strongestCategoryStreak(rows, usedCategories);
    usedCategories.add(streak?.categoryId);
    const adherence = strongestAdherence(history, usedCategories);
    const overall = comparison?.insight ?? spendingOutlier(rows);
    return [overall, overrun, streak, adherence].filter(Boolean).slice(0, 3);
  }

  globalThis.BudgetInsights = { generate };
})();
