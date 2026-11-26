import { Effect, Queue } from "effect";

import type { StoredMessage } from "./db";

export type DeliveryOutcome =
  | { readonly kind: "aborted" }
  | { readonly kind: "delivered" }
  | { readonly kind: "failed" }
  | { readonly kind: "retry"; readonly nextAttemptAt: number };

export interface OutboxWakeOptions {
  readonly contactQid?: string;
  /** Message keys (`${contactQid}:${id}`) whose retry deadlines must be preserved. */
  readonly excludeKeys?: ReadonlySet<string>;
  readonly expediteAll?: boolean;
  /** Wake waiting rows without cancelling the backoff of an already in-flight attempt. */
  readonly skipInFlight?: boolean;
}

export interface OutboxDependencies {
  readonly deliver: (
    message: StoredMessage,
    signal: AbortSignal,
    wasExpedited: () => boolean
  ) => Promise<DeliveryOutcome>;
  readonly expedite: (
    contactQid?: string,
    excludeKeys?: ReadonlySet<string>
  ) => Promise<void>;
  readonly list: () => Promise<readonly StoredMessage[]>;
  readonly reconcile: () => Promise<void>;
}

const MAX_IN_FLIGHT = 64;
const MAX_ACTIVE_CONTACTS = 8;
const HELD_RECONCILE_INTERVAL_MS = 30_000;
const ERROR_RETRY_MS = 2000;

const messageKey = (contactQid: string, id: string) => `${contactQid}:${id}`;

/**
 * Durable outbox scheduler backed directly by SQLite (no mirrored row cache).
 *
 * - Fresh messages (`attempts === 0`) and healthy contacts fan out up to 64 sends
 *   across 8 contacts so online bursts stay fast.
 * - Retrying contacts (`attempts > 0`) probe 1 message per backoff window so an
 *   offline contact never triggers a parallel dial/RPC storm; once the probe
 *   succeeds, remaining due messages for that contact fan out immediately.
 * - Periodic held-receipt reconciliation runs on an independent timer so slow
 *   holder polls never block new sends or peer-connect wakes.
 */
