import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "@effect/vitest";
import { createLifecycleAdapter } from "@qop/protocol";
import { Effect } from "effect";

import {
  createProcessLifecycle,
  isMessagingLifecycleAllowed,
  withProcessLifecycle,
} from "../src/process-lifecycle.ts";

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

  it("SIGCONT delivery still invalidates at the verify boundary", async () => {
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

  it("invalidates from the observe interval after a suspend clock gap", () => {
    // One observe branch: monotonic paused, wall ran. Stall observe is the other.
    let monotonic = 0;
    let wall = 0;
    const adapter = createLifecycleAdapter({
      monotonicNow: () => monotonic,
      stallThresholdMs: 1000,
      wallNow: () => wall,
    });
    let epoch = 0;
    let tick = noop;
    const lifecycle = createProcessLifecycle({
      adapter,
      observeMs: 60_000,
      onInterrupt: () => {
        epoch += 1;
      },
      onSigcont: () => noop,
      setObserveInterval: (handler) => {
        tick = handler;
        return noop;
      },
    });
    expect(epoch).toBe(0);
    wall += 60_000;
    monotonic += 10;
    tick();
    expect(epoch).toBe(1);
    expect(lifecycle.adapter.takeInvalidation()).toBe(false);
    lifecycle.dispose();
  });

  it("invalidates from the observe interval after a monotonic stall", () => {
    // Verified Mac software-sleep: both clocks jumped ~123s, so stall fired
    // and the wall−monotonic sleep-gap did not. SIGCONT was not delivered.
    let monotonic = 0;
    let wall = 0;
    const adapter = createLifecycleAdapter({
      monotonicNow: () => monotonic,
      stallThresholdMs: 1000,
      wallNow: () => wall,
    });
    let epoch = 0;
    let tick = noop;
    const lifecycle = createProcessLifecycle({
      adapter,
      observeMs: 60_000,
      onInterrupt: () => {
        epoch += 1;
      },
      onSigcont: () => noop,
      setObserveInterval: (handler) => {
        tick = handler;
        return noop;
      },
    });
    expect(epoch).toBe(0);
    wall += 123_096;
    monotonic += 123_094.7825;
    tick();
    expect(epoch).toBe(1);
    expect(lifecycle.adapter.takeInvalidation()).toBe(false);
    lifecycle.dispose();
  });

  it("allows linux and darwin holders", () => {
    expect(isMessagingLifecycleAllowed({ platform: "linux" })).toBe(true);
    expect(isMessagingLifecycleAllowed({ platform: "darwin" })).toBe(true);
    expect(isMessagingLifecycleAllowed({ platform: "win32" })).toBe(false);
  });

  it.effect("disposes the observe interval when startup work fails", () =>
    Effect.gen(function* () {
      const adapter = createLifecycleAdapter({
        monotonicNow: () => 0,
        wallNow: () => 0,
      });
      let intervalRunning = false;
      const result = yield* withProcessLifecycle(
        {
          adapter,
          onInterrupt: noop,
          onSigcont: () => noop,
          setObserveInterval: () => {
            intervalRunning = true;
            return () => {
              intervalRunning = false;
            };
          },
        },
        () => Effect.fail("loadSecret")
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(intervalRunning).toBe(false);
    })
  );
});
