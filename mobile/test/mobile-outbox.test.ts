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
    expect(list).toHaveBeenCalledTimes(2);
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
