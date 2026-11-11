// Minimal DOM simulation for behavioral checks. Browser layout and native controls require device testing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const STORAGE_KEY = "figgjaraetlan-ledger-v1";
const CURRENT = "2026-11";
const hostileCategoryId = "groceries-\"<tag>&'";
const hostileCategoryLabel = "Matvørur <img src=x> & ‘drykkur’";
const hostileDescription = "Keyp <img src=x> & kaffi";

function createLedger() {
  const categories = [
    { id: hostileCategoryId, label: hostileCategoryLabel, kind: "variable" },
    { id: "phone", label: "Telefon", kind: "fixed" },
  ];
  const monthStatus = {
    "1999-12": "completed",
    "2000-01": "completed",
    "2000-02": "skipped",
    "2000-03": "active",
    "2000-04": "completed",
    "2000-05": "completed",
    "2026-02": "completed",
    "2026-06": "completed",
    "2026-08": "completed",
    "2026-09": "skipped",
    "2026-10": "completed",
    [CURRENT]: "completed",
  };
  const months = Object.fromEntries(Object.entries(monthStatus)
    .map(([month, status]) => [month, { status, budget: null }]));
  const transactions = [
    { id: "dec-outside", date: "1999-12-15", description: "Before range", categoryId: hostileCategoryId, type: "expense", amountOre: 19999 },
    { id: "jan-start", date: "2000-01-01", description: hostileDescription, categoryId: hostileCategoryId, type: "expense", amountOre: 12550 },
    { id: "jan-income", date: "2000-01-03", description: "Old income", categoryId: null, type: "income", amountOre: 200000 },
    { id: "jan-phone", date: "2000-01-12", description: "Old phone", categoryId: "phone", type: "expense", amountOre: 4250 },
    { id: "feb-skipped", date: "2000-02-01", description: "Skipped expense", categoryId: hostileCategoryId, type: "expense", amountOre: 500000 },
    { id: "mar-active", date: "2000-03-10", description: "Active expense", categoryId: hostileCategoryId, type: "expense", amountOre: 600000 },
    { id: "apr-end", date: "2000-04-30", description: "End of range", categoryId: hostileCategoryId, type: "expense", amountOre: 3300 },
    { id: "apr-refund", date: "2000-04-15", description: "Refund at end", categoryId: hostileCategoryId, type: "refund", amountOre: 50 },
    { id: "apr-income", date: "2000-04-08", description: "Other old income", categoryId: null, type: "income", amountOre: 300000 },
    { id: "may-outside", date: "2000-05-01", description: "After range", categoryId: hostileCategoryId, type: "expense", amountOre: 29999 },
    { id: "feb-recent", date: "2026-02-01", description: "Inside 12", categoryId: hostileCategoryId, type: "expense", amountOre: 1500 },
    { id: "jun-recent", date: "2026-06-01", description: "Inside 6", categoryId: hostileCategoryId, type: "expense", amountOre: 2500 },
    { id: "aug-recent", date: "2026-08-01", description: "Outside 3", categoryId: "phone", type: "expense", amountOre: 3500 },
    { id: "sep-skipped", date: "2026-09-03", description: "Skipped recent", categoryId: hostileCategoryId, type: "expense", amountOre: 700000 },
    { id: "oct-recent", date: "2026-10-01", description: "Inside 3", categoryId: hostileCategoryId, type: "expense", amountOre: 4500 },
    { id: "nov-recent", date: CURRENT + "-05", description: "Current completed", categoryId: hostileCategoryId, type: "expense", amountOre: 5500 },
  ];
  return { mode: "personal", state: { version: 1, categories, months, transactions } };
}

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
    if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x"
      ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[name] ?? match;
  });
}

class SimEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = false;
    this.defaultPrevented = false;
    Object.assign(this, options);
  }
  preventDefault() { this.defaultPrevented = true; }
}

const voids = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

