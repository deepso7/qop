import { asHex, pairingFingerprint } from "@qop/protocol";
import type { PairingOfferV1 } from "@qop/protocol";
import { Effect, Result } from "effect";
import * as Clipboard from "expo-clipboard";
import * as React from "react";
import { View } from "react-native";

import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import {
  signDeviceActionRecord,
  trustedIdentityDomain,
} from "@/lib/device-action-approval";
import { useIdentityStore } from "@/lib/identity-store";
import {
  markAcknowledged,
  persistApproval,
  reconcileMembership,
  submitAcknowledged,
} from "@/lib/local-device-action";
import { useP2pStore } from "@/lib/p2p-store";
import {
  decodePairingPayload,
  handshakePairing,
  sendPairingApproval,
} from "@/lib/pairing-client-core";

const DevicesLinkScreen = () => {
  const identity = useIdentityStore((state) => state.identity);
  const registration = useIdentityStore((state) => state.registration);
  const pairConnectAddr = useP2pStore((state) => state.pairConnectAddr);
  const pairWaitPeerReady = useP2pStore((state) => state.pairWaitPeerReady);
  const openPairingStream = useP2pStore((state) => state.openPairingStream);
  const p2pStatus = useP2pStore((state) => state.status);
  const [payload, setPayload] = React.useState("");
  const [message, setMessage] = React.useState<string>();
  const [offer, setOffer] = React.useState<PairingOfferV1>();
  const [peerId, setPeerId] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  const transport = React.useMemo(
    () => ({
      connectAddr: async (address: string) => {
        const connected = await pairConnectAddr(address);
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
    [openPairingStream, pairConnectAddr, pairWaitPeerReady]
  );

  const paste = React.useCallback(async () => {
    const value = await Clipboard.getStringAsync();
    setPayload(value.trim());
  }, []);

  const preview = React.useCallback(async () => {
    const decoded = await Effect.runPromise(
      decodePairingPayload(
        payload.trim(),
        BigInt(Math.floor(Date.now() / 1000))
      ).pipe(Effect.result)
    );
    if (Result.isFailure(decoded)) {
      setOffer(undefined);
      setPeerId(undefined);
      setMessage("That pairing payload is invalid or expired.");
      return;
    }
    const domain = trustedIdentityDomain();
    if (
      decoded.success.registry !== domain.verifyingContract ||
      decoded.success.chainId.toString() !== domain.chainId ||
      decoded.success.qid.toString() !== registration?.qid
    ) {
      setOffer(undefined);
      setMessage("This pairing is for a different account or registry.");
      return;
    }
    setOffer(decoded.success);
    setPeerId(undefined);
    setMessage(
      `CLI ${pairingFingerprint(asHex(decoded.success.deviceKey))} can send and receive as you.`
    );
  }, [payload, registration]);

  const connect = React.useCallback(async () => {
    if (!offer || !registration?.qid || busy) {
      return;
    }
    if (p2pStatus !== "running") {
      setMessage("Wait for this phone’s connection to start, then try again.");
      return;
    }
    setBusy(true);
    const result = await Effect.runPromise(
      handshakePairing(transport, offer, {
        chainId: trustedIdentityDomain().chainId,
        qid: registration.qid,
        registry: trustedIdentityDomain().verifyingContract,
      }).pipe(Effect.result)
    );
    setBusy(false);
    if (Result.isFailure(result)) {
      setMessage(
        "Could not connect to the CLI. Check the payload and try again."
      );
      return;
    }
    setPeerId(result.success.peerId);
    setMessage(
      `Connected to CLI ${result.success.fingerprint}. Linking lets it send and receive as you.`
    );
  }, [busy, offer, p2pStatus, registration, transport]);

  const link = React.useCallback(async () => {
    if (!offer || !peerId || !identity || !registration?.qid || busy) {
      return;
    }
    setBusy(true);
    setMessage("Saving approval…");
    const deviceKey = asHex(offer.deviceKey);
    const signed = await Effect.runPromise(
      signDeviceActionRecord({
        deviceKey,
        expectedOwner: identity.ownerAddress,
        operation: "add",
        qid: BigInt(registration.qid),
      }).pipe(Effect.result)
    );
    if (Result.isFailure(signed)) {
      setBusy(false);
      setMessage("Could not sign the device approval.");
      return;
    }
    if (asHex(signed.success.record.intent.deviceKey) !== deviceKey) {
      setBusy(false);
      setMessage("The signed key did not match the paired CLI.");
      return;
    }
    const persisted = await Effect.runPromise(
      persistApproval(signed.success.record).pipe(Effect.result)
    );
    if (Result.isFailure(persisted)) {
      setBusy(false);
      setMessage("Could not save the approval.");
      return;
    }
    setMessage("Waiting for the CLI to save the approval…");
    const ack = await Effect.runPromise(
      sendPairingApproval(transport, offer, peerId, signed.success.record).pipe(
        Effect.result
      )
    );
    if (Result.isFailure(ack)) {
      setBusy(false);
      setMessage(
        "The CLI did not acknowledge this approval. Re-pair to retry the same record."
      );
      return;
    }
    await Effect.runPromise(
      markAcknowledged(signed.success.record.digest).pipe(Effect.result)
    );
    setMessage("Submitting to the API…");
    await Effect.runPromise(submitAcknowledged().pipe(Effect.result));
    const membership = await Effect.runPromise(
      reconcileMembership().pipe(Effect.result)
    );
    setBusy(false);
    if (
      Result.isSuccess(membership) &&
      membership.success?.membership === "linked"
    ) {
      setMessage("Linked. Both devices confirmed chain membership.");
      return;
    }
    setMessage("Submitted. Waiting for chain membership…");
  }, [busy, identity, offer, peerId, registration, transport]);

  return (
    <Screen bounces={false}>
      <View className="gap-1">
        <Text variant="title">Link device</Text>
        <Text className="text-foreground-secondary" variant="caption">
          Paste the CLI pairing payload. Camera scanning is available in a
          development build after adding camera permission.
        </Text>
      </View>
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setPayload}
        placeholder="qop-pair1.…"
        value={payload}
      />
      <Button
        onPress={async () => {
          await paste();
        }}
        variant="outline"
      >
        <Text>Paste</Text>
      </Button>
      <Button
        disabled={busy}
        onPress={async () => {
          await preview();
        }}
      >
        <Text>Review pairing</Text>
      </Button>
      {offer ? (
        <Button
          disabled={busy}
          onPress={async () => {
            await connect();
          }}
          variant="outline"
        >
          <Text>Connect to CLI</Text>
        </Button>
      ) : null}
      {peerId ? (
        <Button
          disabled={busy}
          onPress={async () => {
            await link();
          }}
        >
          <Text>Link device</Text>
        </Button>
      ) : null}
      {message ? (
        <Text className="text-foreground-secondary" variant="caption">
          {message}
        </Text>
      ) : null}
    </Screen>
  );
};

export default React.memo(DevicesLinkScreen);
