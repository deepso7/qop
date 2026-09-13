import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "@effect/vitest";
import { createLifecycleAdapter } from "@qop/protocol";

import { createProcessLifecycle } from "../src/process-lifecycle.ts";

const noop = () => {
  /* no-op */
};

describe("CLI process lifecycle", () => {
  it("invalidates at the verify boundary after SIGCONT", () => {
    const adapter = createLifecycleAdapter({
      monotonicNow: () => 0,
      stallThresholdMs: 1000,
      wallNow: () => 0,
    });
    let epoch = 0;
    const lifecycle = createProcessLifecycle({
      adapter,
      observeMs: 60_000,
      onInterrupt: () => {
        epoch += 1;
      },
      onSigcont: (handler) => {
        handler();
        return noop;
      },
      setObserveInterval: () => noop,
    });
    expect(epoch).toBe(1);
    expect(lifecycle.adapter.takeInvalidation()).toBe(true);
    expect(lifecycle.adapter.takeInvalidation()).toBe(false);
    lifecycle.dispose();
  });

  it("self-check receives SIGCONT and reports invalidation", async () => {
    const adapter = createLifecycleAdapter({
      monotonicNow: () => performance.now(),
      wallNow: () => Date.now(),
    });
    const lifecycle = createProcessLifecycle({
      adapter,
      observeMs: 60_000,
      onInterrupt: noop,
      setObserveInterval: () => noop,
    });
    process.kill(process.pid, "SIGCONT");
    await delay(50);
    expect(adapter.takeInvalidation()).toBe(true);
    lifecycle.dispose();
  });
});
