import {
  Base64Url32,
  decodeDeviceSessionChallengeV1,
  decodeDeviceSessionProofV1,
  encodeDeviceSessionChallengeV1,
  encodeDeviceSessionProofV1,
  verifyDeviceSessionProofV1,
} from "@qop/identity";
import type {
  DeviceSessionChallengeV1,
  DeviceSessionChallengeV1Encoded,
  DeviceSessionPopCryptoError,
} from "@qop/identity";
import { Context, Data, DateTime, Effect, Layer, Option, Schema } from "effect";
import { keccak256 } from "viem";
import type { Hash } from "viem";

import type { DeviceCertificateInputError } from "../device/inputs.ts";
import {
  DeviceCertificateStore,
  DeviceCertificateStoreLive,
} from "../device/store.ts";
import type { DeviceCertificateStoreError } from "../device/store.ts";
import type { RegistryChainReadError } from "../registry/chain.ts";
import { normalizeCertificateDigest } from "../registry/inputs.ts";
import type { RegistryInputError } from "../registry/inputs.ts";
import { RegistryReader, RegistryReaderLive } from "../registry/reader.ts";
import type { DeviceSessionEntropyError } from "./entropy.ts";
import { DeviceSessionEntropy } from "./entropy.ts";
import {
  DeviceSessionChallengeConsumed,
  DeviceSessionChallengeExpired,
  DeviceSessionChallengeStore,
  DeviceSessionChallengeStoreLive,
} from "./store.ts";
import type {
  DeviceSessionChallengeStoreError,
  StoredDeviceSessionChallenge,
} from "./store.ts";

export const deviceSessionChallengeTtlSeconds = 300n;

export interface IssueDeviceSessionChallenge {
  readonly certificateDigest: Hash;
  readonly flow: DeviceSessionChallengeV1["flow"];
}

export interface CompletedDeviceSessionProof {
  readonly certificateDigest: Hash;
  readonly peerId: string;
  readonly qid: bigint;
}

export class DeviceSessionCertificateRejected extends Data.TaggedError(
  "DeviceSessionCertificateRejected"
)<{
  readonly certificateDigest: Hash;
  readonly reason: "not-found" | "owner-version" | "revoked";
}> {}

export class DeviceSessionChallengeBindingMismatch extends Data.TaggedError(
  "DeviceSessionChallengeBindingMismatch"
)<{ readonly challengeHash: Hash }> {}

export class DeviceSessionProofInvalid extends Data.TaggedError(
  "DeviceSessionProofInvalid"
)<{ readonly challengeHash: Hash }> {}

export class DeviceSessionProtocolError extends Data.TaggedError(
  "DeviceSessionProtocolError"
)<{
  readonly cause: unknown;
  readonly operation:
    | "decode-challenge"
    | "decode-proof"
    | "encode-challenge"
    | "encode-proof";
}> {}

export type DeviceSessionServiceError =
  | DeviceCertificateInputError
  | DeviceCertificateStoreError
  | DeviceSessionCertificateRejected
  | DeviceSessionChallengeBindingMismatch
  | DeviceSessionChallengeStoreError
  | DeviceSessionEntropyError
  | DeviceSessionPopCryptoError
  | DeviceSessionProofInvalid
  | DeviceSessionProtocolError
  | RegistryChainReadError
  | RegistryInputError;

export interface DeviceSessionServiceShape {
  readonly complete: (
    proof: unknown
  ) => Effect.Effect<CompletedDeviceSessionProof, DeviceSessionServiceError>;
  readonly issue: (
    input: IssueDeviceSessionChallenge
  ) => Effect.Effect<
    DeviceSessionChallengeV1Encoded,
    DeviceSessionServiceError
  >;
}

const protocolError =
  (operation: DeviceSessionProtocolError["operation"]) =>
  (cause: unknown): DeviceSessionProtocolError =>
    new DeviceSessionProtocolError({ cause, operation });

const nowSeconds = DateTime.now.pipe(
  Effect.map((now) => BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)))
);

const storedChallengeMatches = (
  stored: StoredDeviceSessionChallenge,
  challenge: DeviceSessionChallengeV1Encoded
): boolean =>
  stored.certificateDigest === challenge.certificateDigest &&
  stored.expiresAt === BigInt(challenge.expiresAt) &&
  stored.flow === challenge.flow &&
  stored.issuedAt === BigInt(challenge.issuedAt) &&
  stored.peerId === challenge.peerId &&
  stored.qid === BigInt(challenge.qid) &&
  stored.version === challenge.version;

export class DeviceSessionService extends Context.Service<
  DeviceSessionService,
  DeviceSessionServiceShape
