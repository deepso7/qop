import {
  AddDeviceIntentV1,
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  EthereumAddress,
  Handle,
  hashAddDeviceIntentV1,
  Hex32,
  ownerAddressFromRecoveryKeyV1,
  Qid,
  strictParseOptions,
  Uint256,
  UnixSeconds,
} from "@qop/identity";
import type { IdentityEip712DomainV1Encoded } from "@qop/identity";
import { DEVICE_ACTION_DEADLINE_SECONDS } from "@qop/protocol";
import { Data, Effect, Schema, Semaphore } from "effect";

import type { createDeviceActionClient } from "./device-action-client-core";
import type { createIdentityVault, LocalIdentity } from "./identity-vault-core";
import type { createRegistryReader, RegistryAccount } from "./registry-core";

// Enrollment of a restored phone: the device joins an existing account by
// owner-signing addDevice for its own device key with the imported recovery
// key. Mirrors local registration: the digest is saved before submitting, and
// the chain roster is the source of truth for confirmation.

// Matches the registry's MAX_ACTIVE_DEVICES.
export const MAX_DEVICES = 4;

const canonical = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.decodeTo(schema.pipe(Schema.flip)));

const StoredLocalEnrollmentV1 = Schema.Struct({
  deadline: canonical(UnixSeconds),
  digest: canonical(Hex32),
  failureCode: Schema.NullOr(Schema.String),
  handle: Handle,
  nonce: canonical(Uint256),
  ownerAddress: EthereumAddress,
  qid: canonical(Qid),
  status: Schema.Literals(["submitted", "confirmed", "failed"]),
  version: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected local enrollment field",
});

const StoredLocalEnrollmentJson = Schema.fromJsonString(
  StoredLocalEnrollmentV1
);

export type LocalEnrollment = typeof StoredLocalEnrollmentV1.Type;

// The account a recovery key owns, as shown before the user commits.
export interface RecoveryAccount {
  readonly deviceCount: number;
  readonly handle: string;
  readonly maxDevices: number;
  readonly qid: string;
}

export class LocalEnrollmentError extends Data.TaggedError(
  "LocalEnrollmentError"
)<{
  readonly operation:
    | "configuration"
    | "decode"
    | "delete"
    | "identity"
    | "invalid-key"
    | "network"
    | "read"
    | "sign"
    | "verify"
    | "write";
}> {}

const localError = (operation: LocalEnrollmentError["operation"]) =>
  new LocalEnrollmentError({ operation });

export interface LocalEnrollmentDependencies {
  readonly deviceActionClient: Pick<
    ReturnType<typeof createDeviceActionClient>,
    "get" | "submit"
  >;
  readonly domain: IdentityEip712DomainV1Encoded;
  // Deadlines use chain time: the relayer accepts at most chain time + 600s,
  // and block timestamps trail the phone's clock.
  readonly registry: Pick<
    ReturnType<typeof createRegistryReader>,
    "latestTimestamp" | "lookupOwner"
  >;
  readonly secureStore: {
    readonly delete: (key: string) => Promise<void>;
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string) => Promise<void>;
  };
  readonly vault: Pick<
    ReturnType<typeof createIdentityVault>,
    "loadLocalIdentity" | "signOwnAddDeviceIntent"
  >;
}

const isActive = (account: RegistryAccount, identity: LocalIdentity) =>
  account.devices.some(
    (device) => device.deviceKey === identity.deviceKey.toLowerCase()
  );

