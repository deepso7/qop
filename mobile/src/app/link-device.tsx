import type { ConnectTarget } from "@minip2p/react-native";
import { asHex, pairingFingerprint } from "@qop/protocol";
import type { PairingOfferV1 } from "@qop/protocol";
import { Effect, Result } from "effect";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import * as React from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
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

// The QR scanner: hidden, showing the camera, or blocked by camera permission.
type Scanner = "closed" | "denied" | "open";

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
const Camera = withUniwind(CameraView);

/**
 * Checks pasted or scanned text: a live pairing offer for this account.
 * `editedAtSeconds` is when the text arrived, for the expiry check.
 */
const readPayload = (
  text: string,
  editedAtSeconds: bigint,
  { identity, qid }: Account
): Payload => {
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
      reason: "Not a valid pairing code, or it has expired.",
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
      reason: `This code is for a different account. Link it as ${identity.handle} (qop link --account ${identity.handle}).`,
    };
  }

  return { kind: "valid", offer: decoded.success };
};

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

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
      return "Could not finish linking. Start linking again on the other device and retry.";
    }
  }
};

/**
 * Sheet that links QOP Desktop or the CLI to this account: scan or paste its
 * pairing code, check the fingerprint against that device, then one tap
 * connects and approves.
 */
const LinkDeviceSheet = ({ account }: { account: Account }) => {
  const { identity, qid } = account;
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
  const [scanner, setScanner] = React.useState<Scanner>("closed");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
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
  const payload = React.useMemo(
    () => readPayload(text, editedAtSeconds, account),
    [account, editedAtSeconds, text]
  );

  const changeText = React.useCallback((next: string) => {
    setText(next);
    setEditedAtSeconds(nowSeconds());
    // A slow clipboard read can land after linking started.
    setState((current) => (current.kind === "failed" ? IDLE : current));
  }, []);

  const paste = React.useCallback(async () => {
    const pasted = await Clipboard.getStringAsync();
    changeText(pasted.trim());
  }, [changeText]);

  // Asks for the camera on first use; a refusal falls back to paste.
  const openScanner = React.useCallback(async () => {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();

    // Linking may have started while the permission prompt was up.
    if (linking.current) {
      return;
    }

    setScanner(permission.granted ? "open" : "denied");
  }, [cameraPermission, requestCameraPermission]);

  // A scanned code goes through the same path as a paste. The scanner stays
  // open on an invalid code so the user can try again.
  const scanned = React.useCallback(
    ({ data }: BarcodeScanningResult) => {
      const next = data.trim();

      // The camera reports a code on every frame it stays in view.
      if (linking.current || next === text.trim()) {
        return;
      }

      changeText(next);

      if (readPayload(next, nowSeconds(), account).kind === "valid") {
        setScanner("closed");
      }
    },
    [account, changeText, text]
  );

  /**
   * Connect to the other device, then approve its enrollment and wait for it.
   * Resolves to a failure message, or undefined once linked; never throws.
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
        return "Could not reach the other device. Keep its pairing code open and try again.";
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
          ? "This device was linked and later removed. Start linking again on it."
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
    if (BigInt(offer.expiresAt) <= nowSeconds()) {
      setState({
        kind: "failed",
        message: "This code has expired. Get a new one and try again.",
      });

      return;
    }

    // A ref, not state: a second tap can land before the re-render.
    linking.current = true;
    // Closed for good: reopened after a failure, it could scan over the code being linked.
    setScanner("closed");
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
        Scan the QR code shown in QOP Desktop, or run{" "}
        <Text variant="monospace">qop link --account {identity.handle}</Text> on
        your computer and paste the pairing code it prints.
      </Text>

      {scanner === "open" && !busy ? (
        <View className="gap-2">
          <View className="aspect-square overflow-hidden rounded-xl bg-black">
            <Camera
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              className="flex-1"
              facing="back"
              onBarcodeScanned={scanned}
            />
          </View>
          <Button onPress={() => setScanner("closed")} variant="outline">
            <Text>Stop scanning</Text>
          </Button>
        </View>
      ) : (
        <Button disabled={busy} onPress={openScanner} variant="outline">
          <Text>Scan QR code</Text>
        </Button>
      )}

      {scanner === "denied" ? (
        <View className="gap-2">
          <Text tone="secondary" variant="caption">
            Camera access is off, so paste the code instead. You can allow the
            camera in Settings.
          </Text>
          <Button
            onPress={() => {
              void Linking.openSettings();
            }}
            size="sm"
            variant="outline"
          >
            <Text>Open Settings</Text>
          </Button>
        </View>
      ) : null}

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
            Only link if this matches the fingerprint shown on the other device.
            It will be able to send and receive as you.
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
