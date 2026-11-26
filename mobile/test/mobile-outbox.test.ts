import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import type { StoredMessage } from "@/lib/db";
import { createMobileOutbox } from "@/lib/mobile-outbox";
import type { DeliveryOutcome } from "@/lib/mobile-outbox";

const message = (
  id: string,
  contactQid = "1",
  overrides: Partial<StoredMessage> = {}
): StoredMessage => ({
  attempts: 0,
  contactQid,
  direction: "out",
  holderPeerId: null,
  id,
  nextAttemptAt: 0,
  receivedAt: 1,
  sentAt: 1,
  status: "queued",
  text: id,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

it("does not block new sends while periodic held reconciliation is running", async () => {
  vi.useFakeTimers();
  const poll = Promise.withResolvers<true>();
  let rows: StoredMessage[] = [message("held", "1", { status: "held" })];

  const reconcile = vi.fn(async () => {
    await poll.promise;
  });

  const deliver = vi.fn((row: StoredMessage): Promise<DeliveryOutcome> => {
    rows = rows.filter((item) => item.id !== row.id);

    return Promise.resolve({ kind: "delivered" });
  });

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile,
  });

  try {
    await worker.wake();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledOnce();

    // New message arrives while the 30s reconcile is still hanging.
    rows = [...rows, message("fresh", "2")];
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver.mock.calls[0]?.[0].id).toBe("fresh");

    poll.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    worker.close();
    poll.resolve(true);
  }
});

it("retries immediately when expedited while a failing attempt is still in flight", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<true>();
  let rows = [message("m1")];
  let attempt = 0;

  const deliver = vi.fn(
    async (
      row: StoredMessage,
      _signal: AbortSignal,
      wasExpedited: () => boolean
    ): Promise<DeliveryOutcome> => {
      attempt += 1;

      if (attempt === 1) {
        await gate.promise;
        const nextAttemptAt = wasExpedited() ? 0 : Date.now() + 60_000;

        rows = rows.map((item) =>
          item.id === row.id ? { ...item, attempts: 1, nextAttemptAt } : item
        );

        return { kind: "retry", nextAttemptAt };
      }

      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => {
      rows = rows.map((row) => ({ ...row, nextAttemptAt: 0 }));

      return Promise.resolve();
    },
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

    // Contact comes online before attempt 1 finishes failing.
    await worker.wake({ contactQid: "1" });
    gate.resolve(true);

    // Must retry immediately without waiting for any backoff timer.
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(rows).toEqual([]);
  } finally {
    worker.close();
    gate.resolve(true);
  }
});