export const createLocalEnrollment = ({
  deviceActionClient,
  domain: domainInput,
  registry,
  secureStore,
  vault,
}: LocalEnrollmentDependencies) => {
  const storageKey = `qop.enrollment.v1.${domainInput.chainId}.${domainInput.verifyingContract.toLowerCase()}`;
  const semaphore = Semaphore.makeUnsafe(1);

  const write = Effect.fn("LocalEnrollment.write")(function* (
    enrollment: LocalEnrollment
  ) {
    const encoded = yield* Schema.encodeEffect(StoredLocalEnrollmentJson)(
      enrollment
    ).pipe(Effect.mapError(() => localError("write")));

    yield* Effect.tryPromise({
      catch: () => localError("write"),
      try: () => secureStore.set(storageKey, encoded),
    });

    return enrollment;
  });

  const loadIdentity = Effect.fn("LocalEnrollment.loadIdentity")(function* () {
    const identity = yield* vault
      .loadLocalIdentity()
      .pipe(Effect.mapError(() => localError("identity")));

    return identity ?? (yield* localError("identity"));
  });

  // The stored record, checked against the identity it was made for.
  const read = Effect.fn("LocalEnrollment.read")(function* () {
    const encoded = yield* Effect.tryPromise({
      catch: () => localError("read"),
      try: () => secureStore.get(storageKey),
    });

    if (encoded === null) {
      return null;
    }

    const enrollment = yield* Schema.decodeUnknownEffect(
      StoredLocalEnrollmentJson
    )(encoded, strictParseOptions).pipe(
      Effect.mapError(() => localError("decode"))
    );

    const identity = yield* loadIdentity();

    if (
      enrollment.ownerAddress !== identity.ownerAddress ||
      enrollment.handle !== identity.handle
    ) {
      return yield* localError("verify");
    }

    return enrollment;
  });

  const chainTime = () =>
    registry
      .latestTimestamp()
      .pipe(Effect.mapError(() => localError("network")));

  const lookupOwner = (owner: string) =>
    registry
      .lookupOwner(owner)
      .pipe(Effect.mapError(() => localError("network")));

  // Owner-signs and sends the add for `intent`; the relayer's answer only
  // matters for outright rejection, since the roster decides success.
  const submit = Effect.fn("LocalEnrollment.submit")(function* (
    enrollment: LocalEnrollment,
    identity: LocalIdentity
  ) {
    const intent = yield* decodeAddDeviceIntentV1({
      deadline: enrollment.deadline,
      deviceKey: identity.deviceKey,
      nonce: enrollment.nonce,
      qid: enrollment.qid,
    }).pipe(
      Effect.flatMap(Schema.encodeEffect(AddDeviceIntentV1)),
      Effect.mapError(() => localError("sign"))
    );

    const ownerSignature = yield* vault
      .signOwnAddDeviceIntent(domainInput, intent)
      .pipe(Effect.mapError(() => localError("sign")));

    const result = yield* deviceActionClient
      .submit({ intent, operation: "add", ownerSignature })
      .pipe(Effect.result);

    // 422: the relayer's roster preflight refused it (stale nonce, full, …).
    if (result._tag === "Failure" && result.failure.status === 422) {
      return yield* write({
        ...enrollment,
        failureCode: "REJECTED",
        status: "failed",
      });
    }

    // Accepted, in flight (409) or unreachable: keep polling the roster.
    return enrollment;
  });

  // Looks up the account a recovery key owns, without storing anything.
  const findRecoveryAccount = Effect.fn("LocalEnrollment.findRecoveryAccount")(
    function* (recoveryKeyInput: string) {
      const owner = yield* ownerAddressFromRecoveryKeyV1(
        recoveryKeyInput.replaceAll(/\s/gu, "")
      ).pipe(Effect.mapError(() => localError("invalid-key")));

      const account = yield* lookupOwner(owner);

      if (!account) {
        return null;
      }

      const recoveryAccount: RecoveryAccount = {
        deviceCount: account.devices.length,
        handle: account.handle,
        maxDevices: MAX_DEVICES,
        qid: account.qid.toString(),
      };

      return recoveryAccount;
    }
  );

  // Starts (or retries) adding this phone to its account. Needs the restored
  // identity in the vault. A submitted or confirmed record is returned as is.
  const startLocalEnrollment = Effect.fn("LocalEnrollment.start")(() =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const existing = yield* read();

        if (existing && existing.status !== "failed") {
          return existing;
        }

        const identity = yield* loadIdentity();
        const account = yield* lookupOwner(identity.ownerAddress);

        if (!account || account.handle !== identity.handle) {
          return yield* localError("verify");
        }

        const domain = yield* decodeIdentityEip712DomainV1(domainInput).pipe(
          Effect.mapError(() => localError("configuration"))
        );

        const deadline = (
          (yield* chainTime()) + BigInt(DEVICE_ACTION_DEADLINE_SECONDS)
        ).toString();

        const intent = yield* decodeAddDeviceIntentV1({
          deadline,
          deviceKey: identity.deviceKey,
          nonce: account.nonce.toString(),
          qid: account.qid.toString(),
        }).pipe(Effect.mapError(() => localError("sign")));

        const digest = yield* hashAddDeviceIntentV1(domain, intent).pipe(
          Effect.mapError(() => localError("sign"))
        );

        const enrollment: LocalEnrollment = {
          deadline,
          digest,
          failureCode: null,
          handle: identity.handle,
          nonce: account.nonce.toString(),
          ownerAddress: identity.ownerAddress,
          qid: account.qid.toString(),
          status: "submitted",
          version: 1,
        };

        // An earlier attempt may have landed after all.
        if (isActive(account, identity)) {
          return yield* write({ ...enrollment, status: "confirmed" });
        }

        if (account.devices.length >= MAX_DEVICES) {
          return yield* write({
            ...enrollment,
            failureCode: "MAX_DEVICES",
            status: "failed",
          });
        }

        // Save the digest before the request can reach the relayer.
        yield* write(enrollment);

        return yield* submit(enrollment, identity);
      })
    )
  );

  // Re-reads the roster (and the relayer, once it matters) for a submitted
  // enrollment. Confirmed once this phone's device key is active.
  const checkLocalEnrollment = Effect.fn("LocalEnrollment.check")(() =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const enrollment = yield* read();

        if (!enrollment) {
          return yield* localError("verify");
        }

        if (enrollment.status !== "submitted") {
          return enrollment;
        }

        const identity = yield* loadIdentity();
        const account = yield* lookupOwner(identity.ownerAddress);

        // The recovery key no longer owns this account (owner recovered).
        if (!account || account.qid.toString() !== enrollment.qid) {
          return yield* write({
            ...enrollment,
            failureCode: "OWNER_CHANGED",
            status: "failed",
          });
        }

        if (isActive(account, identity)) {
          return yield* write({ ...enrollment, status: "confirmed" });
        }

        const reconciled = yield* deviceActionClient
          .get(enrollment.digest)
          .pipe(Effect.result);

        if (reconciled._tag === "Success") {
          const { status } = reconciled.success;

          if (status === "reverted" || status === "expired") {
            return yield* write({
              ...enrollment,
              failureCode: status === "reverted" ? "REVERTED" : "EXPIRED",
              status: "failed",
            });
          }

          return enrollment;
        }

        if (reconciled.failure.status !== 404) {
          return yield* localError("network");
        }

        // The relayer never saw it: resend while it can still land.
        if ((yield* chainTime()) < BigInt(enrollment.deadline)) {
          return yield* submit(enrollment, identity);
        }

        return yield* write({
          ...enrollment,
          failureCode: "EXPIRED",
          status: "failed",
        });
      })
    )
  );

  const loadLocalEnrollment = Effect.fn("LocalEnrollment.load")(() => read());

  const deleteLocalEnrollment = Effect.fn("LocalEnrollment.delete")(() =>
    Effect.tryPromise({
      catch: () => localError("delete"),
      try: () => secureStore.delete(storageKey),
    })
  );

  return {
    checkLocalEnrollment,
    deleteLocalEnrollment,
    findRecoveryAccount,
    loadLocalEnrollment,
    startLocalEnrollment,
  };
};
