import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import type { StoredMessage } from "@/lib/db";
import { createMobileOutbox } from "@/lib/mobile-outbox";

const message = (id: string, contactQid = "1"): StoredMessage => ({
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
});

afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "keeps sends flowing during single-flight reconciliation (failure: %s)",
  async (failure) => {
    vi.useFakeTimers();
    const poll = Promise.withResolvers<true>();

    let rows = [
      { ...message("held"), status: "held" as const },
      { ...message("retry"), nextAttemptAt: Date.now() + 35_000 },
    ];

    const list = vi.fn(() => Promise.resolve(rows));

    const reconcile = vi.fn(async () => {
      await poll.promise;

      if (failure) {
        throw new Error("holder unavailable");
      }

      rows = rows.filter((row) => row.id !== "held");
    });

    const deliver = vi.fn((row: StoredMessage) => {
      rows = rows.filter((item) => item.id !== row.id);

      return Promise.resolve({ ...row, status: "sent" as const });
    });

    const worker = createMobileOutbox({
      list,
      deliver,
      reconcile,
      expedite: () => Promise.resolve(),
    });

    try {
      await worker.wake();
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcile).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5000);
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0].id).toBe("retry");

      rows.push(message("new", "2"));
      await worker.wake();
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(deliver.mock.calls[1]?.[0].id).toBe("new");

      await worker.wake(undefined, true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      const reads = list.mock.calls.length;
      poll.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(reads + 1);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() =>
        expect(reconcile).toHaveBeenCalledTimes(failure ? 2 : 1)
      );

      if (!failure) {
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      worker.close();
      poll.resolve(true);
    }
  }
);

it.each([false, true])(
  "keeps the stored deadline when wake and delivery share a batch (expedited: %s)",
  async (expedited) => {
    vi.useFakeTimers();
    const delivery = Promise.withResolvers<true>();
    const poll = Promise.withResolvers<true>();

    const retry = {
      ...message("retry"),
      attempts: 1,
      nextAttemptAt: Date.now() + 60_000,
    };

    let rows = [
      message("retry"),
      { ...message("held"), status: "held" as const },
    ];

    const reconcile = vi.fn(async () => {
      await poll.promise;
    });

    const deliver = vi.fn(async (row: StoredMessage) => {
      if (row.attempts === 0) {
        rows = rows.map((item) => (item.id === row.id ? retry : item));
        await delivery.promise;

        return retry;
      }

      rows = rows.filter((item) => item.id !== row.id);

      return { ...row, status: "sent" as const };
    });

    const worker = createMobileOutbox({
      list: () => Promise.resolve(rows),
      deliver,
      reconcile,
      expedite: () => {
        rows = rows.map((row) => ({ ...row, nextAttemptAt: 0 }));

        return Promise.resolve();
      },
    });

    try {
      await worker.wake();
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcile).toHaveBeenCalledOnce();
      delivery.resolve(true);

      if (expedited) {
        await worker.wake("1");
      }

      await vi.advanceTimersByTimeAsync(0);
      poll.resolve(true);

      if (!expedited) {
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(30_000);
      }

      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(deliver.mock.calls[1]?.[0].nextAttemptAt).toBe(
        expedited ? 0 : retry.nextAttemptAt
      );
    } finally {
      worker.close();
      delivery.resolve(true);
      poll.resolve(true);
    }
  }
);

it.each(["new message", "periodic reconciliation"])(
  "admits %s while earlier sends remain in flight",
  async (work) => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<true>();

    let rows = [
      message("old"),
      { ...message("held"), status: "held" as const },
    ];

    const reconcile = vi.fn(() => Promise.resolve());

    const deliver = vi.fn(async (row: StoredMessage) => {
      if (row.id === "old") {
        await gate.promise;
      }

      rows = rows.filter((item) => item.id !== row.id);

      return { ...row, status: "sent" as const };
    });

    const worker = createMobileOutbox({
      list: () => Promise.resolve(rows),
      deliver,
      reconcile,
      expedite: () => Promise.resolve(),
    });

    try {
      await worker.wake();
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      if (work === "new message") {
        rows.push(message("new", "2"));
        await worker.wake();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(deliver.mock.calls.map(([row]) => row.id)).toEqual([
          "old",
          "new",
        ]);
        await worker.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(2);
      } else {
        await vi.advanceTimersByTimeAsync(30_100);
        await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
        expect(deliver).toHaveBeenCalledOnce();
      }
    } finally {
      worker.close();
      gate.resolve(true);
    }
  }
);

