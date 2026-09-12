import type { Stats } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  deviceKeyFromEd25519SecretKey,
  Hex32,
  PeerId,
  peerIdFromEd25519SecretKey,
} from "@qop/identity";
import { DeviceActionApprovalV1 } from "@qop/protocol";
import { Data, Effect, Schema } from "effect";

const IDENTITY_VERSION = 1 as const;

const StoredIdentity = Schema.Struct({
  account: Schema.String,
  chainId: Schema.String,
  deviceKey: Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip))),
  handle: Schema.String,
  peerId: PeerId.pipe(Schema.decodeTo(PeerId.pipe(Schema.flip))),
  qid: Schema.String,
  registry: Schema.String,
  version: Schema.Literal(IDENTITY_VERSION),
}).annotate({
  messageUnexpectedKey: "Unexpected CLI identity field",
  parseOptions: { errors: "all", onExcessProperty: "error" },
});

export type StoredCliIdentity = typeof StoredIdentity.Type;

export class CliIdentityStoreError extends Data.TaggedError(
  "CliIdentityStoreError"
)<{
  readonly operation:
    | "conflict"
    | "decode"
    | "lock"
    | "permissions"
    | "read"
    | "write";
}> {}

const storeError = (operation: CliIdentityStoreError["operation"]) =>
  new CliIdentityStoreError({ operation });

export const defaultDataDirectory = (home = process.env.HOME ?? "") =>
  path.join(home, ".local", "share", "qop");

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;

const NodeErrno = Schema.Struct({
  code: Schema.String,
});

const errnoCode = Schema.decodeUnknownOption(NodeErrno);

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const parsed = errnoCode(error);
    return parsed._tag === "Some" && parsed.value.code === "EPERM";
  }
};

const assertPrivateMode = Effect.fn("CliIdentity.assertPrivateMode")(function* (
  filePath: string,
  directory: boolean
) {
  const info = yield* Effect.tryPromise({
    catch: () => storeError("permissions"),
    try: () => stat(filePath),
  });
  const permission = info.mode.toString(8).slice(-3);
  const expected = directory ? "700" : "600";
  if (permission !== expected) {
    return yield* storeError("permissions");
  }
});

const writeAtomic = Effect.fn("CliIdentity.writeAtomic")(function* (
  filePath: string,
  contents: string | Uint8Array
) {
  const temporary = `${filePath}.tmp`;
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => writeFile(temporary, contents, { mode: MODE_FILE }),
  });
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => chmod(temporary, MODE_FILE),
  });
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => rename(temporary, filePath),
  });
});

const readTextOptional = (filePath: string) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: () => readFile(filePath, "utf-8"),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(storeError("read"));
      },
      onSuccess: (value) => Effect.succeed(value),
    })
  );

const statOptional = (filePath: string) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: () => stat(filePath),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "ENOENT"
          ? Effect.succeed<Stats | null>(null)
          : Effect.fail(storeError("read"));
      },
      onSuccess: (value) => Effect.succeed(value),
    })
  );

const unlinkOptional = (filePath: string) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: () => unlink(filePath),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "ENOENT"
          ? Effect.void
          : Effect.fail(storeError("write"));
      },
      onSuccess: () => Effect.void,
    })
  );

