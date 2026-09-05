import { Effect, Result } from "effect";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRegistrationClient } from "@/lib/registration-client-core";

const fetchMock =
  vi.fn<(input: URL, init?: RequestInit) => Promise<Response>>();
const digest = `0x${"11".repeat(32)}` as const;
const intent = {
  deadline: "1700001800",
  deviceKey: `0x${"22".repeat(32)}`,
  handle: "alice",
  nonce: `0x${"33".repeat(32)}`,
  owner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
} as const;

const signDigest = async (hash: Hex) => {
  const signature = await privateKeyToAccount(`0x${"01".repeat(32)}`).sign({
    hash,
  });
  const recovery = signature.slice(-2).toLowerCase();
  let parity = recovery;
  if (recovery === "1b") {
    parity = "00";
  } else if (recovery === "1c") {
    parity = "01";
  }
  return `${signature.slice(0, -2)}${parity}`;
};

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://api.qop.test";
  fetchMock.mockReset();
});

describe("registration client", () => {
  it("registers an owner-signed intent in one POST", async () => {
    const registrationSignature = await signDigest(digest);
    fetchMock.mockResolvedValue(
      Response.json({
        digest,
        registrationSignature,
        status: "submitted",
        transactionHash: `0x${"44".repeat(32)}`,
      })
    );
    const ownerSignature = await signDigest(`0x${"55".repeat(32)}`);
    const { register } = createRegistrationClient({ fetch: fetchMock });

    const result = await Effect.runPromise(
      register({ admissionCode: "abc123", intent, ownerSignature })
    );

    expect(result).toMatchObject({ digest, status: "submitted" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.qop.test/v1/registrations"),
      expect.objectContaining({ method: "POST" })
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      admissionCode: "ABC-123",
      intent,
      ownerSignature,
    });
  });

  it("rejects a noncanonical registration signature", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        digest,
        registrationSignature: `0x${"00".repeat(65)}`,
        status: "submitted",
        transactionHash: `0x${"44".repeat(32)}`,
      })
    );
    const { register } = createRegistrationClient({ fetch: fetchMock });
    const result = await Effect.runPromise(
      register({
        admissionCode: "ABC-123",
        intent,
        ownerSignature: await signDigest(`0x${"55".repeat(32)}`),
      }).pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "response"
    );
  });

  it("gets registration state with GET", async () => {
    const registration = {
      digest,
      failureCode: null,
      qid: "42",
      status: "confirmed",
      transactionHash: `0x${"44".repeat(32)}`,
    } as const;
    fetchMock.mockResolvedValue(Response.json(registration));
    const { getRegistration } = createRegistrationClient({ fetch: fetchMock });

    await expect(Effect.runPromise(getRegistration(digest))).resolves.toEqual(
      registration
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`https://api.qop.test/v1/registrations/${digest}`),
      undefined
    );
  });

  it.each([
    { failureCode: null, qid: null, status: "confirmed" },
    { failureCode: null, qid: null, status: "failed" },
    { failureCode: null, qid: "42", status: "ready" },
    { failureCode: null, qid: "42", status: "submitted" },
  ])("rejects an invalid $status registration response", async (response) => {
    fetchMock.mockResolvedValue(
      Response.json({ digest, transactionHash: null, ...response })
    );
    const { getRegistration } = createRegistrationClient({ fetch: fetchMock });

    const result = await Effect.runPromise(
      getRegistration(digest).pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe(
      "response"
    );
  });

  it("preserves tagged API errors", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { _tag: "RegistrationConflict", kind: "handle-unavailable" },
        { status: 409 }
      )
    );
    const { getRegistration } = createRegistrationClient({ fetch: fetchMock });
    const result = await Effect.runPromise(
      getRegistration(digest).pipe(Effect.result)
    );

    expect(Result.isFailure(result) && result.failure).toMatchObject({
      kind: "handle-unavailable",
      operation: "response",
      status: 409,
      tag: "RegistrationConflict",
    });
  });
});
