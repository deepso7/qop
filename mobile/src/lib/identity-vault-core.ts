import {
  Base64Url32,
  decodeRecoveryKeyV1,
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  decodeRecoverOwnerIntentV1,
  decodeWipeDevicesIntentV1,
  deviceKeyFromEd25519SecretKey,
  encodeRecoveryKeyV1,
  EcdsaSignature,
  EthereumAddress,
  Handle,
  Hex32,
  ownerAddressFromRecoveryKeyV1,
  PeerId,
  peerIdFromEd25519SecretKey,
  signRegisterIntentV1,
  signRecoverOwnerIntentV1,
  signWipeDevicesIntentV1,
} from "@qop/identity";
import type {
  IdentityEip712DomainV1Encoded,
  RegisterIntentV1Encoded,
  RecoverOwnerIntentV1Encoded,
  WipeDevicesIntentV1Encoded,
} from "@qop/identity";
import { Data, Effect, Result, Schema, Semaphore } from "effect";

const INSTALL_STORAGE_KEY = "qop.install.v1";
const INSTALL_STORAGE_VALUE = "1";
const LEGACY_IDENTITY_STORAGE_KEY = "qop.identity.v1";
const IDENTITY_STORAGE_KEY = "qop.identity.v2";
const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const CanonicalBase64Url32 = Base64Url32.pipe(
  Schema.decodeTo(Base64Url32.pipe(Schema.flip))
);
const CanonicalPeerId = PeerId.pipe(Schema.decodeTo(PeerId.pipe(Schema.flip)));

const RecoveryKeyV1String = Schema.String.check(
  Schema.isPattern(/^qop1_[A-Za-z0-9_-]{43}_[0-9a-f]{8}$/u, {
    expected: "a canonical qop v1 recovery key",
  })
);

const StoredLocalIdentityV2 = Schema.Struct({
  backupState: Schema.Literals(["copied", "pending", "skipped"]),
  deviceSecretKey: CanonicalBase64Url32,
  handle: Handle,
  ownerAddress: EthereumAddress,
  peerId: CanonicalPeerId,
  recoveryKey: RecoveryKeyV1String,
  version: Schema.Literal(2),
}).annotate({
  messageUnexpectedKey: "Unexpected local identity field",
  parseOptions: strictParseOptions,
});

const StoredLocalIdentityJson = Schema.fromJsonString(StoredLocalIdentityV2);

type StoredLocalIdentity = typeof StoredLocalIdentityV2.Type;

export type LocalIdentity = Pick<
  StoredLocalIdentity,
  "backupState" | "handle" | "ownerAddress" | "peerId" | "version"
> & {
  readonly deviceKey: typeof Hex32.Encoded;
};
export type IdentityBackupState = StoredLocalIdentity["backupState"];

export class IdentityVaultError extends Data.TaggedError("IdentityVaultError")<{
  readonly operation:
    | "already-exists"
    | "availability"
    | "create"
    | "decode"
    | "delete"
    | "install-state"
    | "invalid-handle"
    | "missing-identity"
    | "read"
    | "sign"
    | "stale-install"
    | "write";
}> {}

const vaultError = (operation: IdentityVaultError["operation"]) =>
  new IdentityVaultError({ operation });

const publicIdentity = Effect.fn("IdentityVault.publicIdentity")(function* ({
  backupState,
  deviceSecretKey,
  handle,
  ownerAddress,
  peerId,
  version,
}: StoredLocalIdentity) {
  const secretKey = yield* Schema.decodeUnknownEffect(Base64Url32)(
    deviceSecretKey
  ).pipe(Effect.mapError(() => vaultError("decode")));
  const deviceKey = yield* deviceKeyFromEd25519SecretKey(secretKey).pipe(
    Effect.flatMap(Schema.encodeEffect(Hex32)),
    Effect.mapError(() => vaultError("decode"))
  );
  return {
    backupState,
    deviceKey,
    handle,
    ownerAddress,
    peerId,
    version,
  };
});

export interface IdentityVaultDependencies {
  readonly makeInstallMarker: () => {
    readonly exists: boolean;
    readonly write: (value: string) => void;
  };
  readonly randomBytes: () => Promise<Uint8Array>;
  readonly secureStore: {
    readonly delete: (key: string) => Promise<void>;
    readonly get: (key: string) => Promise<string | null>;
    readonly isAvailable: () => Promise<boolean>;
    readonly set: (key: string, value: string) => Promise<void>;
  };
}

