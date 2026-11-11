const path = require("node:path");
const assert = require("node:assert/strict");
const { loadApp, createLedger, hostileCategoryId, hostileCategoryLabel, hostileDescription } = require("./support/dom.cjs");

const source = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
const app = loadApp(source);
const { document, get, click, change } = app;
const all = selector => document.querySelectorAll(selector);
const chartRows = () => all(".chart-rows .chart-row");
const chartMonths = () => chartRows().map(row => row.dataset.chartMonth).filter(Boolean);
const categoryButtons = () => all(".category-stats-chart button[data-stats-category]");
const context = app.context;
const format = context.BudgetCore.money;
const checked = [];

function test(label, callback) {
  try {
    callback();
    checked.push(label);
    console.log("PASS", label);
  } catch (error) {
    console.error("FAIL", label);
    throw error;
  }
}

function assignMonth(field, number) {
  if (field.options?.length) {
    const option = field.options.find(item => Number(item.value) === Number(number));
    assert.ok(option, "No month option for " + number);
    field.value = option.value;
  } else field.value = number;
}

function chooseRange(start, end, target = app) {
  const { get, change } = target;
  if (get("#stats-period").value !== "custom") change("#stats-period", "custom");
  const [startYear, startMonth] = start.split("-");
  const [endYear, endMonth] = end.split("-");
  const form = get("#stats-range-form");
  assignMonth(form.elements.startMonth, startMonth);
  assignMonth(form.elements.endMonth, endMonth);
  form.elements.startYear.value = String(Number(startYear));
  form.elements.endYear.value = String(Number(endYear));
  form.requestSubmit();
}

function detailVisible() {
  const sections = all(".stats-detail").filter(section => !section.hidden);
  return sections.find(section => section.querySelector("button[data-stats-transaction]"));
}

function verifyDetail() {
  const button = categoryButtons().find(element => element.textContent.includes(hostileCategoryLabel));
  assert.ok(button, "Missing original category after escaping");
  assert.match(button.dataset.statsCategory, /^\d+$/, "Raw user category ID stays outside markup attributes");
  assert.match(button.textContent, /Matvørur/);
  assert.ok(button.textContent.includes(hostileCategoryLabel));
  assert.ok(button.textContent.includes(format(15800)), "Net spending includes two expenses less a refund");
  assert.equal(button.querySelector("img"), null, "Category label remains plain text");
  button.click();
  const details = detailVisible();
  assert.ok(details, "Category transaction detail is visible");
  for (const phrase of [hostileDescription, "End of range", "Refund at end"]) {
    assert.ok(details.textContent.includes(phrase), "Missing detail for " + phrase);
  }
  for (const phrase of ["Before range", "After range", "Skipped expense", "Active expense", "Old phone", "Old income"]) {
    assert.ok(!details.textContent.includes(phrase), "Unexpected detail for " + phrase);
  }
  assert.equal(details.querySelector("img"), null, "Transaction description remains plain text");
  return details;
}

test("Original 3, 6, and 12 month presets keep inclusive completed current month and skip September", () => {
  click("#tab-stats");
  assert.equal(get("#stats-period").value, "3");
  assert.deepEqual(chartMonths(), ["2026-10", "2026-11"]);
  assert.equal(chartRows().length, 3);
  change("#stats-period", "6");
  assert.deepEqual(chartMonths(), ["2026-06", "2026-08", "2026-10", "2026-11"]);
  assert.equal(chartRows().length, 6);
  change("#stats-period", "12");
  assert.deepEqual(chartMonths(), ["2026-02", "2026-06", "2026-08", "2026-10", "2026-11"]);
  assert.equal(chartRows().length, 12);
});

test("Custom January through April includes both months but excludes active and skipped entries", () => {
  chooseRange("2000-01", "2000-04");
  assert.equal(get("#stats-period").value, "custom");
  assert.deepEqual(chartMonths(), ["2000-01", "2000-04"]);
  assert.equal(chartRows().length, 4);
  const text = get(".stats-coverage").textContent;
  assert.match(text, /\b2\b/);
  assert.match(text, /\b4\b/);
  assert.ok(get("#view").textContent.includes(format(20050)), "Net expense is 200.50 DKK");
  assert.ok(get("#view").textContent.includes(format(500000)), "Recorded income is 5000 DKK");
});

test("Custom range form rejects an inverted period without replacing applied data", () => {
  chooseRange("2000-04", "2000-01");
  const error = get("[data-range-error]");
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.trim());
  assert.deepEqual(chartMonths(), ["2000-01", "2000-04"]);
  chooseRange("2000-01", "2000-04");
  assert.deepEqual(chartMonths(), ["2000-01", "2000-04"]);
  assert.equal(get("[data-range-error]").hidden, true);
});

