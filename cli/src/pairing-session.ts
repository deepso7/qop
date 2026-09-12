import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  EcdsaSignature,
  recoverAddDeviceIntentSignerV1,
} from "@qop/identity";
import {
  acknowledgeApproval,
  asHex,
  asQidString,
  DEVICE_ACTION_DEADLINE_SECONDS,
  verifyApprovalDigest,
} from "@qop/protocol";
import type {
  DeviceActionApprovalV1,
  PairingFrameV1,
  PairingOfferV1,
} from "@qop/protocol";
import { Data, Effect, Schema } from "effect";

export class PairingSessionError extends Data.TaggedError(
  "PairingSessionError"
)<{
  readonly operation:
    | "claimed"
    | "expired"
    | "membership"
    | "mismatch"
    | "secret"
    | "unclaimed";
}> {}

export interface PairingAccountSnapshot {
  readonly chainId: string;
  readonly chainTime: bigint;
  readonly devices: readonly string[];
  readonly nonce: bigint;
  readonly owner: string;
  readonly qid: bigint;
  readonly registry: string;
}

export const createCliPairingSession = <E>({
  loadApproval,
  nowSeconds = () => BigInt(Math.floor(Date.now() / 1000)),
  offer,
  saveApproval,
}: {
  readonly loadApproval: () => Effect.Effect<DeviceActionApprovalV1 | null, E>;
  readonly nowSeconds?: () => bigint;
  readonly offer: PairingOfferV1;
  readonly saveApproval: (
    record: DeviceActionApprovalV1
  ) => Effect.Effect<void, E>;
}) => {
  let claimedPeerId: string | undefined;
  let claimedPhoneKey: string | undefined;

  const assertOfferFresh = () => {
    if (BigInt(offer.expiresAt) <= nowSeconds()) {
      return Effect.fail(new PairingSessionError({ operation: "expired" }));
    }
    return Effect.void;
  };

  const mismatch = () => new PairingSessionError({ operation: "mismatch" });

  const approvalMatchesAccount = (
    record: DeviceActionApprovalV1,
    snapshot: PairingAccountSnapshot
  ) =>
    record.operation === "add" &&
    asQidString(record.domain.chainId) === snapshot.chainId &&
    record.domain.verifyingContract === snapshot.registry &&
    asQidString(record.intent.qid) === asQidString(snapshot.qid) &&
    asHex(record.intent.deviceKey) === asHex(offer.deviceKey) &&
    record.expectedOwner === snapshot.owner;

  const assertNewOccupancy = (
    record: DeviceActionApprovalV1,
    snapshot: PairingAccountSnapshot,
    replay: boolean
  ) => {
    if (replay) {
      return Effect.void;
    }
    if (asQidString(record.intent.nonce) !== asQidString(snapshot.nonce)) {
      return Effect.fail(mismatch());
    }
    const deadline = BigInt(record.intent.deadline);
    if (
      deadline <= snapshot.chainTime ||
      deadline > snapshot.chainTime + BigInt(DEVICE_ACTION_DEADLINE_SECONDS)
    ) {
      return Effect.fail(mismatch());
    }
    return assertOfferFresh();
  };

  const verifyOwnerSigner = (
    record: DeviceActionApprovalV1,
    snapshot: PairingAccountSnapshot
  ) =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(record.domain).pipe(
        Effect.mapError(mismatch)
      );
      const intent = yield* decodeAddDeviceIntentV1(record.intent).pipe(
        Effect.mapError(mismatch)
      );
      const signature = yield* Schema.decodeUnknownEffect(EcdsaSignature)(
        asHex(record.ownerSignature)
      ).pipe(Effect.mapError(mismatch));
      const signer = yield* recoverAddDeviceIntentSignerV1(
        domain,
        intent,
        signature
      ).pipe(Effect.mapError(mismatch));
      if (signer !== snapshot.owner.toLowerCase()) {
        return yield* mismatch();
      }
    });

  const hello = Effect.fn("CliPairingSession.hello")(function* (
    peerId: string,
    secret: string | Uint8Array,
    phoneDeviceKey: string,
    snapshot: PairingAccountSnapshot,
    challenge: PairingFrameV1 & { readonly type: "hello" }
  ) {
    yield* assertOfferFresh();
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
    claimedPhoneKey = phoneDeviceKey.toLowerCase();
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
      snapshot: PairingAccountSnapshot,
      sessionId: string | Uint8Array
    ) {
      if (!claimedPeerId) {
        return yield* new PairingSessionError({ operation: "unclaimed" });
      }
      if (peerId !== claimedPeerId) {
        return yield* new PairingSessionError({ operation: "claimed" });
      }
      if (asHex(sessionId) !== asHex(offer.sessionId)) {
        return yield* mismatch();
      }
      yield* verifyApprovalDigest(record).pipe(Effect.mapError(mismatch));
      if (!approvalMatchesAccount(record, snapshot)) {
        return yield* mismatch();
      }
      if (!claimedPhoneKey || !snapshot.devices.includes(claimedPhoneKey)) {
        return yield* new PairingSessionError({ operation: "membership" });
      }
      const pending = yield* loadApproval();
      const ack = acknowledgeApproval(pending, record);
      if (ack.kind === "conflict") {
        return ack;
      }
      const replay = pending !== null && pending.digest === record.digest;
      yield* assertNewOccupancy(record, snapshot, replay);
      yield* verifyOwnerSigner(record, snapshot);
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
