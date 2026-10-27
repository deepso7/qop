import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  EcdsaSignature,
  recoverAddDeviceIntentSignerV1,
} from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceActionClientError } from "@/lib/device-action-client-core";
import { createIdentityVault } from "@/lib/identity-vault-core";
import type { LocalIdentity } from "@/lib/identity-vault-core";
import {
  createLocalEnrollment,
  MAX_DEVICES,
} from "@/lib/local-enrollment-core";

const ENROLLMENT_STORAGE_KEY =
  "qop.enrollment.v1.31337.0x1111111111111111111111111111111111111111";

const DOMAIN = {
  chainId: "31337",
  verifyingContract: "0x1111111111111111111111111111111111111111",
} as const;

const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const OTHER_DEVICE_KEY = `0x${"23".repeat(32)}`;
const OTHER_OWNER = `0x${"02".repeat(20)}`;

const secureStoreMock = { items: new Map<string, string>() };

const clientMock = {
  get: vi.fn(),
  submit: vi.fn(),
};

const registryMock = {
  lookupOwner: vi.fn(),
};

let now = 1_700_000_000n;
let nextByte = 1;

// A vault with its own in-memory storage, i.e. its own phone.
const makeVault = () => {
  const items = new Map<string, string>();
  let marker = false;

  return createIdentityVault({
    makeInstallMarker: () => ({
      get exists() {
        return marker;
      },
      writeSync: () => {
        marker = true;
      },
    }),
    randomBytes: () => {
      const bytes = new Uint8Array(32);
      bytes[31] = nextByte;
      nextByte += 1;

      return Promise.resolve(bytes);
    },
    secureStore: {
      delete: (key) => {
        items.delete(key);

        return Promise.resolve();
      },
      get: (key) => Promise.resolve(items.get(key) ?? null),
      isAvailable: () => Promise.resolve(true),
      set: (key, value) => {
        items.set(key, value);

        return Promise.resolve();
      },
    },
  });
};

let recoveryKey: string;
let vault: ReturnType<typeof createIdentityVault>;
let identity: LocalIdentity;

const account = ({
  deviceKeys = [OTHER_DEVICE_KEY],
  handle = "alice",
  nonce = 7n,
  owner = identity.ownerAddress,
} = {}) => ({
  blockNumber: 1n,
  deviceKey: deviceKeys[0] ?? null,
  devices: deviceKeys.map((deviceKey) => ({ deviceKey, peerId: PEER_ID })),
  freshness: "fresh",
  handle,
  nonce,
  owner,
  ownerVersion: 1,
  peerId: PEER_ID,
  qid: 42n,
  registeredAt: 1_700_000_100n,
});

const loadEnrollment = () =>
  createLocalEnrollment({
    deviceActionClient: clientMock,
    domain: DOMAIN,
    // Chain time, which deadlines are measured against.
    registry: { ...registryMock, latestTimestamp: () => Effect.succeed(now) },
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
    vault,
  });

const clientError = (status: number | null) =>
  Effect.fail(new DeviceActionClientError({ kind: null, status }));

const stored = () =>
  JSON.parse(secureStoreMock.items.get(ENROLLMENT_STORAGE_KEY) ?? "null");

const submitted = () =>
  Effect.runPromise(loadEnrollment().startLocalEnrollment());

beforeEach(async () => {
  secureStoreMock.items.clear();
  now = 1_700_000_000n;
  nextByte = 1;

  // The first phone creates the identity; this phone restores it.
  const original = makeVault();
  await Effect.runPromise(original.createLocalIdentity("alice"));
  recoveryKey = await Effect.runPromise(
    original.revealLocalIdentityRecoveryKey()
  );
  vault = makeVault();
  identity = await Effect.runPromise(
    vault.importLocalIdentity(recoveryKey, "alice")
  );

  registryMock.lookupOwner
    .mockReset()
    .mockReturnValue(Effect.succeed(account()));
  clientMock.submit.mockReset().mockReturnValue(
    Effect.succeed({
      digest: `0x${"11".repeat(32)}`,
      status: "submitted" as const,
      transactionHash: `0x${"77".repeat(32)}`,
    })
  );
  clientMock.get.mockReset().mockReturnValue(
    Effect.succeed({
      digest: `0x${"11".repeat(32)}`,
      failureCode: null,
      status: "submitted" as const,
      transactionHash: null,
    })
  );
});