function parse(selector, parent) {
  let current = parent;
  for (const [token] of selector.matchAll(/<!--[\s\S]*?-->|<![^>]+>|<\/?[A-Za-z][\w:-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+|</g)) {
    if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      const tag = /^<\/([\w:-]+)/.exec(token)[1].toLowerCase();
      let cursor = current;
      while (cursor !== parent && cursor.tag !== tag) cursor = cursor.parentElement;
      if (cursor !== parent) current = cursor.parentElement;
      continue;
    }
    const opening = /^<([A-Za-z][\w:-]*)/.exec(token);
    if (!opening) {
      current.children.push(decode(token));
      continue;
    }
    const element = new SimElement(opening[1].toLowerCase(), current);
    current.children.push(element);
    const attributes = token.slice(opening[0].length).replace(/\/?\s*>$/, "");
    for (const [, name, doubleQuoted, singleQuoted, bare] of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
      element.setAttribute(name, decode(doubleQuoted ?? singleQuoted ?? bare ?? ""));
    }
    if (!voids.has(element.tag) && !token.endsWith("/>")) current = element;
  }
}

function matchPart(element, selector) {
  const tag = /^[a-z][a-z0-9-]*/i.exec(selector)?.[0];
  if (tag && element.tag !== tag.toLowerCase()) return false;
  const id = /#([\w-]+)/.exec(selector)?.[1];
  if (id && element.id !== id) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
    if (!element.classList.contains(name)) return false;
  }
  for (const [, name, quoted, bare] of selector.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g)) {
    if (!element.hasAttribute(name)) return false;
    const value = quoted ?? bare;
    if (value !== undefined && element.getAttribute(name) !== value) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  const segments = selector.trim().split(/\s+(?![^\[]*\])/g);
  if (!matchPart(element, segments.pop())) return false;
  let ancestor = element.parentElement;
  while (segments.length) {
    const part = segments.pop();
    while (ancestor && !matchPart(ancestor, part)) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

class SimElement {
  constructor(tag, parent = null) {
    this.tag = tag;
    this.parentElement = parent;
    this.children = [];
    this.attrs = new Map();
    this.handlers = new Map();
    this.rawMarkup = "";
  }
  get id() { return this.getAttribute("id"); }
  set id(value) { this.setAttribute("id", value); }
  get name() { return this.getAttribute("name"); }
  get value() {
    if (this.tag === "select") {
      if (this._value !== undefined) return this.options.some(option => option.value === this._value) ? this._value : "";
      const option = this.options.find(item => item.hasAttribute("selected")) ?? this.options[0];
      return option?.value ?? "";
    }
    return this._value ?? this.getAttribute("value") ?? (this.tag === "option" ? this.textContent : "");
  }
  set value(value) { this._value = String(value ?? ""); }
  get valueAsNumber() { return this.value ? Number(this.value) : NaN; }
  get options() { return this.querySelectorAll("option"); }
  get dataset() {
    return Object.fromEntries(Array.from(this.attrs)
      .filter(([key]) => key.startsWith("data-"))
      .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, part) => part.toUpperCase()), value]));
  }
  get classList() {
    const list = new Set((this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
    const apply = () => this.setAttribute("class", Array.from(list).join(" "));
    return {
      contains: value => list.has(value),
      toggle: (value, force) => {
        const enable = force ?? !list.has(value);
        if (enable) list.add(value); else list.delete(value);
        apply();
        return enable;
      },
      add: (...values) => { values.forEach(value => list.add(value)); apply(); },
      remove: (...values) => { values.forEach(value => list.delete(value)); apply(); },
    };
  }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(flag) { if (flag) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(flag) { if (flag) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get elements() {
    return Object.fromEntries(this.querySelectorAll("input, select, button, textarea")
      .filter(node => node.name).map(node => [node.name, node]));
  }
  get lastElementChild() { return this.children.filter(child => child instanceof SimElement).at(-1); }
  get textContent() {
    return this.children.map(child => child instanceof SimElement ? child.textContent : child).join("");
  }
  set textContent(text) { this.children = [String(text)]; }
  get innerHTML() { return this.rawMarkup; }
  set innerHTML(markup) {
    this.rawMarkup = String(markup);
    this.children = [];
    parse(this.rawMarkup, this);
  }
  getAttribute(name) { return this.attrs.get(name.toLowerCase()) ?? null; }
  hasAttribute(name) { return this.attrs.has(name.toLowerCase()); }
  setAttribute(name, value) { this.attrs.set(name.toLowerCase(), String(value)); }
  removeAttribute(name) { this.attrs.delete(name.toLowerCase()); }
  matches(selector) { return selector.split(",").some(part => matchesSelector(this, part)); }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  querySelectorAll(selector) {
    const list = [];
    for (const child of this.children) {
      if (!(child instanceof SimElement)) continue;
      if (child.matches(selector)) list.push(child);
      list.push(...child.querySelectorAll(selector));
    }
    return list;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(callback);
  }
  dispatchEvent(event) {
    event.target ??= this;
    const chain = [this];
    for (let node = this.parentElement; event.bubbles && node; node = node.parentElement) chain.push(node);
    for (const node of chain) {
      event.currentTarget = node;
      for (const handler of node.handlers.get(event.type) ?? []) handler(event);
    }
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    const allow = this.dispatchEvent(new SimEvent("click", { bubbles: true }));
    if (allow && this.tag === "button" && (this.getAttribute("type") ?? "submit") === "submit") {
      this.closest("form")?.requestSubmit();
    }
  }
  requestSubmit() { this.dispatchEvent(new SimEvent("submit", { bubbles: true })); }
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatchEvent(new SimEvent("close")); }
  focus() { this.wasFocused = true; }
  scrollIntoView() {}
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  append(...nodes) {
    for (const node of nodes) if (node instanceof SimElement) node.parentElement = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
    this.parentElement = null;
  }
  insertAdjacentHTML(position, markup) {
    assert.equal(position, "beforeend");
    parse(markup, this);
  }
}

function loadApp(cwd, ledger = createLedger(), options = {}) {
  const document = new SimElement("#document");
  const standalone = path.extname(cwd).toLowerCase() === ".html";
  const htmlFile = fs.readFileSync(standalone ? cwd : path.join(cwd, "index.html"), "utf8");
  document.innerHTML = standalone ? htmlFile.replace(/<script>[\s\S]*?<\/script>/g, "") : htmlFile;
  document.getElementById = id => document.querySelector("#" + id);
  document.createElement = tag => new SimElement(tag);
  Object.defineProperty(document, "body", { get: () => document.querySelector("body") });
  const storage = new Map([[STORAGE_KEY, JSON.stringify(ledger)]]);
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [2026, 10, 10, 13])); }
    static now() { return +new FixtureDate(); }
  }
  const context = vm.createContext({
    Date: FixtureDate, console, document, localStorage, Event: SimEvent, scrollTo() {},
    URLSearchParams, location: { search: "" }, navigator: {},
    setTimeout() { return 0; }, clearTimeout() {}, confirm() { return true; },
  });
  context.window = context;
  if (options.sync) context.BudgetSync = options.sync;
  const get = selector => {
    const result = document.querySelector(selector);
    assert.ok(result, "Missing selector " + selector);
    return result;
  };
  const scripts = standalone
    ? Array.from(htmlFile.matchAll(/<script>([\s\S]*?)<\/script>/g), (match, index) => [`inline-${index + 1}.js`, match[1]])
    : Array.from(htmlFile.matchAll(/<script defer src="([^"]+)"><\/script>/g), (match) => [match[1], fs.readFileSync(path.join(cwd, match[1]), "utf8")]);
  for (const [filename, content] of scripts) vm.runInContext(content, context, { filename });
  assert.equal(context.BudgetCore.validateState(ledger.state), true, "Fixture ledger is valid");
  assert.equal(get("#page-title").textContent, "Yvirlit");
  return {
    document, get, context, localStorage,
    ledger: () => JSON.parse(localStorage.getItem(STORAGE_KEY)),
    click: selector => get(selector).click(),
    change: (selector, value) => {
      const item = get(selector);
      item.value = value;
      item.dispatchEvent(new SimEvent("change", { bubbles: true }));
    },
  };
}

module.exports = { loadApp, createLedger, CURRENT, hostileCategoryId, hostileCategoryLabel, hostileDescription, SimEvent };
