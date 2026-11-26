import { afterEach, expect, it, vi } from "vitest";

import { createMailboxPushRegistration } from "@/lib/mailbox-push-registration-core";

afterEach(() => {
  vi.useRealTimers();
});

it("backs off after failed and partial registration without waiting for resume", async () => {
  vi.useFakeTimers();

  const register = vi
    .fn<() => Promise<boolean>>()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);

  const registration = createMailboxPushRegistration({
    isActive: () => true,
    register,
  });

  try {
    registration.refresh();
    await vi.advanceTimersByTimeAsync(4999);
    expect(register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(register).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(register).toHaveBeenCalledTimes(3);
  } finally {
    registration.stop();
  }

  expect(vi.getTimerCount()).toBe(0);
});
