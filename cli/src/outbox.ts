import type {
  ChatFrame,
  OutboxRecordV1,
  RegistryAccount,
  RegistryReaderError,
} from "@qop/protocol";
import { Data, Effect, Option, Queue } from "effect";

import { describeCliOutboxStoreError } from "./outbox-store.ts";
import type { CliOutboxStore, CliOutboxStoreError } from "./outbox-store.ts";

export class CliOutboxDeliverError extends Data.TaggedError(
  "CliOutboxDeliverError"
)<{
  readonly operation: "timeout" | "transport" | "unauthorized";
}> {}

export const OUTBOX_INITIAL_BACKOFF_MS = 2000;
export const OUTBOX_MAX_BACKOFF_MS = 60_000;
/** Cap concurrent deliveries so one hung peer cannot open unbounded streams. */
export const OUTBOX_FLUSH_CONCURRENCY = 8;
/** Bound connected-peer registry lookups so a hung RPC cannot stall the consumer. */
export const OUTBOX_PEER_LOOKUP_TIMEOUT_MS = 5000;

export type OutboxWake =
  | { readonly kind: "enqueued" }
  | { readonly kind: "connected"; readonly peerId: string };

/** Build a freshly queued outbox row. Callers persist via `enqueue`. */
export const newOutboxRecord = ({
  frame,
  now,
  toHandle,
  toQid,
}: {
  readonly frame: ChatFrame;
  readonly now: number;
  readonly toHandle: string;
  readonly toQid: string;
}): OutboxRecordV1 => ({
  attempts: 0,
  frame,
  lastError: null,
  nextAttemptAt: now,
  queuedAt: now,
  status: "queued",
  toHandle,
  toQid,
  updatedAt: now,
  v: 1,
});

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

interface FlushDueOptions {
  readonly ignoreBackoffForQid?: string;
  readonly ignoreBackoffForQids?: readonly string[];
}

