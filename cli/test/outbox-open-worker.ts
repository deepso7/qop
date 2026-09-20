import { Effect } from "effect";

import { openCliOutboxStore } from "../src/outbox-store.ts";

const root = process.argv.at(2);
if (!root) {
  process.stderr.write("usage: outbox-open-worker <root>\n");
  process.exit(2);
}

const result = await Effect.runPromise(
  Effect.scoped(
    openCliOutboxStore(root).pipe(
      Effect.flatMap((store) => store.queuedCount())
    )
  ).pipe(Effect.result)
);

if (result._tag === "Success") {
  process.stdout.write(`SUCCESS ${result.success}\n`);
} else {
  process.stdout.write(`FAILURE ${result.failure.operation}\n`);
}
