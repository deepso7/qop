import {
  acknowledgeApproval,
  asHex,
  asQidString,
  verifyApprovalDigest,
} from "@qop/protocol";
import type {
  DeviceActionApprovalV1,
  PairingFrameV1,
  PairingOfferV1,
} from "@qop/protocol";
import { Data, Effect } from "effect";

export class PairingSessionError extends Data.TaggedError(
  "PairingSessionError"
)<{
  readonly operation:
    | "claimed"
    | "membership"
    | "mismatch"
    | "secret"
    | "unclaimed";
}> {}

export interface PairingAccountSnapshot {
  readonly chainId: string;
  readonly devices: readonly string[];
  readonly owner: string;
  readonly qid: bigint;
  readonly registry: string;
}

export const createCliPairingSession = <E>({
  loadApproval,
  offer,
  saveApproval,
}: {
  readonly loadApproval: () => Effect.Effect<DeviceActionApprovalV1 | null, E>;
  readonly offer: PairingOfferV1;
  readonly saveApproval: (
    record: DeviceActionApprovalV1
  ) => Effect.Effect<void, E>;
}) => {
  let claimedPeerId: string | undefined;

  const hello = Effect.fn("CliPairingSession.hello")(function* (
    peerId: string,
    secret: string | Uint8Array,
    phoneDeviceKey: string,
    snapshot: PairingAccountSnapshot,
    challenge: PairingFrameV1 & { readonly type: "hello" }
  ) {
    if (asHex(secret) !== asHex(offer.secret)) {
      return yield* new PairingSessionError({ operation: "secret" });
    }
    if (asHex(challenge.sessionId) !== asHex(offer.sessionId)) {
      return yield* new PairingSessionError({ operation: "mismatch" });
    }
    if (snapshot.chainId !== asQidString(offer.chainId)) {
      return yield* new PairingSessionError({ operation: "mismatch" });
    }
    if (snapshot.registry !== offer.registry) {
      return yield* new PairingSessionError({ operation: "mismatch" });
    }
    if (asQidString(snapshot.qid) !== asQidString(offer.qid)) {
      return yield* new PairingSessionError({ operation: "mismatch" });
    }
    if (!snapshot.devices.includes(phoneDeviceKey.toLowerCase())) {
      return yield* new PairingSessionError({ operation: "membership" });
    }
    if (claimedPeerId && claimedPeerId !== peerId) {
      return yield* new PairingSessionError({ operation: "claimed" });
    }
    claimedPeerId = peerId;
    return {
      chainId: offer.chainId,
      challenge: challenge.challenge,
      deviceKey: offer.deviceKey,
      qid: offer.qid,
      registry: offer.registry,
      sessionId: offer.sessionId,
      type: "helloAck",
      v: 1,
    } satisfies PairingFrameV1;
  });

  const receiveApproval = Effect.fn("CliPairingSession.receiveApproval")(
    function* (
      peerId: string,
      record: DeviceActionApprovalV1,
      snapshot: PairingAccountSnapshot
    ) {
      if (!claimedPeerId) {
        return yield* new PairingSessionError({ operation: "unclaimed" });
      }
      if (peerId !== claimedPeerId) {
        return yield* new PairingSessionError({ operation: "claimed" });
      }
      yield* verifyApprovalDigest(record);
      if (
        record.operation !== "add" ||
        asQidString(record.domain.chainId) !== snapshot.chainId ||
        record.domain.verifyingContract !== snapshot.registry ||
        asQidString(record.intent.qid) !== asQidString(snapshot.qid) ||
        asHex(record.intent.deviceKey) !== asHex(offer.deviceKey) ||
        record.expectedOwner !== snapshot.owner
      ) {
        return yield* new PairingSessionError({ operation: "mismatch" });
      }
      const pending = yield* loadApproval();
      const ack = acknowledgeApproval(pending, record);
      if (
        ack.kind === "saved" &&
        (!pending || pending.digest !== record.digest)
      ) {
        yield* saveApproval(record);
      }
      return ack;
    }
  );

  return { hello, receiveApproval };
};
