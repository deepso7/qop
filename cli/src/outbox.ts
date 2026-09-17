import type {
  ChatFrame,
  OutboxRecordV1,
  RegistryAccount,
  RegistryReaderError,
} from "@qop/protocol";
import { Data, Effect, Semaphore } from "effect";

import { describeCliOutboxStoreError } from "./outbox-store.ts";
import type {
  CliOutboxStoreError,
  createCliOutboxStore,
} from "./outbox-store.ts";

export class CliOutboxDeliverError extends Data.TaggedError(
  "CliOutboxDeliverError"
)<{
  readonly operation: "timeout" | "transport" | "unauthorized";
}> {}

export const OUTBOX_INITIAL_BACKOFF_MS = 2000;
export const OUTBOX_MAX_BACKOFF_MS = 60_000;
export const OUTBOX_POLL_MS = 2000;
/** Cap concurrent deliveries so one hung peer cannot open unbounded streams. */
export const OUTBOX_FLUSH_CONCURRENCY = 8;

/** Jitter-free exponential backoff, capped at one minute. */
export const nextAttemptDelayMs = (attempts: number) => {
  if (attempts < 1) {
    return 0;
  }
  const shift = Math.min(attempts - 1, 16);
  return Math.min(
    OUTBOX_MAX_BACKOFF_MS,
    OUTBOX_INITIAL_BACKOFF_MS * 2 ** shift
  );
};

const noteFromError = (cause: unknown) => {
  let text: string;
  if (cause instanceof CliOutboxDeliverError) {
    text = cause.operation;
  } else if (cause instanceof Error) {
    text = cause.message;
  } else {
    text = String(cause);
  }
  const trimmed = text.trim() || "delivery failed";
  return trimmed.length > 400 ? trimmed.slice(0, 400) : trimmed;
};

const sameRecipient = (account: RegistryAccount, record: OutboxRecordV1) =>
  account.handle === record.toHandle && account.qid.toString() === record.toQid;

export type OutboxEvent =
  | {
      readonly handle: string;
      readonly kind: "failed";
      readonly reason: string;
    }
  | { readonly handle: string; readonly kind: "queued" }
  | { readonly count: number; readonly kind: "resumed" }
  | { readonly handle: string; readonly kind: "sent" }
  | {
      readonly kind: "store-error";
      readonly reason: string;
    }
  | {
      readonly handle: string;
      readonly kind: "waiting";
      readonly reason: string;
    };

const announce = (
  onEvent: ((event: OutboxEvent) => void) | undefined,
  event: OutboxEvent
) => {
  onEvent?.(event);
};

const groupByRecipient = (records: readonly OutboxRecordV1[]) => {
  const groups = new Map<string, OutboxRecordV1[]>();
  for (const record of records) {
    const group = groups.get(record.toQid);
    if (group) {
      group.push(record);
    } else {
      groups.set(record.toQid, [record]);
    }
  }
  return [...groups.values()];
};