test("Category click shows only in-range completed-month entries, with labels and descriptions rendered safely", () => {
  verifyDetail();
});

test("Clicking category evidence opens and edits the real transaction, then refreshes Hagtøl", () => {
  const details = detailVisible();
  const button = details.querySelectorAll("button[data-stats-transaction]")
    .find(element => element.textContent.includes(hostileDescription));
  assert.ok(button, "Category evidence row has expected transaction");
  button.click();
  assert.equal(get("#page-title").textContent, "Skráset");
  const form = get("#transaction-form");
  assert.equal(form.elements.amount.value, "125,50");
  assert.equal(form.elements.date.value, "2000-01-01");
  assert.equal(form.elements.description.value, hostileDescription);
  assert.equal(form.elements.category.value, hostileCategoryId);
  form.elements.amount.value = "130,75";
  form.requestSubmit();
  assert.equal(app.ledger().state.transactions.find(item => item.id === "jan-start").amountOre, 13075);
  click("#tab-stats");
  assert.equal(get("#stats-period").value, "custom");
  assert.deepEqual(chartMonths(), ["2000-01", "2000-04"]);
  const category = categoryButtons().find(element => element.textContent.includes(hostileCategoryLabel));
  assert.ok(category.textContent.includes(format(16325)), "Stats recomputes after editing an underlying record");
});

test("One-month and empty ranges are represented without inventing zero-spend months", () => {
  chooseRange("2000-01", "2000-01");
  assert.deepEqual(chartMonths(), ["2000-01"]);
  assert.equal(chartRows().length, 1);
  chooseRange("2001-01", "2001-01");
  assert.equal(chartMonths().length, 0);
  assert.equal(categoryButtons().length, 0);
  assert.match(get(".stats-coverage").textContent, /\b0\b/);
});

test("A multi-decade range preserves all-period coverage and limits visible chart rows", () => {
  chooseRange("1980-01", "2026-11");
  assert.equal(get("[data-range-error]").hidden, true);
  assert.ok(chartRows().length <= 12, "Chart must paginate");
  assert.match(get(".stats-coverage").textContent, /\b9\b/);
  const button = all("[data-chart-page]").find(element => !element.disabled);
  assert.ok(button, "Multi-decade range can move between chart pages");
  const labelBefore = chartRows().map(row => row.textContent);
  button.click();
  assert.notDeepEqual(chartRows().map(row => row.textContent), labelBefore);
  assert.ok(chartRows().length <= 12, "Next page also limits chart rows");
  assert.match(get(".stats-coverage").textContent, /\b9\b/);
});

test("Generated insight escapes the category text and links each actual evidence month", () => {
  const ledger = createLedger();
  const amounts = [60000, 61000, 59000, 120000, 150000, 180000];
  const months = amounts.map((amountOre, index) => {
    const key = "2024-" + String(index + 1).padStart(2, "0");
    ledger.state.months[key] = { status: "completed", budget: null };
    ledger.state.transactions.push({
      id: "insight-" + key, date: key + "-15", description: "Evidence " + key,
      categoryId: hostileCategoryId, type: "expense", amountOre,
    });
    return key;
  });
  for (const key of ["2023-12", "2024-08"]) {
    ledger.state.months[key] = { status: "completed", budget: null };
    ledger.state.transactions.push({
      id: "outside-" + key, date: key + "-15", description: "Outside evidence " + key,
      categoryId: hostileCategoryId, type: "expense", amountOre: 100000,
    });
  }
  const target = loadApp(source, ledger);
  target.click("#tab-stats");
  chooseRange("2023-12", "2024-08", target);
  const card = target.get(".stats-insight");
  assert.match(card.querySelector("h3").textContent, /øktar/);
  assert.ok(card.textContent.includes(hostileCategoryLabel));
  assert.equal(card.querySelector("img"), null);
  assert.deepEqual(card.querySelectorAll("[data-insight-month]").map(button => button.dataset.insightMonth), months);
  const categoryEvidence = card.querySelector("[data-insight-category]");
  assert.ok(categoryEvidence, "Insight exposes its category evidence");
  assert.equal(categoryEvidence.dataset.insightMonths, months.join(","));
  categoryEvidence.click();
  const details = target.get(".stats-detail");
  assert.equal(details.hidden, false);
  assert.equal(details.querySelectorAll("[data-stats-transaction]").length, 6);
  assert.doesNotMatch(details.textContent, /Outside evidence/);
  target.click("[data-stats-show-all]");
  assert.equal(details.querySelectorAll("[data-stats-transaction]").length, 8);
  assert.match(details.textContent, /Outside evidence 2023-12/);
  assert.match(details.textContent, /Outside evidence 2024-08/);
  card.querySelector('[data-insight-month="2024-06"]').click();
  assert.equal(target.get("#page-title").textContent, "Skráset");
  assert.match(target.get(".transaction-list").textContent, /Evidence 2024-06/);
});

