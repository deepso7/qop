import { ed25519 } from "@noble/curves/ed25519.js";
import { Deferred, Effect } from "effect";
import { bytesToHex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { createChatCipher } from "../src/chat-envelope.ts";
import {
  depositToMailbox,
  drainMailbox,
  parseMailboxAddrs,
} from "../src/mailbox-client.ts";
import {
  exchangeMailbox,
  readMailboxRequestFrom,
  writeMailboxResponseTo,
} from "../src/mailbox-io.ts";
import type { MailboxStream } from "../src/mailbox-io.ts";
import {
  decodeBase64,
  decodeMailboxRequestV1,
  decodeMailboxResponseV1,
  encodeBase64,
  encodeMailboxRequestV1,
  encodeMailboxResponseV1,
  MAILBOX_MAX_ACK_SEQS,
  MAILBOX_MAX_DEPOSIT_ITEMS,
  MAILBOX_MAX_FETCH_LIMIT,
  MailboxCodecError,
  MAX_MAILBOX_PAYLOAD_BYTES,
} from "../src/mailbox.ts";
import type { MailboxRequestV1 } from "../src/mailbox.ts";

const sampleKey = `0x${"11".repeat(32)}`;
const sampleId = "c56a4180-65aa-42ec-a945-5fd21dec0538";
const sampleEnvelope = encodeBase64(Uint8Array.from([1, 2, 3, 4, 5, 6]));

const makeMockMailboxStream = (
  respond: (req: MailboxRequestV1) => Uint8Array
): MailboxStream => {
  const written: Uint8Array[] = [];
  let replies: Uint8Array[] = [];

  return {
    closeWrite: () => {
      const total = written.reduce((sum, c) => sum + c.byteLength, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;

      for (const chunk of written) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const req = Effect.runSync(decodeMailboxRequestV1(bytes));
      replies = [respond(req)];
    },
    connId: 1,
    peerId: "12D3KooWMailbox",
    read: () => Promise.resolve(replies.shift()),
    reset: vi.fn(),
    write: (data) => {
      written.push(data);

      return Promise.resolve();
    },
  };
};

describe("mailbox base64 and address helpers", () => {
  it("round-trips bytes and rejects malformed or non-canonical base64", () => {
    for (const bytes of [
      Uint8Array.from([0]),
      Uint8Array.from([1, 2]),
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([255, 0, 128, 64, 32, 16]),
    ]) {
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }

    for (const bad of ["", "A", "AQID ", "AB==", "AQ=", "!!!!"]) {
      expect(() => decodeBase64(bad)).toThrow();
    }
  });

  it("parses and deduplicates mailbox multiaddrs by peer ID", () => {
    expect(parseMailboxAddrs(undefined)).toEqual([]);
    expect(
      parseMailboxAddrs(
        " /ip4/1.2.3.4/udp/19877/quic-v1/p2p/12D3KooWOne , /invalid , /ip4/5.6.7.8/udp/19877/quic-v1/p2p/12D3KooWOne , /dns/m.example/udp/19877/quic-v1/p2p/12D3KooWTwo "
      )
    ).toEqual([
      {
        addr: "/ip4/1.2.3.4/udp/19877/quic-v1/p2p/12D3KooWOne",
        peerId: "12D3KooWOne",
      },
      {
        addr: "/dns/m.example/udp/19877/quic-v1/p2p/12D3KooWTwo",
        peerId: "12D3KooWTwo",
      },
    ]);
  });
});

describe("mailbox wire codecs and stream exchange", () => {
  it("round-trips all request and response variants", async () => {
    const requests = [
      {
        items: [
          {
            envelope: sampleEnvelope,
            id: sampleId,
            recipientDeviceKey: sampleKey,
          },
        ],
        type: "deposit" as const,
        v: 1 as const,
      },
      { limit: MAILBOX_MAX_FETCH_LIMIT, type: "fetch" as const, v: 1 as const },
      { seqs: [1, 2, 3], type: "ack" as const, v: 1 as const },
    ];

    await Promise.all(
      requests.map(async (request) => {
        const bytes = await Effect.runPromise(encodeMailboxRequestV1(request));
        const decoded = await Effect.runPromise(decodeMailboxRequestV1(bytes));
        expect(decoded).toEqual(request);
      })
    );

    const responses = [
      {
        items: [{ id: sampleId, recipientDeviceKey: sampleKey }],
        type: "deposited" as const,
        v: 1 as const,
      },
      {
        hasMore: true,
        items: [
          {
            envelope: sampleEnvelope,
            id: sampleId,
            senderDeviceKey: sampleKey,
            seq: 1,
            storedAt: 1_700_000_000_000,
          },
        ],
        type: "messages" as const,
        v: 1 as const,
      },
      { count: 2, type: "acked" as const, v: 1 as const },
      { reason: "quota" as const, type: "error" as const, v: 1 as const },
    ];

    await Promise.all(
      responses.map(async (response) => {
        const bytes = await Effect.runPromise(
          encodeMailboxResponseV1(response)
        );

        const decoded = await Effect.runPromise(decodeMailboxResponseV1(bytes));
        expect(decoded).toEqual(response);
      })
    );
  });

  it("rejects out-of-bounds fields, bad base64, extra keys, and oversized payloads", async () => {
    const badInputs = [
      { items: [], type: "deposit", v: 1 },
      {
        items: Array.from({ length: MAILBOX_MAX_DEPOSIT_ITEMS + 1 }, () => ({
          envelope: sampleEnvelope,
          id: sampleId,
          recipientDeviceKey: sampleKey,
        })),
        type: "deposit",
        v: 1,
      },
      {
        items: [
          {
            envelope: "AB==",
            id: sampleId,
            recipientDeviceKey: sampleKey,
          },
        ],
        type: "deposit",
        v: 1,
      },
      { limit: 0, type: "fetch", v: 1 },
      { limit: MAILBOX_MAX_FETCH_LIMIT + 1, type: "fetch", v: 1 },
      { seqs: [0], type: "ack", v: 1 },
      {
        seqs: Array.from({ length: MAILBOX_MAX_ACK_SEQS + 1 }, (_, i) => i + 1),
        type: "ack",
        v: 1,
      },
      { extra: true, limit: 1, type: "fetch", v: 1 },
    ];

    await Promise.all(
      badInputs.map(async (input) => {
        const result = await Effect.runPromise(
          decodeMailboxRequestV1(
            new TextEncoder().encode(JSON.stringify(input))
          ).pipe(Effect.result)
        );

        expect(result._tag).toBe("Failure");
      })
    );

    const oversized = await Effect.runPromise(
      decodeMailboxRequestV1(
        new Uint8Array(MAX_MAILBOX_PAYLOAD_BYTES + 1)
      ).pipe(Effect.result)
    );

    expect(oversized._tag).toBe("Failure");

    if (oversized._tag === "Failure") {
      expect(oversized.failure).toBeInstanceOf(MailboxCodecError);
      expect(oversized.failure.operation).toBe("oversized");
    }
  });

  it("exchanges frames and resets the stream on timeout", async () => {
    const request = { limit: 4, type: "fetch" as const, v: 1 as const };

    const response = {
      hasMore: false,
      items: [],
      type: "messages" as const,
      v: 1 as const,
    };

    const written: Uint8Array[] = [];
    let closed = false;

    const replyChunks = [
      await Effect.runPromise(encodeMailboxResponseV1(response)),
    ];

    const actual = await Effect.runPromise(
      exchangeMailbox(
        {
          closeWrite: () => {
            closed = true;
          },
          read: () => Promise.resolve(replyChunks.shift()),
          write: (chunk) => {
            written.push(chunk);

            return Promise.resolve();
          },
        },
        request
      )
    );

    expect(closed).toBe(true);
    expect(actual).toEqual(response);

    const serverRead = [...written];

    const decodedReq = await Effect.runPromise(
      readMailboxRequestFrom({
        read: () => Promise.resolve(serverRead.shift()),
      })
    );

    expect(decodedReq).toEqual(request);

    const serverWritten: Uint8Array[] = [];
    await Effect.runPromise(
      writeMailboxResponseTo(
        {
          closeWrite: () => {},
          write: (chunk) => {
            serverWritten.push(chunk);

            return Promise.resolve();
          },
        },
        response
      )
    );
    expect(serverWritten).toHaveLength(1);

    const reset = vi.fn();

    const stalled = await Effect.runPromise(
      exchangeMailbox(
        {
          closeWrite: () => {},
          read: async () => {
            await Effect.runPromise(Effect.sleep("500 millis"));
          },
          reset,
          write: () => Promise.resolve(),
        },
        request,
        25
      ).pipe(Effect.result)
    );

    expect(stalled._tag).toBe("Failure");
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("mailbox client deposit and drain safeguards", () => {
  it("caps drain pages and stops if a hostile mailbox repeats an already-acked seq", async () => {
    const aliceSecret = new Uint8Array(32).fill(1);
    const bobSecret = new Uint8Array(32).fill(2);

    const aliceKey = bytesToHex(
      ed25519.getPublicKey(aliceSecret)
    ).toLowerCase();

    const bobPub = ed25519.getPublicKey(bobSecret);
    const aliceCipher = createChatCipher(aliceSecret);
    const bobCipher = createChatCipher(bobSecret);

    const frame = {
      fromHandle: "alice",
      id: sampleId,
      sentAt: 1_700_000_000_000,
      text: "hello",
      v: 1 as const,
    };

    const sealed = encodeBase64(await aliceCipher.seal(frame, bobPub));

    // Hostile mailbox returns seq: 1 with hasMore: true on every fetch forever.
    let fetchCount = 0;

    const repeated = await Effect.runPromise(
      drainMailbox({
        cipher: bobCipher,
        onMessage: () => "ack",
        openStream: () =>
          Promise.resolve(
            makeMockMailboxStream((req) => {
              if (req.type === "fetch") {
                fetchCount += 1;

                return Effect.runSync(
                  encodeMailboxResponseV1({
                    hasMore: true,
                    items: [
                      {
                        envelope: sealed,
                        id: sampleId,
                        senderDeviceKey: aliceKey,
                        seq: 1,
                        storedAt: 1_700_000_000_000,
                      },
                    ],
                    type: "messages",
                    v: 1,
                  })
                );
              }

              return Effect.runSync(
                encodeMailboxResponseV1({ count: 1, type: "acked", v: 1 })
              );
            })
          ),
      })
    );

    expect(repeated).toBe(1);
    expect(fetchCount).toBe(2);

    // Hostile mailbox returns fresh seqs with hasMore: true forever -> capped at maxPages.
    let nextSeq = 1;
    let cappedFetches = 0;

    const capped = await Effect.runPromise(
      drainMailbox({
        cipher: bobCipher,
        maxPages: 3,
        onMessage: () => "ack",
        openStream: () =>
          Promise.resolve(
            makeMockMailboxStream((req) => {
              if (req.type === "fetch") {
                cappedFetches += 1;
                const seq = nextSeq;
                nextSeq += 1;

                return Effect.runSync(
                  encodeMailboxResponseV1({
                    hasMore: true,
                    items: [
                      {
                        envelope: sealed,
                        id: sampleId,
                        senderDeviceKey: aliceKey,
                        seq,
                        storedAt: 1_700_000_000_000,
                      },
                    ],
                    type: "messages",
                    v: 1,
                  })
                );
              }

              return Effect.runSync(
                encodeMailboxResponseV1({ count: 1, type: "acked", v: 1 })
              );
            })
          ),
      })
    );

    expect(capped).toBe(3);
    expect(cappedFetches).toBe(3);
  });

  it("handles retry and abort dispositions without ACKing unpersisted items", async () => {
    const aliceSecret = new Uint8Array(32).fill(3);
    const bobSecret = new Uint8Array(32).fill(4);

    const aliceKey = bytesToHex(
      ed25519.getPublicKey(aliceSecret)
    ).toLowerCase();

    const bobPub = ed25519.getPublicKey(bobSecret);
    const aliceCipher = createChatCipher(aliceSecret);
    const bobCipher = createChatCipher(bobSecret);

    const frame = {
      fromHandle: "alice",
      id: sampleId,
      sentAt: 1_700_000_000_000,
      text: "hello",
      v: 1 as const,
    };

    const sealed = encodeBase64(await aliceCipher.seal(frame, bobPub));

    const ackedSeqs: number[] = [];

    const count = await Effect.runPromise(
      drainMailbox({
        cipher: bobCipher,
        onMessage: (_f, meta) => (meta.seq === 1 ? "retry" : "abort"),
        openStream: () =>
          Promise.resolve(
            makeMockMailboxStream((req) => {
              if (req.type === "ack") {
                ackedSeqs.push(...req.seqs);

                return Effect.runSync(
                  encodeMailboxResponseV1({
                    count: req.seqs.length,
                    type: "acked",
                    v: 1,
                  })
                );
              }

              return Effect.runSync(
                encodeMailboxResponseV1({
                  hasMore: false,
                  items: [
                    {
                      envelope: sealed,
                      id: sampleId,
                      senderDeviceKey: aliceKey,
                      seq: 1,
                      storedAt: 1_700_000_000_000,
                    },
                    {
                      envelope: sealed,
                      id: sampleId,
                      senderDeviceKey: aliceKey,
                      seq: 2,
                      storedAt: 1_700_000_000_000,
                    },
                  ],
                  type: "messages",
                  v: 1,
                })
              );
            })
          ),
      })
    );

    expect(count).toBe(0);
    expect(ackedSeqs).toEqual([]);
  });

  it("deposits deduplicated recipient device keys in a single batch", async () => {
    const aliceSecret = new Uint8Array(32).fill(5);
    const bobSecret = new Uint8Array(32).fill(6);
    const bobKey = bytesToHex(ed25519.getPublicKey(bobSecret)).toLowerCase();
    const depositedBatches: number[] = [];

    const accepted = await Effect.runPromise(
      depositToMailbox({
        cipher: createChatCipher(aliceSecret),
        frame: {
          fromHandle: "alice",
          id: sampleId,
          sentAt: 1_700_000_000_000,
          text: "batch check",
          v: 1,
        },
        openStream: () =>
          Promise.resolve(
            makeMockMailboxStream((req) => {
              if (req.type !== "deposit") {
                return Effect.runSync(
                  encodeMailboxResponseV1({
                    reason: "invalid",
                    type: "error",
                    v: 1,
                  })
                );
              }

              const { items } = req;
              depositedBatches.push(items.length);

              return Effect.runSync(
                encodeMailboxResponseV1({
                  items: items.map((item) => ({
                    id: item.id,
                    recipientDeviceKey: item.recipientDeviceKey,
                  })),
                  type: "deposited",
                  v: 1,
                })
              );
            })
          ),
        recipientDeviceKeys: [bobKey, bobKey.toUpperCase()],
      })
    );

    expect(accepted).toEqual([bobKey]);
    expect(depositedBatches).toEqual([1]);
  });

  it("ignores mismatched deposit receipts and resets streams resolved after cancellation", async () => {
    const aliceSecret = new Uint8Array(32).fill(5);
    const bobSecret = new Uint8Array(32).fill(6);
    const otherSecret = new Uint8Array(32).fill(9);
    const bobKey = bytesToHex(ed25519.getPublicKey(bobSecret)).toLowerCase();

    const otherKey = bytesToHex(
      ed25519.getPublicKey(otherSecret)
    ).toLowerCase();

    // Receipt with wrong message id or unsubmitted recipient must not be counted.
    const mismatched = await Effect.runPromise(
      depositToMailbox({
        cipher: createChatCipher(aliceSecret),
        frame: {
          fromHandle: "alice",
          id: sampleId,
          sentAt: 1_700_000_000_000,
          text: "receipt check",
          v: 1,
        },
        openStream: () =>
          Promise.resolve(
            makeMockMailboxStream(() =>
              Effect.runSync(
                encodeMailboxResponseV1({
                  items: [
                    {
                      id: "00000000-0000-4000-8000-000000000000",
                      recipientDeviceKey: bobKey,
                    },
                    { id: sampleId, recipientDeviceKey: otherKey },
                  ],
                  type: "deposited",
                  v: 1,
                })
              )
            )
          ),
        recipientDeviceKeys: [bobKey],
      })
    );

    expect(mismatched).toEqual([]);

    // Interrupted openStream must reset the stream when it eventually resolves.
    const lateReset = vi.fn();
    const lateOpen = Deferred.makeUnsafe<MailboxStream>();
    let opened = false;
    const controller = new AbortController();

    const pending = Effect.runPromise(
      depositToMailbox({
        cipher: createChatCipher(aliceSecret),
        frame: {
          fromHandle: "alice",
          id: sampleId,
          sentAt: 1_700_000_000_000,
          text: "cancel check",
          v: 1,
        },
        openStream: () => {
          opened = true;

          return Effect.runPromise(Deferred.await(lateOpen));
        },
        recipientDeviceKeys: [bobKey],
      }),
      { signal: controller.signal }
    ).catch(() => "aborted");

    await vi.waitFor(() => expect(opened).toBe(true));
    controller.abort();
    expect(await pending).toBe("aborted");

    Deferred.doneUnsafe(
      lateOpen,
      Effect.succeed({
        ...makeMockMailboxStream(() => new Uint8Array()),
        reset: lateReset,
      })
    );
    await vi.waitFor(() => expect(lateReset).toHaveBeenCalledTimes(1));

    // beforeWrite returning false resets the opened stream without writing.
    const blockedReset = vi.fn();
    const blockedWrite = vi.fn(() => Promise.resolve());

    const blockedStream: MailboxStream = {
      ...makeMockMailboxStream(() => new Uint8Array()),
      reset: blockedReset,
      write: blockedWrite,
    };

    const blocked = await Effect.runPromise(
      depositToMailbox({
        beforeWrite: () => false,
        cipher: createChatCipher(aliceSecret),
        frame: {
          fromHandle: "alice",
          id: sampleId,
          sentAt: 1_700_000_000_000,
          text: "auth check",
          v: 1,
        },
        openStream: () => Promise.resolve(blockedStream),
        recipientDeviceKeys: [bobKey],
      }).pipe(Effect.result)
    );

    expect(blocked._tag).toBe("Failure");
    expect(blockedReset).toHaveBeenCalledTimes(1);
    expect(blockedWrite).not.toHaveBeenCalled();
  });
});