export const createMobileOutbox = ({
  deliver,
  expedite,
  list,
  reconcile,
}: OutboxDependencies) => {
  const controller = new AbortController();
  const wakes = Effect.runSync(Queue.unbounded<true>());
  const inFlight = new Map<string, string>();
  const messageRetryUntil = new Map<string, Map<string, number>>();
  const contactCooldownUntil = new Map<string, number>();
  const healthyContacts = new Set<string>();

  const setMessageRetry = (qid: string, id: string, until: number) => {
    const byContact = messageRetryUntil.get(qid);

    if (byContact) {
      byContact.set(id, until);
    } else {
      messageRetryUntil.set(qid, new Map([[id, until]]));
    }
  };

  const clearMessageRetry = (qid: string, id: string) => {
    const byContact = messageRetryUntil.get(qid);

    if (!byContact) {
      return;
    }

    byContact.delete(id);

    if (byContact.size === 0) {
      messageRetryUntil.delete(qid);
    }
  };

  let expediteSeq = 0;
  let expeditedAllSeq = 0;
  const expeditedContactSeq = new Map<string, number>();

  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileInFlight = false;

  const notify = () => {
    if (!controller.signal.aborted) {
      Queue.offerUnsafe(wakes, true);
    }
  };

  const armRetry = (at: number) => {
    clearTimeout(retryTimer);
    retryTimer = undefined;

    if (!controller.signal.aborted && Number.isFinite(at)) {
      retryTimer = setTimeout(notify, Math.max(0, at - Date.now()));
    }
  };

  const runPeriodicReconcile = () => {
    reconcileTimer = undefined;

    if (controller.signal.aborted || reconcileInFlight) {
      return;
    }

    reconcileInFlight = true;
    void reconcile()
      .catch(() => {
        // Reconcile is best-effort; retry on the next 30s tick if held rows remain.
      })
      .finally(() => {
        reconcileInFlight = false;
        notify();
      });
  };

  const syncReconcileTimer = (hasHeld: boolean) => {
    if (!hasHeld) {
      clearTimeout(reconcileTimer);
      reconcileTimer = undefined;

      return;
    }

    if (!reconcileTimer && !reconcileInFlight && !controller.signal.aborted) {
      reconcileTimer = setTimeout(
        runPeriodicReconcile,
        HELD_RECONCILE_INTERVAL_MS
      );
    }
  };

  const makeExpeditedCheck = (qid: string, startedSeq: number) => () =>
    Math.max(expeditedAllSeq, expeditedContactSeq.get(qid) ?? 0) > startedSeq;

  const dispatch = Effect.fnUntraced(function* (
    groups: ReadonlyMap<string, readonly StoredMessage[]>,
    activePerContact: Map<string, number>,
    probingContacts: ReadonlySet<string>
  ) {
    const ready = [...groups].toSorted(
      ([a], [b]) =>
        (activePerContact.get(a) ?? 0) - (activePerContact.get(b) ?? 0)
    );

    for (let round = 0; inFlight.size < MAX_IN_FLIGHT; round += 1) {
      let started = false;

      for (const [qid, messages] of ready) {
        const message = messages[round];

        if (!message || inFlight.size >= MAX_IN_FLIGHT) {
          continue;
        }

        const activeForContact = activePerContact.get(qid) ?? 0;

        if (
          activeForContact === 0 &&
          activePerContact.size >= MAX_ACTIVE_CONTACTS
        ) {
          continue;
        }

        // Probe backed-off contacts 1 message at a time until a send succeeds.
        if (probingContacts.has(qid) && activeForContact >= 1) {
          continue;
        }

        const key = messageKey(qid, message.id);
        const wasExpedited = makeExpeditedCheck(qid, expediteSeq);

        started = true;
        inFlight.set(key, qid);
        activePerContact.set(qid, activeForContact + 1);

        yield* Effect.forkScoped(
          Effect.promise((signal) => deliver(message, signal, wasExpedited))
            .pipe(
              Effect.catchCause(() =>
                Effect.succeed<DeliveryOutcome>({
                  kind: "retry",
                  nextAttemptAt: Date.now() + ERROR_RETRY_MS,
                })
              )
            )
            .pipe(
              Effect.tap((outcome) =>
                Effect.sync(() => {
                  inFlight.delete(key);

                  if (outcome.kind === "delivered") {
                    clearMessageRetry(qid, message.id);
                    contactCooldownUntil.delete(qid);
                    healthyContacts.add(qid);
                  } else if (outcome.kind === "failed") {
                    clearMessageRetry(qid, message.id);
                  } else if (outcome.kind === "retry") {
                    healthyContacts.delete(qid);

                    if (!wasExpedited() && outcome.nextAttemptAt > Date.now()) {
                      setMessageRetry(qid, message.id, outcome.nextAttemptAt);
                      contactCooldownUntil.set(qid, outcome.nextAttemptAt);
                    } else {
                      clearMessageRetry(qid, message.id);
                    }
                  }

                  notify();
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

  const sweep = Effect.gen(function* () {
    yield* Queue.takeAll(wakes);
    clearTimeout(retryTimer);
    retryTimer = undefined;

    // Exclude keys already in flight before reading SQLite so a row that commits
    // `sent` during `list()` cannot be dispatched a second time from this snapshot.
    const inFlightBeforeRead = new Set(inFlight.keys());
    const rows = yield* Effect.promise(list);
    const now = Date.now();
    let hasHeld = false;

    const activePerContact = new Map<string, number>();

    for (const qid of inFlight.values()) {
      activePerContact.set(qid, (activePerContact.get(qid) ?? 0) + 1);
    }

    const probingContacts = new Set<string>();

    for (const qid of contactCooldownUntil.keys()) {
      if (!healthyContacts.has(qid)) {
        probingContacts.add(qid);
      }
    }

    for (const row of rows) {
      if (
        row.status === "queued" &&
        row.attempts > 0 &&
        !healthyContacts.has(row.contactQid)
      ) {
        probingContacts.add(row.contactQid);
      }
    }

    const groups = new Map<string, StoredMessage[]>();
    let nextWakeAt = Number.POSITIVE_INFINITY;

    for (const row of rows) {
      if (row.status === "held") {
        hasHeld = true;
        continue;
      }

      if (row.status !== "queued") {
        continue;
      }

      const key = messageKey(row.contactQid, row.id);

      if (inFlight.has(key) || inFlightBeforeRead.has(key)) {
        continue;
      }

      const messageCooldown =
        messageRetryUntil.get(row.contactQid)?.get(row.id) ?? 0;

      const contactCooldown = contactCooldownUntil.get(row.contactQid) ?? 0;

      const dueAt = Math.max(
        row.nextAttemptAt,
        messageCooldown,
        contactCooldown
      );

      if (dueAt > now) {
        nextWakeAt = Math.min(nextWakeAt, dueAt);
        continue;
      }

      clearMessageRetry(row.contactQid, row.id);

      const group = groups.get(row.contactQid);

      if (group) {
        group.push(row);
      } else {
        groups.set(row.contactQid, [row]);
      }
    }

    syncReconcileTimer(hasHeld);
    yield* dispatch(groups, activePerContact, probingContacts);
    armRetry(nextWakeAt);
  });

  void Effect.runPromiseExit(
    Effect.scoped(
      Effect.forever(
        sweep.pipe(
          Effect.catchCause(() =>
            Effect.sync(() => armRetry(Date.now() + ERROR_RETRY_MS))
          )
        )
      )
    ),
    { signal: controller.signal }
  );

  const clearContactRetries = (
    qid: string,
    excludeKeys?: ReadonlySet<string>
  ) => {
    const byContact = messageRetryUntil.get(qid);

    if (!byContact) {
      return;
    }

    if (!excludeKeys || excludeKeys.size === 0) {
      messageRetryUntil.delete(qid);

      return;
    }

    for (const id of byContact.keys()) {
      if (!excludeKeys.has(messageKey(qid, id))) {
        byContact.delete(id);
      }
    }

    if (byContact.size === 0) {
      messageRetryUntil.delete(qid);
    }
  };

  const wake = async (options?: OutboxWakeOptions): Promise<void> => {
    if (controller.signal.aborted) {
      return;
    }

    const contactQid = options?.contactQid;
    const excludeKeys = options?.excludeKeys;
    const expediteAll = options?.expediteAll === true;

    if (contactQid !== undefined || expediteAll) {
      if (expediteAll) {
        if (!options?.skipInFlight) {
          expediteSeq += 1;
          expeditedAllSeq = expediteSeq;
        }

        if (!excludeKeys || excludeKeys.size === 0) {
          messageRetryUntil.clear();
        } else {
          for (const qid of messageRetryUntil.keys()) {
            clearContactRetries(qid, excludeKeys);
          }
        }

        contactCooldownUntil.clear();
      } else if (contactQid !== undefined) {
        if (!options?.skipInFlight) {
          expediteSeq += 1;
          expeditedContactSeq.set(contactQid, expediteSeq);
        }

        clearContactRetries(contactQid, excludeKeys);
        contactCooldownUntil.delete(contactQid);
      }

      await expedite(contactQid, excludeKeys).catch(() => {
        // Keep the persisted retry deadline if expediting fails.
      });
    }

    notify();
  };

  return {
    close: () => {
      controller.abort();
      clearTimeout(retryTimer);
      clearTimeout(reconcileTimer);
      retryTimer = undefined;
      reconcileTimer = undefined;
    },
    isInFlight: (contactQid: string, id: string) =>
      inFlight.has(messageKey(contactQid, id)),
    wake,
  };
};
