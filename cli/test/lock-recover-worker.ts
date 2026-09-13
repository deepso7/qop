import { Effect } from "effect";

import { createCliIdentityStore } from "../src/identity-store.ts";

const root = process.argv.at(2);
const delayMs = Number(process.argv.at(3) ?? "0");
if (!root) {
  console.error("usage: lock-recover-worker <root> [delayMs]");
  process.exit(2);
}

const store = createCliIdentityStore(root, {
  beforeRecoverSteal: () => Effect.sleep(delayMs),
});

const result = await Effect.runPromise(store.acquireLock().pipe(Effect.result));
if (result._tag === "Success") {
  process.stdout.write("SUCCESS\n");
  await Effect.runPromise(Effect.never);
} else {
  process.stdout.write("FAILURE\n");
}
