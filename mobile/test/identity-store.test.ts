import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultMock = vi.hoisted(() => ({
  createLocalIdentity: vi.fn(),
  deleteLocalIdentity: vi.fn(),
  finishLocalIdentityOnboarding: vi.fn(),
  loadLocalIdentity: vi.fn(),
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

const identity = {
  backupState: "pending",
  deviceSecretKey: "device-secret",
  encryptionSecretKey: "encryption-secret",
  handle: "alice",
  ownerAddress: "0x0000000000000000000000000000000000000001",
  peerId: "peer-id",
  recoveryKey: "recovery-key",
  version: 1,
};

const deferred = <A>() => Promise.withResolvers<A>();

const loadStore = async () => {
  vi.resetModules();
  const identityStore = await import("@/lib/identity-store");
  return identityStore.useIdentityStore;
};

beforeEach(() => {
  vaultMock.createLocalIdentity.mockReset();
  vaultMock.deleteLocalIdentity.mockReset().mockReturnValue(Effect.void);
  vaultMock.finishLocalIdentityOnboarding.mockReset();
  vaultMock.loadLocalIdentity.mockReset().mockReturnValue(Effect.succeed(null));
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
    const result = await store.getState().finishOnboarding("skipped");

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "missing-identity"
    );
    expect(vaultMock.finishLocalIdentityOnboarding).not.toHaveBeenCalled();
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
