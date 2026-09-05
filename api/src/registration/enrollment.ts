import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  EcdsaSignature,
  hashRegisterIntentV1,
  recoverRegisterIntentSignerV1,
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
import { toHex } from "viem";
import type { Address, Hash, Hex } from "viem";

import { Env } from "../env.ts";
import type { RegistryChainReadError } from "../registry/chain.ts";
import type { RegistryInputError } from "../registry/inputs.ts";
import { RegistryReader, RegistryReaderLive } from "../registry/reader.ts";
import type { RegistryRegistrationProbe } from "../registry/types.ts";
import { epochSeconds } from "../time.ts";
import {
  decodeRegistrationAdmissionCode,
  RegistrationAdmission,
  RegistrationAdmissionLive,
} from "./admission.ts";
import type { RegistrationAdmissionError } from "./admission.ts";
import {
  normalizeRegistrationDigest,
  normalizeRegistrationOwner,
  normalizeRegistrationOwnerSignature,
  registrationAdmissionCodeInputError,
} from "./inputs.ts";
import type { RegistrationInputError } from "./inputs.ts";
import { RegistrationRelayer } from "./relayer.ts";
import type { RegistrationRelayerError } from "./relayer.ts";
import { RegistrationSigner } from "./signer.ts";
import type { RegistrationSignerError } from "./signer.ts";
import {
  RegistrationDeadlineInvalid,
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

export const registrationMaxDeadlineSeconds = 3600n;
export const registrationReconciliationConcurrency = 16;

export interface RegisterRegistration {
  readonly admissionCode: string;
  readonly intent: RegisterIntentV1Encoded;
  readonly ownerSignature: string;
}

export interface RegisteredRegistration {
  readonly digest: Hash;
  readonly registrationSignature: Hex;
  readonly status: "confirmed" | "submitted";
  readonly transactionHash: Hash;
}

export interface ReconciledRegistration {
  readonly digest: Hash;
  readonly failureCode: string | null;
  readonly qid: bigint | null;
  readonly status: RegistrationIntentStatus;
  readonly transactionHash: Hash | null;
}

export const registrationReconciliationFailureCodes = {
  chainConflict: "ONCHAIN_REGISTRATION_CONFLICT",
  deadlineExpired: "REGISTRATION_DEADLINE_EXPIRED",
} as const;

export { RegistrationDeadlineInvalid } from "./store.ts";

export class RegistrationHandleUnavailable extends Data.TaggedError(
  "RegistrationHandleUnavailable"
)<{ readonly handle: string; readonly qid?: bigint }> {}

export class RegistrationOwnerUnavailable extends Data.TaggedError(
  "RegistrationOwnerUnavailable"
)<{ readonly owner: Address; readonly qid?: bigint }> {}

export class RegistrationNonceUsed extends Data.TaggedError(
  "RegistrationNonceUsed"
)<{ readonly nonce: Hash }> {}

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
    | "reconcile-chain"
    | "verify-state";
}> {}

export type RegistrationEnrollmentError =
  | IdentityCryptoError
  | RegistrationAdmissionError
  | RegistrationDeadlineInvalid
  | RegistrationHandleUnavailable
  | RegistrationInputError
  | RegistrationNonceUsed
  | RegistrationOwnerUnavailable
  | RegistrationProtocolError
  | RegistrationRelayerError
  | RegistrationSignatureMismatch
  | RegistrationSignerError
  | RegistrationStoreError
  | RegistryChainReadError
  | RegistryInputError;

export interface RegistrationEnrollmentContract {
  readonly reconcile: (
    digest: Hash
  ) => Effect.Effect<ReconciledRegistration, RegistrationEnrollmentError>;
  readonly register: (
    input: RegisterRegistration
  ) => Effect.Effect<RegisteredRegistration, RegistrationEnrollmentError>;
}

const protocolError =
  (operation: RegistrationProtocolError["operation"]) =>
  (cause: unknown): RegistrationProtocolError =>
    new RegistrationProtocolError({ cause, operation });

const decodeSignature = (signature: Hex) =>
  Schema.decodeUnknownEffect(EcdsaSignature)(signature).pipe(
    Effect.mapError(protocolError("decode-signature"))
  );

