import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

// Run the app's SQL using SQLite in Node when the native Expo module is unavailable.
export const openDatabaseAsync = () => {
  const database = new DatabaseSync(":memory:");
  const runAsync = (sql: string, ...params: SQLInputValue[]) =>
    Promise.resolve(database.prepare(sql).run(...params));
  return Promise.resolve({
    execAsync: (sql: string) => Promise.resolve(database.exec(sql)),
    getAllAsync: (sql: string, ...params: SQLInputValue[]) =>
      Promise.resolve(database.prepare(sql).all(...params)),
    getFirstAsync: (sql: string, ...params: SQLInputValue[]) =>
      Promise.resolve(database.prepare(sql).get(...params) ?? null),
    runAsync,
    withExclusiveTransactionAsync: async (
      run: (transaction: { runAsync: typeof runAsync }) => Promise<void>
    ) => {
      database.exec("BEGIN");
      try {
        await run({ runAsync });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
};