/** Persist-before-send outbox with bounded retry while the CLI stays running. */
export const createOutboxRuntime = ({
  deliver,
  lookupHandle,
  now = () => Date.now(),
  onEvent,
  store,
}: {
  readonly deliver: (
    record: OutboxRecordV1
  ) => Effect.Effect<void, CliOutboxDeliverError>;
  readonly lookupHandle: (
    handle: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly now?: () => number;
  readonly onEvent?: (event: OutboxEvent) => void;
  readonly store: ReturnType<typeof createCliOutboxStore>;
}) => {
  const inFlight = new Set<string>();
  const recipientLocks = new Map<
    string,
    ReturnType<typeof Semaphore.makeUnsafe>
  >();

  const withRecipientLock = <A, E, R>(
    qid: string,
    effect: Effect.Effect<A, E, R>
  ) => {
    let lock = recipientLocks.get(qid);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      recipientLocks.set(qid, lock);
    }
    return lock.withPermit(effect);
  };

  const announceStoreError = (error: CliOutboxStoreError) => {
    announce(onEvent, {
      kind: "store-error",
      reason: describeCliOutboxStoreError(error),
    });
  };

  const enqueue = Effect.fn("qop.outbox.enqueue")(function* ({
    frame,
    toHandle,
    toQid,
  }: {
    readonly frame: ChatFrame;
    readonly toHandle: string;
    readonly toQid: string;
  }) {
    const at = now();
    const record: OutboxRecordV1 = {
      attempts: 0,
      frame,
      lastError: null,
      nextAttemptAt: at,
      queuedAt: at,
      status: "queued",
      toHandle,
      toQid,
      updatedAt: at,
      v: 1,
    };
    const saved = yield* store.enqueue(record);
    if (saved.status === "queued" && saved.attempts === 0) {
      announce(onEvent, { handle: saved.toHandle, kind: "queued" });
    }
    return saved;
  });

  const markWaiting = Effect.fn("qop.outbox.markWaiting")(function* (
    record: OutboxRecordV1,
    cause: unknown
  ) {
    const attempts = record.attempts + 1;
    const at = now();
    const reason = noteFromError(cause);
    const updated: OutboxRecordV1 = {
      ...record,
      attempts,
      lastError: reason,
      nextAttemptAt: at + nextAttemptDelayMs(attempts),
      status: "queued",
      updatedAt: at,
    };
    yield* store.put(updated);
    announce(onEvent, { handle: record.toHandle, kind: "waiting", reason });
  });

  const markFailed = Effect.fn("qop.outbox.markFailed")(function* (
    record: OutboxRecordV1,
    reason: string
  ) {
    const at = now();
    yield* store.put({
      ...record,
      lastError: noteFromError(reason),
      status: "failed",
      updatedAt: at,
    });
    announce(onEvent, { handle: record.toHandle, kind: "failed", reason });
  });

  const deliverOne = Effect.fn("qop.outbox.deliverOne")(function* (
    record: OutboxRecordV1
  ) {
    if (inFlight.has(record.frame.id)) {
      return;
    }
    inFlight.add(record.frame.id);
    yield* withRecipientLock(
      record.toQid,
      Effect.gen(function* () {
        const latest = (yield* store.loadRecords()).find(
          (item) => item.frame.id === record.frame.id
        );
        if (!latest || latest.status !== "queued") {
          return;
        }
        const account = yield* lookupHandle(latest.toHandle).pipe(
          Effect.result
        );
        if (account._tag === "Failure") {
          yield* markWaiting(latest, account.failure);
          return;
        }
        if (!account.success) {
          yield* markWaiting(latest, "Account was not found.");
          return;
        }
        if (!sameRecipient(account.success, latest)) {
          yield* markFailed(
            latest,
            "Handle now belongs to a different account."
          );
          return;
        }
        const outcome = yield* deliver(latest).pipe(Effect.result);
        if (outcome._tag === "Failure") {
          yield* markWaiting(latest, outcome.failure);
          return;
        }
        const at = now();
        yield* store.put({
          ...latest,
          lastError: null,
          status: "sent",
          updatedAt: at,
        });
        announce(onEvent, { handle: latest.toHandle, kind: "sent" });
      })
    ).pipe(
      Effect.ensuring(Effect.sync(() => inFlight.delete(record.frame.id)))
    );
  });

  const deliverDue = (record: OutboxRecordV1) =>
    deliverOne(record).pipe(
      Effect.catchTag("CliOutboxStoreError", (error) =>
        Effect.sync(() => {
          announceStoreError(error);
        })
      )
    );

  const flushDue = Effect.fn("qop.outbox.flushDue")(function* (options?: {
    readonly ignoreBackoffForQid?: string;
  }) {
    const pending = yield* store.queued();
    const at = now();
    const due = pending.filter(
      (record) =>
        record.nextAttemptAt <= at ||
        record.toQid === options?.ignoreBackoffForQid
    );
    yield* Effect.forEach(
      groupByRecipient(due),
      (records) => Effect.forEach(records, deliverDue, { concurrency: 1 }),
      { concurrency: OUTBOX_FLUSH_CONCURRENCY }
    );
  });

  const flushDueOrAnnounce = (options?: {
    readonly ignoreBackoffForQid?: string;
  }) =>
    flushDue(options).pipe(
      Effect.catchTag("CliOutboxStoreError", (error) =>
        Effect.sync(() => {
          announceStoreError(error);
        })
      )
    );

  const resume = Effect.fn("qop.outbox.resume")(function* () {
    const pending = yield* store.queued();
    if (pending.length > 0) {
      announce(onEvent, { count: pending.length, kind: "resumed" });
    }
    return pending.length;
  });

  /** Skip registry work unless a waiting record could use this peer's qid. */
  const flushOnConnection = Effect.fn("qop.outbox.flushOnConnection")(
    function* (peerQid: Effect.Effect<string | undefined>) {
      const pending = yield* store.queued().pipe(
        Effect.catchTag("CliOutboxStoreError", (error) =>
          Effect.sync((): OutboxRecordV1[] => {
            announceStoreError(error);
            return [];
          })
        )
      );
      if (pending.length === 0) {
        return;
      }
      const at = now();
      if (pending.every((record) => record.nextAttemptAt <= at)) {
        yield* flushDueOrAnnounce();
        return;
      }
      const qid = yield* peerQid;
      yield* flushDueOrAnnounce(qid ? { ignoreBackoffForQid: qid } : undefined);
    }
  );

  const run = Effect.forever(
    Effect.gen(function* () {
      yield* flushDueOrAnnounce();
      yield* Effect.sleep(OUTBOX_POLL_MS);
    })
  );

  return { enqueue, flushDue, flushOnConnection, resume, run };
};

export const describeOutboxEvent = (event: OutboxEvent) => {
  switch (event.kind) {
    case "failed": {
      return `Failed for @${event.handle}: ${event.reason}`;
    }
    case "queued": {
      return `Queued for @${event.handle}. Delivery waits until an authorized device is reachable.`;
    }
    case "resumed": {
      return `Resuming ${event.count} queued message${event.count === 1 ? "" : "s"}.`;
    }
    case "sent": {
      return `Sent to @${event.handle}.`;
    }
    case "store-error": {
      return event.reason;
    }
    case "waiting": {
      return `Waiting for @${event.handle} (${event.reason}). Will retry when an authorized device is reachable.`;
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
