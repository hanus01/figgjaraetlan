(() => {
  'use strict';

  function create(prefix) {
    const volatile = new Map();
    const keyFor = (scope) => `${prefix}:${encodeURIComponent(scope)}`;

    function load(scope) {
      if (volatile.has(scope)) return new Map(volatile.get(scope));
      try {
        const pairs = JSON.parse(localStorage.getItem(keyFor(scope)) ?? '[]');
        return new Map(pairs.filter((pair) => Array.isArray(pair) && typeof pair[0] === 'string'
          && pair[1] && typeof pair[1] === 'object' && pair[1].meta && Object.hasOwn(pair[1], 'data')));
      } catch {
        return new Map();
      }
    }

    function persist(scope, entries) {
      try {
        if (entries.size) localStorage.setItem(keyFor(scope), JSON.stringify([...entries]));
        else localStorage.removeItem(keyFor(scope));
        volatile.delete(scope);
        return true;
      } catch {
        volatile.set(scope, entries);
        return false;
      }
    }

    return {
      read(scope, key) { return scope ? load(scope).get(key)?.data : undefined; },
      entries(scope) { return scope ? [...load(scope)].reverse() : []; },
      write(scope, key, data, meta) {
        if (!scope) return false;
        const entries = load(scope);
        entries.delete(key);
        entries.set(key, { data, meta });
        return persist(scope, entries);
      },
      discard(scope, key) {
        if (!scope) return;
        const entries = load(scope);
        if (entries.delete(key)) persist(scope, entries);
      },
      clear(scope) { if (scope) persist(scope, new Map()); },
    };
  }

  globalThis.BudgetDraftStore = { create };
})();
