import { Effect, Result } from "effect";
import { useFocusEffect } from "expo-router";
import * as React from "react";

import { completeDeviceRemove } from "@/lib/device-link-flow";
import { useIdentityStore } from "@/lib/identity-store";
import { LocalDeviceActionError } from "@/lib/local-device-action";
import { lookupQid } from "@/lib/registry";

interface RosterDevice {
  readonly deviceKey: string;
  readonly peerId: string;
}

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
export const useDeviceRoster = () => {
  const identity = useIdentityStore((state) => state.identity);
  const registration = useIdentityStore((state) => state.registration);
  const [devices, setDevices] = React.useState<readonly RosterDevice[]>([]);
  const [status, setStatus] = React.useState<"error" | "loading" | "ready">(
    "loading"
  );
  const [removing, setRemoving] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const qid = registration?.qid;

  // Only the newest load may write; focus cleanup also invalidates in-flight
  // loads. Overlapping reads can see different registry heads.
  const loadSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    loadSeq.current += 1;
    const seq = loadSeq.current;
    if (!qid) {
      setDevices([]);
      setStatus("ready");
      return;
    }
    const account = await Effect.runPromise(
      lookupQid(BigInt(qid)).pipe(Effect.result)
    );
    if (seq !== loadSeq.current) {
      return;
    }
    if (Result.isSuccess(account) && account.success) {
      setDevices(account.success.devices);
      setStatus("ready");
    } else {
      setStatus("error");
    }
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
    setStatus("loading");
    void load();
  }, [load]);

  const remove = React.useCallback(
    async (deviceKey: string) => {
      if (!identity || !qid || removing) {
        return;
      }
      setRemoving(true);
      setMessage("Removing device…");
      const result = await Effect.runPromise(
        completeDeviceRemove({
          deviceKey,
          expectedOwner: identity.ownerAddress,
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
    [identity, load, qid, removing]
  );

  return {
    devices,
    message,
    remove,
    removing,
    retry,
    status,
    thisDeviceKey: identity?.deviceKey,
  };
};
