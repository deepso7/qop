import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIdentityStore } from "@/lib/identity-store-core";
import { IdentityVaultError } from "@/lib/identity-vault-core";

const vaultMock = {
  createLocalIdentity: vi.fn(),
  deleteLocalIdentity: vi.fn(),
  loadLocalIdentity: vi.fn(),
  revealLocalIdentityRecoveryKey: vi.fn(),
  updateLocalIdentityBackupState: vi.fn(),
};
const registrationMock = {
  deleteLocalRegistration: vi.fn(),
  loadLocalRegistration: vi.fn(),
};
const deleteAllData = vi.fn();

const identity = {
  backupState: "pending",
  deviceKey: `0x${"22".repeat(32)}`,
  handle: "alice",
  ownerAddress: "0x0000000000000000000000000000000000000001",
  peerId: "peer-id",
  version: 2,
};

const confirmedRegistration = {
  deadline: "1700001800",
  digest: `0x${"11".repeat(32)}`,
  failureCode: null,
  handle: "alice",
  nonce: `0x${"33".repeat(32)}`,
  ownerAddress: identity.ownerAddress,
  qid: "1",
  status: "confirmed" as const,
  version: 2 as const,
};

const deferred = <A>() => Promise.withResolvers<A>();

const loadStore = () =>
  createIdentityStore({
    deleteAllData,
    identityVault: vaultMock,
    makeIdentityVaultError: (operation) =>
      new IdentityVaultError({ operation }),
    registration: registrationMock,
  });

beforeEach(() => {
  deleteAllData.mockReset().mockImplementation(() => Promise.resolve());
  registrationMock.deleteLocalRegistration
    .mockReset()
    .mockReturnValue(Effect.void);
  registrationMock.loadLocalRegistration
    .mockReset()
    .mockReturnValue(Effect.succeed(confirmedRegistration));
  vaultMock.createLocalIdentity.mockReset();
  vaultMock.deleteLocalIdentity.mockReset().mockReturnValue(Effect.void);
  vaultMock.loadLocalIdentity.mockReset().mockReturnValue(Effect.succeed(null));
  vaultMock.revealLocalIdentityRecoveryKey
    .mockReset()
    .mockReturnValue(Effect.succeed("recovery-key"));
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
    registrationMock.loadLocalRegistration.mockReturnValue(
      Effect.succeed(null)
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
      status: "unregistered",
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
    expect(deleteAllData).toHaveBeenCalledOnce();
    expect(vaultMock.deleteLocalIdentity).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      identity: null,
      status: "absent",
    });
  });

  it("marks a backed-up identity unregistered until registration is confirmed", async () => {
    const backedUpIdentity = { ...identity, backupState: "copied" };
    vaultMock.loadLocalIdentity.mockReturnValue(
      Effect.succeed(backedUpIdentity)
    );
    registrationMock.loadLocalRegistration.mockReturnValue(
      Effect.succeed(null)
    );
    const store = await loadStore();
    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({
      identity: backedUpIdentity,
      registration: null,
      status: "unregistered",
    });
  });

  it("hydrates a confirmed registration into ready state", async () => {
    const backedUpIdentity = { ...identity, backupState: "copied" as const };
    vaultMock.loadLocalIdentity.mockReturnValue(
      Effect.succeed(backedUpIdentity)
    );
    const store = await loadStore();

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({
      identity: backedUpIdentity,
      registration: confirmedRegistration,
      status: "ready",
    });
  });

  it("maps a registration read failure to a vault read error", async () => {
    const backedUpIdentity = { ...identity, backupState: "copied" as const };
    vaultMock.loadLocalIdentity.mockReturnValue(
      Effect.succeed(backedUpIdentity)
    );
    registrationMock.loadLocalRegistration.mockReturnValue(
      Effect.fail({ operation: "read" })
    );
    const store = await loadStore();

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({
      error: { _tag: "IdentityVaultError", operation: "read" },
      identity: backedUpIdentity,
      isHydrating: false,
      registration: null,
      status: "error",
    });
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
