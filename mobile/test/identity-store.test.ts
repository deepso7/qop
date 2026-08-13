import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMock = vi.hoisted(() => ({
  createLocalIdentity: vi.fn(),
  deleteLocalIdentity: vi.fn(),
  loadLocalIdentity: vi.fn(),
  revealLocalIdentityRecoveryKey: vi.fn(),
  updateLocalIdentityBackupState: vi.fn(),
  updateLocalIdentityHandle: vi.fn(),
}));
const registrationMock = vi.hoisted(() => ({
  deleteLocalRegistration: vi.fn(),
}));

vi.mock("@/lib/identity-vault", () => {
  class IdentityVaultError extends Error {
    readonly _tag = "IdentityVaultError";
    readonly operation: string;

    constructor({ operation }: { operation: string }) {
      super(operation);
      this.name = "IdentityVaultError";
      this.operation = operation;
    }
  }

  return { IdentityVaultError, ...vaultMock };
});

vi.mock("@/lib/local-registration", () => registrationMock);

const identity = {
  backupState: "pending",
  encryptionPublicKey: "encryption-public",
  handle: "alice",
  ownerAddress: "0x0000000000000000000000000000000000000001",
  peerId: "peer-id",
  version: 1,
};

const deferred = <A>() => Promise.withResolvers<A>();

const loadStore = async () => {
  vi.resetModules();
  const identityStore = await import("@/lib/identity-store");
  return identityStore.useIdentityStore;
};

beforeEach(() => {
  registrationMock.deleteLocalRegistration
    .mockReset()
    .mockReturnValue(Effect.void);
  vaultMock.createLocalIdentity.mockReset();
  vaultMock.deleteLocalIdentity.mockReset().mockReturnValue(Effect.void);
  vaultMock.loadLocalIdentity.mockReset().mockReturnValue(Effect.succeed(null));
  vaultMock.revealLocalIdentityRecoveryKey
    .mockReset()
    .mockReturnValue(Effect.succeed("recovery-key"));
  vaultMock.updateLocalIdentityHandle.mockReset();
  vaultMock.updateLocalIdentityBackupState.mockReset();
});

describe("identity store", () => {
  it("fences a stale hydrate after identity creation", async () => {
    const hydration = deferred<null>();
    vaultMock.loadLocalIdentity.mockReturnValue(
      Effect.promise(() => hydration.promise)
    );
    vaultMock.createLocalIdentity.mockReturnValue(Effect.succeed(identity));
    const store = await loadStore();

    const hydrate = store.getState().hydrate();
    const create = store.getState().createIdentity("alice");
    hydration.resolve(null);
    await Promise.all([hydrate, create]);

    expect(store.getState()).toMatchObject({
      identity,
      status: "backup",
    });
  });

  it("shares duplicate create calls and invokes the vault once", async () => {
    const creation = deferred<typeof identity>();
    vaultMock.createLocalIdentity.mockReturnValue(
      Effect.promise(() => creation.promise)
    );
    const store = await loadStore();

    const first = store.getState().createIdentity("alice");
    const second = store.getState().createIdentity("alice");
    expect(second).toBe(first);
    creation.resolve(identity);
    const result = await first;

    expect(Result.isSuccess(result)).toBe(true);
    expect(vaultMock.createLocalIdentity).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ identity, status: "backup" });
  });

  it("returns a typed failure when there is no identity to finish", async () => {
    const store = await loadStore();
    const result = await store.getState().setBackupState("skipped");

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "missing-identity"
    );
    expect(vaultMock.updateLocalIdentityBackupState).not.toHaveBeenCalled();
  });

  it("persists a later recovery backup and keeps only public identity state", async () => {
    const skippedIdentity = { ...identity, backupState: "skipped" };
    const backedUpIdentity = { ...identity, backupState: "copied" };
    vaultMock.loadLocalIdentity.mockReturnValue(
      Effect.succeed(skippedIdentity)
    );
    vaultMock.updateLocalIdentityBackupState.mockReturnValue(
      Effect.succeed(backedUpIdentity)
    );
    const store = await loadStore();
    await store.getState().hydrate();

    const result = await store.getState().setBackupState("copied");

    expect(Result.isSuccess(result)).toBe(true);
    expect(store.getState()).toMatchObject({
      identity: backedUpIdentity,
      status: "ready",
    });
    expect(store.getState().identity).not.toHaveProperty("recoveryKey");
  });

  it("reveals recovery material without retaining it in store state", async () => {
    const store = await loadStore();
    const result = await store.getState().revealRecoveryKey();

    expect(Result.isSuccess(result) && result.success).toBe("recovery-key");
    expect(store.getState()).not.toHaveProperty("recoveryKey");
    expect(store.getState().identity).toBeNull();
  });

  it("deletes registration retry material with the identity", async () => {
    vaultMock.loadLocalIdentity.mockReturnValue(Effect.succeed(identity));
    const store = await loadStore();
    await store.getState().hydrate();

    const result = await store.getState().resetIdentity();

    expect(Result.isSuccess(result)).toBe(true);
    expect(registrationMock.deleteLocalRegistration).toHaveBeenCalledOnce();
    expect(vaultMock.deleteLocalIdentity).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      identity: null,
      status: "absent",
    });
  });

  it("updates the registration handle without replacing identity keys", async () => {
    const updated = { ...identity, handle: "bob" };
    vaultMock.loadLocalIdentity.mockReturnValue(Effect.succeed(identity));
    vaultMock.updateLocalIdentityHandle.mockReturnValue(
      Effect.succeed(updated)
    );
    const store = await loadStore();
    await store.getState().hydrate();

    const result = await store.getState().updateHandle("bob");

    expect(Result.isSuccess(result)).toBe(true);
    expect(vaultMock.updateLocalIdentityHandle).toHaveBeenCalledWith("bob");
    expect(store.getState().identity).toEqual(updated);
  });

  it("keeps the error tree mounted while retrying hydration", async () => {
    const retry = deferred<null>();
    const store = await loadStore();
    vaultMock.loadLocalIdentity.mockReturnValueOnce(
      Effect.fail({ operation: "read" })
    );
    await store.getState().hydrate();
    vaultMock.loadLocalIdentity.mockReturnValueOnce(
      Effect.promise(() => retry.promise)
    );

    store.getState().retryLoad();
    expect(store.getState()).toMatchObject({
      isHydrating: true,
      status: "error",
    });
    retry.resolve(null);
    await vi.waitFor(() => expect(store.getState().status).toBe("absent"));
  });
});
