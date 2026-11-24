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

type OutboxEvent =
  | { readonly _tag: "Wake" | "Tick" }
  | {
      readonly _tag: "Delivered";
      readonly message: StoredMessage;
      readonly result: StoredMessage | null;
    };

const messageKey = (message: StoredMessage) =>
  `${message.contactQid}:${message.id}`;

export const createMobileOutbox = ({
  list,
  deliver,
  expedite,
  reconcile,
}: OutboxDependencies) => {
  const controller = new AbortController();
  const events = Effect.runSync(Queue.unbounded<OutboxEvent>());
  const slots = Effect.runSync(Semaphore.make(64));
  const pending = new Map<string, StoredMessage>();
  const inFlight = new Map<string, StoredMessage>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconcileAt = Date.now() + 30_000;

  const remember = (key: string, message: StoredMessage | null) => {
    if (
      message &&
      (message.status === "queued" ||
        message.status === "held" ||
        message.status === "sending")
    ) {
      pending.set(key, message);
    } else {
      pending.delete(key);
    }
  };

  const arm = (at: number, refresh = false) => {
    clearTimeout(timer);

    if (!controller.signal.aborted && Number.isFinite(at)) {
      timer = setTimeout(
        () => {
          Queue.offerUnsafe(events, { _tag: refresh ? "Wake" : "Tick" });
        },
        Math.max(0, at - Date.now())
      );
    }
  };

  const dispatch = Effect.fnUntraced(function* (
    groups: ReadonlyMap<string, readonly StoredMessage[]>,
    contacts: Map<string, number>
  ) {
    const ready = [...groups].toSorted(
      ([a], [b]) => (contacts.get(a) ?? 0) - (contacts.get(b) ?? 0)
    );

    for (let round = 0; inFlight.size < 64; round += 1) {
      let started = false;

      for (const [qid, messages] of ready) {
        const message = messages[round];

        if (
          !message ||
          inFlight.size >= 64 ||
          (!contacts.has(qid) && contacts.size >= 8)
        ) {
          continue;
        }

        started = true;
        inFlight.set(messageKey(message), message);
        contacts.set(qid, (contacts.get(qid) ?? 0) + 1);
        yield* Effect.forkScoped(
          slots
            .withPermit(
              Effect.promise((abort) => deliver(message, abort)).pipe(
                Effect.catchCause(() =>
                  Effect.succeed({
                    ...message,
                    nextAttemptAt: Date.now() + 2000,
                  })
                )
              )
            )
            .pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  Queue.offerUnsafe(events, {
                    _tag: "Delivered",
                    message,
                    result,
                  });
                })
              )
            )
        );
      }

      if (!started) {
        break;
      }
    }
  });

  const refresh = Effect.promise(list).pipe(
    Effect.tap((rows) =>
      Effect.sync(() => {
        pending.clear();

        for (const row of rows) {
          remember(messageKey(row), row);
        }
      })
    )
  );

  const sweep = Effect.gen(function* () {
    const batch = yield* Queue.takeAll(events);
    clearTimeout(timer);

    yield* (
      batch.some((event) => event._tag === "Wake") ? refresh : Effect.void
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const event of batch) {
            if (event._tag === "Delivered") {
              const key = messageKey(event.message);
              inFlight.delete(key);
              remember(key, event.result);
            }
          }
        })
      )
    );

    const now = Date.now();

    if (
      now >= reconcileAt &&
      [...pending.values()].some((row) => row.status === "held")
    ) {
      yield* Effect.promise(reconcile);
      reconcileAt = Date.now() + 30_000;
      yield* refresh;
    }

    const contacts = new Map<string, number>();

    for (const message of inFlight.values()) {
      contacts.set(
        message.contactQid,
        (contacts.get(message.contactQid) ?? 0) + 1
      );
    }

    const groups = new Map<string, StoredMessage[]>();
    let next = Number.POSITIVE_INFINITY;

    for (const [key, message] of pending) {
      if (inFlight.has(key)) {
        continue;
      }

      if (message.status === "held") {
        next = Math.min(next, reconcileAt);
      } else if (message.nextAttemptAt > now) {
        next = Math.min(next, message.nextAttemptAt);
      } else {
        const group = groups.get(message.contactQid) ?? [];
        group.push(message);
        groups.set(message.contactQid, group);
      }
    }

    yield* dispatch(groups, contacts);

    arm(next);
  });

  void Effect.runPromiseExit(
    Effect.scoped(
      Effect.forever(
        sweep.pipe(
          Effect.catchCause(() =>
            Effect.sync(() => arm(Date.now() + 2000, true))
          )
        )
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
      Queue.offerUnsafe(events, { _tag: "Wake" });
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
