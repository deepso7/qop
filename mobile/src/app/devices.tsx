import { pairingFingerprint } from "@qop/protocol";
import { Effect, Result } from "effect";
import { useFocusEffect, useRouter } from "expo-router";
import * as React from "react";
import { ActivityIndicator, View } from "react-native";

import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { NativeAlert } from "@/components/ui/native-alert";
import { SectionLabel } from "@/components/ui/section-label";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { completeDeviceRemove } from "@/lib/device-link-flow";
import { useIdentityStore } from "@/lib/identity-store";
import { LocalDeviceActionError } from "@/lib/local-device-action";
import { lookupQid } from "@/lib/registry";

const DevicesScreen = () => {
  const { push } = useRouter();
  const identity = useIdentityStore((state) => state.identity);
  const registration = useIdentityStore((state) => state.registration);
  const [devices, setDevices] = React.useState<
    readonly { deviceKey: string; peerId: string }[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const [removeKey, setRemoveKey] = React.useState<string>();

  const refresh = React.useCallback(async () => {
    if (!registration?.qid) {
      setDevices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const account = await Effect.runPromise(
      lookupQid(BigInt(registration.qid)).pipe(Effect.result)
    );
    if (Result.isSuccess(account) && account.success) {
      setDevices(account.success.devices);
    }
    setLoading(false);
  }, [registration]);

  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      const load = async () => {
        if (!registration?.qid) {
          if (active) {
            setDevices([]);
            setLoading(false);
          }
          return;
        }
        if (active) {
          setLoading(true);
        }
        const account = await Effect.runPromise(
          lookupQid(BigInt(registration.qid)).pipe(Effect.result)
        );
        if (!active) {
          return;
        }
        if (Result.isSuccess(account) && account.success) {
          setDevices(account.success.devices);
        }
        setLoading(false);
      };
      void load();
      return () => {
        active = false;
      };
    }, [registration])
  );

  const removeDevice = React.useCallback(
    async (deviceKey: string) => {
      if (!identity || !registration?.qid || busy) {
        return;
      }
      setBusy(true);
      setMessage("Saving removal…");
      const result = await Effect.runPromise(
        completeDeviceRemove({
          deviceKey,
          expectedOwner: identity.ownerAddress,
          qid: BigInt(registration.qid),
        }).pipe(Effect.result)
      );
      if (Result.isFailure(result)) {
        setBusy(false);
        const { failure } = result;
        if (
          failure instanceof LocalDeviceActionError &&
          failure.operation === "conflict"
        ) {
          setMessage("Another device action is still in flight.");
          return;
        }
        if (
          failure instanceof LocalDeviceActionError &&
          failure.operation === "submit"
        ) {
          setMessage("Could not submit the removal. Try again.");
          return;
        }
        if (
          failure instanceof LocalDeviceActionError &&
          failure.operation === "timeout"
        ) {
          setMessage(
            "Still waiting on the API. Try again to resume the same removal."
          );
          return;
        }
        setMessage("Could not save the removal.");
        return;
      }
      await refresh();
      setBusy(false);
      if (result.success?.membership === "removed") {
        setMessage("Removed. History on this phone stays.");
        return;
      }
      setMessage("Removal submitted. History on this phone stays.");
    },
    [busy, identity, refresh, registration]
  );

  return (
    <Screen bounces={false}>
      <View className="gap-1">
        <Text variant="title">Devices</Text>
        <Text className="text-foreground-secondary" variant="caption">
          Authorized devices for @{identity?.handle}. Labels are local.
        </Text>
      </View>

      <View className="gap-2">
        <SectionLabel>On-chain roster</SectionLabel>
        {loading ? (
          <ActivityIndicator />
        ) : (
          devices.map((device) => {
            const isThis = device.deviceKey === identity?.deviceKey;
            return (
              <Surface
                className="border-background-selected gap-2 rounded-xl border p-4"
                key={device.deviceKey}
                tone="element"
              >
                <Text variant="label">
                  {isThis
                    ? "This device"
                    : pairingFingerprint(device.deviceKey)}
                </Text>
                <Text
                  className="text-foreground-secondary font-mono"
                  selectable
                  variant="caption"
                >
                  {device.peerId}
                </Text>
                {isThis ? null : (
                  <Button
                    disabled={busy}
                    onPress={() => setRemoveKey(device.deviceKey)}
                    variant="outline"
                  >
                    <Text className="text-destructive">Remove</Text>
                  </Button>
                )}
              </Surface>
            );
          })
        )}
      </View>

      <Button className="h-12 rounded-xl" onPress={() => push("/devices-link")}>
        <Text>Link device</Text>
      </Button>
      {message ? (
        <Text
          className="text-foreground-secondary text-center"
          variant="caption"
        >
          {message}
        </Text>
      ) : null}
      <NativeAlert
        confirmLabel="Remove"
        description="This device will lose access to send and receive as you. Conversation history stays."
        destructive
        onConfirm={async () => {
          const deviceKey = removeKey;
          setRemoveKey(undefined);
          if (deviceKey) {
            await removeDevice(deviceKey);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveKey(undefined);
          }
        }}
        open={removeKey !== undefined}
        title="Remove this device?"
      />
    </Screen>
  );
};

export default React.memo(DevicesScreen);
