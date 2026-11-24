import { Effect, Queue, Semaphore } from "effect";

import type { StoredMessage } from "./db";

interface OutboxDependencies {
  readonly list: () => Promise<readonly StoredMessage[]>;
  readonly deliver: (
    message: StoredMessage,
    signal: AbortSignal
  ) => Promise<StoredMessage | null>;
  readonly expedite: (qid?: string) => Promise<void>;
  readonly reconcile: () => Promise<void>;
}

export const createMobileOutbox = ({
  list,
  deliver,
  expedite,
  reconcile,
}: OutboxDependencies) => {
  const controller = new AbortController();
  const signal = Effect.runSync(Queue.dropping<true>(1));
  const slots = Effect.runSync(Semaphore.make(64));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconcileAt = Date.now() + 30_000;

  const arm = (at: number) => {
    clearTimeout(timer);

    if (!controller.signal.aborted && Number.isFinite(at)) {
      timer = setTimeout(
        () => {
          void wake();
        },
        Math.max(0, at - Date.now())
      );
    }
  };

  const sweep = Effect.gen(function* () {
    clearTimeout(timer);
    const pending = yield* Effect.promise(list);
    const now = Date.now();

    if (pending.some((row) => row.status === "held") && now >= reconcileAt) {
      yield* Effect.promise(reconcile);
      reconcileAt = Date.now() + 30_000;
    }

    const groups = new Map<string, StoredMessage[]>();
    const remaining: StoredMessage[] = [];

    for (const message of pending) {
      if (message.status === "queued" && message.nextAttemptAt <= now) {
        const group = groups.get(message.contactQid) ?? [];
        group.push(message);
        groups.set(message.contactQid, group);
      } else {
        remaining.push(message);
      }
    }

    const delivered = yield* Effect.forEach(
      groups.values(),
      (messages) =>
        Effect.forEach(
          messages,
          (message) =>
            slots.withPermit(
              Effect.promise((abort) => deliver(message, abort))
            ),
          { concurrency: 64 }
        ),
      { concurrency: 8 }
    );

    remaining.push(...delivered.flat().filter((row) => row !== null));

    let next = Number.POSITIVE_INFINITY;

    for (const row of remaining) {
      if (row.status === "queued") {
        next = Math.min(next, row.nextAttemptAt);
      } else if (row.status === "held") {
        next = Math.min(next, reconcileAt);
      }
    }

    arm(next);
  });

  void Effect.runPromiseExit(
    Effect.forever(
      Queue.take(signal).pipe(
        Effect.andThen(sweep),
        Effect.catchCause(() => Effect.sync(() => arm(Date.now() + 2000)))
      )
    ),
    { signal: controller.signal }
  );

  const wake = async (qid?: string, sync = false): Promise<void> => {
    if (controller.signal.aborted) {
      return;
    }

    if (qid || sync) {
      await expedite(qid).catch(() => {
        // A failed early wake keeps the persisted retry deadline.
      });
    }

    if (sync) {
      reconcileAt = Date.now();
    }

    if (!controller.signal.aborted) {
      Queue.offerUnsafe(signal, true);
    }
  };

  return {
    close: () => {
      controller.abort();
      clearTimeout(timer);
    },
    wake,
  };
};