const decodeStoredIntent = Effect.fn(
  "RegistrationEnrollment.decodeStoredIntent"
)(function* (stored: StoredRegistrationIntent) {
  return yield* decodeRegisterIntentV1({
    deadline: stored.deadline.toString(),
    deviceKey: stored.deviceKey,
    handle: stored.handle,
    nonce: stored.registrationNonce,
    owner: stored.owner,
  }).pipe(Effect.mapError(protocolError("decode-intent")));
});

const reconciledRegistration = (
  stored: StoredRegistrationIntent
): ReconciledRegistration => ({
  digest: stored.digest,
  failureCode: stored.failureCode,
  qid: stored.qid,
  status: stored.status,
  transactionHash: stored.transactionHash,
});

export class RegistrationEnrollment extends Context.Service<
  RegistrationEnrollment,
  RegistrationEnrollmentContract
>()("@qop/api/RegistrationEnrollment") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const admissions = yield* RegistrationAdmission;
      const env = yield* Env;
      const registry = yield* RegistryReader;
      const relayer = yield* RegistrationRelayer;
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

      const resumeSubmission = Effect.fn(
        "RegistrationEnrollment.resumeSubmission"
      )(function* (stored: StoredRegistrationIntent, intent: RegisterIntentV1) {
        let submitted = stored;
        if (stored.status === "ready") {
          submitted = yield* store.prepareSubmission(
            stored.digest,
            relayer.pendingNonce,
            (nonce) =>
              relayer.prepare(
                intent,
                stored.ownerSignature,
                stored.registrationSignature,
                nonce
              )
          );
        }
        if (submitted.status === "confirmed") {
          return submitted;
        }
        if (
          submitted.status !== "submitted" ||
          submitted.transactionHash === null ||
          submitted.serializedTransaction === null
        ) {
          return yield* new RegistrationProtocolError({
            cause: `Cannot submit registration in ${submitted.status} state`,
            operation: "verify-state",
          });
        }
        const transactionHash = yield* relayer.broadcast({
          serializedTransaction: submitted.serializedTransaction,
          transactionHash: submitted.transactionHash,
        });
        if (transactionHash !== submitted.transactionHash) {
          return yield* new RegistrationProtocolError({
            cause: "Relayer returned a different transaction hash",
            operation: "verify-state",
          });
        }
        return submitted;
      });

      const toRegisteredRegistration = Effect.fn(
        "RegistrationEnrollment.toRegisteredRegistration"
      )(function* (submitted: StoredRegistrationIntent) {
        if (
          (submitted.status !== "submitted" &&
            submitted.status !== "confirmed") ||
          submitted.transactionHash === null
        ) {
          return yield* new RegistrationTransitionConflict({
            actual: submitted.status,
            digest: submitted.digest,
            expected: ["submitted", "confirmed"],
          });
        }
        return {
          digest: submitted.digest,
          registrationSignature: submitted.registrationSignature,
          status: submitted.status,
          transactionHash: submitted.transactionHash,
        } satisfies RegisteredRegistration;
      });

      const registeredRegistration = Effect.fn(
        "RegistrationEnrollment.registeredRegistration"
      )(function* (stored: StoredRegistrationIntent) {
        return yield* toRegisteredRegistration(
          yield* resumeSubmission(stored, yield* decodeStoredIntent(stored))
        );
      });

      const handleProbe = Effect.fn("RegistrationEnrollment.handleProbe")(
        function* (
          stored: StoredRegistrationIntent,
          probe: RegistryRegistrationProbe
        ) {
          if (probe.registrationNonceUsed) {
            if (
              probe.handleQid === null ||
              probe.ownerQid !== probe.handleQid
            ) {
              return yield* new RegistrationProtocolError({
                cause:
                  "Registration nonce is used but handle and owner do not resolve to the same qid",
                operation: "reconcile-chain",
              });
            }
            const confirmed = yield* store.markConfirmed(
              stored.digest,
              probe.handleQid
            );
            yield* Effect.all(
              [
                registry.invalidate.qidByHandle(stored.handle),
                registry.invalidate.qidByOwner(stored.owner),
              ],
              { discard: true }
            );
            return confirmed;
          }

          let terminalFailure: string | undefined;
          if (probe.handleQid !== null || probe.ownerQid !== null) {
            terminalFailure =
              registrationReconciliationFailureCodes.chainConflict;
          } else if (probe.blockTimestamp > stored.deadline) {
            terminalFailure =
              registrationReconciliationFailureCodes.deadlineExpired;
          }
          if (terminalFailure) {
            if (stored.status === "submitted") {
              yield* resumeSubmission(
                stored,
                yield* decodeStoredIntent(stored)
              );
            }
            return yield* store.markFailed(stored.digest, terminalFailure);
          }

          return yield* resumeSubmission(
            stored,
            yield* decodeStoredIntent(stored)
          );
        }
      );

      const reconcileActive = Effect.fn(
        "RegistrationEnrollment.reconcileActive"
      )(function* (stored: StoredRegistrationIntent) {
        const probe = yield* reconciliationSemaphore.withPermits(1)(
          registry.fresh.registrationProbe(
            stored.handle,
            stored.owner,
            stored.registrationNonce
          )
        );
        return yield* handleProbe(stored, probe.value);
      });

      // Expire/confirm a blocking ready|submitted row so unique slots can free.
      const reconcileBlocker = Effect.fn(
        "RegistrationEnrollment.reconcileBlocker"
      )(function* (digest: Hash) {
        const blockerOption = yield* store.get(digest);
        if (Option.isNone(blockerOption)) {
          return { freed: true as const, qid: undefined };
        }
        const blocker = blockerOption.value;
        if (blocker.status !== "ready" && blocker.status !== "submitted") {
          return {
            freed: true as const,
            qid: blocker.qid ?? undefined,
          };
        }
        const reconciled = yield* reconcileActive(blocker);
        if (reconciled.status === "failed") {
          return { freed: true as const, qid: undefined };
        }
        return {
          freed: false as const,
          qid: reconciled.qid ?? undefined,
        };
      });

      const register = Effect.fn("RegistrationEnrollment.register")(function* (
        input: RegisterRegistration
      ) {
        const intent = yield* decodeRegisterIntentV1(input.intent).pipe(
          Effect.mapError(protocolError("decode-intent"))
        );
        const ownerSignature = yield* normalizeRegistrationOwnerSignature(
          input.ownerSignature
        );
        const expectedOwner = yield* normalizeRegistrationOwner(intent.owner);

        // Hash before admission/ECDSA so digest replays skip the invite check.
        const digest = yield* hashRegisterIntentV1(domain, intent);
        const replay = yield* store.get(digest);
        if (Option.isSome(replay)) {
          const recoveredOwner = yield* recoverRegisterIntentSignerV1(
            domain,
            intent,
            yield* decodeSignature(ownerSignature)
          );
          if (recoveredOwner !== expectedOwner) {
            return yield* new RegistrationSignatureMismatch({
              expected: expectedOwner,
              kind: "owner",
              recovered: yield* normalizeRegistrationOwner(recoveredOwner),
            });
          }
          if (replay.value.status === "failed") {
            return yield* new RegistrationTransitionConflict({
              actual: "failed",
              digest,
              expected: ["ready", "submitted", "confirmed"],
            });
          }
          if (replay.value.status === "ready") {
            return yield* toRegisteredRegistration(
              yield* reconcileActive(replay.value)
            );
          }
          return yield* registeredRegistration(replay.value);
        }

        const now = epochSeconds(yield* DateTime.now);
        if (
          intent.deadline <= now ||
          intent.deadline > now + registrationMaxDeadlineSeconds
        ) {
          return yield* new RegistrationDeadlineInvalid({
            deadline: intent.deadline,
          });
        }

        // Admission before ECDSA recovery so uninvited clients cannot burn CPU.
        const { codeHash: admissionCodeHash } =
          yield* decodeRegistrationAdmissionCode(input.admissionCode).pipe(
            Effect.mapError(registrationAdmissionCodeInputError)
          );
        yield* admissions.validate(admissionCodeHash);

        const recoveredOwner = yield* recoverRegisterIntentSignerV1(
          domain,
          intent,
          yield* decodeSignature(ownerSignature)
        );
        if (recoveredOwner !== expectedOwner) {
          return yield* new RegistrationSignatureMismatch({
            expected: expectedOwner,
            kind: "owner",
            recovered: yield* normalizeRegistrationOwner(recoveredOwner),
          });
        }

        const deviceKey = yield* normalizeRegistrationDigest(
          toHex(intent.deviceKey)
        );
        const registrationNonce = yield* normalizeRegistrationDigest(
          toHex(intent.nonce)
        );
        const probe = yield* registry.fresh.registrationProbe(
          intent.handle,
          expectedOwner,
          registrationNonce
        );
        if (probe.value.registrationNonceUsed) {
          return yield* new RegistrationNonceUsed({ nonce: registrationNonce });
        }
        if (probe.value.handleQid !== null) {
          return yield* new RegistrationHandleUnavailable({
            handle: intent.handle,
            qid: probe.value.handleQid,
          });
        }
        if (probe.value.ownerQid !== null) {
          return yield* new RegistrationOwnerUnavailable({
            owner: expectedOwner,
            qid: probe.value.ownerQid,
          });
        }

        const registrationSignature = yield* signer.sign(domain, intent);
        const createFields = {
          admissionCodeHash,
          deadline: intent.deadline,
          deviceKey,
          digest,
          handle: intent.handle,
          owner: expectedOwner,
          ownerSignature,
          registrationNonce,
          registrationSignature,
        };
        const createIntent = store.create(createFields).pipe(
          Effect.catchTags({
            RegistrationIntentConflict: (error) =>
              store.get(digest).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(error),
                    onSome: Effect.succeed,
                  })
                )
              ),
            RegistrationNonceConflict: () =>
              Effect.fail(
                new RegistrationNonceUsed({ nonce: registrationNonce })
              ),
          })
        );
        const stored = yield* createIntent.pipe(
          Effect.catchTags({
            RegistrationActiveHandleConflict: (error) =>
              Effect.gen(function* () {
                const result = yield* reconcileBlocker(error.digest);
                if (!result.freed) {
                  return yield* new RegistrationHandleUnavailable({
                    handle: error.handle,
                    ...(result.qid === undefined
                      ? {}
                      : { qid: result.qid }),
                  });
                }
                return yield* createIntent.pipe(
                  Effect.catchTags({
                    RegistrationActiveHandleConflict: (retryError) =>
                      Effect.fail(
                        new RegistrationHandleUnavailable({
                          handle: retryError.handle,
                        })
                      ),
                    RegistrationActiveOwnerConflict: () =>
                      Effect.fail(
                        new RegistrationOwnerUnavailable({
                          owner: expectedOwner,
                        })
                      ),
                  })
                );
              }),
            RegistrationActiveOwnerConflict: (error) =>
              Effect.gen(function* () {
                const result = yield* reconcileBlocker(error.digest);
                if (!result.freed) {
                  return yield* new RegistrationOwnerUnavailable({
                    owner: expectedOwner,
                    ...(result.qid === undefined
                      ? {}
                      : { qid: result.qid }),
                  });
                }
                return yield* createIntent.pipe(
                  Effect.catchTags({
                    RegistrationActiveHandleConflict: (retryError) =>
                      Effect.fail(
                        new RegistrationHandleUnavailable({
                          handle: retryError.handle,
                        })
                      ),
                    RegistrationActiveOwnerConflict: () =>
                      Effect.fail(
                        new RegistrationOwnerUnavailable({
                          owner: expectedOwner,
                        })
                      ),
                  })
                );
              }),
          })
        );
        return yield* registeredRegistration(stored);
      });

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
          return reconciledRegistration(yield* reconcileActive(stored));
        }
      );

      return RegistrationEnrollment.of({ reconcile, register });
    })
  );
}

export const RegistrationEnrollmentLive = RegistrationEnrollment.layer.pipe(
  Layer.provide(RegistrationAdmissionLive),
  Layer.provide(RegistrationStoreLive),
  Layer.provide(RegistryReaderLive),
  Layer.provide(Env.layer)
);
