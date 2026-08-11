import {
  Base64Url32,
  decodeRecoveryKeyV1,
  encodeRecoveryKeyV1,
  EthereumAddress,
  Handle,
  ownerAddressFromRecoveryKeyV1,
  PeerId,
  peerIdFromEd25519SecretKey,
} from "@qop/identity";
import { Data, Effect, Result, Schema } from "effect";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const IDENTITY_STORAGE_KEY = "qop.identity.v1";
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const CanonicalBase64Url32 = Base64Url32.pipe(
  Schema.decodeTo(Base64Url32.pipe(Schema.flip))
);
const CanonicalPeerId = PeerId.pipe(Schema.decodeTo(PeerId.pipe(Schema.flip)));

const RecoveryKeyV1String = Schema.String.check(
  Schema.isPattern(/^qop1_[A-Za-z0-9_-]{43}_[0-9a-f]{8}$/u, {
    expected: "a canonical qop v1 recovery key",
  })
);

const LocalIdentityV1 = Schema.Struct({
  backupState: Schema.Literals(["copied", "pending", "skipped"]),
  deviceSecretKey: CanonicalBase64Url32,
  encryptionSecretKey: CanonicalBase64Url32,
  handle: Handle,
  ownerAddress: EthereumAddress,
  peerId: CanonicalPeerId,
  recoveryKey: RecoveryKeyV1String,
  version: Schema.Literal(1),
}).annotate({ messageUnexpectedKey: "Unexpected local identity field" });

const LocalIdentityJson = Schema.fromJsonString(LocalIdentityV1);

export type LocalIdentity = typeof LocalIdentityV1.Type;
export type IdentityBackupState = LocalIdentity["backupState"];

export class IdentityVaultError extends Data.TaggedError("IdentityVaultError")<{
  readonly operation:
    | "already-exists"
    | "availability"
    | "create"
    | "decode"
    | "read"
    | "write";
}> {}

const vaultError = (operation: IdentityVaultError["operation"]) =>
  new IdentityVaultError({ operation });

const ensureSecureStore = Effect.fn("IdentityVault.ensureSecureStore")(
  function* () {
    const available = yield* Effect.tryPromise({
      catch: () => vaultError("availability"),
      try: () => SecureStore.isAvailableAsync(),
    });
    if (!available) {
      return yield* vaultError("availability");
    }
  }
);

const randomBytes32 = Effect.fn("IdentityVault.randomBytes32")(() =>
  Effect.tryPromise({
    catch: () => vaultError("create"),
    try: () => Crypto.getRandomBytesAsync(32),
  })
);

const makeRecoveryKey = Effect.fn("IdentityVault.makeRecoveryKey")(
  function* () {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = yield* randomBytes32();
      const encoded = yield* encodeRecoveryKeyV1(candidate).pipe(Effect.result);
      if (Result.isSuccess(encoded)) {
        return encoded.success;
      }
    }
    return yield* vaultError("create");
  }
);

const decodeStoredIdentity = Effect.fn("IdentityVault.decodeStoredIdentity")(
  function* (encoded: string) {
    const identity = yield* Schema.decodeUnknownEffect(LocalIdentityJson)(
      encoded
    ).pipe(Effect.mapError(() => vaultError("decode")));
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
  function* (identity: LocalIdentity) {
    const encoded = yield* Schema.encodeEffect(LocalIdentityJson)(
      identity
    ).pipe(Effect.mapError(() => vaultError("write")));
    yield* Effect.tryPromise({
      catch: () => vaultError("write"),
      try: () =>
        SecureStore.setItemAsync(
          IDENTITY_STORAGE_KEY,
          encoded,
          secureStoreOptions
        ),
    });
  }
);

export const loadLocalIdentity = Effect.fn("IdentityVault.loadLocalIdentity")(
  function* () {
    yield* ensureSecureStore();
    const encoded = yield* Effect.tryPromise({
      catch: () => vaultError("read"),
      try: () =>
        SecureStore.getItemAsync(IDENTITY_STORAGE_KEY, secureStoreOptions),
    });
    return encoded === null ? null : yield* decodeStoredIdentity(encoded);
  }
);

export const createLocalIdentity = Effect.fn(
  "IdentityVault.createLocalIdentity"
)(function* (input: unknown) {
  const handle = yield* Schema.decodeUnknownEffect(Handle)(input).pipe(
    Effect.mapError(() => vaultError("create"))
  );
  if ((yield* loadLocalIdentity()) !== null) {
    return yield* vaultError("already-exists");
  }

  const [recoveryKey, deviceSecretKey, encryptionSecretKey] = yield* Effect.all(
    [makeRecoveryKey(), randomBytes32(), randomBytes32()] as const,
    { concurrency: "unbounded" }
  );
  const ownerAddress = yield* ownerAddressFromRecoveryKeyV1(recoveryKey).pipe(
    Effect.mapError(() => vaultError("create"))
  );
  const peerId = yield* peerIdFromEd25519SecretKey(deviceSecretKey).pipe(
    Effect.flatMap(Schema.encodeEffect(PeerId)),
    Effect.mapError(() => vaultError("create"))
  );
  const [encodedDeviceSecretKey, encodedEncryptionSecretKey] =
    yield* Effect.all(
      [
        Schema.encodeEffect(Base64Url32)(deviceSecretKey),
        Schema.encodeEffect(Base64Url32)(encryptionSecretKey),
      ] as const,
      { concurrency: "unbounded" }
    ).pipe(Effect.mapError(() => vaultError("create")));
  const identity: LocalIdentity = {
    backupState: "pending",
    deviceSecretKey: encodedDeviceSecretKey,
    encryptionSecretKey: encodedEncryptionSecretKey,
    handle,
    ownerAddress,
    peerId,
    recoveryKey,
    version: 1,
  };
  yield* writeLocalIdentity(identity);
  return identity;
});

export const finishLocalIdentityOnboarding = Effect.fn(
  "IdentityVault.finishLocalIdentityOnboarding"
)(function* (
  identity: LocalIdentity,
  backupState: Exclude<IdentityBackupState, "pending">
) {
  const updated: LocalIdentity = { ...identity, backupState };
  yield* writeLocalIdentity(updated);
  return updated;
});
