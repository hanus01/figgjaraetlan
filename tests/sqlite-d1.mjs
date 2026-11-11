import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function createSqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_ledger.sql', '0002_sessions.sql']) {
    sqlite.exec(readFileSync(new URL('../cloud/migrations/' + name, import.meta.url), 'utf8'));
  }

  function prepared(sql, args = []) {
    return {
      sql, args,
      bind(...nextArgs) {
        return prepared(sql, nextArgs);
      },
      async first(column) {
        const row = sqlite.prepare(sql).get(...args);
        return (column === undefined ? row : row?.[column]) ?? null;
      },
      async all() {
        return { success: true, results: sqlite.prepare(sql).all(...args) };
      },
      async run() {
        const { changes, lastInsertRowid } = sqlite.prepare(sql).run(...args);
        return { success: true, results: [], meta: { changes, last_row_id: lastInsertRowid } };
      },
    };
  }

  const db = {
    prepare: prepared,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map(({ sql, args }) => ({
          success: true,
          results: sqlite.prepare(sql).all(...args),
        }));
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };

  return { db, close: () => sqlite.close() };
}
