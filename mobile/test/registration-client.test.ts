import { Effect, Result } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("expo/fetch", () => ({ fetch: fetchMock }));

const prepared = {
  digest: `0x${"11".repeat(32)}`,
  domain: {
    chainId: "31337",
    verifyingContract: "0x1111111111111111111111111111111111111111",
  },
  intent: {
    deadline: "1700003600",
    deviceCommitment: `0x${"22".repeat(32)}`,
    handle: "alice",
    nonce: `0x${"33".repeat(32)}`,
    owner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  },
  status: "pending_owner_signature",
} as const;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.qop.test";
  process.env.EXPO_PUBLIC_REGISTRY_ADDRESS = prepared.domain.verifyingContract;
  process.env.EXPO_PUBLIC_REGISTRY_CHAIN_ID = prepared.domain.chainId;
  fetchMock.mockReset();
});

describe("registration client", () => {
  it("decodes the exact prepare response", async () => {
    fetchMock.mockResolvedValue(
      Response.json(prepared, {
        headers: { "Content-Type": "application/json" },
        status: 200,
      })
    );
    const { prepareRegistration } = await import("@/lib/registration-client");
    const result = await Effect.runPromise(
      prepareRegistration({
        admissionCode: "ABC-123",
        deviceCommitment: prepared.intent.deviceCommitment,
        handle: "alice",
        idempotencyKey: "B".repeat(43),
        observeTokenHash: `0x${"44".repeat(32)}`,
        owner: prepared.intent.owner,
        peerId: "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X",
      })
    );

    expect(result).toEqual(prepared);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.qop.test/v1/registrations"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("accepts a checksummed registry address from the environment", async () => {
    process.env.EXPO_PUBLIC_REGISTRY_ADDRESS =
      "0x111111111111111111111111111111111111111A";
    fetchMock.mockResolvedValue(
      Response.json({
        ...prepared,
        domain: {
          ...prepared.domain,
          verifyingContract: "0x111111111111111111111111111111111111111a",
        },
      })
    );
    const { prepareRegistration } = await import("@/lib/registration-client");

    const result = await Effect.runPromise(
      prepareRegistration({
        admissionCode: "ABC-123",
        deviceCommitment: prepared.intent.deviceCommitment,
        handle: "alice",
        idempotencyKey: "B".repeat(43),
        observeTokenHash: `0x${"44".repeat(32)}`,
        owner: prepared.intent.owner,
        peerId: "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X",
      })
    );

    expect(result.domain.verifyingContract).toBe(
      "0x111111111111111111111111111111111111111a"
    );
  });

  it("preserves stable transport errors", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          _tag: "RegistrationConflict",
          kind: "handle-unavailable",
        },
        { status: 409 }
      )
    );
    const { prepareRegistration } = await import("@/lib/registration-client");
    const result = await Effect.runPromise(
      prepareRegistration({
        admissionCode: "ABC-123",
        deviceCommitment: prepared.intent.deviceCommitment,
        handle: "alice",
        idempotencyKey: "B".repeat(43),
        observeTokenHash: `0x${"44".repeat(32)}`,
        owner: prepared.intent.owner,
        peerId: "peer",
      }).pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure).toMatchObject({
      kind: "handle-unavailable",
      operation: "response",
      status: 409,
      tag: "RegistrationConflict",
    });
  });

  it("rejects an API response for a different registry", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...prepared,
        domain: {
          ...prepared.domain,
          verifyingContract: "0x2222222222222222222222222222222222222222",
        },
      })
    );
    const { prepareRegistration } = await import("@/lib/registration-client");
    const result = await Effect.runPromise(
      prepareRegistration({
        admissionCode: "ABC-123",
        deviceCommitment: prepared.intent.deviceCommitment,
        handle: "alice",
        idempotencyKey: "B".repeat(43),
        observeTokenHash: `0x${"44".repeat(32)}`,
        owner: prepared.intent.owner,
        peerId: "peer",
      }).pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "response"
    );
  });
});
