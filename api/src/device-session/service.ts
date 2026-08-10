import {
  Base64Url32,
  decodeDeviceSessionChallengeV1,
  decodeDeviceSessionProofV1,
  encodeDeviceSessionChallengeV1,
  encodeDeviceSessionProofV1,
  verifyDeviceSessionProofV1,
} from "@qop/identity";
import type {
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
import { Env } from "../env.ts";
import type { RegistryChainReadError } from "../registry/chain.ts";
import { normalizeCertificateDigest } from "../registry/inputs.ts";
import type { RegistryInputError } from "../registry/inputs.ts";
import { RegistryReader, RegistryReaderLive } from "../registry/reader.ts";
import type { DeviceSessionEntropyError } from "./entropy.ts";
import { DeviceSessionEntropy } from "./entropy.ts";
import {
  DeviceSessionChallengeConsumed,
  DeviceSessionChallengeExpired,
  DeviceSessionStore,
  DeviceSessionStoreLive,
} from "./store.ts";
import type {
  DeviceSessionStoreError,
  StoredDeviceSessionChallenge,
} from "./store.ts";

export const deviceSessionChallengeTtlSeconds = 300n;
export const deviceSessionTtlSeconds = 3600n;

export interface IssueDeviceSessionChallenge {
  readonly certificateDigest: Hash;
}

export interface AuthenticatedDeviceSession {
  readonly certificateDigest: Hash;
  readonly expiresAt: string;
  readonly peerId: string;
  readonly qid: bigint;
  readonly token: string;
}

export interface ResolvedDeviceSession {
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
    | "decode-token"
    | "encode-challenge"
    | "encode-proof"
    | "encode-token";
}> {}

export type DeviceSessionServiceError =
  | DeviceCertificateInputError
  | DeviceCertificateStoreError
  | DeviceSessionCertificateRejected
  | DeviceSessionChallengeBindingMismatch
  | DeviceSessionStoreError
  | DeviceSessionEntropyError
  | DeviceSessionPopCryptoError
  | DeviceSessionProofInvalid
  | DeviceSessionProtocolError
  | RegistryChainReadError
  | RegistryInputError;

export interface DeviceSessionServiceShape {
  readonly authenticate: (
    proof: unknown
  ) => Effect.Effect<AuthenticatedDeviceSession, DeviceSessionServiceError>;
  readonly issue: (
    input: IssueDeviceSessionChallenge
  ) => Effect.Effect<
    DeviceSessionChallengeV1Encoded,
    DeviceSessionServiceError
  >;
  readonly resolve: (
    token: unknown
  ) => Effect.Effect<ResolvedDeviceSession, DeviceSessionServiceError>;
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
  stored.issuedAt === BigInt(challenge.issuedAt) &&
  stored.peerId === challenge.peerId &&
  stored.qid === BigInt(challenge.qid) &&
  stored.verifier === challenge.verifier &&
  stored.version === challenge.version;

const encodeStoredChallenge = (
  stored: StoredDeviceSessionChallenge
): DeviceSessionChallengeV1Encoded => ({
  certificateDigest: stored.certificateDigest,
  challenge: stored.challenge,
  expiresAt: stored.expiresAt.toString(),
  issuedAt: stored.issuedAt.toString(),
  peerId: stored.peerId,
  qid: stored.qid.toString(),
  verifier: stored.verifier,
  version: 1,
});

export class DeviceSessionService extends Context.Service<
  DeviceSessionService,
  DeviceSessionServiceShape
>()("@qop/api/DeviceSessionService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const certificates = yield* DeviceCertificateStore;
      const sessions = yield* DeviceSessionStore;
      const entropy = yield* DeviceSessionEntropy;
      const env = yield* Env;
      const registry = yield* RegistryReader;

      const currentVerifier = Effect.fn("DeviceSessionService.currentVerifier")(
        () =>
          Schema.encodeEffect(Base64Url32)(env.GATEWAY_ID).pipe(
            Effect.mapError(protocolError("encode-challenge"))
          )
      );

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
        yield* sessions.purgeExpired;
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
          issuedAt: issuedAt.toString(),
          peerId: certificate.peerId,
          qid: certificate.qid.toString(),
          verifier: yield* currentVerifier(),
          version: 1,
        }).pipe(Effect.mapError(protocolError("decode-challenge")));
        const encoded = yield* encodeDeviceSessionChallengeV1(challenge).pipe(
          Effect.mapError(protocolError("encode-challenge"))
        );
        const stored = yield* sessions.createChallenge({
          challenge: encoded,
          challengeHash: keccak256(challengeBytes),
        });
        return encodeStoredChallenge(stored);
      });

      const authenticate = Effect.fn("DeviceSessionService.authenticate")(
        function* (input: unknown) {
          const proof = yield* decodeDeviceSessionProofV1(input).pipe(
            Effect.mapError(protocolError("decode-proof"))
          );
          const encodedProof = yield* encodeDeviceSessionProofV1(proof).pipe(
            Effect.mapError(protocolError("encode-proof"))
          );
          const challengeHash = keccak256(proof.challenge.challenge);
          const stored = yield* sessions.getChallenge(challengeHash);
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
          if (encodedProof.challenge.verifier !== (yield* currentVerifier())) {
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
              sessions
                .consumeChallenge(challengeHash)
                .pipe(Effect.flatMap(() => Effect.fail(error)))
            )
          );
          const tokenBytes = yield* entropy.bytes32;
          const token = yield* Schema.encodeEffect(Base64Url32)(
            tokenBytes
          ).pipe(Effect.mapError(protocolError("encode-token")));
          const session = yield* sessions.authenticate({
            challengeHash,
            ownerVersion: certificate.ownerVersion,
            sessionTtlSeconds: deviceSessionTtlSeconds,
            tokenHash: keccak256(tokenBytes),
          });
          return {
            certificateDigest: certificate.certificateDigest,
            expiresAt: session.expiresAt.toString(),
            peerId: certificate.peerId,
            qid: certificate.qid,
            token,
          };
        }
      );

      const resolve = Effect.fn("DeviceSessionService.resolve")(function* (
        input: unknown
      ) {
        const tokenBytes = yield* Schema.decodeUnknownEffect(Base64Url32)(
          input
        ).pipe(Effect.mapError(protocolError("decode-token")));
        const session = yield* sessions.getActiveSession(keccak256(tokenBytes));
        const account = yield* registry.fresh.account(session.qid);
        if (account.value.ownerVersion !== session.ownerVersion) {
          return yield* new DeviceSessionCertificateRejected({
            certificateDigest: session.certificateDigest,
            reason: "owner-version",
          });
        }
        const revocation = yield* registry.fresh.deviceRevocation(
          session.qid,
          session.certificateDigest
        );
        if (revocation.value) {
          return yield* new DeviceSessionCertificateRejected({
            certificateDigest: session.certificateDigest,
            reason: "revoked",
          });
        }
        return {
          certificateDigest: session.certificateDigest,
          peerId: session.peerId,
          qid: session.qid,
        };
      });

      return DeviceSessionService.of({ authenticate, issue, resolve });
    })
  );
}

export const DeviceSessionServiceLive = DeviceSessionService.layer.pipe(
  Layer.provide(DeviceCertificateStoreLive),
  Layer.provide(DeviceSessionStoreLive),
  Layer.provide(DeviceSessionEntropy.layer),
  Layer.provide(RegistryReaderLive),
  Layer.provide(Env.layer)
);
