import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  EthereumAddress,
  Handle,
  hashRegisterIntentV1,
  Hex32,
  Qid,
  RegisterIntentV1,
  RegistrationAdmissionCode,
  RegistrationNonce,
  UnixSeconds,
} from "@qop/identity";
import type { IdentityEip712DomainV1Encoded } from "@qop/identity";
import { Data, Effect, Result, Schema, Semaphore } from "effect";

import type { createIdentityVault } from "./identity-vault-core";
import type { createRegistrationClient } from "./registration-client-core";
import type { createRegistryReader } from "./registry-core";

const REGISTRATION_STORAGE_KEY = "qop.registration.v2";
const REGISTRATION_DEADLINE_SECONDS = 1800n;
const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const CanonicalAdmissionCode = RegistrationAdmissionCode.pipe(
  Schema.decodeTo(RegistrationAdmissionCode.pipe(Schema.flip))
);
const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalNonce = RegistrationNonce.pipe(
  Schema.decodeTo(RegistrationNonce.pipe(Schema.flip))
);
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));
const CanonicalDeadline = UnixSeconds.pipe(
  Schema.decodeTo(UnixSeconds.pipe(Schema.flip))
);

const StoredLocalRegistrationV2 = Schema.Struct({
  deadline: CanonicalDeadline,
  digest: CanonicalHex32,
  failureCode: Schema.NullOr(Schema.String),
  handle: Handle,
  nonce: CanonicalNonce,
  ownerAddress: EthereumAddress,
  qid: Schema.NullOr(CanonicalQid),
  status: Schema.Literals(["pending", "submitted", "confirmed", "failed"]),
  version: Schema.Literal(2),
}).annotate({
  messageUnexpectedKey: "Unexpected local registration field",
  parseOptions: strictParseOptions,
});

const StoredLocalRegistrationJson = Schema.fromJsonString(
  StoredLocalRegistrationV2
);
export type LocalRegistration = typeof StoredLocalRegistrationV2.Type;

export class LocalRegistrationError extends Data.TaggedError(
  "LocalRegistrationError"
)<{
  readonly operation:
    | "configuration"
    | "create"
    | "decode"
    | "delete"
    | "identity"
    | "network"
    | "read"
    | "sign"
    | "verify"
    | "write";
}> {}

const localError = (operation: LocalRegistrationError["operation"]) =>
  new LocalRegistrationError({ operation });

export interface LocalRegistrationDependencies {
  readonly domain: IdentityEip712DomainV1Encoded;
  readonly now: () => bigint;
  readonly randomBytes: () => Promise<Uint8Array>;
  readonly registrationClient: Pick<
    ReturnType<typeof createRegistrationClient>,
    "getRegistration" | "register"
  >;
  readonly registry: Pick<
    ReturnType<typeof createRegistryReader>,
    "lookupHandle" | "lookupOwner"
  >;
  readonly secureStore: {
    readonly delete: (key: string) => Promise<void>;
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string) => Promise<void>;
  };
  readonly vault: Pick<
    ReturnType<typeof createIdentityVault>,
    "loadLocalIdentity" | "signRegisterIntent"
  >;
}

