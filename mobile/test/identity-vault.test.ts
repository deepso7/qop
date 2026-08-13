import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY_STORAGE_KEY = "qop.identity.v1";
const INSTALL_MARKER_FILENAME = ".qop-install-v1";
const INSTALL_STORAGE_KEY = "qop.install.v1";

const secureStoreMock = vi.hoisted(() => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  isAvailableAsync: vi.fn(),
  items: new Map<string, string>(),
  setItemAsync: vi.fn(),
}));

const fileSystemMock = vi.hoisted(() => ({
  failRead: false,
  failWrite: false,
  markers: new Set<string>(),
}));

const cryptoMock = vi.hoisted(() => ({
  getRandomBytesAsync: vi.fn(),
  nextByte: 1,
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  deleteItemAsync: secureStoreMock.deleteItemAsync,
  getItemAsync: secureStoreMock.getItemAsync,
  isAvailableAsync: secureStoreMock.isAvailableAsync,
  setItemAsync: secureStoreMock.setItemAsync,
}));

vi.mock("expo-file-system", () => {
  class File {
    readonly name: string;

    constructor(_directory: unknown, name: string) {
      this.name = name;
    }

    get exists() {
      if (fileSystemMock.failRead) {
        throw new Error("marker read failed");
      }
      return fileSystemMock.markers.has(this.name);
    }

    write() {
      if (fileSystemMock.failWrite) {
        throw new Error("marker write failed");
      }
      fileSystemMock.markers.add(this.name);
    }
  }

  return { File, Paths: { document: "document" } };
});

vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: cryptoMock.getRandomBytesAsync,
}));

const deferred = <A>() => Promise.withResolvers<A>();

const loadVault = () => import("@/lib/identity-vault");

beforeEach(() => {
  secureStoreMock.items.clear();
  fileSystemMock.markers.clear();
  fileSystemMock.failRead = false;
  fileSystemMock.failWrite = false;
  cryptoMock.nextByte = 1;

  secureStoreMock.isAvailableAsync.mockReset().mockResolvedValue(true);
  secureStoreMock.getItemAsync
    .mockReset()
    .mockImplementation((key) =>
      Promise.resolve(secureStoreMock.items.get(key) ?? null)
    );
  secureStoreMock.setItemAsync.mockReset().mockImplementation((key, value) => {
    secureStoreMock.items.set(key, value);
    return Promise.resolve();
  });
  secureStoreMock.deleteItemAsync.mockReset().mockImplementation((key) => {
    secureStoreMock.items.delete(key);
    return Promise.resolve();
  });
  cryptoMock.getRandomBytesAsync.mockReset().mockImplementation(() => {
    const bytes = new Uint8Array(32);
    bytes[31] = cryptoMock.nextByte;
    cryptoMock.nextByte += 1;
    return Promise.resolve(bytes);
  });
});

