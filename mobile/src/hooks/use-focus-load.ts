import { useFocusEffect } from "expo-router";
import * as React from "react";

import { useP2pStore } from "@/lib/p2p-store";

/** A screen's async read. A failed refresh keeps the last loaded value. */
export type Load<A> =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly refreshFailed: boolean;
      readonly value: A;
    };

/**
 * Runs `load` while the screen is focused, again after every chat change (P2P
 * `revision`), and on `retry`. Pass a stable (memoized) `load`; changing it
 * starts over from `loading`, so one resource's value never stands in for
 * another's. Results that arrive after blur or a newer load are dropped.
 */
export const useFocusLoad = <A>(load: () => Promise<A>) => {
  // Keyed by `load` so a value is only kept as stale data for the same load.
  const [entry, setEntry] = React.useState<{
    readonly load: () => Promise<A>;
    readonly state: Load<A>;
  }>({ load, state: { kind: "loading" } });

  const [attempt, retry] = React.useReducer((count: number) => count + 1, 0);
  const revision = useP2pStore((store) => store.revision);

  useFocusEffect(
    React.useCallback(() => {
      let active = true;

      // The unused arguments make revision and retries rerun this effect.
      const run = async (_revision: number, _attempt: number) => {
        try {
          const value = await load();

          if (active) {
            setEntry({
              load,
              state: { kind: "ready", refreshFailed: false, value },
            });
          }
        } catch {
          if (active) {
            setEntry((previous) => ({
              load,
              state:
                previous.load === load && previous.state.kind === "ready"
                  ? { ...previous.state, refreshFailed: true }
                  : { kind: "failed" },
            }));
          }
        }
      };

      void run(revision, attempt);

      return () => {
        active = false;
      };
    }, [attempt, load, revision])
  );

  const state: Load<A> =
    entry.load === load ? entry.state : { kind: "loading" };

  return [state, retry] as const;
};