/** Persist-before-send outbox with one consumer fiber woken by a Queue. */
export const createOutboxRuntime = Effect.fn("qop.createOutboxRuntime")(
  function* ({
    deliver,
    lookupHandle,
    lookupPeerQid,
    now = () => Date.now(),
    onEvent,
    store,
  }: {
    readonly deliver: (
      record: OutboxRecordV1,
      account: RegistryAccount
    ) => Effect.Effect<void, CliOutboxDeliverError>;
    readonly lookupHandle: (
      handle: string
    ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
    readonly lookupPeerQid?: (
      peerId: string
    ) => Effect.Effect<string | undefined>;
    readonly now?: () => number;
    readonly onEvent?: (event: OutboxEvent) => void;
    readonly store: CliOutboxStore;
  }) {
    const wakes = yield* Queue.make<OutboxWake>();
    let storeErrorReason: string | undefined;
    let storeErrorSeq = 0;

    const announceStoreError = (error: CliOutboxStoreError) => {
      const reason = describeCliOutboxStoreError(error);
      storeErrorSeq += 1;
      if (storeErrorReason === reason) {
        return;
      }
      storeErrorReason = reason;
      announce(onEvent, {
        kind: "store-error",
        reason,
      });
    };

    const enqueue = Effect.fn("qop.outbox.enqueue")(function* (
      record: OutboxRecordV1
    ) {
      const saved = yield* store.enqueue(record);
      yield* Queue.offer(wakes, { kind: "enqueued" });
      if (saved.status === "queued" && saved.attempts === 0) {
        announce(onEvent, { handle: saved.toHandle, kind: "queued" });
      }
      return saved;
    });

    const wake = (peerId: string) =>
      Queue.offer(wakes, { kind: "connected", peerId });

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
      const [latest] = yield* store.getByIds([record.frame.id]);
      if (!latest || latest.status !== "queued") {
        return;
      }
      const account = yield* lookupHandle(latest.toHandle).pipe(Effect.result);
      if (account._tag === "Failure") {
        yield* markWaiting(latest, account.failure);
        return;
      }
      if (!account.success) {
        yield* markWaiting(latest, "Account was not found.");
        return;
      }
      if (!sameRecipient(account.success, latest)) {
        yield* markFailed(latest, "Handle now belongs to a different account.");
        return;
      }
      const outcome = yield* deliver(latest, account.success).pipe(
        Effect.result
      );
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
    });

    const deliverDue = (record: OutboxRecordV1) =>
      deliverOne(record).pipe(
        Effect.catchTag("CliOutboxStoreError", (error) =>
          Effect.sync(() => {
            announceStoreError(error);
          })
        )
      );

    const deliverRecipient = (records: readonly OutboxRecordV1[]) =>
      Effect.forEach(records, deliverDue, { concurrency: 1 });

    const flushDue = Effect.fn("qop.outbox.flushDue")(function* (
      options?: FlushDueOptions
    ) {
      const pending = yield* store.queued();
      const errorSeq = storeErrorSeq;
      const at = now();
      const skip = new Set<string>();
      if (options?.ignoreBackoffForQids) {
        for (const qid of options.ignoreBackoffForQids) {
          skip.add(qid);
        }
      }
      if (options?.ignoreBackoffForQid !== undefined) {
        skip.add(options.ignoreBackoffForQid);
      }
      const due = pending.filter(
        (record) => record.nextAttemptAt <= at || skip.has(record.toQid)
      );
      yield* Effect.forEach(groupByRecipient(due), deliverRecipient, {
        concurrency: OUTBOX_FLUSH_CONCURRENCY,
      });
      if (storeErrorSeq === errorSeq) {
        storeErrorReason = undefined;
      }
    });

    const flushDueOrAnnounce = (options?: FlushDueOptions) =>
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

    const takeWakes = (sleepFor: number | undefined) =>
      sleepFor === undefined
        ? Queue.take(wakes).pipe(Effect.map((first) => [first]))
        : Queue.take(wakes).pipe(
            Effect.timeoutOption(sleepFor),
            Effect.map((taken) => (Option.isSome(taken) ? [taken.value] : []))
          );

    let ignoreBackoffForQids: readonly string[] = [];
    const run = Effect.forever(
      Effect.gen(function* () {
        yield* flushDueOrAnnounce(
          ignoreBackoffForQids.length > 0 ? { ignoreBackoffForQids } : undefined
        );
        const pendingResult = yield* store.queued().pipe(Effect.result);
        let pending: readonly OutboxRecordV1[] = [];
        let sleepFor: number | undefined;
        const at = now();
        if (pendingResult._tag === "Failure") {
          // Don't treat a failed read as an empty outbox (that parks forever).
          announceStoreError(pendingResult.failure);
          sleepFor = OUTBOX_INITIAL_BACKOFF_MS;
        } else {
          pending = pendingResult.success;
          if (pending.length > 0) {
            // Due rows left queued after a swallowed write must not spin at 0.
            sleepFor = Math.max(
              OUTBOX_INITIAL_BACKOFF_MS,
              Math.min(...pending.map((record) => record.nextAttemptAt)) - at
            );
          }
        }
        const taken = yield* takeWakes(sleepFor);
        const drained = yield* Queue.clear(wakes);
        const seen = [...taken, ...drained];
        // Recompute after the wait so expired backoff isn't treated as waiting.
        const afterWait = now();
        const waiting = pending.some(
          (record) => record.nextAttemptAt > afterWait
        );
        const connectedPeerIds = [
          ...new Set(
            seen.flatMap((item) =>
              item.kind === "connected" ? [item.peerId] : []
            )
          ),
        ];
        if (!waiting || connectedPeerIds.length === 0 || !lookupPeerQid) {
          ignoreBackoffForQids = [];
          return;
        }
        const found = yield* Effect.forEach(
          connectedPeerIds,
          (peerId) =>
            lookupPeerQid(peerId).pipe(
              Effect.timeoutOption(OUTBOX_PEER_LOOKUP_TIMEOUT_MS)
            ),
          { concurrency: "unbounded" }
        );
        ignoreBackoffForQids = found.flatMap((qidOption) => {
          if (Option.isNone(qidOption) || qidOption.value === undefined) {
            return [];
          }
          return [qidOption.value];
        });
      })
    );

    return { enqueue, flushDue, resume, run, wake };
  }
);

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