export const createIdentityVault = ({
  makeInstallMarker,
  randomBytes,
  secureStore,
}: IdentityVaultDependencies) => {
  const createSemaphore = Semaphore.makeUnsafe(1);

  const ensureSecureStore = Effect.fn("IdentityVault.ensureSecureStore")(
    function* () {
      const available = yield* Effect.tryPromise({
        catch: () => vaultError("availability"),
        try: () => secureStore.isAvailable(),
      });
      if (!available) {
        return yield* vaultError("availability");
      }
    }
  );

  const sandboxInstallMarker = makeInstallMarker;

  const writeSandboxInstallMarker = Effect.fn(
    "IdentityVault.writeSandboxInstallMarker"
  )(() =>
    Effect.try({
      catch: () => vaultError("install-state"),
      try: () => sandboxInstallMarker().write(INSTALL_STORAGE_VALUE),
    })
  );

  const readInstallState = Effect.fn("IdentityVault.readInstallState")(
    function* () {
      const keychainMarker = yield* Effect.tryPromise({
        catch: () => vaultError("install-state"),
        try: () => secureStore.get(INSTALL_STORAGE_KEY),
      });
      const sandboxMarkerExists = yield* Effect.try({
        catch: () => vaultError("install-state"),
        try: () => sandboxInstallMarker().exists,
      });

      if (keychainMarker === null) {
        yield* writeSandboxInstallMarker();
        yield* Effect.tryPromise({
          catch: () => vaultError("install-state"),
          try: () =>
            secureStore.set(INSTALL_STORAGE_KEY, INSTALL_STORAGE_VALUE),
        });
        return "current" as const;
      }
      if (keychainMarker !== INSTALL_STORAGE_VALUE) {
        return yield* vaultError("install-state");
      }
      return sandboxMarkerExists
        ? ("current" as const)
        : ("reinstalled" as const);
    }
  );

  const randomBytes32 = Effect.fn("IdentityVault.randomBytes32")(() =>
    Effect.tryPromise({
      catch: () => vaultError("create"),
      try: randomBytes,
    })
  );

  const makeRecoveryKey = Effect.fn("IdentityVault.makeRecoveryKey")(
    function* () {
      for (let attempt = 0; attempt < 128; attempt += 1) {
        const candidate = yield* randomBytes32();
        const encoded = yield* encodeRecoveryKeyV1(candidate).pipe(
          Effect.result
        );
        if (Result.isSuccess(encoded)) {
          return encoded.success;
        }
      }
      return yield* vaultError("create");
    }
  );

  const decodeStoredIdentity = Effect.fn("IdentityVault.decodeStoredIdentity")(
    function* (encoded: string) {
      const identity = yield* Schema.decodeUnknownEffect(
        StoredLocalIdentityJson
      )(encoded).pipe(Effect.mapError(() => vaultError("decode")));
      const recoveryPrivateKey = yield* decodeRecoveryKeyV1(
        identity.recoveryKey
      ).pipe(Effect.mapError(() => vaultError("decode")));
      const ownerAddress = yield* ownerAddressFromRecoveryKeyV1(
        identity.recoveryKey
      ).pipe(Effect.mapError(() => vaultError("decode")));
      const deviceSecretKey = yield* Schema.decodeUnknownEffect(Base64Url32)(
        identity.deviceSecretKey
      ).pipe(Effect.mapError(() => vaultError("decode")));
      const peerId = yield* peerIdFromEd25519SecretKey(deviceSecretKey).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId)),
        Effect.mapError(() => vaultError("decode"))
      );

      if (
        recoveryPrivateKey.length !== 32 ||
        ownerAddress !== identity.ownerAddress ||
        peerId !== identity.peerId
      ) {
        return yield* vaultError("decode");
      }
      return identity;
    }
  );

  const writeLocalIdentity = Effect.fn("IdentityVault.writeLocalIdentity")(
    function* (identity: StoredLocalIdentity) {
      const encoded = yield* Schema.encodeEffect(StoredLocalIdentityJson)(
        identity
      ).pipe(Effect.mapError(() => vaultError("write")));
      yield* Effect.tryPromise({
        catch: () => vaultError("write"),
        try: () => secureStore.set(IDENTITY_STORAGE_KEY, encoded),
      });
    }
  );

  const loadStoredLocalIdentity = Effect.fn(
    "IdentityVault.loadStoredLocalIdentity"
  )(function* () {
    yield* ensureSecureStore();
    const [encoded, legacyEncoded, installState] = yield* Effect.all(
      [
        Effect.tryPromise({
          catch: () => vaultError("read"),
          try: () => secureStore.get(IDENTITY_STORAGE_KEY),
        }),
        Effect.tryPromise({
          catch: () => vaultError("read"),
          try: () => secureStore.get(LEGACY_IDENTITY_STORAGE_KEY),
        }),
        readInstallState(),
      ] as const,
      { concurrency: "unbounded" }
    );
    if (encoded === null) {
      if (legacyEncoded !== null) {
        return yield* vaultError("decode");
      }
      if (installState === "reinstalled") {
        yield* writeSandboxInstallMarker();
      }
      return null;
    }
    if (installState === "reinstalled") {
      return yield* vaultError("stale-install");
    }
    return yield* decodeStoredIdentity(encoded);
  });

  const loadLocalIdentity = Effect.fn("IdentityVault.loadLocalIdentity")(
    function* () {
      const identity = yield* loadStoredLocalIdentity();
      return identity === null ? null : yield* publicIdentity(identity);
    }
  );

  const createLocalIdentityUnlocked = Effect.fn(
    "IdentityVault.createLocalIdentityUnlocked"
  )(function* (input: string) {
    const handle = yield* Schema.decodeUnknownEffect(Handle)(input).pipe(
      Effect.mapError(() => vaultError("create"))
    );
    if ((yield* loadStoredLocalIdentity()) !== null) {
      return yield* vaultError("already-exists");
    }

    const [recoveryKey, deviceSecretKey] = yield* Effect.all(
      [makeRecoveryKey(), randomBytes32()] as const,
      { concurrency: "unbounded" }
    );
    const ownerAddress = yield* ownerAddressFromRecoveryKeyV1(recoveryKey).pipe(
      Effect.mapError(() => vaultError("create"))
    );
    const peerId = yield* peerIdFromEd25519SecretKey(deviceSecretKey).pipe(
      Effect.flatMap(Schema.encodeEffect(PeerId)),
      Effect.mapError(() => vaultError("create"))
    );
    const encodedDeviceSecretKey = yield* Schema.encodeEffect(Base64Url32)(
      deviceSecretKey
    ).pipe(Effect.mapError(() => vaultError("create")));
    const identity: StoredLocalIdentity = {
      backupState: "pending",
      deviceSecretKey: encodedDeviceSecretKey,
      handle,
      ownerAddress,
      peerId,
      recoveryKey,
      version: 2,
    };
    yield* writeLocalIdentity(identity);
    return yield* publicIdentity(identity);
  });

  const createLocalIdentity = Effect.fn("IdentityVault.createLocalIdentity")(
    (input: string) =>
      createSemaphore.withPermit(createLocalIdentityUnlocked(input))
  );

  const deleteLocalIdentity = Effect.fn("IdentityVault.deleteLocalIdentity")(
    () =>
      createSemaphore.withPermit(
        Effect.gen(function* () {
          yield* ensureSecureStore();
          yield* Effect.tryPromise({
            catch: () => vaultError("delete"),
            try: () => secureStore.delete(IDENTITY_STORAGE_KEY),
          });
          yield* Effect.tryPromise({
            catch: () => vaultError("delete"),
            try: () => secureStore.delete(LEGACY_IDENTITY_STORAGE_KEY),
          });
          yield* writeSandboxInstallMarker();
        })
      )
  );

  const revealLocalIdentityRecoveryKey = Effect.fn(
    "IdentityVault.revealLocalIdentityRecoveryKey"
  )(function* () {
    const identity = yield* loadStoredLocalIdentity();
    if (!identity) {
      return yield* vaultError("missing-identity");
    }
    return identity.recoveryKey;
  });

  const signRegisterIntent = Effect.fn("IdentityVault.signRegisterIntent")(
    function* (
      domainInput: IdentityEip712DomainV1Encoded,
      intentInput: RegisterIntentV1Encoded
    ) {
      const identity = yield* loadStoredLocalIdentity();
      if (!identity) {
        return yield* vaultError("missing-identity");
      }
      const [domain, intent, privateKey] = yield* Effect.all(
        [
          decodeIdentityEip712DomainV1(domainInput),
          decodeRegisterIntentV1(intentInput),
          decodeRecoveryKeyV1(identity.recoveryKey),
        ] as const,
        { concurrency: "unbounded" }
      ).pipe(Effect.mapError(() => vaultError("sign")));
      if (
        intent.handle !== identity.handle ||
        intent.owner !== identity.ownerAddress ||
        intentInput.deviceKey !== (yield* publicIdentity(identity)).deviceKey
      ) {
        return yield* vaultError("sign");
      }
      return yield* signRegisterIntentV1(domain, intent, privateKey).pipe(
        Effect.flatMap(Schema.encodeEffect(EcdsaSignature)),
        Effect.mapError(() => vaultError("sign"))
      );
    }
  );

  // Device-only wipe: owner signs WipeDevices. Not completed owner recovery —
  // a compromised owner can still addDevice until recoverOwner rotates ownership.
  const signWipeDevicesIntent = Effect.fn(
    "IdentityVault.signWipeDevicesIntent"
  )(function* (
    domainInput: IdentityEip712DomainV1Encoded,
    intentInput: WipeDevicesIntentV1Encoded
  ) {
    const identity = yield* loadStoredLocalIdentity();
    if (!identity) {
      return yield* vaultError("missing-identity");
    }
    const [domain, intent, privateKey] = yield* Effect.all(
      [
        decodeIdentityEip712DomainV1(domainInput),
        decodeWipeDevicesIntentV1(intentInput),
        decodeRecoveryKeyV1(identity.recoveryKey),
      ] as const,
      { concurrency: "unbounded" }
    ).pipe(Effect.mapError(() => vaultError("sign")));
    return yield* signWipeDevicesIntentV1(domain, intent, privateKey).pipe(
      Effect.flatMap(Schema.encodeEffect(EcdsaSignature)),
      Effect.mapError(() => vaultError("sign"))
    );
  });

  // Completed owner recovery: rotate owner + wipe devices (on-chain recoverOwner).
  // Current recovery key signs as the compromised owner; caller supplies newOwnerSignature.
  const signRecoverOwnerIntent = Effect.fn(
    "IdentityVault.signRecoverOwnerIntent"
  )(function* (
    domainInput: IdentityEip712DomainV1Encoded,
    intentInput: RecoverOwnerIntentV1Encoded
  ) {
    const identity = yield* loadStoredLocalIdentity();
    if (!identity) {
      return yield* vaultError("missing-identity");
    }
    const [domain, intent, privateKey] = yield* Effect.all(
      [
        decodeIdentityEip712DomainV1(domainInput),
        decodeRecoverOwnerIntentV1(intentInput),
        decodeRecoveryKeyV1(identity.recoveryKey),
      ] as const,
      { concurrency: "unbounded" }
    ).pipe(Effect.mapError(() => vaultError("sign")));
    return yield* signRecoverOwnerIntentV1(domain, intent, privateKey).pipe(
      Effect.flatMap(Schema.encodeEffect(EcdsaSignature)),
      Effect.mapError(() => vaultError("sign"))
    );
  });

  const updateLocalIdentityBackupState = Effect.fn(
    "IdentityVault.updateLocalIdentityBackupState"
  )((backupState: Exclude<IdentityBackupState, "pending">) =>
    createSemaphore.withPermit(
      Effect.gen(function* () {
        const identity = yield* loadStoredLocalIdentity();
        if (!identity) {
          return yield* vaultError("missing-identity");
        }
        const updated: StoredLocalIdentity = { ...identity, backupState };
        yield* writeLocalIdentity(updated);
        return yield* publicIdentity(updated);
      })
    )
  );

  // These bytes must never be logged or persisted anywhere else.
  const loadDeviceSecretKey = Effect.fn("IdentityVault.loadDeviceSecretKey")(
    function* () {
      const identity = yield* loadStoredLocalIdentity();
      if (!identity) {
        return yield* vaultError("missing-identity");
      }
      const secretKey = yield* Schema.decodeUnknownEffect(Base64Url32)(
        identity.deviceSecretKey
      ).pipe(Effect.mapError(() => vaultError("decode")));
      return Uint8Array.from(secretKey);
    }
  );

  return {
    createLocalIdentity,
    deleteLocalIdentity,
    loadDeviceSecretKey,
    loadLocalIdentity,
    revealLocalIdentityRecoveryKey,
    signRecoverOwnerIntent,
    signRegisterIntent,
    signWipeDevicesIntent,
    updateLocalIdentityBackupState,
  };
};