test("Aggregate categories and insight evidence use the latest selected monthly name even without later spending", () => {
  const ledger = createLedger();
  const categoryId = hostileCategoryId;
  const oldLabel = "Original name";
  const newLabel = "Renamed category";
  ledger.state.months = {};
  ledger.state.transactions = [{
    id: "before-rename", date: "2024-01-15", description: "Purchase before rename",
    categoryId, type: "expense", amountOre: 30000,
  }];
  for (const key of ["2024-01", "2024-02", "2024-03"]) {
    ledger.state.months[key] = { status: "completed", budget: {
      income: [], copiedFrom: null,
      allocations: [{ categoryId, label: key === "2024-03" ? newLabel : oldLabel,
        kind: "variable", amountOre: 100000 }],
    } };
  }
  const target = loadApp(source, ledger);
  target.click("#tab-stats");
  chooseRange("2024-01", "2024-03", target);
  assert.match(target.get(".stats-insight h3").textContent, /Renamed category/);
  assert.match(target.get("[data-insight-category]").textContent, /Renamed category/);
  assert.match(target.get("[data-stats-category]").textContent, /Renamed category/);
  target.click("[data-insight-category]");
  assert.match(target.get(".stats-detail h3").textContent, /Renamed category/);
  assert.match(target.get(".stats-detail").textContent, /Purchase before rename/);
  chooseRange("2024-01", "2024-01", target);
  assert.match(target.get("[data-stats-category]").textContent, /Original name/);
  assert.equal(ledger.state.months["2024-01"].budget.allocations[0].label, oldLabel);
});

test("Preset still anchors to the preceding calendar month when this month is active", () => {
  const ledger = createLedger();
  ledger.state.months["2026-11"].status = "active";
  const target = loadApp(source, ledger);
  target.click("#tab-stats");
  assert.deepEqual(target.document.querySelectorAll("[data-chart-month]").map(button => button.dataset.chartMonth),
    ["2026-08", "2026-10"]);
});

test("Extreme valid range renders sparse data without expanding 119,988 month rows", () => {
  chooseRange("0001-01", "9999-12");
  assert.equal(get("[data-range-error]").hidden, true);
  assert.match(get(".stats-coverage").textContent, /119988/);
  assert.ok(chartRows().length <= 12);
  assert.match(chartRows().at(-1).textContent, /9999/);
});

test("Category detail pages its actual transactions and retains link to an older row", () => {
  const ledger = createLedger();
  ledger.state.transactions = Array.from({ length: 25 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return { id: "paginated-" + day, date: "2000-01-" + day, description: "Row " + day,
      categoryId: hostileCategoryId, type: "expense", amountOre: 1234 };
  });
  const target = loadApp(source, ledger);
  target.click("#tab-stats");
  chooseRange("2000-01", "2000-01", target);
  target.click("[data-stats-category]");
  assert.equal(target.document.querySelectorAll("[data-stats-transaction]").length, 20);
  target.click("[data-stats-more]");
  assert.equal(target.document.querySelectorAll("[data-stats-transaction]").length, 25);
  const oldest = target.document.querySelectorAll("[data-stats-transaction]").find(button => button.textContent.includes("Row 01"));
  oldest.click();
  assert.equal(target.get("#transaction-form").elements.date.value, "2000-01-01");
  assert.equal(target.get("#transaction-form").elements.description.value, "Row 01");
});

console.log("Passed " + checked.length + " simulated-DOM Hagtøl regression cases");


test("The optional current month is marked partial and does not affect complete-month averages", () => {
  const ledger = createLedger();
  ledger.state.months["2026-11"].status = "active";
  const partial = loadApp(source, ledger);
  partial.click("#tab-stats");
  assert.equal(partial.document.querySelector('[data-chart-month="2026-11"]'), null);
  const toggle = partial.get("#stats-include-current");
  toggle.checked = true;
  partial.change("#stats-include-current", "on");
  const row = partial.get('[data-chart-month="2026-11"]');
  assert.equal(row.querySelector('.chart-partial').textContent, 'Higartil');
  const metrics = partial.document.querySelectorAll('.metric-card');
  const spent = metrics.find(card => card.textContent.includes('Skrásettar útreiðslur'));
  const average = metrics.find(card => card.textContent.includes('Miðal útreiðslur'));
  assert.ok(spent.textContent.includes(format(10000)));
  assert.ok(average.textContent.includes(format(4500)));
});

console.log(`Passed ${checked.length} simulated-DOM Hagtøl regression cases`);