export const createCliIdentityStore = (root: string) => {
  const identityPath = path.join(root, "identity.json");
  const secretPath = path.join(root, "device.key");
  const approvalPath = path.join(root, "pending-approval.json");
  const lockPath = path.join(root, "lock");

  const openExclusiveLock = () =>
    Effect.tryPromise({
      catch: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "EEXIST"
          ? storeError("conflict")
          : storeError("lock");
      },
      try: () => open(lockPath, "wx"),
    });

  const recoverStaleLock = Effect.fn("CliIdentity.recoverStaleLock")(
    function* () {
      const encoded = yield* readTextOptional(lockPath);
      if (encoded === null) {
        return;
      }
      const pid = Number(encoded.trim());
      if (!Number.isInteger(pid) || pid <= 0) {
        yield* unlinkOptional(lockPath);
        return;
      }
      if (processExists(pid)) {
        return yield* storeError("conflict");
      }
      yield* unlinkOptional(lockPath);
    }
  );

  const acquireLock = Effect.fn("CliIdentity.acquireLock")(function* () {
    yield* Effect.tryPromise({
      catch: () => storeError("write"),
      try: () => mkdir(root, { mode: MODE_DIR, recursive: true }),
    });
    yield* Effect.tryPromise({
      catch: () => storeError("write"),
      try: () => chmod(root, MODE_DIR),
    });
    yield* assertPrivateMode(root, true);
    const handle = yield* openExclusiveLock().pipe(
      Effect.catchIf(
        (error) => error.operation === "conflict",
        () => recoverStaleLock().pipe(Effect.andThen(openExclusiveLock()))
      )
    );
    yield* Effect.tryPromise({
      catch: () => storeError("write"),
      try: () => handle.writeFile(String(process.pid)),
    });
    const release = Effect.tryPromise({
      catch: () => storeError("lock"),
      try: async () => {
        await handle.close();
        await unlink(lockPath);
      },
    });
    return { lockPath, release };
  });

  const loadIdentity = Effect.fn("CliIdentity.loadIdentity")(function* () {
    const encoded = yield* readTextOptional(identityPath);
    if (!encoded) {
      return null;
    }
    yield* assertPrivateMode(identityPath, false);
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(StoredIdentity)
    )(encoded).pipe(Effect.mapError(() => storeError("decode")));
  });

  const loadSecret = Effect.fn("CliIdentity.loadSecret")(function* () {
    yield* assertPrivateMode(secretPath, false);
    const bytes = yield* Effect.tryPromise({
      catch: () => storeError("read"),
      try: () => readFile(secretPath),
    });
    if (bytes.byteLength !== 32) {
      return yield* storeError("decode");
    }
    return new Uint8Array(bytes);
  });

  const persistIdentity = Effect.fn("CliIdentity.persistIdentity")(function* (
    publicIdentity: Omit<StoredCliIdentity, "deviceKey" | "peerId" | "version">,
    secret: Uint8Array
  ) {
    yield* writeAtomic(secretPath, secret);
    const deviceKey = yield* deviceKeyFromEd25519SecretKey(secret).pipe(
      Effect.flatMap(Schema.encodeEffect(Hex32)),
      Effect.mapError(() => storeError("write"))
    );
    const peerId = yield* peerIdFromEd25519SecretKey(secret).pipe(
      Effect.flatMap(Schema.encodeEffect(PeerId)),
      Effect.mapError(() => storeError("write"))
    );
    const identity: StoredCliIdentity = {
      ...publicIdentity,
      deviceKey,
      peerId,
      version: IDENTITY_VERSION,
    };
    yield* writeAtomic(
      identityPath,
      JSON.stringify(
        yield* Schema.encodeEffect(StoredIdentity)(identity).pipe(
          Effect.mapError(() => storeError("write"))
        )
      )
    );
    yield* assertPrivateMode(identityPath, false);
    yield* assertPrivateMode(secretPath, false);
    return identity;
  });

  const createPendingKey = Effect.fn("CliIdentity.createPendingKey")(function* (
    publicIdentity: Omit<StoredCliIdentity, "deviceKey" | "peerId" | "version">
  ) {
    const existing = yield* loadIdentity();
    if (existing) {
      if (
        existing.handle !== publicIdentity.handle ||
        existing.qid !== publicIdentity.qid ||
        existing.registry !== publicIdentity.registry
      ) {
        return yield* storeError("conflict");
      }
      return existing;
    }
    const secretInfo = yield* statOptional(secretPath);
    if (secretInfo) {
      // Secret without identity is incomplete — never mint over it.
      return yield* storeError("conflict");
    }
    const secret = crypto.getRandomValues(new Uint8Array(32));
    return yield* persistIdentity(publicIdentity, secret);
  });

  const rotatePendingKey = Effect.fn("CliIdentity.rotatePendingKey")(function* (
    publicIdentity: Omit<StoredCliIdentity, "deviceKey" | "peerId" | "version">
  ) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const identity = yield* persistIdentity(publicIdentity, secret);
    yield* unlinkOptional(approvalPath);
    return identity;
  });

  const loadApproval = Effect.fn("CliIdentity.loadApproval")(function* () {
    const encoded = yield* readTextOptional(approvalPath);
    if (!encoded) {
      return null;
    }
    const parsed = yield* Effect.try({
      catch: () => storeError("decode"),
      // SAFETY: JSON.parse is untyped; DeviceActionApprovalV1 is decoded next.
      try: () => JSON.parse(encoded) as unknown,
    });
    return yield* Schema.decodeUnknownEffect(DeviceActionApprovalV1)(
      parsed
    ).pipe(Effect.mapError(() => storeError("decode")));
  });

  const saveApproval = Effect.fn("CliIdentity.saveApproval")(function* (
    record: DeviceActionApprovalV1
  ) {
    const encoded = yield* Schema.encodeEffect(DeviceActionApprovalV1)(
      record
    ).pipe(Effect.mapError(() => storeError("write")));
    yield* writeAtomic(approvalPath, JSON.stringify(encoded));
  });

  return {
    acquireLock,
    createPendingKey,
    loadApproval,
    loadIdentity,
    loadSecret,
    rotatePendingKey,
    saveApproval,
  };
};
