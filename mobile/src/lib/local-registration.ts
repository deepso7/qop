import {
  Base64Url32,
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  EthereumAddress,
  hashRegisterIntentV1,
  hashRegistrationDeviceCommitmentV1,
  hashRegistrationObserveTokenV1,
  Hex32,
  IdentityEip712DomainV1,
  PeerId,
  Qid,
  RegisterIntentV1,
  RegistrationAdmissionCode,
} from "@qop/identity";
import { Data, Effect, Schema, Semaphore } from "effect";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import {
  loadLocalIdentity,
  signLocalRegistrationIntent,
} from "./identity-vault";
import {
  authorizeRegistration,
  prepareRegistration,
  reconcileRegistration,
} from "./registration-client";

const REGISTRATION_STORAGE_KEY = "qop.registration.v1";
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;
const registrationSemaphore = Semaphore.makeUnsafe(1);

const CanonicalBase64Url32 = Base64Url32.pipe(
  Schema.decodeTo(Base64Url32.pipe(Schema.flip))
);
const CanonicalAdmissionCode = RegistrationAdmissionCode.pipe(
  Schema.decodeTo(RegistrationAdmissionCode.pipe(Schema.flip))
);
const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalPeerId = PeerId.pipe(Schema.decodeTo(PeerId.pipe(Schema.flip)));
const CanonicalQid = Qid.pipe(Schema.decodeTo(Qid.pipe(Schema.flip)));
const CanonicalDomain = IdentityEip712DomainV1.pipe(
  Schema.decodeTo(IdentityEip712DomainV1.pipe(Schema.flip))
);
const CanonicalIntent = RegisterIntentV1.pipe(
  Schema.decodeTo(RegisterIntentV1.pipe(Schema.flip))
);

const RegistrationStatus = Schema.Literals([
  "draft",
  "pending_owner_signature",
  "ready",
  "submitted",
  "confirmed",
  "failed",
  "expired",
]);

const StoredLocalRegistrationV1 = Schema.Struct({
  admissionCode: Schema.NullOr(CanonicalAdmissionCode),
  digest: Schema.NullOr(CanonicalHex32),
  domain: Schema.NullOr(CanonicalDomain),
  idempotencyKey: CanonicalBase64Url32,
  intent: Schema.NullOr(CanonicalIntent),
  observeToken: CanonicalBase64Url32,
  ownerAddress: EthereumAddress,
  peerId: CanonicalPeerId,
  qid: Schema.NullOr(CanonicalQid),
  status: RegistrationStatus,
  version: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected local registration field",
  parseOptions: strictParseOptions,
});

const StoredLocalRegistrationJson = Schema.fromJsonString(
  StoredLocalRegistrationV1
);
type StoredLocalRegistration = typeof StoredLocalRegistrationV1.Type;

export type LocalRegistration = Pick<
  StoredLocalRegistration,
  "digest" | "qid" | "status" | "version"
>;

