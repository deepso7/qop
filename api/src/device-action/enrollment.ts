import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  decodeRemoveDeviceIntentV1,
  EcdsaSignature,
  hashAddDeviceIntentV1,
  hashRemoveDeviceIntentV1,
  recoverAddDeviceIntentSignerV1,
  recoverRemoveDeviceIntentSignerV1,
} from "@qop/identity";
import type {
  AddDeviceIntentV1Encoded,
  IdentityCryptoError,
  IdentityEip712DomainV1,
  RemoveDeviceIntentV1Encoded,
} from "@qop/identity";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { toHex } from "viem";
import type { Address, Hash, Hex } from "viem";

import { Env } from "../env.ts";
import {
  normalizeRegistrationDigest,
  normalizeRegistrationOwnerSignature,
} from "../registration/inputs.ts";
import type { RegistrationInputError } from "../registration/inputs.ts";
import {
  DeviceActionChain,
  DeviceActionChainLive,
  matchingDeviceActionEvent,
} from "./chain.ts";
import type { DeviceActionChainError } from "./chain.ts";
import { DeviceActionRelayer } from "./relayer.ts";
import type {
  DeviceActionIntent,
  DeviceActionRelayerError,
} from "./relayer.ts";
import {
  DeviceActionDeadlineInvalid,
  DeviceActionIntentNotFound,
  DeviceActionStore,
  DeviceActionStoreLive,
  DeviceActionTransitionConflict,
} from "./store.ts";
import type {
  DeviceActionStoreError,
  StoredDeviceActionIntent,
  DeviceActionInFlightConflict,
} from "./store.ts";
import type {
  DeviceActionIntentStatus,
  DeviceActionOperation,
} from "./types.ts";

export const deviceActionMaxDeadlineSeconds = 600n;

export interface SubmitDeviceAction {
  readonly intent: AddDeviceIntentV1Encoded | RemoveDeviceIntentV1Encoded;
  readonly operation: DeviceActionOperation;
  readonly ownerSignature: string;
}

export interface SubmittedDeviceAction {
  readonly digest: Hash;
  readonly status: "confirmed" | "submitted";
  readonly transactionHash: Hash;
}

export interface ReconciledDeviceAction {
  readonly digest: Hash;
  readonly failureCode: string | null;
  readonly status: DeviceActionIntentStatus;
  readonly transactionHash: Hash | null;
}

export class DeviceActionSignatureMismatch extends Data.TaggedError(
  "DeviceActionSignatureMismatch"
)<{ readonly expected: Address; readonly recovered: Address }> {}

export class DeviceActionRosterInvalid extends Data.TaggedError(
  "DeviceActionRosterInvalid"
)<{ readonly kind: "active" | "cap" | "nonce" | "owner" | "removed" }> {}

export class DeviceActionProtocolError extends Data.TaggedError(
  "DeviceActionProtocolError"
)<{
  readonly cause: unknown;
  readonly operation: "decode" | "reconcile" | "verify-state";
}> {}

export type DeviceActionEnrollmentError =
  | DeviceActionChainError
  | DeviceActionDeadlineInvalid
  | DeviceActionInFlightConflict
  | DeviceActionProtocolError
  | DeviceActionRelayerError
  | DeviceActionRosterInvalid
  | DeviceActionSignatureMismatch
  | DeviceActionStoreError
  | IdentityCryptoError
  | RegistrationInputError;

export interface DeviceActionEnrollmentContract {
  readonly reconcile: (
    digest: Hash
  ) => Effect.Effect<ReconciledDeviceAction, DeviceActionEnrollmentError>;
  readonly submit: (
    input: SubmitDeviceAction
  ) => Effect.Effect<SubmittedDeviceAction, DeviceActionEnrollmentError>;
}

const protocolError =
  (operation: DeviceActionProtocolError["operation"]) =>
  (cause: unknown): DeviceActionProtocolError =>
    new DeviceActionProtocolError({ cause, operation });

export class DeviceActionEnrollment extends Context.Service<
  DeviceActionEnrollment,
  DeviceActionEnrollmentContract
