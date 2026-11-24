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

it("keeps per-contact FIFO across a failure and caps parallel contacts at eight", async () => {
  vi.useFakeTimers();

  let rows = [
    message("first"),
    message("second"),
    ...Array.from({ length: 9 }, (_, index) =>
      message(`other-${index}`, String(index + 2))
    ),
  ];

  const gate = Promise.withResolvers<true>();
  let active = 0;
  let maximum = 0;
  let fail = true;
  const ids: string[] = [];

  const worker = createMobileOutbox({
    list: () => Promise.resolve(rows),
    reconcile: async () => {},
    deliver: async (row) => {
      active += 1;
      maximum = Math.max(maximum, active);
      ids.push(row.id);
      await gate.promise;
      active -= 1;

      rows =
        row.id === "first" && fail
          ? rows.map((item) =>
              item.id === row.id
                ? { ...item, nextAttemptAt: Date.now() + 2000 }
                : item
            )
          : rows.filter((item) => item.id !== row.id);
    },
  });

  try {
    const work = worker.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(8);
    gate.resolve(true);
    await work;
    expect(maximum).toBe(8);
    expect(ids).not.toContain("second");
    fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(ids.slice(-2)).toEqual(["first", "second"]);
    expect(rows).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
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

  const deliver = vi.fn(async () => {});

  const worker = createMobileOutbox({
    list,
    deliver,
    reconcile: async () => {},
  });

  await worker.wake();
  worker.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves an empty queue parked without timers", async () => {
  vi.useFakeTimers();
  const deliver = vi.fn(async () => {});

  const worker = createMobileOutbox({
    list: () => Promise.resolve([]),
    deliver,
    reconcile: async () => {},
  });

  await worker.wake();
  expect(deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  worker.close();
});
