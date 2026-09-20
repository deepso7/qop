import { createLifecycleAdapter } from "@qop/protocol";
import type { LifecycleAdapter } from "@qop/protocol";
import { Effect } from "effect";

export const LIFECYCLE_OBSERVE_MS = 1000;

/** Holder chat is armed on macOS and Linux: SIGCONT, stall/sleep observe, verify-boundary. */
export const isMessagingLifecycleAllowed = ({
  platform = process.platform,
}: {
  readonly platform?: NodeJS.Platform;
} = {}) => platform === "linux" || platform === "darwin";

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

export type ArmedProcessLifecycle = ReturnType<typeof createProcessLifecycle>;

/** Arm SIGCONT + stall observe, and dispose on every exit including startup failure. */
export const withProcessLifecycle = <A, E, R>(
  options: Parameters<typeof createProcessLifecycle>[0],
  use: (lifecycle: ArmedProcessLifecycle) => Effect.Effect<A, E, R>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* Effect.acquireRelease(
        Effect.sync(() => createProcessLifecycle(options)),
        (armed) => Effect.sync(() => armed.dispose())
      );
      return yield* use(lifecycle);
    })
  );

export const withMessagingLifecycle = <A, E, R>(
  onInterrupt: () => void,
  use: (lifecycle: ArmedProcessLifecycle) => Effect.Effect<A, E, R>
) =>
  withProcessLifecycle(
    {
      adapter: createLifecycleAdapter({
        monotonicNow: () => performance.now(),
        wallNow: () => Date.now(),
      }),
      onInterrupt,
    },
    use
  );
