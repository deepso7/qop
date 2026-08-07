import {
  Base64Url32,
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  EcdsaSignature,
  encodeRegisterIntentV1,
  hashRegisterIntentV1,
  recoverRegisterIntentSignerV1,
  RegistrationNonce,
} from "@qop/identity";
import type {
  IdentityCryptoError,
  IdentityEip712DomainV1,
  RegisterIntentV1,
  RegisterIntentV1Encoded,
} from "@qop/identity";
import {
  Context,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import { concatBytes, hexToBytes, keccak256, stringToBytes, toHex } from "viem";
import type { Address, Hash, Hex } from "viem";

import { Env } from "../env.ts";
import type { RegistryChainReadError } from "../registry/chain.ts";
import { normalizeRegistryHandle } from "../registry/inputs.ts";
import type { RegistryInputError } from "../registry/inputs.ts";
import { RegistryReader, RegistryReaderLive } from "../registry/reader.ts";
import { RegistrationEntropy } from "./entropy.ts";
import type { RegistrationEntropyError } from "./entropy.ts";
import {
  decodeRegistrationIdempotencyKey,
  normalizeRegistrationDigest,
  normalizeRegistrationOwner,
  normalizeRegistrationOwnerSignature,
  normalizeRegistrationPeerId,
  normalizeRegistrationSignerSignature,
} from "./inputs.ts";
import type { RegistrationInputError } from "./inputs.ts";
import { RegistrationSigner } from "./signer.ts";
import type { RegistrationSignerError } from "./signer.ts";
import {
  RegistrationIntentConflict,
  RegistrationIntentExpired,
  RegistrationIntentNotFound,
  RegistrationStore,
  RegistrationStoreLive,
  RegistrationTransitionConflict,
} from "./store.ts";
import type {
  RegistrationStoreError,
  StoredRegistrationIntent,
} from "./store.ts";
import type { RegistrationIntentStatus } from "./types.ts";

export const registrationIntentTtlSeconds = 600n;
export const registrationReconciliationConcurrency = 16;
const observeTokenDerivationDomain = stringToBytes(
  "qop-registration-observe-token-v1"
);

export interface PrepareRegistration {
  readonly handle: string;
  readonly idempotencyKey: string;
  readonly owner: Address;
  readonly peerId: string;
}

export interface PreparedRegistration {
  readonly digest: Hash;
  readonly intent: RegisterIntentV1Encoded;
  readonly observeToken: string;
  readonly status: "pending_owner_signature";
}

export interface AuthorizeRegistration {
  readonly digest: Hash;
  readonly ownerSignature: Hex;
}

export interface AuthorizedRegistration {
  readonly digest: Hash;
  readonly intent: RegisterIntentV1Encoded;
  readonly ownerSignature: Hex;
  readonly registrationSignature: Hex;
  readonly status: "confirmed" | "ready" | "submitted";
}

export interface ReconciledRegistration {
  readonly digest: Hash;
  readonly failureCode: string | null;
  readonly qid: bigint | null;
  readonly status: RegistrationIntentStatus;
}

export const registrationReconciliationFailureCodes = {
  chainConflict: "ONCHAIN_REGISTRATION_CONFLICT",
  deadlineExpired: "REGISTRATION_DEADLINE_EXPIRED",
} as const;

export class RegistrationHandleUnavailable extends Data.TaggedError(
  "RegistrationHandleUnavailable"
)<{ readonly handle: string; readonly qid: bigint }> {}

export class RegistrationOwnerUnavailable extends Data.TaggedError(
  "RegistrationOwnerUnavailable"
)<{ readonly owner: Address; readonly qid: bigint }> {}

export class RegistrationSignatureMismatch extends Data.TaggedError(
  "RegistrationSignatureMismatch"
)<{
  readonly expected: Address;
  readonly kind: "owner" | "registration";
  readonly recovered: Address;
}> {}

export class RegistrationProtocolError extends Data.TaggedError(
  "RegistrationProtocolError"
)<{
  readonly cause: unknown;
  readonly operation:
    | "decode-domain"
    | "decode-intent"
    | "decode-signature"
    | "encode-intent"
    | "generate-nonce"
    | "generate-observe-token"
    | "reconcile-chain"
    | "verify-digest"
    | "verify-state";
}> {}

export type RegistrationEnrollmentError =
  | IdentityCryptoError
  | RegistrationEntropyError
  | RegistrationHandleUnavailable
  | RegistrationInputError
  | RegistrationOwnerUnavailable
  | RegistrationProtocolError
  | RegistrationSignatureMismatch
  | RegistrationSignerError
  | RegistrationStoreError
  | RegistryChainReadError
  | RegistryInputError;

export interface RegistrationEnrollmentShape {
  readonly authorize: (
    input: AuthorizeRegistration
  ) => Effect.Effect<AuthorizedRegistration, RegistrationEnrollmentError>;
  readonly prepare: (
    input: PrepareRegistration
  ) => Effect.Effect<PreparedRegistration, RegistrationEnrollmentError>;
  readonly reconcile: (
    digest: Hash
  ) => Effect.Effect<ReconciledRegistration, RegistrationEnrollmentError>;
}

const protocolError =
  (operation: RegistrationProtocolError["operation"]) =>
  (cause: unknown): RegistrationProtocolError =>
    new RegistrationProtocolError({ cause, operation });

const epochSeconds = (value: DateTime.DateTime): bigint =>
  BigInt(Math.floor(DateTime.toEpochMillis(value) / 1000));

const decodeStoredIntent = Effect.fn(
  "RegistrationEnrollment.decodeStoredIntent"
)(function* (stored: {
  readonly deadline: bigint;
  readonly handle: string;
  readonly owner: string;
  readonly registrationNonce: string;
}) {
  return yield* decodeRegisterIntentV1({
    deadline: stored.deadline.toString(),
    handle: stored.handle,
    nonce: stored.registrationNonce,
    owner: stored.owner,
  }).pipe(Effect.mapError(protocolError("decode-intent")));
});

const encodeIntent = (intent: RegisterIntentV1) =>
  encodeRegisterIntentV1(intent).pipe(
    Effect.mapError(protocolError("encode-intent"))
  );

const decodeSignature = (signature: Hex) =>
  Schema.decodeUnknownEffect(EcdsaSignature)(signature).pipe(
    Effect.mapError(protocolError("decode-signature"))
  );

const reconciledRegistration = (
  stored: StoredRegistrationIntent
): ReconciledRegistration => ({
  digest: stored.digest,
  failureCode: stored.failureCode,
  qid: stored.qid,
  status: stored.status,
});

const verifyPreparedRegistrationStatus = Effect.fn(
  "RegistrationEnrollment.verifyPreparedStatus"
)(function* (status: RegistrationIntentStatus) {
  if (status !== "pending_owner_signature") {
    return yield* new RegistrationProtocolError({
      cause: `Unexpected prepared registration status: ${status}`,
      operation: "verify-state",
    });
  }
  return status;
});

const verifyAuthorizedRegistrationStatus = Effect.fn(
  "RegistrationEnrollment.verifyAuthorizedStatus"
)(function* (status: RegistrationIntentStatus) {
  if (status !== "confirmed" && status !== "ready" && status !== "submitted") {
    return yield* new RegistrationProtocolError({
      cause: `Unexpected authorized registration status: ${status}`,
      operation: "verify-state",
    });
  }
  return status;
});

export class RegistrationEnrollment extends Context.Service<
  RegistrationEnrollment,
  RegistrationEnrollmentShape
>()("@qop/api/RegistrationEnrollment") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const entropy = yield* RegistrationEntropy;
      const env = yield* Env;
      const registry = yield* RegistryReader;
      const signer = yield* RegistrationSigner;
      const store = yield* RegistrationStore;
      const reconciliationSemaphore = yield* Semaphore.make(
        registrationReconciliationConcurrency
      );
      const domain: IdentityEip712DomainV1 =
        yield* decodeIdentityEip712DomainV1({
          chainId: env.CHAIN_ID.toString(),
          verifyingContract: env.REGISTRY_ADDRESS,
        }).pipe(Effect.mapError(protocolError("decode-domain")));

      const preparedRegistration = Effect.fn(
        "RegistrationEnrollment.preparedRegistration"
      )(function* (
        stored: StoredRegistrationIntent,
        expected: {
          readonly handle: string;
          readonly owner: Address;
          readonly peerId: string;
        },
        observeToken: string,
        replay: boolean
      ) {
        if (
          stored.handle !== expected.handle ||
          stored.owner !== expected.owner ||
          stored.peerId !== expected.peerId
        ) {
          return yield* new RegistrationIntentConflict({
            digest: stored.digest,
          });
        }
        if (replay) {
          const now = epochSeconds(yield* DateTime.now);
          if (
            stored.status === "pending_owner_signature" &&
            stored.deadline < now
          ) {
            return yield* new RegistrationIntentExpired({
              digest: stored.digest,
            });
          }
          if (stored.status !== "pending_owner_signature") {
            return yield* new RegistrationTransitionConflict({
              actual: stored.status,
              digest: stored.digest,
              expected: ["pending_owner_signature"],
            });
          }
        }
        const status = yield* verifyPreparedRegistrationStatus(stored.status);
        const intent = yield* decodeStoredIntent(stored);
        if ((yield* hashRegisterIntentV1(domain, intent)) !== stored.digest) {
          return yield* new RegistrationProtocolError({
            cause: "Stored registration intent does not match its digest",
            operation: "verify-digest",
          });
        }
        return {
          digest: stored.digest,
          intent: yield* encodeIntent(intent),
          observeToken,
          status,
        } satisfies PreparedRegistration;
      });

      const prepare = Effect.fn("RegistrationEnrollment.prepare")(function* (
        input: PrepareRegistration
      ) {
        const handle = yield* normalizeRegistryHandle(input.handle);
        const owner = yield* normalizeRegistrationOwner(input.owner);
        const peerId = yield* normalizeRegistrationPeerId(input.peerId);
        const idempotencyKey = yield* decodeRegistrationIdempotencyKey(
          input.idempotencyKey
        );
        const observeTokenBytes = hexToBytes(
          keccak256(concatBytes([observeTokenDerivationDomain, idempotencyKey]))
        );
        const observeToken = yield* Schema.encodeEffect(Base64Url32)(
          observeTokenBytes
        ).pipe(Effect.mapError(protocolError("generate-observe-token")));
        const observeTokenHash = keccak256(toHex(observeTokenBytes));
        // Opportunistically bound abandoned-intent growth on every valid
        // admission request. The store performs a small SKIP LOCKED batch, so
        // concurrent API instances can safely share this maintenance work.
        yield* store.expire;
        const expected = { handle, owner, peerId } as const;
        const replay = yield* store.getByObserveTokenHash(observeTokenHash);
        if (Option.isSome(replay)) {
          return yield* preparedRegistration(
            replay.value,
            expected,
            observeToken,
            true
          );
        }
        const [handleRegistration, ownerRegistration] = yield* Effect.all(
          [
            registry.fresh.qidByHandle(handle),
            registry.fresh.qidByOwner(owner),
          ],
          { concurrency: "unbounded" }
        );
        if (handleRegistration.value !== null) {
          return yield* new RegistrationHandleUnavailable({
            handle,
            qid: handleRegistration.value,
          });
        }
        if (ownerRegistration.value !== null) {
          return yield* new RegistrationOwnerUnavailable({
            owner,
            qid: ownerRegistration.value,
          });
        }

        const registrationNonceBytes = yield* entropy.bytes32;
        const registrationNonce = yield* Schema.encodeEffect(RegistrationNonce)(
          registrationNonceBytes
        ).pipe(Effect.mapError(protocolError("generate-nonce")));
        const deadline =
          epochSeconds(yield* DateTime.now) + registrationIntentTtlSeconds;
        const intent = yield* decodeRegisterIntentV1({
          deadline: deadline.toString(),
          handle,
          nonce: registrationNonce,
          owner,
        }).pipe(Effect.mapError(protocolError("decode-intent")));
        const digest = yield* hashRegisterIntentV1(domain, intent);
        const stored = yield* store.create({
          deadline,
          digest,
          handle,
          observeTokenHash,
          owner,
          peerId,
          registrationNonce: registrationNonce as Hash,
        });
        return yield* preparedRegistration(
          stored,
          expected,
          observeToken,
          false
        );
      });

      const authorize = Effect.fn("RegistrationEnrollment.authorize")(
        function* (input: AuthorizeRegistration) {
          const digest = yield* normalizeRegistrationDigest(input.digest);
          const storedOption = yield* store.get(digest);
          if (Option.isNone(storedOption)) {
            return yield* new RegistrationIntentNotFound({ digest });
          }
          const stored = storedOption.value;
          const intent = yield* decodeStoredIntent(stored);
          const reconstructedDigest = yield* hashRegisterIntentV1(
            domain,
            intent
          );
          if (reconstructedDigest !== digest) {
            return yield* new RegistrationProtocolError({
              cause: "Stored registration intent does not match its digest",
              operation: "verify-digest",
            });
          }
          const callerOwnerSignature =
            yield* normalizeRegistrationOwnerSignature(input.ownerSignature);
          const ownerSignature = yield* decodeSignature(callerOwnerSignature);
          const recoveredOwner = yield* recoverRegisterIntentSignerV1(
            domain,
            intent,
            ownerSignature
          );
          const expectedOwner = stored.owner as Address;
          if (recoveredOwner !== expectedOwner) {
            return yield* new RegistrationSignatureMismatch({
              expected: expectedOwner,
              kind: "owner",
              recovered: recoveredOwner as Address,
            });
          }
          const ownerSignatureHex =
            stored.ownerSignature === null
              ? callerOwnerSignature
              : yield* normalizeRegistrationOwnerSignature(
                  stored.ownerSignature
                );
          if (ownerSignatureHex !== callerOwnerSignature) {
            const persistedOwner = yield* recoverRegisterIntentSignerV1(
              domain,
              intent,
              yield* decodeSignature(ownerSignatureHex)
            );
            if (persistedOwner !== expectedOwner) {
              return yield* new RegistrationSignatureMismatch({
                expected: expectedOwner,
                kind: "owner",
                recovered: persistedOwner as Address,
              });
            }
          }
          let registrationSignatureHex: Hex;
          if (stored.registrationSignature === null) {
            yield* store.assertAuthorizable(digest);
            const availability = yield* registry.fresh.registrationProbe(
              stored.handle,
              expectedOwner,
              stored.registrationNonce
            );
            if (availability.value.handleQid !== null) {
              return yield* new RegistrationHandleUnavailable({
                handle: stored.handle,
                qid: availability.value.handleQid,
              });
            }
            if (availability.value.ownerQid !== null) {
              return yield* new RegistrationOwnerUnavailable({
                owner: expectedOwner,
                qid: availability.value.ownerQid,
              });
            }
            registrationSignatureHex = yield* signer.sign(domain, intent);
          } else {
            registrationSignatureHex =
              yield* normalizeRegistrationSignerSignature(
                stored.registrationSignature
              );
          }
          const registrationSignature = yield* decodeSignature(
            registrationSignatureHex
          );
          const recoveredRegistrationSigner =
            yield* recoverRegisterIntentSignerV1(
              domain,
              intent,
              registrationSignature
            );
          if (recoveredRegistrationSigner !== signer.address) {
            return yield* new RegistrationSignatureMismatch({
              expected: signer.address,
              kind: "registration",
              recovered: recoveredRegistrationSigner as Address,
            });
          }

          const authorized = yield* store.authorize(digest, {
            ownerSignature: ownerSignatureHex,
            registrationSignature: registrationSignatureHex,
          });
          const status = yield* verifyAuthorizedRegistrationStatus(
            authorized.status
          );
          return {
            digest,
            intent: yield* encodeIntent(intent),
            ownerSignature: ownerSignatureHex,
            registrationSignature: registrationSignatureHex,
            status,
          } satisfies AuthorizedRegistration;
        }
      );

      const reconcile = Effect.fn("RegistrationEnrollment.reconcile")(
        function* (inputDigest: Hash) {
          const digest = yield* normalizeRegistrationDigest(inputDigest);
          const storedOption = yield* store.get(digest);
          if (Option.isNone(storedOption)) {
            return yield* new RegistrationIntentNotFound({ digest });
          }
          const stored = storedOption.value;
          if (stored.status !== "ready" && stored.status !== "submitted") {
            return reconciledRegistration(stored);
          }

          const probe = yield* reconciliationSemaphore.withPermits(1)(
            registry.fresh.registrationProbe(
              stored.handle,
              stored.owner,
              stored.registrationNonce
            )
          );
          if (probe.value.registrationNonceUsed) {
            if (probe.value.handleQid === null) {
              return yield* new RegistrationProtocolError({
                cause:
                  "Registration nonce is used but its handle has no confirmed qid",
                operation: "reconcile-chain",
              });
            }
            const confirmed = yield* store.markConfirmed(
              digest,
              probe.value.handleQid
            );
            yield* Effect.all(
              [
                registry.invalidate.qidByHandle(stored.handle),
                registry.invalidate.qidByOwner(stored.owner),
              ],
              { discard: true }
            );
            return reconciledRegistration(confirmed);
          }

          if (probe.value.handleQid !== null || probe.value.ownerQid !== null) {
            return reconciledRegistration(
              yield* store.markFailed(
                digest,
                registrationReconciliationFailureCodes.chainConflict
              )
            );
          }
          if (probe.value.blockTimestamp > stored.deadline) {
            return reconciledRegistration(
              yield* store.markFailed(
                digest,
                registrationReconciliationFailureCodes.deadlineExpired
              )
            );
          }
          return reconciledRegistration(stored);
        }
      );

      return RegistrationEnrollment.of({ authorize, prepare, reconcile });
    })
  );
}

export const RegistrationEnrollmentLive = RegistrationEnrollment.layer.pipe(
  Layer.provide(RegistrationEntropy.layer),
  Layer.provide(RegistrationStoreLive),
  Layer.provide(RegistryReaderLive),
  Layer.provide(Env.layer)
);
