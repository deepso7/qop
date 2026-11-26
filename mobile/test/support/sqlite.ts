import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

let failingRun:
  | { readonly matches: (sql: string) => boolean; readonly fired: () => void }
  | undefined;

/**
 * Makes the next `runAsync` whose SQL matches reject, like a storage error.
 * Resolves once that write has failed.
 */
export const failNextRun = (matches: (sql: string) => boolean) => {
  const fired = Promise.withResolvers<undefined>();
  failingRun = { fired: () => fired.resolve(undefined), matches };

  return fired.promise;
};

// Run the app's SQL using SQLite in Node when the native Expo module is unavailable.
export const openDatabaseAsync = () => {
  const database = new DatabaseSync(":memory:");

  const runAsync = (sql: string, ...params: SQLInputValue[]) => {
    if (failingRun?.matches(sql)) {
      failingRun.fired();
      failingRun = undefined;

      return Promise.reject(new Error("Simulated storage failure"));
    }

    return Promise.resolve(database.prepare(sql).run(...params));
  };

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
