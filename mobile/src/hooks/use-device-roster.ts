import { Effect, Result } from "effect";
import { useFocusEffect } from "expo-router";
import * as React from "react";

import { completeDeviceRemove } from "@/lib/device-link-flow";
import type { Account } from "@/lib/identity-store";
import { LocalDeviceActionError } from "@/lib/local-device-action";
import { lookupQid } from "@/lib/registry";

interface RosterDevice {
  readonly deviceKey: string;
  readonly peerId: string;
}

type RosterState =
  | { readonly status: "error" | "loading" }
  | { readonly devices: readonly RosterDevice[]; readonly status: "ready" };

const removeFailureMessage = (
  operation: LocalDeviceActionError["operation"] | undefined
) => {
  switch (operation) {
    case "conflict": {
      return "Another device action is still in flight.";
    }

    case "submit": {
      return "Could not submit the removal. Try again.";
    }

    case "timeout": {
      return "Still waiting on the API. Try again to resume the same removal.";
    }

    default: {
      return "Could not save the removal.";
    }
  }
};

/**
 * The account's on-chain device roster, reloaded whenever the screen gains
 * focus (e.g. after the link-device sheet closes), plus device removal.
 */
export const useDeviceRoster = ({ identity, qid }: Account) => {
  const [roster, setRoster] = React.useState<RosterState>({
    status: "loading",
  });

  const { ownerAddress } = identity;
  const [removing, setRemoving] = React.useState(false);
  const [message, setMessage] = React.useState<string>();

  // Only the newest load may write; focus cleanup also invalidates in-flight
  // loads. Overlapping reads can see different registry heads.
  const loadSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    loadSeq.current += 1;
    const seq = loadSeq.current;

    const account = await Effect.runPromise(
      lookupQid(BigInt(qid)).pipe(Effect.result)
    );

    if (seq !== loadSeq.current) {
      return;
    }

    setRoster(
      Result.isSuccess(account) && account.success
        ? { devices: account.success.devices, status: "ready" }
        : { status: "error" }
    );
  }, [qid]);

  useFocusEffect(
    React.useCallback(() => {
      void load();

      return () => {
        loadSeq.current += 1;
      };
    }, [load])
  );

  const retry = React.useCallback(() => {
    setRoster({ status: "loading" });
    void load();
  }, [load]);

  const remove = React.useCallback(
    async (deviceKey: string) => {
      if (removing) {
        return;
      }

      setRemoving(true);
      setMessage("Removing device…");

      const result = await Effect.runPromise(
        completeDeviceRemove({
          deviceKey,
          expectedOwner: ownerAddress,
          qid: BigInt(qid),
        }).pipe(Effect.result)
      );

      if (Result.isFailure(result)) {
        setRemoving(false);
        const { failure } = result;
        setMessage(
          removeFailureMessage(
            failure instanceof LocalDeviceActionError
              ? failure.operation
              : undefined
          )
        );

        return;
      }

      await load();
      setRemoving(false);
      setMessage(
        result.success?.membership === "removed"
          ? "Device removed. Its conversation history stays."
          : "Removal submitted. Its conversation history stays."
      );
    },
    [load, ownerAddress, qid, removing]
  );

  return {
    ...roster,
    message,
    remove,
    removing,
    retry,
    thisDeviceKey: identity.deviceKey,
  };
};
