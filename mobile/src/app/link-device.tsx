import type { ConnectTarget } from "@minip2p/react-native";
import { asHex, pairingFingerprint } from "@qop/protocol";
import type { PairingOfferV1 } from "@qop/protocol";
import { Effect, Result } from "effect";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import * as React from "react";
import { ActivityIndicator, Platform, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useTheme } from "@/constants/theme";
import { trustedIdentityDomain } from "@/lib/device-action-approval";
import { completeDeviceLink } from "@/lib/device-link-flow";
import { successHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";
import { LocalDeviceActionError } from "@/lib/local-device-action";
import { useP2pStore } from "@/lib/p2p-store";
import {
  assertOfferMatchesAccount,
  decodePairingPayload,
  handshakePairing,
} from "@/lib/pairing-client-core";

type Payload =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "valid"; readonly offer: PairingOfferV1 };

const linkFailureMessage = (
  operation: LocalDeviceActionError["operation"] | undefined
) => {
  switch (operation) {
    case "conflict": {
      return "Another device action is still in flight.";
    }
    case "submit": {
      return "Could not reach the qop API. Try again.";
    }
    case "timeout": {
      return "Still waiting on the API. Try again to resume the same approval.";
    }
    default: {
      return "Could not finish linking. Run the link command again and retry.";
    }
  }
};

/**
 * Sheet that links a CLI to this account: paste its pairing payload, check
 * the fingerprint against the terminal, then one tap connects and approves.
 */