>()("@qop/api/DeviceActionEnrollment") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const chain = yield* DeviceActionChain;
      const env = yield* Env;
      const relayer = yield* DeviceActionRelayer;
      const store = yield* DeviceActionStore;
      const domain: IdentityEip712DomainV1 =
        yield* decodeIdentityEip712DomainV1({
          chainId: env.CHAIN_ID.toString(),
          verifyingContract: env.REGISTRY_ADDRESS,
        }).pipe(Effect.mapError(protocolError("decode")));

      const decodeIntent = Effect.fn("DeviceActionEnrollment.decodeIntent")(
        function* (
          operation: DeviceActionOperation,
          encoded: SubmitDeviceAction["intent"]
        ) {
          return operation === "add"
            ? yield* decodeAddDeviceIntentV1(encoded).pipe(
                Effect.mapError(protocolError("decode"))
              )
            : yield* decodeRemoveDeviceIntentV1(encoded).pipe(
                Effect.mapError(protocolError("decode"))
              );
        }
      );

      const hashIntent = (
        operation: DeviceActionOperation,
        intent: DeviceActionIntent
      ) =>
        operation === "add"
          ? hashAddDeviceIntentV1(domain, intent)
          : hashRemoveDeviceIntentV1(domain, intent);

      const recoverSigner = (
        operation: DeviceActionOperation,
        intent: DeviceActionIntent,
        signature: Uint8Array
      ) =>
        operation === "add"
          ? recoverAddDeviceIntentSignerV1(domain, intent, signature)
          : recoverRemoveDeviceIntentSignerV1(domain, intent, signature);

      const decodeSignature = (signature: Hex) =>
        Schema.decodeUnknownEffect(EcdsaSignature)(signature).pipe(
          Effect.mapError(protocolError("decode"))
        );

      const toSubmitted = Effect.fn("DeviceActionEnrollment.toSubmitted")(
        function* (stored: StoredDeviceActionIntent) {
          if (
            (stored.status !== "submitted" && stored.status !== "confirmed") ||
            stored.transactionHash === null
          ) {
            return yield* new DeviceActionTransitionConflict({
              actual: stored.status,
              digest: stored.digest,
              expected: ["submitted", "confirmed"],
            });
          }
          return {
            digest: stored.digest,
            status: stored.status,
            transactionHash: stored.transactionHash,
          } satisfies SubmittedDeviceAction;
        }
      );

      const resumeSubmission = Effect.fn(
        "DeviceActionEnrollment.resumeSubmission"
      )(function* (
        stored: StoredDeviceActionIntent,
        intent: DeviceActionIntent
      ) {
        let submitted = stored;
        if (stored.status === "ready") {
          submitted = yield* store.prepareSubmission(
            stored.digest,
            relayer.pendingNonce,
            (nonce) =>
              relayer.prepare(
                stored.operation,
                intent,
                stored.ownerSignature,
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
          return yield* new DeviceActionProtocolError({
            cause: `Cannot submit device action in ${submitted.status} state`,
            operation: "verify-state",
          });
        }
        const transactionHash = yield* relayer.broadcast({
          serializedTransaction: submitted.serializedTransaction,
          transactionHash: submitted.transactionHash,
        });
        if (transactionHash !== submitted.transactionHash) {
          return yield* new DeviceActionProtocolError({
            cause: "Relayer returned a different transaction hash",
            operation: "verify-state",
          });
        }
        return submitted;
      });

      const confirmFromReceipt = Effect.fn(
        "DeviceActionEnrollment.confirmFromReceipt"
      )(function* (stored: StoredDeviceActionIntent) {
        if (stored.transactionHash === null) {
          return stored;
        }
        const receipt = yield* chain.receipt(stored.transactionHash);
        if (!receipt) {
          return stored;
        }
        const latest = yield* chain.latestBlock;
        if (latest < receipt.blockNumber + BigInt(env.REGISTRY_CONFIRMATIONS)) {
          return stored;
        }
        if (receipt.status === "reverted") {
          return yield* store.markTerminal(
            stored.digest,
            "reverted",
            "DEVICE_ACTION_REVERTED"
          );
        }
        const matched = matchingDeviceActionEvent(
          receipt.logs,
          stored.operation,
          stored.qid,
          stored.deviceKey,
          stored.accountNonce
        );
        if (!matched) {
          return yield* new DeviceActionProtocolError({
            cause: "Receipt lacks a matching registry event",
            operation: "reconcile",
          });
        }
        return yield* store.markConfirmed(stored.digest);
      });

      const reconcileActive = Effect.fn(
        "DeviceActionEnrollment.reconcileActive"
      )(function* (stored: StoredDeviceActionIntent) {
        if (stored.status === "submitted") {
          const confirmed = yield* confirmFromReceipt(stored);
          if (confirmed.status !== "submitted") {
            return confirmed;
          }
          const intent = yield* decodeIntent(stored.operation, {
            deadline: stored.deadline.toString(),
            deviceKey: stored.deviceKey,
            nonce: stored.accountNonce.toString(),
            qid: stored.qid.toString(),
          });
          const submitted = yield* resumeSubmission(confirmed, intent);
          return submitted.status === "submitted"
            ? yield* confirmFromReceipt(submitted)
            : submitted;
        }
        const chainTime = yield* chain.blockTimestamp;
        if (stored.status === "ready" && stored.deadline <= chainTime) {
          return yield* store.markTerminal(
            stored.digest,
            "expired",
            "DEVICE_ACTION_EXPIRED"
          );
        }
        const intent = yield* decodeIntent(stored.operation, {
          deadline: stored.deadline.toString(),
          deviceKey: stored.deviceKey,
          nonce: stored.accountNonce.toString(),
          qid: stored.qid.toString(),
        });
        const submitted = yield* resumeSubmission(stored, intent);
        return submitted.status === "submitted"
          ? yield* confirmFromReceipt(submitted)
          : submitted;
      });

      const validateFresh = Effect.fn("DeviceActionEnrollment.validateFresh")(
        function* (
          operation: DeviceActionOperation,
          intent: DeviceActionIntent,
          ownerSignature: Hex
        ) {
          const signature = yield* decodeSignature(ownerSignature);
          const recovered = yield* recoverSigner(operation, intent, signature);
          const account = yield* chain.account(intent.qid);
          if (account.owner !== recovered) {
            return yield* new DeviceActionSignatureMismatch({
              expected: account.owner,
              // SAFETY: recoverTypedDataAddress returns a checksum address.
              recovered: recovered as Address,
            });
          }
          if (account.nonce !== intent.nonce) {
            return yield* new DeviceActionRosterInvalid({ kind: "nonce" });
          }
          const deviceKey = toHex(intent.deviceKey);
          const active = account.devices.includes(deviceKey);
          if (operation === "add") {
            if (active) {
              return yield* new DeviceActionRosterInvalid({ kind: "active" });
            }
            if (yield* chain.deviceKeyRemoved(deviceKey)) {
              return yield* new DeviceActionRosterInvalid({ kind: "removed" });
            }
            if (account.devices.length >= 4) {
              return yield* new DeviceActionRosterInvalid({ kind: "cap" });
            }
          } else if (!active) {
            return yield* new DeviceActionRosterInvalid({ kind: "active" });
          }
          yield* chain.simulate(operation, intent, ownerSignature);
        }
      );

      const submit = Effect.fn("DeviceActionEnrollment.submit")(function* (
        input: SubmitDeviceAction
      ) {
        const intent = yield* decodeIntent(input.operation, input.intent);
        const ownerSignature = yield* normalizeRegistrationOwnerSignature(
          input.ownerSignature
        );
        const digest = yield* hashIntent(input.operation, intent);
        const replay = yield* store.get(digest);
        if (Option.isSome(replay)) {
          if (
            replay.value.status === "reverted" ||
            replay.value.status === "expired"
          ) {
            return yield* new DeviceActionTransitionConflict({
              actual: replay.value.status,
              digest,
              expected: ["ready", "submitted", "confirmed"],
            });
          }
          return yield* toSubmitted(yield* reconcileActive(replay.value));
        }

        const chainTime = yield* chain.blockTimestamp;
        if (
          intent.deadline <= chainTime ||
          intent.deadline > chainTime + deviceActionMaxDeadlineSeconds
        ) {
          return yield* new DeviceActionDeadlineInvalid({
            deadline: intent.deadline,
          });
        }

        yield* validateFresh(input.operation, intent, ownerSignature);

        const stored = yield* store.create({
          accountNonce: intent.nonce,
          deadline: intent.deadline,
          deviceKey: toHex(intent.deviceKey),
          digest,
          operation: input.operation,
          // SAFETY: recoverTypedDataAddress returns a checksum address.
          owner: (yield* recoverSigner(
            input.operation,
            intent,
            yield* decodeSignature(ownerSignature)
          )) as Address,
          ownerSignature,
          qid: intent.qid,
        });
        return yield* toSubmitted(yield* reconcileActive(stored));
      });

      const reconcile = Effect.fn("DeviceActionEnrollment.reconcile")(
        function* (inputDigest: Hash) {
          const digest = yield* normalizeRegistrationDigest(inputDigest);
          const storedOption = yield* store.get(digest);
          if (Option.isNone(storedOption)) {
            return yield* new DeviceActionIntentNotFound({ digest });
          }
          const stored = storedOption.value;
          if (stored.status !== "ready" && stored.status !== "submitted") {
            return {
              digest: stored.digest,
              failureCode: stored.failureCode,
              status: stored.status,
              transactionHash: stored.transactionHash,
            } satisfies ReconciledDeviceAction;
          }
          const reconciled = yield* reconcileActive(stored);
          return {
            digest: reconciled.digest,
            failureCode: reconciled.failureCode,
            status: reconciled.status,
            transactionHash: reconciled.transactionHash,
          } satisfies ReconciledDeviceAction;
        }
      );

      return DeviceActionEnrollment.of({ reconcile, submit });
    })
  );
}

export const DeviceActionEnrollmentLive = DeviceActionEnrollment.layer.pipe(
  Layer.provide(DeviceActionStoreLive),
  Layer.provide(DeviceActionChainLive),
  Layer.provide(Env.layer)
);