>()("@qop/api/DeviceSessionService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const certificates = yield* DeviceCertificateStore;
      const challenges = yield* DeviceSessionChallengeStore;
      const entropy = yield* DeviceSessionEntropy;
      const registry = yield* RegistryReader;

      const requireCurrentCertificate = Effect.fn(
        "DeviceSessionService.requireCurrentCertificate"
      )(function* (certificateDigest: Hash) {
        const certificate = yield* certificates.get(certificateDigest);
        if (Option.isNone(certificate)) {
          return yield* new DeviceSessionCertificateRejected({
            certificateDigest,
            reason: "not-found",
          });
        }
        const account = yield* registry.fresh.account(certificate.value.qid);
        if (account.value.ownerVersion !== certificate.value.ownerVersion) {
          return yield* new DeviceSessionCertificateRejected({
            certificateDigest,
            reason: "owner-version",
          });
        }
        const revocation = yield* registry.fresh.deviceRevocation(
          certificate.value.qid,
          certificateDigest
        );
        if (revocation.value) {
          return yield* new DeviceSessionCertificateRejected({
            certificateDigest,
            reason: "revoked",
          });
        }
        return certificate.value;
      });

      const issue = Effect.fn("DeviceSessionService.issue")(function* (
        input: IssueDeviceSessionChallenge
      ) {
        yield* challenges.purgeExpired;
        const certificateDigest = yield* normalizeCertificateDigest(
          input.certificateDigest
        );
        const certificate = yield* requireCurrentCertificate(certificateDigest);
        const issuedAt = yield* nowSeconds;
        const challengeBytes = yield* entropy.bytes32;
        const challengeToken = yield* Schema.encodeEffect(Base64Url32)(
          challengeBytes
        ).pipe(Effect.mapError(protocolError("encode-challenge")));
        const challenge = yield* decodeDeviceSessionChallengeV1({
          certificateDigest,
          challenge: challengeToken,
          expiresAt: (issuedAt + deviceSessionChallengeTtlSeconds).toString(),
          flow: input.flow,
          issuedAt: issuedAt.toString(),
          peerId: certificate.peerId,
          qid: certificate.qid.toString(),
          version: 1,
        }).pipe(Effect.mapError(protocolError("decode-challenge")));
        const encoded = yield* encodeDeviceSessionChallengeV1(challenge).pipe(
          Effect.mapError(protocolError("encode-challenge"))
        );
        yield* challenges.create({
          challenge: encoded,
          challengeHash: keccak256(challengeBytes),
        });
        return encoded;
      });

      const complete = Effect.fn("DeviceSessionService.complete")(function* (
        input: unknown
      ) {
        const proof = yield* decodeDeviceSessionProofV1(input).pipe(
          Effect.mapError(protocolError("decode-proof"))
        );
        const encodedProof = yield* encodeDeviceSessionProofV1(proof).pipe(
          Effect.mapError(protocolError("encode-proof"))
        );
        const challengeHash = keccak256(proof.challenge.challenge);
        const stored = yield* challenges.get(challengeHash);
        if (Option.isNone(stored)) {
          return yield* new DeviceSessionChallengeBindingMismatch({
            challengeHash,
          });
        }
        if (!storedChallengeMatches(stored.value, encodedProof.challenge)) {
          return yield* new DeviceSessionChallengeBindingMismatch({
            challengeHash,
          });
        }
        const currentSeconds = yield* nowSeconds;
        if (stored.value.consumedAt !== null) {
          return yield* new DeviceSessionChallengeConsumed({ challengeHash });
        }
        if (stored.value.expiresAt <= currentSeconds) {
          return yield* new DeviceSessionChallengeExpired({ challengeHash });
        }
        const valid = yield* verifyDeviceSessionProofV1(proof);
        if (!valid) {
          return yield* new DeviceSessionProofInvalid({ challengeHash });
        }
        const certificate = yield* requireCurrentCertificate(
          stored.value.certificateDigest
        ).pipe(
          Effect.catchTag("DeviceSessionCertificateRejected", (error) =>
            challenges
              .consume(challengeHash)
              .pipe(Effect.flatMap(() => Effect.fail(error)))
          )
        );
        yield* challenges.consume(challengeHash);
        return {
          certificateDigest: certificate.certificateDigest,
          peerId: certificate.peerId,
          qid: certificate.qid,
        };
      });

      return DeviceSessionService.of({ complete, issue });
    })
  );
}

export const DeviceSessionServiceLive = DeviceSessionService.layer.pipe(
  Layer.provide(DeviceCertificateStoreLive),
  Layer.provide(DeviceSessionChallengeStoreLive),
  Layer.provide(DeviceSessionEntropy.layer),
  Layer.provide(RegistryReaderLive)
);
