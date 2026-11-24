import { Effect } from "effect";

import type { StoredMessage } from "./db";

interface OutboxDependencies {
  readonly list: () => Promise<readonly StoredMessage[]>;
  readonly deliver: (
    message: StoredMessage,
    signal: AbortSignal
  ) => Promise<void>;
  readonly reconcile: () => Promise<void>;
}

export const createMobileOutbox = ({
  list,
  deliver,
  reconcile,
}: OutboxDependencies) => {
  const controller = new AbortController();
  const early = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let requested = false;
  let reconcileRequested = false;
  let reconciledAt = Date.now();
  let allEarly = false;

  const flush = async (): Promise<void> => {
    if (requested && !controller.signal.aborted) {
      requested = false;
      const bypass = new Set(early);
      const bypassAll = allEarly;
      allEarly = false;
      early.clear();
      const pending = await list();

      if (controller.signal.aborted) {
        return;
      }

      const held = pending.some((message) => message.status === "held");

      if (held && (reconcileRequested || Date.now() - reconciledAt >= 30_000)) {
        reconcileRequested = false;
        reconciledAt = Date.now();
        await reconcile();
      }

      const groups = new Map<string, StoredMessage[]>();

      for (const message of pending) {
        if (message.status === "queued") {
          const group = groups.get(message.contactQid) ?? [];
          group.push(message);
          groups.set(message.contactQid, group);
        }
      }

      await Effect.runPromise(
        Effect.forEach(
          groups.values(),
          (messages) => {
            const next = async (index: number): Promise<void> => {
              const message = messages[index];

              if (
                !message ||
                controller.signal.aborted ||
                (message.nextAttemptAt > Date.now() &&
                  !bypassAll &&
                  !bypass.has(message.contactQid))
              ) {
                return;
              }

              await deliver(message, controller.signal);
              const latest = await list();

              if (
                latest.some(
                  (row) =>
                    row.contactQid === message.contactQid &&
                    row.id === message.id &&
                    (row.status === "queued" || row.status === "sending")
                )
              ) {
                return;
              }

              return next(index + 1);
            };

            return Effect.promise(() => next(0));
          },
          { concurrency: 8 }
        )
      );

      return flush();
    }
  };

  const pump = async () => {
    try {
      await flush();
    } catch {
      // Persisted rows are retried after transient storage failures.
    } finally {
      if (!controller.signal.aborted) {
        try {
          const pending = await list();
          const heads = new Map<string, StoredMessage>();

          for (const message of pending) {
            if (message.status === "queued" && !heads.has(message.contactQid)) {
              heads.set(message.contactQid, message);
            }
          }

          const delays = [...heads.values()].map((message) =>
            Math.max(0, message.nextAttemptAt - Date.now())
          );

          if (pending.some((message) => message.status === "held")) {
            delays.push(Math.max(0, 30_000 - (Date.now() - reconciledAt)));
          }

          if (requested) {
            delays.push(0);
          }

          if (delays.length > 0 && !controller.signal.aborted) {
            timer = setTimeout(
              () => {
                void wake();
              },
              Math.max(100, Math.min(...delays))
            );
          }
        } catch {
          if (!controller.signal.aborted) {
            timer = setTimeout(() => {
              void wake();
            }, 2000);
          }
        }
      }

      running = undefined;
    }
  };

  const wake = (qid?: string, sync = false): Promise<void> => {
    if (controller.signal.aborted) {
      return Promise.resolve();
    }

    clearTimeout(timer);
    requested = true;
    reconcileRequested ||= sync;
    allEarly ||= sync;

    if (qid) {
      early.add(qid);
    }

    running ??= pump();

    return running;
  };

  return {
    close: () => {
      controller.abort();
      clearTimeout(timer);
    },
    wake,
  };
};
