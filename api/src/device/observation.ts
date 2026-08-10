import {
  Base64Url32,
  decodeIdentityEip712DomainV1,
  decodeIdentityEnvelopeV1,
  encodeIdentityEnvelopeV1,
  hashDeviceCertificateV1,
  hashRegistrationDeviceCommitmentV1,
  verifyDeviceCertificateOwnerV1,
} from "@qop/identity";
import type {
  IdentityCryptoError,
  IdentityEip712DomainV1,
  IdentityEnvelopeV1Encoded,
} from "@qop/identity";
import { Context, Data, DateTime, Effect, Layer, Option, Schema } from "effect";
import { keccak256 } from "viem";
import type { Hash } from "viem";

import { Env } from "../env.ts";
import type { RegistrationInputError } from "../registration/inputs.ts";
import {
  RegistrationStore,
  RegistrationStoreLive,
} from "../registration/store.ts";
import type {
  RegistrationStorePersistenceError,
  StoredRegistrationIntent,
} from "../registration/store.ts";
import type { RegistrationIntentStatus } from "../registration/types.ts";
import type { RegistryChainReadError } from "../registry/chain.ts";
import { RegistryReader, RegistryReaderLive } from "../registry/reader.ts";
import type { DeviceCertificateInputError } from "./inputs.ts";
import {
  DeviceCertificateStore,
  DeviceCertificateStoreLive,
  DeviceObservationCapabilityConflict,
} from "./store.ts";
import type {
  DeviceCertificateStoreError,
  StoredDeviceCertificate,
} from "./store.ts";

export const deviceCertificateFutureSkewSeconds = 300n;

export interface ObserveRegistrationDevice {
  readonly envelope: unknown;
  readonly observeToken: string;
}

export interface ObservedRegistrationDevice {
  readonly certificateDigest: Hash;
  readonly envelope: IdentityEnvelopeV1Encoded;
  readonly observedAt: Date;
  readonly qid: bigint;
}

export class DeviceObservationUnauthorized extends Data.TaggedError(
  "DeviceObservationUnauthorized"
) {}

export class DeviceObservationRegistrationNotConfirmed extends Data.TaggedError(
  "DeviceObservationRegistrationNotConfirmed"
)<{
  readonly actual: RegistrationIntentStatus;
}> {}

export class DeviceCertificateRejected extends Data.TaggedError(
  "DeviceCertificateRejected"
)<{
  readonly reason:
    | "future-issued-at"
    | "device-commitment"
    | "expired"
    | "owner-signature"
    | "owner-version"
    | "peer-id"
    | "predates-account"
    | "qid"
    | "revoked";
}> {}

export class DeviceObservationProtocolError extends Data.TaggedError(
  "DeviceObservationProtocolError"
)<{
  readonly cause: unknown;
  readonly operation:
    | "decode-domain"
    | "decode-envelope"
    | "decode-observe-token"
    | "encode-envelope";
}> {}

export type DeviceObservationError =
  | DeviceCertificateInputError
  | DeviceCertificateRejected
  | DeviceCertificateStoreError
  | DeviceObservationProtocolError
  | DeviceObservationRegistrationNotConfirmed
  | DeviceObservationUnauthorized
  | IdentityCryptoError
  | RegistrationInputError
  | RegistrationStorePersistenceError
  | RegistryChainReadError;

export interface DeviceObservationShape {
  readonly observeFromRegistration: (
    input: ObserveRegistrationDevice
  ) => Effect.Effect<ObservedRegistrationDevice, DeviceObservationError>;
}

const protocolError =
  (operation: DeviceObservationProtocolError["operation"]) =>
  (cause: unknown): DeviceObservationProtocolError =>
    new DeviceObservationProtocolError({ cause, operation });

const requireConfirmedRegistration = Effect.fn(
  "DeviceObservation.requireConfirmedRegistration"
)(function* (registration: StoredRegistrationIntent): Effect.fn.Return<
  StoredRegistrationIntent & {
    readonly qid: bigint;
    readonly status: "confirmed";
  },
  DeviceObservationRegistrationNotConfirmed
> {
  if (registration.status !== "confirmed" || registration.qid === null) {
    return yield* new DeviceObservationRegistrationNotConfirmed({
      actual: registration.status,
    });
  }
  return registration as StoredRegistrationIntent & {
    readonly qid: bigint;
    readonly status: "confirmed";
  };
});

const observedDevice = (
  stored: StoredDeviceCertificate,
  envelope: IdentityEnvelopeV1Encoded
): ObservedRegistrationDevice => ({
  certificateDigest: stored.certificateDigest,
  envelope,
  observedAt: stored.observedAt,
  qid: stored.qid,
});

export class DeviceObservation extends Context.Service<
  DeviceObservation,
  DeviceObservationShape
