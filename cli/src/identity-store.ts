import type { Stats } from "node:fs";
import {
  chmod,
  link,
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
import { Data, Effect, Result, Schema } from "effect";

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

/** Put a wrongly renamed live inode back without overwriting a newer file. */
const restoreStolenInode = (pathName: string, stalePath: string) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: () => link(stalePath, pathName),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const parsed = errnoCode(error);
        if (
          parsed._tag === "Some" &&
          (parsed.value.code === "EEXIST" || parsed.value.code === "ENOENT")
        ) {
          return unlinkOptional(stalePath);
        }
        return Effect.fail(storeError("lock"));
      },
      onSuccess: () => unlinkOptional(stalePath),
    })
  );

const sameDeadInode = (
  observed: Stats,
  trimmed: string,
  info: Stats | null,
  text: string | null
) =>
  info !== null &&
  info.dev === observed.dev &&
  info.ino === observed.ino &&
  text !== null &&
  text.trim() === trimmed;

type RecoverOutcome =
  | { readonly claimPath: string; readonly kind: "stolen" }
  | { readonly kind: "held" };

export const createCliIdentityStore = (
  root: string,
  options?: {
    /**
     * Test hook: run after `lock` is renamed away, before the inode check.
     * Widens the empty-path window for the three-process race test.
     */
    readonly afterRecoverRename?: () => Effect.Effect<void, never>;
    /**
     * Test hook: run after a dead lock is observed (PID + inode), before the
     * exclusive recover claim. Used to inject the TOCTOU window.
     */
    readonly beforeRecoverSteal?: () => Effect.Effect<void, never>;
    /**
     * Test hook: run after a dead recover-claim PID + inode is confirmed,
     * before renaming that claim. Injects the stale-claim takeover window.
     */
    readonly beforeRecoverClaimTakeover?: () => Effect.Effect<void, never>;
  }
) => {
  const identityPath = path.join(root, "identity.json");
  const secretPath = path.join(root, "device.key");
  const approvalPath = path.join(root, "pending-approval.json");
  const lockPath = path.join(root, "lock");

  const openExclusive = (filePath: string) =>
    Effect.tryPromise({
      catch: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "EEXIST"
          ? storeError("conflict")
          : storeError("lock");
      },
      try: () => open(filePath, "wx"),
    });

  const recoverClaimPathFor = (info: Stats) =>
    `${lockPath}.recover.${info.dev}.${info.ino}`;

  const writeClaimPid = (filePath: string) =>
    Effect.gen(function* () {
      const handle = yield* openExclusive(filePath);
      yield* Effect.tryPromise({
        catch: () => storeError("lock"),
        try: async () => {
          try {
            await handle.writeFile(String(process.pid));
          } finally {
            await handle.close();
          }
        },
      }).pipe(Effect.tapError(() => unlinkOptional(filePath)));
      return filePath;
    });

  /**
   * Exclusive permission to rename this dead inode. Held until lock release
   * so a later recoverer cannot rename away the live lock we then wx.
   */
  const claimDeadInode = Effect.fn("CliIdentity.claimDeadInode")(function* (
    observed: Stats
  ) {
    const claimPath = recoverClaimPathFor(observed);
    const created = yield* writeClaimPid(claimPath).pipe(Effect.result);
    if (Result.isSuccess(created)) {
      return claimPath;
    }
    if (created.failure.operation !== "conflict") {
      return yield* created.failure;
    }
    const encoded = yield* readTextOptional(claimPath);
    if (encoded === null) {
      return null;
    }
    const trimmed = encoded.trim();
    const pid = Number(trimmed);
    if (!trimmed || !Number.isInteger(pid) || pid <= 0 || processExists(pid)) {
      return null;
    }
    const claimInfo = yield* statOptional(claimPath);
    if (claimInfo === null) {
      return null;
    }
    const lockNow = yield* statOptional(lockPath);
    // Only take over a dead claim if `lock` is still the inode it was claiming.
    if (
      lockNow === null ||
      lockNow.dev !== observed.dev ||
      lockNow.ino !== observed.ino
    ) {
      return null;
    }
    if (options?.beforeRecoverClaimTakeover) {
      yield* options.beforeRecoverClaimTakeover();
    }
    const staleClaim = `${claimPath}.stale.${process.pid}.${crypto.randomUUID()}`;
    const moved = yield* Effect.tryPromise({
      catch: (error) => error,
      try: () => rename(claimPath, staleClaim),
    }).pipe(Effect.result);
    if (Result.isFailure(moved)) {
      return null;
    }
    const stolenClaim = yield* statOptional(staleClaim);
    const stolenText = yield* readTextOptional(staleClaim);
    // Path rename is not atomic with the dead-PID check. If another recoverer
    // already replaced this claim, put their live inode back and back off.
    if (!sameDeadInode(claimInfo, trimmed, stolenClaim, stolenText)) {
      yield* restoreStolenInode(claimPath, staleClaim);
      return null;
    }
    yield* unlinkOptional(staleClaim);
    const retried = yield* writeClaimPid(claimPath).pipe(Effect.result);
    return Result.isSuccess(retried) ? claimPath : null;
  });

  const observeDeadLock = Effect.fn("CliIdentity.observeDeadLock")(
    function* () {
      const encoded = yield* readTextOptional(lockPath);
      if (encoded === null) {
        return null;
      }
      const trimmed = encoded.trim();
      // Empty/partial lock means another process won exclusive create and has
      // not written its PID yet. Do not steal it.
      if (!trimmed) {
        return null;
      }
      const pid = Number(trimmed);
      if (!Number.isInteger(pid) || pid <= 0 || processExists(pid)) {
        return null;
      }
      const again = yield* readTextOptional(lockPath);
      if (again === null || again.trim() !== trimmed) {
        return null;
      }
      const observed = yield* statOptional(lockPath);
      if (observed === null) {
        return null;
      }
      return { observed, trimmed };
    }
  );

  const recoverStaleLock = Effect.fn("CliIdentity.recoverStaleLock")(
    function* () {
      const dead = yield* observeDeadLock();
      if (!dead) {
        return { kind: "held" } satisfies RecoverOutcome;
      }
      if (options?.beforeRecoverSteal) {
        yield* options.beforeRecoverSteal();
      }
      const claimPath = yield* claimDeadInode(dead.observed);
      if (claimPath === null) {
        return { kind: "held" } satisfies RecoverOutcome;
      }
      const still = yield* statOptional(lockPath);
      const stillText = yield* readTextOptional(lockPath);
      if (!sameDeadInode(dead.observed, dead.trimmed, still, stillText)) {
        yield* unlinkOptional(claimPath);
        return { kind: "held" } satisfies RecoverOutcome;
      }
      const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
      const renamed = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => rename(lockPath, stalePath),
      }).pipe(Effect.result);
      if (Result.isFailure(renamed)) {
        yield* unlinkOptional(claimPath);
        return { kind: "held" } satisfies RecoverOutcome;
      }
      if (options?.afterRecoverRename) {
        yield* options.afterRecoverRename();
      }
      const stolen = yield* statOptional(stalePath);
      const stolenText = yield* readTextOptional(stalePath);
      // With the inode claim held, this mismatch is leftover defense: restore
      // (link does not overwrite) and drop the claim. Do not wx.
      if (!sameDeadInode(dead.observed, dead.trimmed, stolen, stolenText)) {
        yield* restoreStolenInode(lockPath, stalePath);
        yield* unlinkOptional(claimPath);
        return { kind: "held" } satisfies RecoverOutcome;
      }
      yield* unlinkOptional(stalePath);
      return { claimPath, kind: "stolen" } satisfies RecoverOutcome;
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
    let lastConflict = storeError("conflict");
    let recoverClaimPath: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const opened = yield* openExclusive(lockPath).pipe(Effect.result);
      if (Result.isSuccess(opened)) {
        const handle = opened.success;
        yield* Effect.tryPromise({
          catch: () => storeError("write"),
          try: () => handle.writeFile(String(process.pid)),
        });
        const ownerPid = process.pid;
        const claimPath = recoverClaimPath;
        const release = Effect.tryPromise({
          catch: () => storeError("lock"),
          try: async () => {
            try {
              const ours = await handle.stat();
              let current: Stats | null = null;
              try {
                current = await stat(lockPath);
              } catch {
                current = null;
              }
              if (
                current &&
                current.dev === ours.dev &&
                current.ino === ours.ino
              ) {
                const encoded = await readFile(lockPath, "utf-8");
                if (encoded.trim() === String(ownerPid)) {
                  await unlink(lockPath);
                }
              }
            } finally {
              if (claimPath) {
                try {
                  await unlink(claimPath);
                } catch {
                  // Claim already gone.
                }
              }
              await handle.close();
            }
          },
        });
        return { lockPath, release };
      }
      lastConflict = opened.failure;
      if (recoverClaimPath) {
        yield* unlinkOptional(recoverClaimPath);
        recoverClaimPath = null;
      }
      if (opened.failure.operation !== "conflict") {
        return yield* opened.failure;
      }
      const recovered = yield* recoverStaleLock();
      // Only the recoverer that claimed the observed dead inode may create.
      // Losers (live lock, lost claim) conflict.
      if (recovered.kind !== "stolen") {
        return yield* storeError("conflict");
      }
      recoverClaimPath = recovered.claimPath;
    }
    if (recoverClaimPath) {
      yield* unlinkOptional(recoverClaimPath);
    }
    return yield* lastConflict;
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

  const clearApproval = Effect.fn("CliIdentity.clearApproval")(function* () {
    yield* unlinkOptional(approvalPath);
  });

  return {
    acquireLock,
    clearApproval,
    createPendingKey,
    loadApproval,
    loadIdentity,
    loadSecret,
    rotatePendingKey,
    saveApproval,
  };
};