describe("findRecoveryAccount", () => {
  it("ignores whitespace in a pasted key and summarizes the account", async () => {
    const pasted = ` ${recoveryKey.slice(0, 10)}\n${recoveryKey.slice(10, 30)} \t${recoveryKey.slice(30)}\n`;
    registryMock.lookupOwner.mockReturnValue(
      Effect.succeed(
        account({ deviceKeys: [OTHER_DEVICE_KEY, `0x${"24".repeat(32)}`] })
      )
    );

    const found = await Effect.runPromise(
      loadEnrollment().findRecoveryAccount(pasted)
    );

    expect(found).toEqual({
      deviceCount: 2,
      handle: "alice",
      maxDevices: MAX_DEVICES,
      qid: "42",
    });
    expect(registryMock.lookupOwner).toHaveBeenCalledExactlyOnceWith(
      identity.ownerAddress
    );
  });

  it("fails a mistyped key as invalid-key", async () => {
    const last = recoveryKey.at(-1) === "0" ? "1" : "0";

    const result = await Effect.runPromise(
      loadEnrollment()
        .findRecoveryAccount(`${recoveryKey.slice(0, -1)}${last}`)
        .pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "invalid-key"
    );
    expect(registryMock.lookupOwner).not.toHaveBeenCalled();
  });

  it("returns null when the key owns no account", async () => {
    registryMock.lookupOwner.mockReturnValue(Effect.succeed(null));

    await expect(
      Effect.runPromise(loadEnrollment().findRecoveryAccount(recoveryKey))
    ).resolves.toBeNull();
  });
});

describe("startLocalEnrollment", () => {
  it("saves the record, then submits an owner-signed add for this phone", async () => {
    clientMock.submit.mockImplementationOnce(() =>
      Effect.sync(() => {
        expect(stored()).toMatchObject({ status: "submitted" });
      }).pipe(
        Effect.andThen(
          Effect.succeed({
            digest: `0x${"11".repeat(32)}`,
            status: "submitted" as const,
            transactionHash: `0x${"77".repeat(32)}`,
          })
        )
      )
    );

    const enrollment = await Effect.runPromise(
      loadEnrollment().startLocalEnrollment()
    );

    expect(enrollment).toEqual({
      deadline: "1700000600",
      digest: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
      failureCode: null,
      handle: "alice",
      nonce: "7",
      ownerAddress: identity.ownerAddress,
      qid: "42",
      status: "submitted",
      version: 1,
    });
    expect(stored()).toEqual(enrollment);
    expect(clientMock.submit).toHaveBeenCalledOnce();

    const [{ intent, operation, ownerSignature }] =
      clientMock.submit.mock.calls[0] ?? [];

    expect(operation).toBe("add");
    expect(intent).toMatchObject({
      deviceKey: identity.deviceKey,
      nonce: "7",
      qid: "42",
    });

    const signer = await Effect.runPromise(
      Effect.gen(function* () {
        const domain = yield* decodeIdentityEip712DomainV1(DOMAIN);
        const decodedIntent = yield* decodeAddDeviceIntentV1(intent);

        const signature =
          yield* Schema.decodeUnknownEffect(EcdsaSignature)(ownerSignature);

        return yield* recoverAddDeviceIntentSignerV1(
          domain,
          decodedIntent,
          signature
        );
      })
    );

    expect(signer).toBe(identity.ownerAddress);
  });

  it("confirms without submitting when this phone is already active", async () => {
    registryMock.lookupOwner.mockReturnValue(
      Effect.succeed(account({ deviceKeys: [identity.deviceKey] }))
    );

    const enrollment = await Effect.runPromise(
      loadEnrollment().startLocalEnrollment()
    );

    expect(enrollment.status).toBe("confirmed");
    expect(clientMock.submit).not.toHaveBeenCalled();
  });

  it("fails without submitting when the account is full", async () => {
    registryMock.lookupOwner.mockReturnValue(
      Effect.succeed(
        account({
          deviceKeys: Array.from(
            { length: MAX_DEVICES },
            (_, index) => `0x${(index + 0x30).toString(16).repeat(32)}`
          ),
        })
      )
    );

    const enrollment = await Effect.runPromise(
      loadEnrollment().startLocalEnrollment()
    );

    expect(enrollment).toMatchObject({
      failureCode: "MAX_DEVICES",
      status: "failed",
    });
    expect(clientMock.submit).not.toHaveBeenCalled();
  });

  it("records a 422 as REJECTED and retries a failed record", async () => {
    clientMock.submit.mockReturnValueOnce(clientError(422));
    const { startLocalEnrollment } = loadEnrollment();

    const rejected = await Effect.runPromise(startLocalEnrollment());

    expect(rejected).toMatchObject({
      failureCode: "REJECTED",
      status: "failed",
    });
    expect(stored()).toEqual(rejected);

    const retry = await Effect.runPromise(startLocalEnrollment());

    expect(retry).toMatchObject({ failureCode: null, status: "submitted" });
    expect(clientMock.submit).toHaveBeenCalledTimes(2);
  });

  it("returns a submitted record as is", async () => {
    const { startLocalEnrollment } = loadEnrollment();
    const first = await Effect.runPromise(startLocalEnrollment());
    now += 60n;

    const second = await Effect.runPromise(startLocalEnrollment());

    expect(second).toEqual(first);
    expect(clientMock.submit).toHaveBeenCalledOnce();
  });

  it("returns a confirmed record as is", async () => {
    registryMock.lookupOwner.mockReturnValue(
      Effect.succeed(account({ deviceKeys: [identity.deviceKey] }))
    );
    const { startLocalEnrollment } = loadEnrollment();
    const first = await Effect.runPromise(startLocalEnrollment());

    const second = await Effect.runPromise(startLocalEnrollment());

    expect(second).toEqual(first);
    expect(registryMock.lookupOwner).toHaveBeenCalledOnce();
  });
});