it("isolates a delivery rejection without aborting its sibling", async () => {
  const gate = Promise.withResolvers<true>();
  let siblingSignal: AbortSignal | undefined;

  const worker = createMobileOutbox({
    list: () => Promise.resolve([message("sibling"), message("fault")]),
    expedite: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    deliver: async (row, signal) => {
      if (row.id === "fault") {
        throw new Error("one storage read failed");
      }

      siblingSignal = signal;
      await gate.promise;

      return { ...row, status: "sent" };
    },
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

it("gives new work the next free slot without draining an old snapshot", async () => {
  const first = Promise.withResolvers<true>();
  const rest = Promise.withResolvers<true>();
  const fresh = Promise.withResolvers<true>();
  let rows = Array.from({ length: 300 }, (_, index) => message(String(index)));

  const deliver = vi.fn(async (row: StoredMessage) => {
    if (row.id === "new") {
      await fresh.promise;
    } else {
      await (row.id === "0" ? first.promise : rest.promise);
    }

    rows = rows.filter((item) => item.id !== row.id);

    return { ...row, status: "sent" as const };
  });

  const worker = createMobileOutbox({
    list: () => Promise.resolve(rows),
    deliver,
    reconcile: () => Promise.resolve(),
    expedite: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(64));
    rows.push(message("new", "2"));
    await worker.wake();
    first.resolve(true);
    await vi.waitFor(() =>
      expect(deliver.mock.calls.some(([row]) => row.id === "new")).toBe(true)
    );
    expect(deliver.mock.calls.filter(([row]) => row.id !== "new")).toHaveLength(
      64
    );
  } finally {
    worker.close();
    first.resolve(true);
    rest.resolve(true);
    fresh.resolve(true);
  }
});

it("runs a same-contact burst and retries concurrently, bounded at 64 without per-message scans", async () => {
  vi.useFakeTimers();
  let rows = Array.from({ length: 300 }, (_, index) => message(String(index)));
  const gate = Promise.withResolvers<true>();
  let active = 0;
  let maximum = 0;
  let retry = false;
  const ids: string[] = [];
  const list = vi.fn(() => Promise.resolve(rows));

  const worker = createMobileOutbox({
    list,
    expedite: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    deliver: async (row) => {
      active += 1;
      maximum = Math.max(maximum, active);
      ids.push(row.id);
      await gate.promise;
      active -= 1;

      const updated = {
        ...row,
        status: retry ? ("sent" as const) : ("queued" as const),
        nextAttemptAt: Date.now() + 2000,
      };

      rows = rows.filter((item) => item.id !== row.id);

      if (!retry) {
        rows.push(updated);
      }

      return updated;
    },
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(active).toBe(64));
    gate.resolve(true);
    await vi.waitFor(() => expect(ids).toHaveLength(300));
    expect(maximum).toBe(64);
    expect(list).toHaveBeenCalledOnce();
    retry = true;
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(ids).toHaveLength(600));
    expect(rows).toEqual([]);
    expect(list).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    worker.close();
  }
});

it("admits at most eight contacts at once", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<true>();

  const deliver = vi.fn(async () => {
    await gate.promise;

    return null;
  });

  const worker = createMobileOutbox({
    list: () =>
      Promise.resolve(
        Array.from({ length: 10 }, (_, index) =>
          message(String(index), String(index))
        )
      ),
    deliver,
    expedite: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
  });

  await worker.wake();
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(8));
  gate.resolve(true);
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(10));
  worker.close();
});

it("shares the 64-send bound across contacts", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<true>();
  let active = 0;
  let maximum = 0;

  const deliver = vi.fn(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;

    return null;
  });

  const worker = createMobileOutbox({
    list: () =>
      Promise.resolve(
        Array.from({ length: 128 }, (_, index) =>
          message(String(index), String(Math.floor(index / 32)))
        )
      ),
    deliver,
    expedite: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
  });

  try {
    await worker.wake();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(64));
    gate.resolve(true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(128));
    expect(maximum).toBe(64);
  } finally {
    worker.close();
  }
});

it("backs off storage errors and cancels its idle work on close", async () => {
  vi.useFakeTimers();

  const list = vi
    .fn<() => Promise<readonly StoredMessage[]>>()
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue([message("later")]);

  const deliver = vi.fn(() => Promise.resolve(null));

  const worker = createMobileOutbox({
    list,
    deliver,
    expedite: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
  });

  await worker.wake();
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  worker.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves an empty queue parked without timers", async () => {
  vi.useFakeTimers();
  const deliver = vi.fn(() => Promise.resolve(null));
  const list = vi.fn(() => Promise.resolve([]));

  const worker = createMobileOutbox({
    list,
    deliver,
    expedite: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
  });

  await worker.wake();
  await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(deliver).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  worker.close();
});

it("keeps a retry scheduled if expediting it fails", async () => {
  vi.useFakeTimers();

  const row = { ...message("retry"), nextAttemptAt: Date.now() + 2000 };

  const deliver = vi.fn(() =>
    Promise.resolve({ ...row, status: "sent" as const })
  );

  const list = vi.fn(() => Promise.resolve([row]));

  const worker = createMobileOutbox({
    list,
    deliver,
    expedite: () => Promise.reject(new Error("storage unavailable")),
    reconcile: () => Promise.resolve(),
  });

  try {
    await expect(worker.wake("1")).resolves.toBeUndefined();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  } finally {
    worker.close();
  }
});