it("probes backed-off contacts one message at a time and fans out once the probe succeeds", async () => {
  vi.useFakeTimers();
  const probe1 = Promise.withResolvers<true>();

  let rows = Array.from({ length: 5 }, (_, index) =>
    message(`m${index}`, "1", { attempts: 1, nextAttemptAt: 0 })
  );

  let online = false;

  const deliver = vi.fn(
    async (row: StoredMessage): Promise<DeliveryOutcome> => {
      if (!online) {
        await probe1.promise;
        const nextAttemptAt = Date.now() + 4000;

        rows = rows.map((item) =>
          item.id === row.id
            ? { ...item, attempts: item.attempts + 1, nextAttemptAt }
            : item
        );

        return { kind: "retry", nextAttemptAt };
      }

      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    // Only 1 probe started despite 5 due retrying messages.
    expect(deliver.mock.calls[0]?.[0].id).toBe("m0");

    // Probe fails -> contact enters 4s cooldown; other 4 messages do NOT fire.
    probe1.resolve(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledOnce();

    // After cooldown expires, contact is online -> probe succeeds and remaining 4 fan out.
    online = true;
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(6));
    expect(rows).toEqual([]);
  } finally {
    worker.close();
    probe1.resolve(true);
  }
});

it("isolates a delivery rejection without aborting its sibling", async () => {
  const gate = Promise.withResolvers<true>();
  let siblingSignal: AbortSignal | undefined;

  const worker = createMobileOutbox({
    deliver: async (row, signal) => {
      if (row.id === "fault") {
        throw new Error("one storage read failed");
      }

      siblingSignal = signal;
      await gate.promise;

      return { kind: "delivered" };
    },
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve([message("sibling"), message("fault")]),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(siblingSignal).toBeDefined());
    await sleep(30);
    expect(siblingSignal?.aborted).toBe(false);
  } finally {
    worker.close();
    gate.resolve(true);
  }
});

it("gives a new contact the next free slot during a 300-message burst and bounds at 64", async () => {
  const first = Promise.withResolvers<true>();
  const rest = Promise.withResolvers<true>();
  const fresh = Promise.withResolvers<true>();
  let rows = Array.from({ length: 300 }, (_, index) => message(String(index)));
  let active = 0;
  let maximum = 0;

  const deliver = vi.fn(
    async (row: StoredMessage): Promise<DeliveryOutcome> => {
      active += 1;
      maximum = Math.max(maximum, active);

      if (row.id === "new") {
        await fresh.promise;
      } else {
        await (row.id === "0" ? first.promise : rest.promise);
      }

      active -= 1;
      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(active).toBe(64));
    rows = [...rows, message("new", "2")];
    await worker.wake();
    first.resolve(true);
    await vi.waitFor(() =>
      expect(deliver.mock.calls.some(([row]) => row.id === "new")).toBe(true)
    );
    expect(maximum).toBe(64);
  } finally {
    worker.close();
    first.resolve(true);
    rest.resolve(true);
    fresh.resolve(true);
  }
});

it("admits at most eight contacts at once", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<true>();

  let rows = Array.from({ length: 10 }, (_, index) =>
    message(String(index), String(index))
  );

  const deliver = vi.fn(
    async (row: StoredMessage): Promise<DeliveryOutcome> => {
      await gate.promise;
      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(8));
    gate.resolve(true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(10));
  } finally {
    worker.close();
    gate.resolve(true);
  }
});

it("backs off storage errors, parks when empty, and cancels timers on close", async () => {
  vi.useFakeTimers();

  const list = vi
    .fn<() => Promise<readonly StoredMessage[]>>()
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue([]);

  const deliver = vi.fn((): Promise<DeliveryOutcome> =>
    Promise.resolve({ kind: "delivered" })
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list,
    reconcile: () => Promise.resolve(),
  });

  const closingList = vi
    .fn<() => Promise<readonly StoredMessage[]>>()
    .mockRejectedValue(new Error("storage unavailable"));

  const closingWorker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: closingList,
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(vi.getTimerCount()).toBe(0);
    worker.close();

    // Closing while a retry timer is armed removes the timer and prevents retrying.
    await closingWorker.wake();
    await vi.waitFor(() => expect(closingList).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    closingWorker.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2500);
    expect(closingList).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
  } finally {
    worker.close();
    closingWorker.close();
  }
});

it("keeps a retry scheduled if expediting fails", async () => {
  vi.useFakeTimers();

  let rows = [
    message("retry", "1", { attempts: 1, nextAttemptAt: Date.now() + 2000 }),
  ];

  const deliver = vi.fn((row: StoredMessage): Promise<DeliveryOutcome> => {
    rows = rows.filter((item) => item.id !== row.id);

    return Promise.resolve({ kind: "delivered" });
  });

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.reject(new Error("storage unavailable")),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await expect(worker.wake({ contactQid: "1" })).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  } finally {
    worker.close();
  }
});