describe("checkLocalEnrollment", () => {
  it("confirms once this phone's device key is active", async () => {
    await submitted();
    registryMock.lookupOwner.mockReturnValue(
      Effect.succeed(
        account({ deviceKeys: [OTHER_DEVICE_KEY, identity.deviceKey] })
      )
    );

    const enrollment = await Effect.runPromise(
      loadEnrollment().checkLocalEnrollment()
    );

    expect(enrollment).toMatchObject({ qid: "42", status: "confirmed" });
    expect(clientMock.get).not.toHaveBeenCalled();
  });

  it.each([
    { expected: "REVERTED", status: "reverted" },
    { expected: "EXPIRED", status: "expired" },
  ] as const)(
    "records a $status action as $expected",
    async ({ expected, status }) => {
      const { digest } = await submitted();
      clientMock.get.mockReturnValueOnce(
        Effect.succeed({
          digest,
          failureCode: null,
          status,
          transactionHash: null,
        })
      );

      const enrollment = await Effect.runPromise(
        loadEnrollment().checkLocalEnrollment()
      );

      expect(enrollment).toMatchObject({
        failureCode: expected,
        status: "failed",
      });
      expect(clientMock.get).toHaveBeenCalledExactlyOnceWith(digest);
    }
  );

  it("waits on a confirmed add missing from the roster until the deadline, then fails as REMOVED", async () => {
    const first = await submitted();

    const confirmed = Effect.succeed({
      digest: first.digest,
      failureCode: null,
      status: "confirmed" as const,
      transactionHash: null,
    });

    // Before the deadline the roster read may just be lagging.
    now = BigInt(first.deadline) - 1n;
    clientMock.get.mockReturnValueOnce(confirmed);

    await expect(
      Effect.runPromise(loadEnrollment().checkLocalEnrollment())
    ).resolves.toEqual(first);

    // After it, another device must have removed this phone.
    now = BigInt(first.deadline);
    clientMock.get.mockReturnValueOnce(confirmed);

    await expect(
      Effect.runPromise(loadEnrollment().checkLocalEnrollment())
    ).resolves.toMatchObject({ failureCode: "REMOVED", status: "failed" });
  });

  it("confirms instead of REMOVED when the add lands during the check", async () => {
    const first = await submitted();
    now = BigInt(first.deadline);
    // The first roster read misses the phone; the re-read sees it.
    registryMock.lookupOwner
      .mockReturnValueOnce(Effect.succeed(account()))
      .mockReturnValueOnce(
        Effect.succeed(
          account({ deviceKeys: [OTHER_DEVICE_KEY, identity.deviceKey] })
        )
      );
    clientMock.get.mockReturnValueOnce(
      Effect.succeed({
        digest: first.digest,
        failureCode: null,
        status: "confirmed",
        transactionHash: null,
      })
    );

    await expect(
      Effect.runPromise(loadEnrollment().checkLocalEnrollment())
    ).resolves.toMatchObject({ status: "confirmed" });
  });

  it("resubmits when the relayer never saw it before the deadline", async () => {
    const first = await submitted();
    now = BigInt(first.deadline) - 1n;
    clientMock.get.mockReturnValueOnce(clientError(404));

    const enrollment = await Effect.runPromise(
      loadEnrollment().checkLocalEnrollment()
    );

    expect(enrollment).toEqual(first);
    expect(clientMock.submit).toHaveBeenCalledTimes(2);
    expect(clientMock.submit.mock.calls[1]?.[0].intent).toEqual(
      clientMock.submit.mock.calls[0]?.[0].intent
    );
  });

  it("expires when the relayer never saw it by the deadline", async () => {
    const first = await submitted();
    now = BigInt(first.deadline);
    clientMock.get.mockReturnValueOnce(clientError(404));

    const enrollment = await Effect.runPromise(
      loadEnrollment().checkLocalEnrollment()
    );

    expect(enrollment).toMatchObject({
      failureCode: "EXPIRED",
      status: "failed",
    });
    expect(clientMock.submit).toHaveBeenCalledOnce();
  });

  it("fails as OWNER_CHANGED when the key no longer owns an account", async () => {
    await submitted();
    registryMock.lookupOwner.mockReturnValue(Effect.succeed(null));

    const enrollment = await Effect.runPromise(
      loadEnrollment().checkLocalEnrollment()
    );

    expect(enrollment).toMatchObject({
      failureCode: "OWNER_CHANGED",
      status: "failed",
    });
    expect(clientMock.get).not.toHaveBeenCalled();
  });
});

it("rejects a stored record made for another identity", async () => {
  await Effect.runPromise(loadEnrollment().startLocalEnrollment());
  secureStoreMock.items.set(
    ENROLLMENT_STORAGE_KEY,
    JSON.stringify({ ...stored(), ownerAddress: OTHER_OWNER })
  );

  const result = await Effect.runPromise(
    loadEnrollment().loadLocalEnrollment().pipe(Effect.result)
  );

  expect(Result.isFailure(result) && result.failure.operation).toBe("verify");
});
