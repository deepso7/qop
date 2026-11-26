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

  await worker.wake();
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(2100);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(vi.getTimerCount()).toBe(0);
  worker.close();
  expect(deliver).not.toHaveBeenCalled();
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
