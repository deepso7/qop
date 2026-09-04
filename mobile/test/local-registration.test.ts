import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  hashRegisterIntentV1,
} from "@qop/identity";
import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalRegistration } from "@/lib/local-registration-core";

const REGISTRATION_STORAGE_KEY = "qop.registration.v2";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const OTHER_OWNER = "0x0000000000000000000000000000000000000002";
const DEVICE_KEY = `0x${"22".repeat(32)}`;
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const DOMAIN = {
  chainId: "31337",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

const secureStoreMock = { items: new Map<string, string>() };
const vaultMock = {
  loadLocalIdentity: vi.fn(),
  signRegisterIntent: vi.fn(),
};
const clientMock = {
  getRegistration: vi.fn(),
  register: vi.fn(),
};
const registryMock = {
  lookupHandle: vi.fn(),
  lookupOwner: vi.fn(),
};
let now = 1_700_000_000n;
let nextNonce = 1;

const account = (owner = OWNER, handle = "alice") => ({
  deviceKey: DEVICE_KEY,
  handle,
  owner,
  ownerVersion: 1,
  peerId: PEER_ID,
  qid: 42n,
  registeredAt: 1_700_000_100n,
});

const loadRegistration = () =>
  createLocalRegistration({
    domain: DOMAIN,
    now: () => now,
    randomBytes: () => {
      const bytes = new Uint8Array(32);
      bytes[31] = nextNonce;
      nextNonce += 1;
      return Promise.resolve(bytes);
    },
    registrationClient: clientMock,
    registry: registryMock,
    secureStore: {
      delete: (key) => {
        secureStoreMock.items.delete(key);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(secureStoreMock.items.get(key) ?? null),
      set: (key, value) => {
        secureStoreMock.items.set(key, value);
        return Promise.resolve();
      },
    },
    vault: vaultMock,
  });

beforeEach(() => {
  secureStoreMock.items.clear();
  now = 1_700_000_000n;
  nextNonce = 1;
  vaultMock.loadLocalIdentity.mockReset().mockReturnValue(
    Effect.succeed({
      backupState: "copied",
      deviceKey: DEVICE_KEY,
      handle: "alice",
      ownerAddress: OWNER,
      peerId: PEER_ID,
      version: 2,
    })
  );
  vaultMock.signRegisterIntent
    .mockReset()
    .mockReturnValue(Effect.succeed(`0x${"55".repeat(65)}`));
  clientMock.register.mockReset().mockImplementation(({ intent }) =>
    Effect.gen(function* () {
      const domain = yield* decodeIdentityEip712DomainV1(DOMAIN);
      const decodedIntent = yield* decodeRegisterIntentV1(intent);
      return {
        digest: yield* hashRegisterIntentV1(domain, decodedIntent),
        registrationSignature: `0x${"66".repeat(65)}`,
        status: "submitted" as const,
        transactionHash: `0x${"77".repeat(32)}`,
      };
    })
  );
  clientMock.getRegistration.mockReset().mockReturnValue(
    Effect.succeed({
      digest: `0x${"11".repeat(32)}`,
      failureCode: null,
      qid: null,
      status: "submitted" as const,
      transactionHash: `0x${"77".repeat(32)}`,
    })
  );
  registryMock.lookupOwner.mockReset().mockReturnValue(Effect.succeed(null));
  registryMock.lookupHandle.mockReset().mockReturnValue(Effect.succeed(null));
});

describe("local registration", () => {
  it("stores submitted state with the locally computed digest", async () => {
    const { startLocalRegistration } = loadRegistration();
    const result = await Effect.runPromise(startLocalRegistration("abc123"));
    const signedIntent = vaultMock.signRegisterIntent.mock.calls[0]?.[1];
    const domain = await Effect.runPromise(
      decodeIdentityEip712DomainV1(DOMAIN)
    );
    const decodedIntent = await Effect.runPromise(
      decodeRegisterIntentV1(signedIntent)
    );
    const expectedDigest = await Effect.runPromise(
      hashRegisterIntentV1(domain, decodedIntent)
    );

    expect(result).toMatchObject({
      deadline: "1700001800",
      digest: expectedDigest,
      failureCode: null,
      handle: "alice",
      ownerAddress: OWNER,
      qid: null,
      status: "submitted",
      version: 2,
    });
    expect(
      JSON.parse(secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}")
    ).toEqual(result);
  });

  it("returns an existing submitted registration without another request", async () => {
    const { startLocalRegistration } = loadRegistration();
    const first = await Effect.runPromise(startLocalRegistration("ABC-123"));

    const second = await Effect.runPromise(startLocalRegistration("XYZ-789"));

    expect(second).toEqual(first);
    expect(clientMock.register).toHaveBeenCalledOnce();
  });

  it("treats v1 registration state as absent", async () => {
    secureStoreMock.items.set("qop.registration.v1", "{}");
    const { loadLocalRegistration } = loadRegistration();

    await expect(
      Effect.runPromise(loadLocalRegistration())
    ).resolves.toBeNull();
  });

  it("fails verification when the server returns another digest", async () => {
    clientMock.register.mockReturnValueOnce(
      Effect.succeed({
        digest: `0x${"99".repeat(32)}`,
        registrationSignature: `0x${"66".repeat(65)}`,
        status: "submitted" as const,
        transactionHash: `0x${"77".repeat(32)}`,
      })
    );
    const { startLocalRegistration } = loadRegistration();

    const result = await Effect.runPromise(
      startLocalRegistration("ABC-123").pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe("verify");
    expect(secureStoreMock.items.has(REGISTRATION_STORAGE_KEY)).toBe(false);
  });

  it("confirms from the owner lookup on chain", async () => {
    const { checkLocalRegistration, startLocalRegistration } =
      loadRegistration();
    await Effect.runPromise(startLocalRegistration("ABC-123"));
    registryMock.lookupOwner.mockReturnValue(Effect.succeed(account()));

    const result = await Effect.runPromise(checkLocalRegistration());

    expect(result).toMatchObject({ qid: "42", status: "confirmed" });
    expect(registryMock.lookupHandle).not.toHaveBeenCalled();
    expect(clientMock.getRegistration).not.toHaveBeenCalled();
  });

  it("fails when the handle belongs to another owner", async () => {
    const { checkLocalRegistration, startLocalRegistration } =
      loadRegistration();
    await Effect.runPromise(startLocalRegistration("ABC-123"));
    registryMock.lookupHandle.mockReturnValue(
      Effect.succeed(account(OTHER_OWNER))
    );

    const result = await Effect.runPromise(checkLocalRegistration());

    expect(result).toMatchObject({
      failureCode: "HANDLE_TAKEN",
      status: "failed",
    });
    expect(clientMock.getRegistration).not.toHaveBeenCalled();
  });

  it("consults the API only after the deadline", async () => {
    const { checkLocalRegistration, startLocalRegistration } =
      loadRegistration();
    await Effect.runPromise(startLocalRegistration("ABC-123"));

    await Effect.runPromise(checkLocalRegistration());
    expect(clientMock.getRegistration).not.toHaveBeenCalled();

    now = 1_700_001_801n;
    const result = await Effect.runPromise(checkLocalRegistration());

    expect(clientMock.getRegistration).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      failureCode: "DEADLINE_PASSED",
      status: "failed",
    });
  });
});