export class LocalRegistrationError extends Data.TaggedError(
  "LocalRegistrationError"
)<{
  readonly operation:
    | "conflict"
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

const publicRegistration = ({
  digest,
  qid,
  status,
  version,
}: StoredLocalRegistration): LocalRegistration => ({
  digest,
  qid,
  status,
  version,
});

const readStoredRegistration = Effect.fn(
  "LocalRegistration.readStoredRegistration"
)(function* () {
  const encoded = yield* Effect.tryPromise({
    catch: () => localError("read"),
    try: () =>
      SecureStore.getItemAsync(REGISTRATION_STORAGE_KEY, secureStoreOptions),
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
)(function* (registration: StoredLocalRegistration) {
  const encoded = yield* Schema.encodeEffect(StoredLocalRegistrationJson)(
    registration
  ).pipe(Effect.mapError(() => localError("write")));
  yield* Effect.tryPromise({
    catch: () => localError("write"),
    try: () =>
      SecureStore.setItemAsync(
        REGISTRATION_STORAGE_KEY,
        encoded,
        secureStoreOptions
      ),
  });
});

const randomBase64Url32 = Effect.fn("LocalRegistration.randomBase64Url32")(
  function* () {
    const bytes = yield* Effect.tryPromise({
      catch: () => localError("create"),
      try: () => Crypto.getRandomBytesAsync(32),
    });
    return yield* Schema.encodeEffect(Base64Url32)(bytes).pipe(
      Effect.mapError(() => localError("create"))
    );
  }
);

const loadIdentity = Effect.fn("LocalRegistration.loadIdentity")(function* () {
  const identity = yield* loadLocalIdentity().pipe(
    Effect.mapError(() => localError("identity"))
  );
  if (!identity) {
    return yield* localError("identity");
  }
  return identity;
});

const verifyStoredOwner = Effect.fn("LocalRegistration.verifyStoredOwner")(
  function* (registration: StoredLocalRegistration) {
    const identity = yield* loadIdentity();
    if (
      registration.ownerAddress !== identity.ownerAddress ||
      registration.peerId !== identity.peerId
    ) {
      return yield* localError("conflict");
    }
    return identity;
  }
);

export const loadLocalRegistration = Effect.fn(
  "LocalRegistration.loadLocalRegistration"
)(function* () {
  const registration = yield* readStoredRegistration();
  if (!registration) {
    return null;
  }
  yield* verifyStoredOwner(registration);
  return publicRegistration(registration);
});

const createDraft = Effect.fn("LocalRegistration.createDraft")(function* (
  admissionCode: string
) {
  const identity = yield* loadIdentity();
  const code = yield* Schema.decodeUnknownEffect(CanonicalAdmissionCode)(
    admissionCode
  ).pipe(Effect.mapError(() => localError("create")));
  const [idempotencyKey, observeToken] = yield* Effect.all(
    [randomBase64Url32(), randomBase64Url32()] as const,
    { concurrency: "unbounded" }
  );
  const draft: StoredLocalRegistration = {
    admissionCode: code,
    digest: null,
    domain: null,
    idempotencyKey,
    intent: null,
    observeToken,
    ownerAddress: identity.ownerAddress,
    peerId: identity.peerId,
    qid: null,
    status: "draft",
    version: 1,
  };
  yield* writeStoredRegistration(draft);
  return draft;
});

const prepareDraft = Effect.fn("LocalRegistration.prepareDraft")(function* (
  draft: StoredLocalRegistration
) {
  const identity = yield* verifyStoredOwner(draft);
  if (!draft.admissionCode) {
    return yield* localError("conflict");
  }
  const [peerId, observeToken] = yield* Effect.all(
    [
      Schema.decodeUnknownEffect(PeerId)(draft.peerId),
      Schema.decodeUnknownEffect(Base64Url32)(draft.observeToken),
    ] as const,
    { concurrency: "unbounded" }
  ).pipe(Effect.mapError(() => localError("decode")));
  const deviceCommitment = yield* hashRegistrationDeviceCommitmentV1(
    peerId,
    observeToken
  );
  const prepared = yield* prepareRegistration({
    admissionCode: draft.admissionCode,
    deviceCommitment,
    handle: identity.handle,
    idempotencyKey: draft.idempotencyKey,
    observeTokenHash: yield* hashRegistrationObserveTokenV1(observeToken),
    owner: identity.ownerAddress,
    peerId: identity.peerId,
  }).pipe(Effect.mapError(() => localError("network")));
  const [domain, intent] = yield* Effect.all(
    [
      decodeIdentityEip712DomainV1(prepared.domain),
      decodeRegisterIntentV1(prepared.intent),
    ] as const,
    { concurrency: "unbounded" }
  ).pipe(Effect.mapError(() => localError("verify")));
  const digest = yield* hashRegisterIntentV1(domain, intent).pipe(
    Effect.mapError(() => localError("verify"))
  );
  if (
    digest !== prepared.digest ||
    prepared.intent.deviceCommitment !== deviceCommitment ||
    prepared.intent.handle !== identity.handle ||
    prepared.intent.owner !== identity.ownerAddress
  ) {
    return yield* localError("verify");
  }
  const pending: StoredLocalRegistration = {
    ...draft,
    digest: prepared.digest,
    domain: prepared.domain,
    intent: prepared.intent,
    status: "pending_owner_signature",
  };
  yield* writeStoredRegistration(pending);
  return pending;
});

const authorizePrepared = Effect.fn("LocalRegistration.authorizePrepared")(
  function* (registration: StoredLocalRegistration) {
    if (!registration.digest || !registration.domain || !registration.intent) {
      return yield* localError("conflict");
    }
    const signature = yield* signLocalRegistrationIntent(
      registration.domain,
      registration.intent
    ).pipe(Effect.mapError(() => localError("sign")));
    const authorized = yield* authorizeRegistration(
      registration.digest,
      signature
    ).pipe(Effect.mapError(() => localError("network")));
    if (
      authorized.digest !== registration.digest ||
      authorized.intent.deadline !== registration.intent.deadline ||
      authorized.intent.deviceCommitment !==
        registration.intent.deviceCommitment ||
      authorized.intent.handle !== registration.intent.handle ||
      authorized.intent.nonce !== registration.intent.nonce ||
      authorized.intent.owner !== registration.intent.owner ||
      authorized.ownerSignature !== signature
    ) {
      return yield* localError("verify");
    }
    const updated: StoredLocalRegistration = {
      ...registration,
      admissionCode: null,
      status: authorized.status,
    };
    yield* writeStoredRegistration(updated);
    return updated;
  }
);

export const startLocalRegistration = Effect.fn(
  "LocalRegistration.startLocalRegistration"
)((admissionCode: string) =>
  registrationSemaphore.withPermit(
    Effect.gen(function* () {
      const code = yield* Schema.decodeUnknownEffect(CanonicalAdmissionCode)(
        admissionCode
      ).pipe(Effect.mapError(() => localError("create")));
      let registration = yield* readStoredRegistration();
      if (
        registration?.status === "failed" ||
        registration?.status === "expired"
      ) {
        registration = yield* createDraft(code);
      } else if (registration) {
        yield* verifyStoredOwner(registration);
        if (
          registration.status === "draft" &&
          registration.admissionCode !== code
        ) {
          registration = yield* createDraft(code);
        } else if (
          registration.admissionCode !== null &&
          registration.admissionCode !== code
        ) {
          return yield* localError("conflict");
        }
      } else {
        registration = yield* createDraft(code);
      }
      if (registration.status === "draft") {
        registration = yield* prepareDraft(registration);
      }
      if (registration.status === "pending_owner_signature") {
        registration = yield* authorizePrepared(registration);
      }
      return publicRegistration(registration);
    })
  )
);

export const reconcileLocalRegistration = Effect.fn(
  "LocalRegistration.reconcileLocalRegistration"
)(() =>
  registrationSemaphore.withPermit(
    Effect.gen(function* () {
      const registration = yield* readStoredRegistration();
      if (!registration?.digest) {
        return yield* localError("conflict");
      }
      yield* verifyStoredOwner(registration);
      const reconciled = yield* reconcileRegistration(registration.digest).pipe(
        Effect.mapError(() => localError("network"))
      );
      const updated: StoredLocalRegistration = {
        ...registration,
        qid: reconciled.qid,
        status: reconciled.status,
      };
      yield* writeStoredRegistration(updated);
      return publicRegistration(updated);
    })
  )
);

export const deleteLocalRegistration = Effect.fn(
  "LocalRegistration.deleteLocalRegistration"
)(() =>
  Effect.tryPromise({
    catch: () => localError("delete"),
    try: () =>
      SecureStore.deleteItemAsync(REGISTRATION_STORAGE_KEY, secureStoreOptions),
  })
);
