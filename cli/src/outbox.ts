import type {
  ChatFrame,
  OutboxRecordV1,
  RegistryAccount,
  RegistryReaderError,
} from "@qop/protocol";
import { Effect } from "effect";

import type { createCliOutboxStore } from "./outbox-store.ts";

export const OUTBOX_INITIAL_BACKOFF_MS = 2000;
export const OUTBOX_MAX_BACKOFF_MS = 60_000;
export const OUTBOX_POLL_MS = 2000;

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
  const text = cause instanceof Error ? cause.message : String(cause);
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

/** Persist-before-send outbox with bounded retry while the CLI stays running. */
export const createOutboxRuntime = ({
  deliver,
  lookupHandle,
  now = () => Date.now(),
  onEvent,
  store,
}: {
  readonly deliver: (record: OutboxRecordV1) => Effect.Effect<void, unknown>;
  readonly lookupHandle: (
    handle: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly now?: () => number;
  readonly onEvent?: (event: OutboxEvent) => void;
  readonly store: ReturnType<typeof createCliOutboxStore>;
}) => {
  const inFlight = new Set<string>();
  let flushing = false;

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
    if (record.status !== "queued" || inFlight.has(record.frame.id)) {
      return;
    }
    inFlight.add(record.frame.id);
    yield* Effect.gen(function* () {
      const account = yield* lookupHandle(record.toHandle).pipe(Effect.result);
      if (account._tag === "Failure") {
        yield* markWaiting(record, account.failure);
        return;
      }
      if (!account.success) {
        yield* markWaiting(record, "Account was not found.");
        return;
      }
      if (!sameRecipient(account.success, record)) {
        yield* markFailed(record, "Handle now belongs to a different account.");
        return;
      }
      const outcome = yield* deliver(record).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        yield* markWaiting(record, outcome.failure);
        return;
      }
      const at = now();
      yield* store.put({
        ...record,
        lastError: null,
        status: "sent",
        updatedAt: at,
      });
      announce(onEvent, { handle: record.toHandle, kind: "sent" });
    }).pipe(
      Effect.ensuring(Effect.sync(() => inFlight.delete(record.frame.id)))
    );
  });

  const flushDue = Effect.fn("qop.outbox.flushDue")(function* () {
    if (flushing) {
      return;
    }
    flushing = true;
    yield* Effect.gen(function* () {
      const pending = yield* store.queued();
      const at = now();
      for (const record of pending) {
        if (record.nextAttemptAt <= at) {
          yield* deliverOne(record);
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          flushing = false;
        })
      )
    );
  });

  const resume = Effect.fn("qop.outbox.resume")(function* () {
    const pending = yield* store.queued();
    if (pending.length > 0) {
      announce(onEvent, { count: pending.length, kind: "resumed" });
    }
    return pending.length;
  });

  const run = Effect.forever(
    Effect.gen(function* () {
      yield* flushDue().pipe(Effect.ignore);
      yield* Effect.sleep(OUTBOX_POLL_MS);
    })
  );

  return { enqueue, flushDue, resume, run };
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
    case "waiting": {
      return `Waiting for @${event.handle}. Will retry when an authorized device is reachable.`;
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
