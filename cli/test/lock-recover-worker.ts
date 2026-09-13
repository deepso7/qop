import { readFile, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import { createCliIdentityStore } from "../src/identity-store.ts";

const root = process.argv.at(2);
const delayMs = Number(process.argv.at(3) ?? "0");
const observedPath = process.argv.at(4);
const releasePath = process.argv.at(5);
if (!root) {
  console.error(
    "usage: lock-recover-worker <root> [delayMs] [observedPath] [releasePath]"
  );
  process.exit(2);
}

const waitForPath = (filePath: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = yield* Effect.promise(() =>
        readFile(filePath).then(
          () => true,
          () => false
        )
      );
      if (found) {
        return;
      }
      yield* Effect.sleep(25);
    }
    return yield* Effect.die(`timed out waiting for ${filePath}`);
  });

const store = createCliIdentityStore(root, {
  beforeRecoverSteal: () =>
    Effect.gen(function* () {
      if (observedPath) {
        yield* Effect.promise(() => writeFile(observedPath, "1"));
      }
      if (releasePath) {
        yield* waitForPath(releasePath);
        return;
      }
      if (delayMs > 0) {
        yield* Effect.sleep(delayMs);
      }
    }),
});

const result = await Effect.runPromise(store.acquireLock().pipe(Effect.result));
if (result._tag === "Success") {
  process.stdout.write("SUCCESS\n");
  await Effect.runPromise(Effect.never);
} else {
  process.stdout.write("FAILURE\n");
}
