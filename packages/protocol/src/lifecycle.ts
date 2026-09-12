/** Detect suspend and event-loop stall for CLI live-auth invalidation.
 *
 * Monotonic elapsed time (`performance.now`) typically pauses across sleep;
 * wall-clock time does not. A large wall-minus-monotonic gap means the process
 * was suspended. A large monotonic jump means the event loop stalled. Wall
 * drift may conservatively invalidate, but a later successful registry read at
 * a strictly newer head is still required to mint a new auth window.
 */
export const createLifecycleAdapter = ({
  monotonicNow,
  stallThresholdMs = 2000,
  wallNow,
}: {
  readonly monotonicNow: () => number;
  readonly stallThresholdMs?: number;
  readonly wallNow: () => number;
}) => {
  let generation = 0;
  let lastMonotonic = monotonicNow();
  let lastWall = wallNow();
  let pendingInvalidation = false;

  const observe = () => {
    const monotonic = monotonicNow();
    const wall = wallNow();
    const monotonicDelta = monotonic - lastMonotonic;
    const wallDelta = wall - lastWall;
    lastMonotonic = monotonic;
    lastWall = wall;
    const slept = wallDelta - monotonicDelta >= stallThresholdMs;
    const stalled = monotonicDelta >= stallThresholdMs;
    const clockStepped = wallDelta < 0;
    if (slept || stalled || clockStepped) {
      generation += 1;
      pendingInvalidation = true;
    }
    return generation;
  };

  const takeInvalidation = () => {
    observe();
    const shouldInvalidate = pendingInvalidation;
    pendingInvalidation = false;
    return shouldInvalidate;
  };

  return {
    currentGeneration: () => observe(),
    observe,
    takeInvalidation,
  };
};

export type LifecycleAdapter = ReturnType<typeof createLifecycleAdapter>;
