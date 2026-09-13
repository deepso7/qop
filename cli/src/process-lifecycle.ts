import { createLifecycleAdapter } from "@qop/protocol";
import type { LifecycleAdapter } from "@qop/protocol";
import { Effect } from "effect";

export const LIFECYCLE_OBSERVE_MS = 1000;

export const createProcessLifecycle = ({
  adapter,
  observeMs = LIFECYCLE_OBSERVE_MS,
  onInterrupt,
  onSigcont = (handler: () => void) => {
    process.on("SIGCONT", handler);
    return () => {
      process.off("SIGCONT", handler);
    };
  },
  setObserveInterval = (handler: () => void, ms: number) => {
    const id = setInterval(handler, ms);
    return () => {
      clearInterval(id);
    };
  },
}: {
  readonly adapter: LifecycleAdapter;
  readonly observeMs?: number | undefined;
  readonly onInterrupt: () => void;
  readonly onSigcont?: (handler: () => void) => () => void;
  readonly setObserveInterval?: (handler: () => void, ms: number) => () => void;
}) => {
  const handleWake = () => {
    adapter.markInterrupted();
    onInterrupt();
  };
  const handleTick = () => {
    adapter.observe();
    if (adapter.takeInvalidation()) {
      onInterrupt();
    }
  };
  const stopSigcont = onSigcont(handleWake);
  const stopInterval = setObserveInterval(handleTick, observeMs);
  return {
    adapter,
    dispose: () => {
      stopSigcont();
      stopInterval();
    },
    handleWake,
  };
};

/** Deliver SIGCONT to this process and require the adapter to invalidate. */
export const proveWakeInvalidation = Effect.fn("cli.proveWakeInvalidation")(
  function* (adapter: LifecycleAdapter, waitMs = 50) {
    process.kill(process.pid, "SIGCONT");
    yield* Effect.sleep(waitMs);
    return adapter.takeInvalidation();
  }
);

export const armMessagingLifecycle = (onInterrupt: () => void) => {
  const adapter = createLifecycleAdapter({
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
  });
  return createProcessLifecycle({ adapter, onInterrupt });
};