const LinkDeviceSheet = () => {
  const router = useRouter();
  const colors = useTheme();
  const identity = useIdentityStore((state) => state.identity);
  const registration = useIdentityStore((state) => state.registration);
  const pairConnect = useP2pStore((state) => state.pairConnect);
  const pairWaitPeerReady = useP2pStore((state) => state.pairWaitPeerReady);
  const openPairingStream = useP2pStore((state) => state.openPairingStream);
  const invalidateOwnHolders = useP2pStore(
    (state) => state.invalidateOwnHolders
  );
  const p2pStatus = useP2pStore((state) => state.status);
  const [text, setText] = React.useState("");
  // When the text last changed; expiry is checked against it, not render time.
  const [editedAtSeconds, setEditedAtSeconds] = React.useState(0n);
  const [progress, setProgress] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const linking = React.useRef(false);

  const transport = React.useMemo(
    () => ({
      connect: async (target: ConnectTarget) => {
        const connected = await pairConnect(target);
        if (!connected) {
          throw new Error("Could not connect");
        }
        return connected;
      },
      openPairingStream: async (id: string) => {
        const stream = await openPairingStream(id);
        if (!stream) {
          throw new Error("Could not open pairing stream");
        }
        return stream;
      },
      waitPeerReady: pairWaitPeerReady,
    }),
    [openPairingStream, pairConnect, pairWaitPeerReady]
  );

  // Validate while typing, so there is no separate review step.
  const payload = React.useMemo((): Payload => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { kind: "empty" };
    }
    const decoded = Effect.runSync(
      decodePairingPayload(trimmed, editedAtSeconds).pipe(Effect.result)
    );
    if (Result.isFailure(decoded)) {
      return {
        kind: "invalid",
        reason: "Not a valid pairing payload, or it has expired.",
      };
    }
    const domain = trustedIdentityDomain();
    const sameAccount = Effect.runSync(
      assertOfferMatchesAccount(decoded.success, {
        chainId: domain.chainId,
        qid: registration?.qid ?? "",
        registry: domain.verifyingContract,
      }).pipe(Effect.result)
    );
    if (Result.isFailure(sameAccount)) {
      return {
        kind: "invalid",
        reason: `This payload is for a different account. Use --account ${identity?.handle ?? "<handle>"}.`,
      };
    }
    return { kind: "valid", offer: decoded.success };
  }, [editedAtSeconds, identity?.handle, registration?.qid, text]);

  const changeText = React.useCallback((next: string) => {
    setText(next);
    setEditedAtSeconds(BigInt(Math.floor(Date.now() / 1000)));
    setError(undefined);
  }, []);

  const paste = React.useCallback(async () => {
    const pasted = await Clipboard.getStringAsync();
    changeText(pasted.trim());
  }, [changeText]);

  /** Connect to the CLI, then approve its enrollment and wait for it. */
  const approve = React.useCallback(
    async (
      offer: PairingOfferV1,
      expectedOwner: NonNullable<typeof identity>["ownerAddress"],
      qid: string
    ) => {
      const domain = trustedIdentityDomain();
      setError(undefined);
      setProgress("Connecting to your computer…");
      const handshake = await Effect.runPromise(
        handshakePairing(
          transport,
          offer,
          {
            chainId: domain.chainId,
            qid,
            registry: domain.verifyingContract,
          },
          () => Crypto.getRandomBytesAsync(32)
        ).pipe(Effect.result)
      );
      if (Result.isFailure(handshake)) {
        setError(
          "Could not reach your computer. Keep the link command running and try again."
        );
        return;
      }
      setProgress("Approving…");
      const result = await Effect.runPromise(
        completeDeviceLink({
          deviceKey: asHex(offer.deviceKey),
          expectedOwner,
          offer,
          peerId: handshake.success.peerId,
          qid: BigInt(qid),
          transport,
        }).pipe(Effect.result)
      );
      if (Result.isFailure(result)) {
        const { failure } = result;
        setError(
          linkFailureMessage(
            failure instanceof LocalDeviceActionError
              ? failure.operation
              : undefined
          )
        );
        return;
      }
      if (result.success?.membership !== "linked") {
        setError(
          result.success?.membership === "removed"
            ? "This device was linked and later removed. Run the link command again."
            : "The approval finished, but the device did not become active."
        );
        return;
      }
      invalidateOwnHolders();
      void successHaptic();
      router.back();
    },
    [invalidateOwnHolders, router, transport]
  );

  const link = React.useCallback(async () => {
    if (
      payload.kind !== "valid" ||
      !identity ||
      !registration?.qid ||
      linking.current
    ) {
      return;
    }
    const { offer } = payload;
    // The sheet may have stayed open past the offer's expiry.
    if (BigInt(offer.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) {
      setError("This payload has expired. Run the link command again.");
      return;
    }
    // A ref, not state: a second tap can land before the re-render.
    // approve() reports failures via setError and never throws.
    linking.current = true;
    await approve(offer, identity.ownerAddress, registration.qid);
    linking.current = false;
    setProgress(undefined);
  }, [approve, identity, payload, registration]);

  const p2pReady = p2pStatus === "running";
  const fingerprint =
    payload.kind === "valid"
      ? pairingFingerprint(asHex(payload.offer.deviceKey))
      : undefined;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-5 px-5 pt-2 pb-8"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      {/* Android form sheets have no navigation header to show the title. */}
      {Platform.OS === "android" ? (
        <Text className="pt-4" variant="large">
          Link a device
        </Text>
      ) : null}
      <Text className="text-foreground-secondary">
        On your computer, run{" "}
        <Text className="font-mono">qop link --account {identity?.handle}</Text>{" "}
        and paste the pairing payload it prints.
      </Text>

      <View className="flex-row gap-2">
        <Input
          autoCapitalize="none"
          autoCorrect={false}
          className="flex-1"
          editable={!progress}
          onChangeText={changeText}
          placeholder="qop-pair1.…"
          value={text}
        />
        {Clipboard.isPasteButtonAvailable ? (
          // Native UIPasteControl pastes without the "Allow Paste" prompt.
          <Clipboard.ClipboardPasteButton
            acceptedContentTypes={["plain-text"]}
            backgroundColor={colors.backgroundElement}
            cornerStyle="medium"
            displayMode="labelOnly"
            foregroundColor={colors.text}
            onPress={(data) => {
              // The native control stays tappable during approval.
              if (!linking.current && data.type === "text") {
                changeText(data.text.trim());
              }
            }}
            style={{ height: 44, width: 84 }}
          />
        ) : (
          <Button
            disabled={Boolean(progress)}
            onPress={paste}
            variant="outline"
          >
            <Text>Paste</Text>
          </Button>
        )}
      </View>

      {payload.kind === "invalid" ? (
        <Text className="text-destructive" variant="caption">
          {payload.reason}
        </Text>
      ) : null}

      {fingerprint ? (
        <View className="bg-background-element gap-1 rounded-xl p-4">
          <Text className="text-foreground-secondary" variant="caption">
            Device fingerprint
          </Text>
          <Text className="font-mono" selectable variant="large">
            {fingerprint}
          </Text>
          <Text className="text-foreground-secondary" variant="caption">
            Only link if this matches “Pending device” in your terminal. The
            device will be able to send and receive as you.
          </Text>
        </View>
      ) : null}

      <Button
        disabled={!fingerprint || !p2pReady || Boolean(progress)}
        onPress={link}
      >
        {progress ? (
          <ActivityIndicator colorClassName="accent-primary-foreground" />
        ) : null}
        <Text>{progress ?? "Link device"}</Text>
      </Button>

      {fingerprint && !p2pReady ? (
        <Text className="text-foreground-secondary" variant="caption">
          Waiting for this phone to come online…
        </Text>
      ) : null}
      {error ? (
        <Text className="text-destructive" selectable variant="caption">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
};

export default LinkDeviceSheet;