it("honors a fallback retry pause on a fresh row when storage writes fail", async () => {
  vi.useFakeTimers();

  let rows = [message("fresh-fail", "1", { attempts: 0, nextAttemptAt: 0 })];

  const deliver = vi
    .fn<(row: StoredMessage) => Promise<DeliveryOutcome>>()
    .mockImplementationOnce(() =>
      // Simulate storage write failure: attempts & nextAttemptAt stay 0 in SQLite.
      Promise.resolve({ kind: "retry", nextAttemptAt: Date.now() + 2000 })
    )
    .mockImplementationOnce((row) => {
      rows = rows.filter((item) => item.id !== row.id);

      return Promise.resolve({ kind: "delivered" });
    });

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

    // Must wait the 2s fallback pause instead of spinning immediately.
    await vi.advanceTimersByTimeAsync(1000);
    expect(deliver).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(rows).toEqual([]);
  } finally {
    worker.close();
  }
});

it("does not re-dispatch a row that commits while a sweep read is in flight", async () => {
  const firstDelivery = Promise.withResolvers<true>();
  const pausedList = Promise.withResolvers<readonly StoredMessage[]>();
  let rows = [message("once")];
  let listCalls = 0;

  const list = vi.fn(() => {
    listCalls += 1;

    if (listCalls === 2) {
      return pausedList.promise;
    }

    return Promise.resolve(rows);
  });

  const deliver = vi.fn(
    async (row: StoredMessage): Promise<DeliveryOutcome> => {
      await firstDelivery.promise;
      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list,
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

    // Start a second sweep whose read captures the stale queued snapshot.
    const staleSnapshot = [...rows];
    await worker.wake();
    await vi.waitFor(() => expect(listCalls).toBe(2));

    // Original delivery commits `sent` and clears `inFlight` before `list()` resolves.
    firstDelivery.resolve(true);
    await vi.waitFor(() => expect(worker.isInFlight("1", "once")).toBe(false));
    pausedList.resolve(staleSnapshot);
    await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(3));

    expect(deliver).toHaveBeenCalledOnce();
  } finally {
    worker.close();
    firstDelivery.resolve(true);
    pausedList.resolve([]);
  }
});

it("applies the probe limit and cooldown to fresh rows for a contact already in backoff", async () => {
  vi.useFakeTimers();
  const probe = Promise.withResolvers<true>();
  let online = false;

  let rows: StoredMessage[] = [
    message("retrying", "1", { attempts: 1, nextAttemptAt: 0 }),
  ];

  const deliver = vi.fn(
    async (row: StoredMessage): Promise<DeliveryOutcome> => {
      if (!online) {
        await probe.promise;
        const nextAttemptAt = Date.now() + 4000;

        rows = rows.map((item) =>
          item.id === row.id ? { ...item, attempts: 2, nextAttemptAt } : item
        );

        return { kind: "retry", nextAttemptAt };
      }

      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

    // Fresh messages arrive while the contact's retry probe is still running.
    rows = [
      ...rows,
      message("fresh-1", "1"),
      message("fresh-2", "1"),
      message("fresh-3", "1"),
    ];
    await worker.wake();
    await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledOnce();

    // Probe fails -> fresh messages also honor the contact cooldown.
    probe.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deliver).toHaveBeenCalledOnce();

    // After cooldown, contact comes online -> probe succeeds and remaining rows fan out.
    online = true;
    await vi.advanceTimersByTimeAsync(3100);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(5));
    expect(rows).toEqual([]);
  } finally {
    worker.close();
    probe.resolve(true);
  }
});

it("keeps a row's unpersisted fallback pause even when a sibling succeeds", async () => {
  vi.useFakeTimers();
  const siblingDone = Promise.withResolvers<true>();
  let rows = [message("failed-write", "1"), message("sibling", "1")];
  let failedWriteCalls = 0;

  const deliver = vi.fn(
    async (row: StoredMessage): Promise<DeliveryOutcome> => {
      if (row.id === "sibling") {
        await siblingDone.promise;
        rows = rows.filter((item) => item.id !== row.id);

        return { kind: "delivered" };
      }

      failedWriteCalls += 1;

      if (failedWriteCalls === 1) {
        return { kind: "retry", nextAttemptAt: Date.now() + 2000 };
      }

      rows = rows.filter((item) => item.id !== row.id);

      return { kind: "delivered" };
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: () => Promise.resolve(),
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));

    // Sibling completes while failed-write is still in its 2s fallback pause.
    siblingDone.resolve(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(failedWriteCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1600);
    await vi.waitFor(() => expect(failedWriteCalls).toBe(2));
    expect(rows).toEqual([]);
  } finally {
    worker.close();
    siblingDone.resolve(true);
  }
});