export const createLocalRegistration = ({
  domain: domainInput,
  now,
  randomBytes,
  registrationClient,
  registry,
  secureStore,
  vault,
}: LocalRegistrationDependencies) => {
  const registrationSemaphore = Semaphore.makeUnsafe(1);

  const readStoredRegistration = Effect.fn(
    "LocalRegistration.readStoredRegistration"
  )(function* () {
    const encoded = yield* Effect.tryPromise({
      catch: () => localError("read"),
      try: () => secureStore.get(REGISTRATION_STORAGE_KEY),
    });
    if (encoded === null) {
      return null;
    }
    return yield* Schema.decodeUnknownEffect(StoredLocalRegistrationJson)(
      encoded
    ).pipe(Effect.mapError(() => localError("decode")));
  });

  const writeStoredRegistration = Effect.fn(
    "LocalRegistration.writeStoredRegistration"
  )(function* (registration: LocalRegistration) {
    const encoded = yield* Schema.encodeEffect(StoredLocalRegistrationJson)(
      registration
    ).pipe(Effect.mapError(() => localError("write")));
    yield* Effect.tryPromise({
      catch: () => localError("write"),
      try: () => secureStore.set(REGISTRATION_STORAGE_KEY, encoded),
    });
  });

  const loadIdentity = Effect.fn("LocalRegistration.loadIdentity")(
    function* () {
      const identity = yield* vault
        .loadLocalIdentity()
        .pipe(Effect.mapError(() => localError("identity")));
      if (!identity) {
        return yield* localError("identity");
      }
      return identity;
    }
  );

  const verifyOwner = Effect.fn("LocalRegistration.verifyOwner")(function* (
    registration: LocalRegistration
  ) {
    const identity = yield* loadIdentity();
    if (
      registration.ownerAddress !== identity.ownerAddress ||
      registration.handle !== identity.handle
    ) {
      return yield* localError("verify");
    }
    return identity;
  });

  const makeNonce = Effect.fn("LocalRegistration.makeNonce")(function* () {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const bytes = yield* Effect.tryPromise({
        catch: () => localError("create"),
        try: randomBytes,
      });
      if (bytes.length === 32 && bytes.some((byte) => byte !== 0)) {
        return yield* Schema.encodeEffect(Hex32)(bytes).pipe(
          Effect.mapError(() => localError("create"))
        );
      }
    }
    return yield* localError("create");
  });

  const loadLocalRegistration = Effect.fn(
    "LocalRegistration.loadLocalRegistration"
  )(function* () {
    const registration = yield* readStoredRegistration();
    if (registration) {
      yield* verifyOwner(registration);
    }
    return registration;
  });

  const reconcileRegistration = Effect.fn(
    "LocalRegistration.reconcileRegistration"
  )(function* (registration: LocalRegistration) {
    if (
      registration.status !== "submitted" &&
      registration.status !== "pending"
    ) {
      yield* verifyOwner(registration);
      return registration;
    }
    const identity = yield* verifyOwner(registration);
    const ownerAccount = yield* registry
      .lookupOwner(identity.ownerAddress)
      .pipe(Effect.mapError(() => localError("network")));
    if (ownerAccount?.handle === registration.handle) {
      if (
        ownerAccount.owner === identity.ownerAddress.toLowerCase() &&
        ownerAccount.deviceKey === identity.deviceKey.toLowerCase()
      ) {
        const confirmed: LocalRegistration = {
          ...registration,
          qid: ownerAccount.qid.toString(),
          status: "confirmed",
        };
        yield* writeStoredRegistration(confirmed);
        return confirmed;
      }
      if (ownerAccount.deviceKey !== identity.deviceKey.toLowerCase()) {
        const failed: LocalRegistration = {
          ...registration,
          failureCode: "DEVICE_KEY_MISMATCH",
          status: "failed",
        };
        yield* writeStoredRegistration(failed);
        return failed;
      }
    }
    const handleAccount = yield* registry
      .lookupHandle(registration.handle)
      .pipe(Effect.mapError(() => localError("network")));
    if (
      handleAccount &&
      handleAccount.owner !== identity.ownerAddress.toLowerCase()
    ) {
      const failed: LocalRegistration = {
        ...registration,
        failureCode: "HANDLE_TAKEN",
        status: "failed",
      };
      yield* writeStoredRegistration(failed);
      return failed;
    }
    if (now() < BigInt(registration.deadline)) {
      return registration;
    }
    const reconciled = yield* registrationClient
      .getRegistration(registration.digest)
      .pipe(
        Effect.catch((error) =>
          error.status === 404
            ? Effect.succeed({
                digest: registration.digest,
                failureCode: "REGISTRATION_NOT_FOUND",
                qid: null,
                status: "failed" as const,
                transactionHash: null,
              })
            : Effect.fail(localError("network"))
        )
      );
    if (reconciled.digest !== registration.digest) {
      return yield* localError("verify");
    }
    let updated: LocalRegistration;
    if (reconciled.status === "failed") {
      updated = {
        ...registration,
        failureCode: reconciled.failureCode,
        status: "failed",
      };
    } else if (reconciled.status === "confirmed") {
      updated = {
        ...registration,
        qid: reconciled.qid,
        status: "confirmed",
      };
    } else {
      updated = { ...registration, status: "submitted" };
    }
    yield* writeStoredRegistration(updated);
    return updated;
  });

  const startLocalRegistration = Effect.fn(
    "LocalRegistration.startLocalRegistration"
  )((admissionCodeInput: string) =>
    registrationSemaphore.withPermit(
      Effect.gen(function* () {
        const existing = yield* readStoredRegistration();
        if (existing?.status === "submitted") {
          yield* verifyOwner(existing);
          return existing;
        }
        if (existing?.status === "confirmed") {
          yield* verifyOwner(existing);
          return existing;
        }

        const pending = existing?.status === "pending" ? existing : null;
        if (pending) {
          yield* verifyOwner(pending);
          if (now() >= BigInt(pending.deadline)) {
            return yield* reconcileRegistration(pending);
          }
        }
        const identity = yield* loadIdentity();
        const admissionCode = yield* Schema.decodeUnknownEffect(
          CanonicalAdmissionCode
        )(admissionCodeInput).pipe(Effect.mapError(() => localError("create")));
        const domain = yield* decodeIdentityEip712DomainV1(domainInput).pipe(
          Effect.mapError(() => localError("configuration"))
        );
        const nonce = pending?.nonce ?? (yield* makeNonce());
        const deadline =
          pending?.deadline ??
          (now() + REGISTRATION_DEADLINE_SECONDS).toString();
        const intentInput = {
          deadline,
          deviceKey: identity.deviceKey,
          handle: identity.handle,
          nonce,
          owner: identity.ownerAddress,
        };
        const intent = yield* decodeRegisterIntentV1(intentInput).pipe(
          Effect.mapError(() => localError("create"))
        );
        const canonicalIntent = yield* Schema.encodeEffect(RegisterIntentV1)(
          intent
        ).pipe(Effect.mapError(() => localError("create")));
        const digest = yield* hashRegisterIntentV1(domain, intent).pipe(
          Effect.mapError(() => localError("create"))
        );
        const ownerSignature = yield* vault
          .signRegisterIntent(domainInput, canonicalIntent)
          .pipe(Effect.mapError(() => localError("sign")));
        const request: LocalRegistration = {
          deadline,
          digest,
          failureCode: null,
          handle: identity.handle,
          nonce,
          ownerAddress: identity.ownerAddress,
          qid: null,
          status: "pending",
          version: 2,
        };
        // Save the digest before the request can reach the relayer.
        yield* writeStoredRegistration(request);
        const result = yield* registrationClient
          .register({ admissionCode, intent: canonicalIntent, ownerSignature })
          .pipe(Effect.result);
        if (Result.isFailure(result)) {
          const { status } = result.failure;
          if (
            status !== null &&
            status >= 400 &&
            status < 500 &&
            status !== 408
          ) {
            const failed: LocalRegistration = {
              ...request,
              failureCode: result.failure.tag ?? "REGISTRATION_REJECTED",
              status: "failed",
            };
            yield* writeStoredRegistration(failed);
            return failed;
          }
          return request;
        }
        if (result.success.digest !== digest) {
          return yield* localError("verify");
        }
        const submitted: LocalRegistration = {
          ...request,
          status: "submitted",
        };
        yield* writeStoredRegistration(submitted);
        return submitted;
      })
    )
  );

  const checkLocalRegistration = Effect.fn(
    "LocalRegistration.checkLocalRegistration"
  )(() =>
    registrationSemaphore.withPermit(
      Effect.gen(function* () {
        const registration = yield* readStoredRegistration();
        if (!registration) {
          return yield* localError("verify");
        }
        return yield* reconcileRegistration(registration);
      })
    )
  );

  const deleteLocalRegistration = Effect.fn(
    "LocalRegistration.deleteLocalRegistration"
  )(() =>
    Effect.tryPromise({
      catch: () => localError("delete"),
      try: () => secureStore.delete(REGISTRATION_STORAGE_KEY),
    })
  );

  return {
    checkLocalRegistration,
    deleteLocalRegistration,
    loadLocalRegistration,
    startLocalRegistration,
  };
};