>()("@qop/api/DeviceObservation") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const certificates = yield* DeviceCertificateStore;
      const env = yield* Env;
      const registrations = yield* RegistrationStore;
      const registry = yield* RegistryReader;
      const domain: IdentityEip712DomainV1 =
        yield* decodeIdentityEip712DomainV1({
          chainId: env.CHAIN_ID.toString(),
          verifyingContract: env.REGISTRY_ADDRESS,
        }).pipe(Effect.mapError(protocolError("decode-domain")));

      const observeFromRegistration = Effect.fn(
        "DeviceObservation.observeFromRegistration"
      )(function* (input: ObserveRegistrationDevice) {
        const observeTokenBytes = yield* Schema.decodeUnknownEffect(
          Base64Url32
        )(input.observeToken).pipe(
          Effect.mapError(protocolError("decode-observe-token"))
        );
        const observeTokenHash = keccak256(observeTokenBytes);
        const maybeRegistration =
          yield* registrations.getByObserveTokenHash(observeTokenHash);
        if (Option.isNone(maybeRegistration)) {
          return yield* new DeviceObservationUnauthorized();
        }
        const registration = yield* requireConfirmedRegistration(
          maybeRegistration.value
        );

        const envelope = yield* decodeIdentityEnvelopeV1(input.envelope).pipe(
          Effect.mapError(protocolError("decode-envelope"))
        );
        const encodedEnvelope = yield* encodeIdentityEnvelopeV1(envelope).pipe(
          Effect.mapError(protocolError("encode-envelope"))
        );
        if (envelope.certificate.qid !== registration.qid) {
          return yield* new DeviceCertificateRejected({ reason: "qid" });
        }
        if (encodedEnvelope.certificate.peerId !== registration.peerId) {
          return yield* new DeviceCertificateRejected({ reason: "peer-id" });
        }
        const deviceCommitment = yield* hashRegistrationDeviceCommitmentV1(
          envelope.certificate.peerId,
          observeTokenBytes
        );
        if (deviceCommitment !== registration.deviceCommitment) {
          return yield* new DeviceCertificateRejected({
            reason: "device-commitment",
          });
        }

        const certificateDigest = yield* hashDeviceCertificateV1(
          domain,
          envelope.certificate
        );
        const priorObservation =
          yield* certificates.getObservedFromRegistration(registration.digest);
        if (Option.isSome(priorObservation)) {
          if (priorObservation.value.certificateDigest !== certificateDigest) {
            return yield* new DeviceObservationCapabilityConflict({
              certificateDigest: priorObservation.value.certificateDigest,
              registrationIntentDigest: registration.digest,
            });
          }
          return observedDevice(priorObservation.value, encodedEnvelope);
        }

        const account = yield* registry.fresh.account(registration.qid);
        if (envelope.certificate.ownerVersion !== account.value.ownerVersion) {
          return yield* new DeviceCertificateRejected({
            reason: "owner-version",
          });
        }
        if (envelope.certificate.issuedAt < account.value.registeredAt) {
          return yield* new DeviceCertificateRejected({
            reason: "predates-account",
          });
        }
        const now = yield* DateTime.now;
        const nowSeconds = BigInt(
          Math.floor(DateTime.toEpochMillis(now) / 1000)
        );
        if (
          envelope.certificate.issuedAt >
          nowSeconds + deviceCertificateFutureSkewSeconds
        ) {
          return yield* new DeviceCertificateRejected({
            reason: "future-issued-at",
          });
        }
        if (envelope.certificate.expiresAt <= nowSeconds) {
          return yield* new DeviceCertificateRejected({ reason: "expired" });
        }
        const ownerMatches = yield* verifyDeviceCertificateOwnerV1(
          domain,
          envelope.certificate,
          envelope.signature,
          account.value.owner
        );
        if (!ownerMatches) {
          return yield* new DeviceCertificateRejected({
            reason: "owner-signature",
          });
        }

        const revocation = yield* registry.fresh.deviceRevocation(
          registration.qid,
          certificateDigest
        );
        if (revocation.value) {
          return yield* new DeviceCertificateRejected({ reason: "revoked" });
        }

        const stored = yield* certificates.observeFromRegistration({
          certificateDigest,
          envelope: encodedEnvelope,
          registrationIntentDigest: registration.digest,
        });
        return observedDevice(stored, encodedEnvelope);
      });

      return DeviceObservation.of({ observeFromRegistration });
    })
  );
}

export const DeviceObservationLive = DeviceObservation.layer.pipe(
  Layer.provide(DeviceCertificateStoreLive),
  Layer.provide(RegistrationStoreLive),
  Layer.provide(RegistryReaderLive),
  Layer.provide(Env.layer)
);