describe("identity vault", () => {
  it("loads an absent vault and establishes install markers", async () => {
    const { loadLocalIdentity } = await loadVault();
    const result = await Effect.runPromise(
      loadLocalIdentity().pipe(Effect.result)
    );

    expect(Result.isSuccess(result) && result.success).toBeNull();
    expect(secureStoreMock.items.get(INSTALL_STORAGE_KEY)).toBe("1");
    expect(fileSystemMock.markers.has(INSTALL_MARKER_FILENAME)).toBe(true);
  });

  it("creates and reloads a verified identity", async () => {
    const {
      createLocalIdentity,
      loadLocalIdentity,
      revealLocalIdentityRecoveryKey,
    } = await loadVault();
    const created = await Effect.runPromise(
      createLocalIdentity("alice").pipe(Effect.result)
    );
    expect(Result.isSuccess(created)).toBe(true);
    if (Result.isSuccess(created)) {
      expect(created.success.encryptionPublicKey).toHaveLength(43);
      expect(created.success).not.toHaveProperty("deviceSecretKey");
      expect(created.success).not.toHaveProperty("encryptionSecretKey");
      expect(created.success).not.toHaveProperty("recoveryKey");
    }

    const loaded = await Effect.runPromise(
      loadLocalIdentity().pipe(Effect.result)
    );
    expect(loaded).toEqual(created);
    const recoveryKey = await Effect.runPromise(
      revealLocalIdentityRecoveryKey()
    );
    expect(recoveryKey).toMatch(/^qop1_/u);
  });

  it("updates public metadata without replacing private key material", async () => {
    const {
      createLocalIdentity,
      loadLocalIdentity,
      updateLocalIdentityBackupState,
      updateLocalIdentityHandle,
    } = await loadVault();
    await Effect.runPromise(createLocalIdentity("alice"));
    const before = JSON.parse(
      secureStoreMock.items.get(IDENTITY_STORAGE_KEY) ?? "{}"
    );

    const updated = await Effect.runPromise(updateLocalIdentityHandle("bob"));
    expect(updated).toMatchObject({ backupState: "pending", handle: "bob" });
    expect(updated).not.toHaveProperty("deviceSecretKey");
    expect(updated).not.toHaveProperty("encryptionSecretKey");
    expect(updated).not.toHaveProperty("recoveryKey");

    const afterHandleChange = JSON.parse(
      secureStoreMock.items.get(IDENTITY_STORAGE_KEY) ?? "{}"
    );
    expect(afterHandleChange).toMatchObject({
      deviceSecretKey: before.deviceSecretKey,
      encryptionSecretKey: before.encryptionSecretKey,
      recoveryKey: before.recoveryKey,
    });

    await Effect.runPromise(updateLocalIdentityBackupState("skipped"));
    await expect(Effect.runPromise(loadLocalIdentity())).resolves.toMatchObject(
      {
        backupState: "skipped",
        handle: "bob",
      }
    );
  });

  it("signs registration intents without exposing the recovery key", async () => {
    const { createLocalIdentity, signLocalRegistrationIntent } =
      await loadVault();
    const identity = await Effect.runPromise(createLocalIdentity("alice"));
    const signature = await Effect.runPromise(
      signLocalRegistrationIntent(
        {
          chainId: "31337",
          verifyingContract: "0x1111111111111111111111111111111111111111",
        },
        {
          deadline: "1700003600",
          deviceCommitment: `0x${"02".repeat(32)}`,
          handle: identity.handle,
          nonce: `0x${"01".repeat(32)}`,
          owner: identity.ownerAddress,
        }
      )
    );

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/u);
  });

  it("refuses to sign a registration for another owner", async () => {
    const { createLocalIdentity, signLocalRegistrationIntent } =
      await loadVault();
    await Effect.runPromise(createLocalIdentity("alice"));
    const result = await Effect.runPromise(
      signLocalRegistrationIntent(
        {
          chainId: "31337",
          verifyingContract: "0x1111111111111111111111111111111111111111",
        },
        {
          deadline: "1700003600",
          deviceCommitment: `0x${"02".repeat(32)}`,
          handle: "alice",
          nonce: `0x${"01".repeat(32)}`,
          owner: "0x0000000000000000000000000000000000000001",
        }
      ).pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe("sign");
  });

  it("rejects invalid handle updates without changing the vault", async () => {
    const { createLocalIdentity, updateLocalIdentityHandle } =
      await loadVault();
    await Effect.runPromise(createLocalIdentity("alice"));
    const before = secureStoreMock.items.get(IDENTITY_STORAGE_KEY);

    const result = await Effect.runPromise(
      updateLocalIdentityHandle("Alice").pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "invalid-handle"
    );
    expect(secureStoreMock.items.get(IDENTITY_STORAGE_KEY)).toBe(before);
  });

  it("rejects malformed, excess, and inconsistent stored data", async () => {
    const { createLocalIdentity, loadLocalIdentity } = await loadVault();
    await Effect.runPromise(createLocalIdentity("alice"));
    const encoded = secureStoreMock.items.get(IDENTITY_STORAGE_KEY);
    expect(encoded).toBeDefined();

    const invalidRecords = [
      "{",
      JSON.stringify({ ...JSON.parse(encoded ?? "{}"), unexpected: true }),
      JSON.stringify({
        ...JSON.parse(encoded ?? "{}"),
        ownerAddress: "0x0000000000000000000000000000000000000000",
      }),
    ];

    const results = await Effect.runPromise(
      Effect.forEach(
        invalidRecords,
        (invalidRecord) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              secureStoreMock.items.set(IDENTITY_STORAGE_KEY, invalidRecord);
            });
            return yield* loadLocalIdentity().pipe(Effect.result);
          }),
        { concurrency: 1 }
      )
    );
    for (const result of results) {
      expect(Result.isFailure(result) && result.failure.operation).toBe(
        "decode"
      );
    }
  });

  it("rejects an existing identity", async () => {
    const { createLocalIdentity } = await loadVault();
    await Effect.runPromise(createLocalIdentity("alice"));
    const result = await Effect.runPromise(
      createLocalIdentity("bob").pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "already-exists"
    );
  });

  it("serializes concurrent creates so only one identity is written", async () => {
    const { createLocalIdentity } = await loadVault();
    const writeStarted = deferred<null>();
    const releaseWrite = deferred<null>();
    let blockedIdentityWrite = false;
    secureStoreMock.setItemAsync.mockImplementation(async (key, value) => {
      if (key === IDENTITY_STORAGE_KEY && !blockedIdentityWrite) {
        blockedIdentityWrite = true;
        writeStarted.resolve(null);
        await releaseWrite.promise;
      }
      secureStoreMock.items.set(key, value);
    });

    const first = Effect.runPromise(
      createLocalIdentity("alice").pipe(Effect.result)
    );
    await writeStarted.promise;
    const second = Effect.runPromise(
      createLocalIdentity("bob").pipe(Effect.result)
    );
    releaseWrite.resolve(null);
    const results = await Promise.all([first, second]);

    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    const failures = results.filter(Result.isFailure);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failure.operation).toBe("already-exists");
    expect(
      secureStoreMock.setItemAsync.mock.calls.filter(
        ([key]) => key === IDENTITY_STORAGE_KEY
      )
    ).toHaveLength(1);
  });

  it("maps availability, read, write, and delete failures", async () => {
    const { createLocalIdentity, deleteLocalIdentity, loadLocalIdentity } =
      await loadVault();

    secureStoreMock.isAvailableAsync.mockResolvedValueOnce(false);
    const unavailable = await Effect.runPromise(
      loadLocalIdentity().pipe(Effect.result)
    );
    expect(Result.isFailure(unavailable) && unavailable.failure.operation).toBe(
      "availability"
    );

    secureStoreMock.getItemAsync.mockImplementationOnce(() =>
      Promise.reject(new Error("read failed"))
    );
    const unreadable = await Effect.runPromise(
      loadLocalIdentity().pipe(Effect.result)
    );
    expect(Result.isFailure(unreadable) && unreadable.failure.operation).toBe(
      "read"
    );

    secureStoreMock.setItemAsync.mockImplementation((key, value) => {
      if (key === IDENTITY_STORAGE_KEY) {
        return Promise.reject(new Error("write failed"));
      }
      secureStoreMock.items.set(key, value);
      return Promise.resolve();
    });
    const unwritable = await Effect.runPromise(
      createLocalIdentity("alice").pipe(Effect.result)
    );
    expect(Result.isFailure(unwritable) && unwritable.failure.operation).toBe(
      "write"
    );

    secureStoreMock.deleteItemAsync.mockRejectedValueOnce(
      new Error("delete failed")
    );
    const undeletable = await Effect.runPromise(
      deleteLocalIdentity().pipe(Effect.result)
    );
    expect(Result.isFailure(undeletable) && undeletable.failure.operation).toBe(
      "delete"
    );
  });

  it("locks a surviving iOS vault after reinstall until reset", async () => {
    const { createLocalIdentity, deleteLocalIdentity, loadLocalIdentity } =
      await loadVault();
    await Effect.runPromise(createLocalIdentity("alice"));
    fileSystemMock.markers.clear();

    const stale = await Effect.runPromise(
      loadLocalIdentity().pipe(Effect.result)
    );
    expect(Result.isFailure(stale) && stale.failure.operation).toBe(
      "stale-install"
    );
    expect(secureStoreMock.items.has(IDENTITY_STORAGE_KEY)).toBe(true);

    await Effect.runPromise(deleteLocalIdentity());
    expect(secureStoreMock.items.has(IDENTITY_STORAGE_KEY)).toBe(false);
    expect(fileSystemMock.markers.has(INSTALL_MARKER_FILENAME)).toBe(true);
  });
});
