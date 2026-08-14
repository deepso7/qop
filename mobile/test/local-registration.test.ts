import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  hashRegisterIntentV1,
} from "@qop/identity";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const REGISTRATION_STORAGE_KEY = "qop.registration.v1";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const DOMAIN = {
  chainId: "31337",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;
let preparedIntent = {
  deadline: "1700003600",
  deviceCommitment: `0x${"22".repeat(32)}`,
  handle: "alice",
  nonce: `0x${"33".repeat(32)}`,
  owner: OWNER,
};

const secureStoreMock = vi.hoisted(() => ({
  items: new Map<string, string>(),
}));
const cryptoMock = vi.hoisted(() => ({ nextByte: 1 }));
const vaultMock = vi.hoisted(() => ({
  loadLocalIdentity: vi.fn(),
  signLocalRegistrationIntent: vi.fn(),
}));
const clientMock = vi.hoisted(() => ({
  authorizeRegistration: vi.fn(),
  prepareRegistration: vi.fn(),
  reconcileRegistration: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  deleteItemAsync: (key: string) => {
    secureStoreMock.items.delete(key);
    return Promise.resolve();
  },
  getItemAsync: (key: string) =>
    Promise.resolve(secureStoreMock.items.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStoreMock.items.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: () => {
    const bytes = new Uint8Array(32);
    bytes[31] = cryptoMock.nextByte;
    cryptoMock.nextByte += 1;
    return Promise.resolve(bytes);
  },
}));

vi.mock("@/lib/identity-vault", () => vaultMock);
vi.mock("@/lib/registration-client", () => clientMock);

beforeEach(() => {
  secureStoreMock.items.clear();
  cryptoMock.nextByte = 1;
  vaultMock.loadLocalIdentity.mockReset().mockReturnValue(
    Effect.succeed({
      backupState: "copied",
      encryptionPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      handle: "alice",
      ownerAddress: OWNER,
      peerId: PEER_ID,
      version: 1,
    })
  );
  vaultMock.signLocalRegistrationIntent
    .mockReset()
    .mockReturnValue(Effect.succeed(`0x${"55".repeat(65)}`));
  clientMock.prepareRegistration.mockReset().mockImplementation((input) =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(DOMAIN);
      preparedIntent = {
        deadline: "1700003600",
        deviceCommitment: input.deviceCommitment,
        handle: input.handle,
        nonce: `0x${"33".repeat(32)}`,
        owner: input.owner,
      };
      const intent = yield* decodeRegisterIntentV1(preparedIntent);
      return {
        digest: yield* hashRegisterIntentV1(domain, intent),
        domain: DOMAIN,
        intent: preparedIntent,
        status: "pending_owner_signature" as const,
      };
    })
  );
  clientMock.authorizeRegistration.mockReset().mockImplementation((digest) =>
    Effect.succeed({
      digest,
      intent: preparedIntent,
      ownerSignature: `0x${"55".repeat(65)}`,
      registrationSignature: `0x${"66".repeat(65)}`,
      status: "submitted" as const,
    })
  );
  clientMock.reconcileRegistration.mockReset().mockImplementation((digest) =>
    Effect.succeed({
      digest,
      failureCode: null,
      qid: "42",
      status: "confirmed" as const,
    })
  );
});

describe("local registration", () => {
  it("persists retry material and submits an owner-authorized intent", async () => {
    const { startLocalRegistration } = await import("@/lib/local-registration");
    const result = await Effect.runPromise(startLocalRegistration("ABC-123"));

    expect(result).toMatchObject({ qid: null, status: "submitted" });
    expect(result).not.toHaveProperty("admissionCode");
    expect(result).not.toHaveProperty("observeToken");
    expect(vaultMock.signLocalRegistrationIntent).toHaveBeenCalledWith(
      DOMAIN,
      expect.objectContaining({ handle: "alice", owner: OWNER })
    );
    const stored = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );
    expect(stored).toMatchObject({
      admissionCode: null,
      ownerAddress: OWNER,
      peerId: PEER_ID,
      status: "submitted",
    });
    expect(stored.idempotencyKey).toHaveLength(43);
    expect(stored.observeToken).toHaveLength(43);
  });

  it("reconciles the submitted transaction to a qid", async () => {
    const { reconcileLocalRegistration, startLocalRegistration } =
      await import("@/lib/local-registration");
    await Effect.runPromise(startLocalRegistration("ABC-123"));
    const result = await Effect.runPromise(reconcileLocalRegistration());

    expect(result).toMatchObject({ qid: "42", status: "confirmed" });
  });

  it("retries authorization without preparing a second intent", async () => {
    clientMock.authorizeRegistration.mockReturnValueOnce(
      Effect.fail(new Error("offline"))
    );
    const { startLocalRegistration } = await import("@/lib/local-registration");
    const first = await Effect.runPromise(
      startLocalRegistration("ABC-123").pipe(Effect.result)
    );
    const second = await Effect.runPromise(startLocalRegistration("abc123"));

    expect(first._tag).toBe("Failure");
    expect(second.status).toBe("submitted");
    expect(clientMock.prepareRegistration).toHaveBeenCalledOnce();
    expect(clientMock.authorizeRegistration).toHaveBeenCalledTimes(2);
  });

  it("retries a draft after preparation fails", async () => {
    clientMock.prepareRegistration.mockReturnValueOnce(
      Effect.fail(new Error("offline"))
    );
    const { startLocalRegistration } = await import("@/lib/local-registration");
    const first = await Effect.runPromise(
      startLocalRegistration("ABC-123").pipe(Effect.result)
    );
    const stored = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );
    const second = await Effect.runPromise(startLocalRegistration("abc123"));

    expect(first._tag).toBe("Failure");
    expect(stored.status).toBe("draft");
    expect(second.status).toBe("submitted");
    expect(clientMock.prepareRegistration).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh draft after a terminal registration", async () => {
    const { startLocalRegistration } = await import("@/lib/local-registration");
    await Effect.runPromise(startLocalRegistration("ABC-123"));
    const stored = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );
    secureStoreMock.items.set(
      REGISTRATION_STORAGE_KEY,
      JSON.stringify({ ...stored, status: "failed" })
    );

    const result = await Effect.runPromise(startLocalRegistration("XYZ-789"));

    expect(result.status).toBe("submitted");
    expect(clientMock.prepareRegistration).toHaveBeenCalledTimes(2);
    const restarted = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );
    expect(restarted.idempotencyKey).not.toBe(stored.idempotencyKey);
  });

  it("replaces a failed restart draft when given another invitation", async () => {
    const { startLocalRegistration } = await import("@/lib/local-registration");
    await Effect.runPromise(startLocalRegistration("ABC-123"));
    const registered = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );
    secureStoreMock.items.set(
      REGISTRATION_STORAGE_KEY,
      JSON.stringify({ ...registered, status: "failed" })
    );
    clientMock.prepareRegistration.mockReturnValueOnce(
      Effect.fail(new Error("offline"))
    );

    await Effect.runPromise(
      startLocalRegistration("XYZ-789").pipe(Effect.result)
    );
    const failedDraft = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );
    const result = await Effect.runPromise(startLocalRegistration("QOP-456"));
    const replacement = JSON.parse(
      secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}"
    );

    expect(failedDraft.status).toBe("draft");
    expect(result.status).toBe("submitted");
    expect(replacement.idempotencyKey).not.toBe(failedDraft.idempotencyKey);
    expect(clientMock.prepareRegistration).toHaveBeenCalledTimes(3);
  });
});