it("honors excludeKeys for in-flight messages, keeps max contact cooldown, restores startup cooldown, and preserves fallback pauses on failed expedite", async () => {
  vi.useFakeTimers();
  const base = Date.now();

  let rows = [
    message("old", "1", { attempts: 1, nextAttemptAt: base + 8000 }),
    message("fresh", "1"),
  ];

  let expediteShouldFail = false;

  const deliver = vi.fn(
    (
      row: StoredMessage,
      _signal: AbortSignal,
      wasExpedited: () => boolean
    ): Promise<DeliveryOutcome> => {
      if (row.id === "in-flight-excluded") {
        return Promise.resolve({
          kind: "retry",
          nextAttemptAt: wasExpedited() ? 0 : Date.now() + 6000,
        });
      }

      if (row.id === "long-fail") {
        return Promise.resolve({
          kind: "retry",
          nextAttemptAt: Date.now() + 10_000,
        });
      }

      if (row.id === "short-fail") {
        return Promise.resolve({
          kind: "retry",
          nextAttemptAt: Date.now() + 2000,
        });
      }

      rows = rows.filter((item) => item.id !== row.id);

      return Promise.resolve({ kind: "delivered" });
    }
  );

  const worker = createMobileOutbox({
    deliver,
    expedite: (contactQid, excludeKeys) => {
      if (expediteShouldFail) {
        return Promise.reject(new Error("db busy"));
      }

      rows = rows.map((row) =>
        (contactQid === undefined || row.contactQid === contactQid) &&
        !excludeKeys?.has(`${row.contactQid}:${row.id}`)
          ? { ...row, nextAttemptAt: 0 }
          : row
      );

      return Promise.resolve();
    },
    list: () => Promise.resolve(rows),
    reconcile: () => Promise.resolve(),
  });

  try {
    // Startup restores persisted contact cooldown so fresh row waits with old row.
    await worker.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(deliver).not.toHaveBeenCalled();

    // Verified peer wake clears restored cooldown.
    await worker.wake({ contactQid: "1" });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));

    // Sibling retry with shorter backoff must not shorten active 10s contact cooldown,
    // and a failed expedite must keep the in-memory fallback pause.
    rows = [message("long-fail", "2"), message("short-fail", "2")];
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4));

    rows = [...rows, message("waiting", "2")];
    expediteShouldFail = true;
    await worker.wake({ contactQid: "2" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(deliver).toHaveBeenCalledTimes(4);

    // Exclude an in-flight key from a wake without skipInFlight.
    const gate = Promise.withResolvers<undefined>();
    let excludedWasExpedited = true;

    deliver.mockImplementationOnce(async (_row, _signal, wasExpedited) => {
      await gate.promise;
      excludedWasExpedited = wasExpedited();

      return { kind: "retry", nextAttemptAt: Date.now() + 5000 };
    });

    expediteShouldFail = false;
    rows = [message("in-flight-excluded", "3")];
    await worker.wake();
    await vi.waitFor(() =>
      expect(worker.isInFlight("3", "in-flight-excluded")).toBe(true)
    );
    await worker.wake({
      contactQid: "3",
      excludeKeys: new Set(["3:in-flight-excluded"]),
    });
    gate.resolve(undefined);
    await vi.waitFor(() =>
      expect(worker.isInFlight("3", "in-flight-excluded")).toBe(false)
    );
    expect(excludedWasExpedited).toBe(false);
  } finally {
    worker.close();
  }
});
