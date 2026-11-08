import type { ConnectTarget } from "@minip2p/react-native";
import { asHex, pairingFingerprint } from "@qop/protocol";
import type { PairingOfferV1 } from "@qop/protocol";
import { Effect, Result } from "effect";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import * as React from "react";
import { Platform, ScrollView, View } from "react-native";
import { withUniwind } from "uniwind";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useTheme } from "@/constants/theme";
import { trustedIdentityDomain } from "@/lib/device-action-approval";
import { completeDeviceLink } from "@/lib/device-link-flow";
import { successHaptic } from "@/lib/haptics";
import { selectAccount, useIdentityStore } from "@/lib/identity-store";
import type { Account } from "@/lib/identity-store";
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

type LinkState =
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "idle" }
  | { readonly kind: "linking"; readonly step: keyof typeof STEP_LABELS };

const STEP_LABELS = {
  approving: "Approving…",
  connecting: "Connecting to your computer…",
} as const;

const IDLE: LinkState = { kind: "idle" };

// Native UIPasteControl, sized through classes.
const PasteButton = withUniwind(Clipboard.ClipboardPasteButton);

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
const LinkDeviceSheet = ({
  account: { identity, qid },
}: {
  account: Account;
}) => {
  const router = useRouter();
  const colors = useTheme();
  const pairConnect = useP2pStore((state) => state.pairConnect);
  const pairWaitPeerReady = useP2pStore((state) => state.pairWaitPeerReady);
  const openPairingStream = useP2pStore((state) => state.openPairingStream);

  const invalidateOwnHolders = useP2pStore(
    (state) => state.invalidateOwnHolders
  );

  const p2pStatus = useP2pStore((state) => state.connection.status);
  const [text, setText] = React.useState("");
  // When the text last changed; expiry is checked against it, not render time.
  const [editedAtSeconds, setEditedAtSeconds] = React.useState(0n);
  const [state, setState] = React.useState<LinkState>(IDLE);
  const busy = state.kind === "linking";
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
        qid,
        registry: domain.verifyingContract,
      }).pipe(Effect.result)
    );

    if (Result.isFailure(sameAccount)) {
      return {
        kind: "invalid",
        reason: `This payload is for a different account. Use --account ${identity.handle}.`,
      };
    }

    return { kind: "valid", offer: decoded.success };
  }, [editedAtSeconds, identity.handle, qid, text]);

  const changeText = React.useCallback((next: string) => {
    setText(next);
    setEditedAtSeconds(BigInt(Math.floor(Date.now() / 1000)));
    // A slow clipboard read can land after linking started.
    setState((current) => (current.kind === "failed" ? IDLE : current));
  }, []);

  const paste = React.useCallback(async () => {
    const pasted = await Clipboard.getStringAsync();
    changeText(pasted.trim());
  }, [changeText]);

  /**
   * Connect to the CLI, then approve its enrollment and wait for it. Resolves
   * to a failure message, or undefined once linked; never throws.
   */
  const approve = React.useCallback(
    async (offer: PairingOfferV1) => {
      const domain = trustedIdentityDomain();
      setState({ kind: "linking", step: "connecting" });

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
        return "Could not reach your computer. Keep the link command running and try again.";
      }

      setState({ kind: "linking", step: "approving" });

      const result = await Effect.runPromise(
        completeDeviceLink({
          deviceKey: asHex(offer.deviceKey),
          expectedOwner: identity.ownerAddress,
          offer,
          peerId: handshake.success.peerId,
          qid: BigInt(qid),
          transport,
        }).pipe(Effect.result)
      );

      if (Result.isFailure(result)) {
        const { failure } = result;

        return linkFailureMessage(
          failure instanceof LocalDeviceActionError
            ? failure.operation
            : undefined
        );
      }

      if (result.success?.membership !== "linked") {
        return result.success?.membership === "removed"
          ? "This device was linked and later removed. Run the link command again."
          : "The approval finished, but the device did not become active.";
      }

      invalidateOwnHolders();
      void successHaptic();
      router.back();
    },
    [identity.ownerAddress, invalidateOwnHolders, qid, router, transport]
  );

  const link = React.useCallback(async () => {
    if (payload.kind !== "valid" || linking.current) {
      return;
    }

    const { offer } = payload;

    // The sheet may have stayed open past the offer's expiry.
    if (BigInt(offer.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) {
      setState({
        kind: "failed",
        message: "This payload has expired. Run the link command again.",
      });

      return;
    }

    // A ref, not state: a second tap can land before the re-render.
    linking.current = true;
    const failure = await approve(offer);
    linking.current = false;
    setState(
      failure === undefined ? IDLE : { kind: "failed", message: failure }
    );
  }, [approve, payload]);

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
        <Text className="mt-4" variant="large">
          Link a device
        </Text>
      ) : null}
      <Text tone="secondary">
        On your computer, run{" "}
        <Text variant="monospace">qop link --account {identity.handle}</Text>{" "}
        and paste the pairing payload it prints.
      </Text>

      <View className="flex-row gap-2">
        <Input
          autoCapitalize="none"
          autoCorrect={false}
          className="flex-1"
          editable={!busy}
          onChangeText={changeText}
          placeholder="qop-pair1.…"
          value={text}
        />
        {Clipboard.isPasteButtonAvailable ? (
          // Native UIPasteControl pastes without the "Allow Paste" prompt.
          <PasteButton
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
            className="h-11 w-21"
          />
        ) : (
          <Button disabled={busy} onPress={paste} variant="outline">
            <Text>Paste</Text>
          </Button>
        )}
      </View>

      {payload.kind === "invalid" ? (
        <Text tone="destructive" variant="caption">
          {payload.reason}
        </Text>
      ) : null}

      {fingerprint ? (
        <View className="bg-background-element gap-1 rounded-xl p-4">
          <Text tone="secondary" variant="caption">
            Device fingerprint
          </Text>
          <Text selectable variant="fingerprint">
            {fingerprint}
          </Text>
          <Text tone="secondary" variant="caption">
            Only link if this matches “Pending device” in your terminal. The
            device will be able to send and receive as you.
          </Text>
        </View>
      ) : null}

      <Button disabled={!fingerprint || !p2pReady || busy} onPress={link}>
        {busy ? <Spinner tone="onPrimary" /> : null}
        <Text>{busy ? STEP_LABELS[state.step] : "Link device"}</Text>
      </Button>

      {fingerprint && !p2pReady ? (
        <Text tone="secondary" variant="caption">
          Waiting for this phone to come online…
        </Text>
      ) : null}
      {state.kind === "failed" ? (
        <Text selectable tone="destructive" variant="caption">
          {state.message}
        </Text>
      ) : null}
    </ScrollView>
  );
};

// Stack.Protected can render this once more after the account is gone (e.g.
// on log out), before it unmounts.
const LinkDeviceRoute = () => {
  const account = useIdentityStore(selectAccount);

  return account ? <LinkDeviceSheet account={account} /> : null;
};

export default LinkDeviceRoute;
