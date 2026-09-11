import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  hashRegisterIntentV1,
} from "@qop/identity";
import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalRegistration } from "@/lib/local-registration-core";
import { RegistrationClientError } from "@/lib/registration-client-core";

const REGISTRATION_STORAGE_KEY = "qop.registration.v2";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const OTHER_OWNER = "0x0000000000000000000000000000000000000002";
const DEVICE_KEY = `0x${"22".repeat(32)}`;
const OTHER_DEVICE_KEY = `0x${"23".repeat(32)}`;
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
  devices: [{ deviceKey: DEVICE_KEY, peerId: PEER_ID }],
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
  it("persists before POST and reuses the request after a lost response and restart", async () => {
    clientMock.register.mockImplementationOnce(() =>
      Effect.sync(() => {
        expect(secureStoreMock.items.has(REGISTRATION_STORAGE_KEY)).toBe(true);
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new RegistrationClientError({
              kind: null,
              operation: "network",
              status: null,
              tag: null,
            })
          )
        )
      )
    );
    const first = await Effect.runPromise(
      loadRegistration().startLocalRegistration("ABC-123")
    );
    expect(first.status).toBe("pending");
    const retry = await Effect.runPromise(
      loadRegistration().startLocalRegistration("ABC-123")
    );
    expect(retry.digest).toBe(first.digest);
    expect(retry.nonce).toBe(first.nonce);
    expect(retry.status).toBe("submitted");
    expect(clientMock.register.mock.calls[1]).toEqual(
      clientMock.register.mock.calls[0]
    );
  });

  it("confirms a lost POST response directly from the chain after restart", async () => {
    clientMock.register.mockReturnValueOnce(
      Effect.fail(
        new RegistrationClientError({
          kind: null,
          operation: "network",
          status: null,
          tag: null,
        })
      )
    );
    const pending = await Effect.runPromise(
      loadRegistration().startLocalRegistration("ABC-123")
    );
    registryMock.lookupOwner.mockReturnValue(Effect.succeed(account()));
    const confirmed = await Effect.runPromise(
      loadRegistration().checkLocalRegistration()
    );
    expect(confirmed).toMatchObject({
      digest: pending.digest,
      qid: "42",
      status: "confirmed",
    });
    expect(clientMock.register).toHaveBeenCalledOnce();
  });

  it("releases a pending request after its deadline when the API never received it", async () => {
    clientMock.register.mockReturnValueOnce(
      Effect.fail(
        new RegistrationClientError({
          kind: null,
          operation: "network",
          status: null,
          tag: null,
        })
      )
    );
    await Effect.runPromise(
      loadRegistration().startLocalRegistration("ABC-123")
    );
    now += 1801n;
    clientMock.getRegistration.mockReturnValueOnce(
      Effect.fail(
        new RegistrationClientError({
          kind: null,
          operation: "response",
          status: 404,
          tag: "RegistrationIntentNotFound",
        })
      )
    );
    expect(
      await Effect.runPromise(loadRegistration().checkLocalRegistration())
    ).toMatchObject({
      failureCode: "REGISTRATION_NOT_FOUND",
      status: "failed",
    });
  });

  it.each([0n, 1n])(
    "reconciles an expired pending retry at deadline + %s without resubmitting",
    async (elapsed) => {
      clientMock.register.mockReturnValueOnce(
        Effect.fail(
          new RegistrationClientError({
            kind: null,
            operation: "network",
            status: null,
            tag: null,
          })
        )
      );
      const pending = await Effect.runPromise(
        loadRegistration().startLocalRegistration("ABC-123")
      );
      now = BigInt(pending.deadline) + elapsed;
      clientMock.getRegistration.mockReturnValueOnce(
        Effect.succeed({
          digest: pending.digest,
          failureCode: null,
          qid: null,
          status: "submitted" as const,
          transactionHash: `0x${"77".repeat(32)}`,
        })
      );

      const retry = await Effect.runPromise(
        loadRegistration().startLocalRegistration("ABC-123")
      );

      expect(retry).toMatchObject({
        digest: pending.digest,
        nonce: pending.nonce,
        status: "submitted",
      });
      expect(clientMock.getRegistration).toHaveBeenCalledExactlyOnceWith(
        pending.digest
      );
      expect(clientMock.register).toHaveBeenCalledOnce();
      expect(vaultMock.signRegisterIntent).toHaveBeenCalledOnce();
    }
  );

  it("retains the pending request when expired retry reconciliation is unavailable", async () => {
    const unavailable = new RegistrationClientError({
      kind: null,
      operation: "network",
      status: null,
      tag: null,
    });
    clientMock.register.mockReturnValueOnce(Effect.fail(unavailable));
    const registration = loadRegistration();
    const pending = await Effect.runPromise(
      registration.startLocalRegistration("ABC-123")
    );
    now = BigInt(pending.deadline);
    clientMock.getRegistration.mockReturnValueOnce(Effect.fail(unavailable));

    const retry = await Effect.runPromise(
      registration.startLocalRegistration("ABC-123").pipe(Effect.result)
    );

    expect(Result.isFailure(retry) && retry.failure.operation).toBe("network");
    expect(
      await Effect.runPromise(registration.loadLocalRegistration())
    ).toEqual(pending);
    expect(clientMock.register).toHaveBeenCalledOnce();
  });

  it("allows a fresh request after an expired pending retry reconciles as missing", async () => {
    clientMock.register.mockReturnValueOnce(
      Effect.fail(
        new RegistrationClientError({
          kind: null,
          operation: "network",
          status: null,
          tag: null,
        })
      )
    );
    const registration = loadRegistration();
    const pending = await Effect.runPromise(
      registration.startLocalRegistration("ABC-123")
    );
    now = BigInt(pending.deadline);
    clientMock.getRegistration.mockReturnValueOnce(
      Effect.fail(
        new RegistrationClientError({
          kind: null,
          operation: "response",
          status: 404,
          tag: "RegistrationIntentNotFound",
        })
      )
    );

    const failed = await Effect.runPromise(
      registration.startLocalRegistration("ABC-123")
    );
    expect(failed).toMatchObject({
      digest: pending.digest,
      failureCode: "REGISTRATION_NOT_FOUND",
      status: "failed",
    });
    expect(clientMock.register).toHaveBeenCalledOnce();

    const retry = await Effect.runPromise(
      registration.startLocalRegistration("ABC-123")
    );
    expect(retry.status).toBe("submitted");
    expect(retry.nonce).not.toBe(pending.nonce);
    expect(clientMock.register).toHaveBeenCalledTimes(2);
  });

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
    expect(secureStoreMock.items.has(REGISTRATION_STORAGE_KEY)).toBe(true);
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

  it("fails when the owner's account has another device key", async () => {
    const { checkLocalRegistration, startLocalRegistration } =
      loadRegistration();
    await Effect.runPromise(startLocalRegistration("ABC-123"));
    registryMock.lookupOwner.mockReturnValue(
      Effect.succeed({
        ...account(),
        deviceKey: OTHER_DEVICE_KEY,
        devices: [{ deviceKey: OTHER_DEVICE_KEY, peerId: PEER_ID }],
      })
    );

    const result = await Effect.runPromise(checkLocalRegistration());

    expect(result).toMatchObject({
      failureCode: "DEVICE_KEY_MISMATCH",
      status: "failed",
    });
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

  it("consults the API at the deadline, but not before", async () => {
    const { checkLocalRegistration, startLocalRegistration } =
      loadRegistration();
    const submitted = await Effect.runPromise(
      startLocalRegistration("ABC-123")
    );
    clientMock.getRegistration.mockReturnValue(
      Effect.succeed({
        digest: submitted.digest,
        failureCode: null,
        qid: null,
        status: "submitted" as const,
        transactionHash: `0x${"77".repeat(32)}`,
      })
    );

    now = BigInt(submitted.deadline) - 1n;
    await Effect.runPromise(checkLocalRegistration());
    expect(clientMock.getRegistration).not.toHaveBeenCalled();

    now = BigInt(submitted.deadline);
    const result = await Effect.runPromise(checkLocalRegistration());

    expect(clientMock.getRegistration).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      failureCode: null,
      status: "submitted",
    });
  });

  it("rejects a post-deadline response for another digest", async () => {
    const { checkLocalRegistration, startLocalRegistration } =
      loadRegistration();
    const submitted = await Effect.runPromise(
      startLocalRegistration("ABC-123")
    );
    now = 1_700_001_801n;
    clientMock.getRegistration.mockReturnValueOnce(
      Effect.succeed({
        digest: `0x${"99".repeat(32)}`,
        failureCode: null,
        qid: null,
        status: "submitted" as const,
        transactionHash: null,
      })
    );

    const result = await Effect.runPromise(
      checkLocalRegistration().pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe("verify");
    expect(
      JSON.parse(secureStoreMock.items.get(REGISTRATION_STORAGE_KEY) ?? "{}")
    ).toEqual(submitted);
  });
});
