import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Minip2p } from "@minip2p/node";
import { deviceKeyFromEd25519SecretKey } from "@qop/identity";
import {
  createChatCipher,
  decodeBase64,
  encodeBase64,
  exchangeMailbox,
  MAILBOX_PROTOCOL,
} from "@qop/protocol";
import { Effect } from "effect";
import { bytesToHex } from "viem";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOrCreateKey } from "../src/main.ts";
import {
  createDeviceAuthorizer,
  createMailboxHandler,
  startMailboxServer,
} from "../src/server.ts";
import type { MailboxRegistry } from "../src/server.ts";
import { openMailboxStore } from "../src/store.ts";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qop-mailbox-server-"));
  tempDirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const makeIdentity = () => {
  const secret = new Uint8Array(randomBytes(32));
  const publicKey = Effect.runSync(deviceKeyFromEd25519SecretKey(secret));
  // SAFETY: bytesToHex always returns a `0x`-prefixed lowercase hex string.
  const deviceKeyHex = bytesToHex(publicKey).toLowerCase() as Hex;

  return { deviceKeyHex, publicKey, secret };
};

const makeMockRegistry = (
  activeDevices: ReadonlyMap<string, bigint>
): MailboxRegistry => ({
  lookupDeviceQid: (deviceKey) =>
    Effect.succeed(activeDevices.get(deviceKey.toLowerCase()) ?? null),
});

describe("mailbox server hardening and transport", () => {
  it("wakes the registered recipient once for a committed encrypted deposit", async () => {
    const store = await Effect.runPromise(
      openMailboxStore(await makeTempDir())
    );

    const sender = makeIdentity();
    const recipient = makeIdentity();

    const registry = makeMockRegistry(
      new Map([
        [sender.deviceKeyHex, 1n],
        [recipient.deviceKeyHex, 2n],
      ])
    );

    const token = { platform: "fcm", token: "test-recipient-token" } as const;
    const wakeups: unknown[] = [];
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const handler = createMailboxHandler({
      registry,
      store,
      wake: {
        fcm: async (targetToken) => {
          const pending = await Effect.runPromise(
            store.fetch(recipient.deviceKeyHex, 1, 128 * 1024, Date.now())
          );

          wakeups.push({ pending: pending.items.length, token: targetToken });
          throw new Error(`Provider rejected token ${targetToken}`);
        },
      },
    });

    try {
      expect(
        await Effect.runPromise(
          handler.handleAuthorized(recipient.deviceKeyHex, "2", {
            ...token,
            type: "register-push",
            v: 1,
          })
        )
      ).toEqual({ type: "push-registered", v: 1 });

      const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

      const sealed = await createChatCipher(sender.secret).seal(
        { fromHandle: "alice", id, sentAt: Date.now(), text: "private", v: 1 },
        recipient.publicKey
      );

      const deposit = {
        items: [
          {
            envelope: encodeBase64(sealed),
            id,
            recipientDeviceKey: recipient.deviceKeyHex,
          },
        ],
        type: "deposit",
        v: 1,
      } as const;

      const sendDeposit = () =>
        Effect.runPromise(
          handler.handleAuthorized(sender.deviceKeyHex, "1", deposit)
        );

      const deposited = {
        items: [{ id, recipientDeviceKey: recipient.deviceKeyHex }],
        type: "deposited",
        v: 1,
      };

      expect(await sendDeposit()).toEqual(deposited);
      expect(await sendDeposit()).toEqual(deposited);

      await delay(0);
      expect(wakeups).toEqual([{ pending: 1, token: token.token }]);
      expect(warning.mock.calls.flat()).toEqual([
        "qop-mailbox push: FCM send failed; check project, sender permissions, and connectivity\n",
      ]);
    } finally {
      warning.mockRestore();
      store.close();
    }
  });

  it("coalesces concurrent auth lookups and never caches transient RPC errors", async () => {
    let calls = 0;
    let shouldFail = true;

    const authorizer = createDeviceAuthorizer({
      lookupDeviceQid: () =>
        Effect.tryPromise({
          catch: (cause) => cause,
          try: async () => {
            calls += 1;
            await delay(15);

            if (shouldFail) {
              throw new Error("rpc down");
            }

            return 42n;
          },
        }),
    });

    const key = `0x${"11".repeat(32)}`;

    const failed = await Promise.all([
      Effect.runPromise(authorizer.authorize(key)),
      Effect.runPromise(authorizer.authorize(key)),
    ]);

    expect(calls).toBe(1);
    expect(failed).toEqual([
      { status: "unavailable" },
      { status: "unavailable" },
    ]);

    shouldFail = false;
    const recovered = await Effect.runPromise(authorizer.authorize(key));
    expect(calls).toBe(2);
    expect(recovered).toEqual({ qid: "42", status: "active" });

    // Cached on subsequent read.
    await Effect.runPromise(authorizer.authorize(key));
    expect(calls).toBe(2);
  });

  it("refuses malformed mailbox.key files instead of silently rotating", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "mailbox.key"), Uint8Array.from([1, 2, 3]));
    await expect(loadOrCreateKey(dir)).rejects.toThrow("Invalid mailbox key");
  });

  it("delivers encrypted envelopes, rejects unauthorized peers early, and enforces rate limits", async () => {
    const dir = await makeTempDir();
    const store = await Effect.runPromise(openMailboxStore(dir));
    const serverKey = new Uint8Array(randomBytes(32));
    const alice = makeIdentity();
    const bob = makeIdentity();
    const rogue = makeIdentity();

    const registry = makeMockRegistry(
      new Map([
        [alice.deviceKeyHex, 1n],
        [bob.deviceKeyHex, 2n],
      ])
    );

    const server = startMailboxServer({
      keypair: serverKey,
      listenAddrs: ["/ip4/127.0.0.1/udp/0/quic-v1"],
      maxRequestsPerMinute: 4,
      registry,
      store,
      streamTimeoutMs: 5000,
    });

    const [serverAddr] = server.listenAddrs();

    if (!serverAddr) {
      throw new Error("Mailbox server has no listen address");
    }

    const aliceEndpoint = Minip2p.create({
      listen: ["/ip4/127.0.0.1/udp/0/quic-v1"],
      protocols: [MAILBOX_PROTOCOL],
      secretKey: alice.secret,
    });

    const rogueEndpoint = Minip2p.create({
      listen: ["/ip4/127.0.0.1/udp/0/quic-v1"],
      protocols: [MAILBOX_PROTOCOL],
      secretKey: rogue.secret,
    });

    const openMailboxStream = async (client: Minip2p) => {
      if (!client.connectedPeers().includes(server.peerId)) {
        await client.connect([serverAddr], { timeoutMs: 10_000 });
      }

      await client.waitPeerReady(server.peerId, { timeoutMs: 10_000 });

      return client.openStream(server.peerId, MAILBOX_PROTOCOL, {
        timeoutMs: 10_000,
      });
    };

    try {
      const aliceCipher = createChatCipher(alice.secret);
      const messageId = "c56a4180-65aa-42ec-a945-5fd21dec0538";

      const frame = {
        fromHandle: "alice",
        id: messageId,
        sentAt: 1_700_000_000_000,
        text: "offline hello",
        v: 1 as const,
      };

      const sealed = await aliceCipher.seal(frame, bob.publicKey);

      // Unauthorized peer's stream is reset immediately without reading its body.
      const rogueResult = await Effect.runPromise(
        Effect.tryPromise(() => openMailboxStream(rogueEndpoint)).pipe(
          Effect.flatMap((stream) =>
            exchangeMailbox(stream, { limit: 4, type: "fetch", v: 1 })
          ),
          Effect.result
        )
      );

      expect(rogueResult._tag).toBe("Failure");

      // Alice deposits a batch containing both a revoked sibling (rogue) and active Bob:
      // rogue is skipped without blocking Bob's copy.
      const sealedRogue = await aliceCipher.seal(frame, rogue.publicKey);

      const depositRes = await Effect.runPromise(
        exchangeMailbox(await openMailboxStream(aliceEndpoint), {
          items: [
            {
              envelope: encodeBase64(sealedRogue),
              id: messageId,
              recipientDeviceKey: rogue.deviceKeyHex,
            },
            {
              envelope: encodeBase64(sealed),
              id: messageId,
              recipientDeviceKey: bob.deviceKeyHex,
            },
          ],
          type: "deposit",
          v: 1,
        })
      );

      expect(depositRes).toEqual({
        items: [{ id: messageId, recipientDeviceKey: bob.deviceKeyHex }],
        type: "deposited",
        v: 1,
      });

      // A batch with only unauthorized recipients fails with unauthorized.
      const unauthorizedBatchRes = await Effect.runPromise(
        exchangeMailbox(await openMailboxStream(aliceEndpoint), {
          items: [
            {
              envelope: encodeBase64(sealedRogue),
              id: messageId,
              recipientDeviceKey: rogue.deviceKeyHex,
            },
          ],
          type: "deposit",
          v: 1,
        })
      );

      expect(unauthorizedBatchRes).toEqual({
        reason: "unauthorized",
        type: "error",
        v: 1,
      });

      // Exceeding maxRequestsPerMinute (4) resets subsequent streams immediately.
      await Effect.runPromise(
        exchangeMailbox(await openMailboxStream(aliceEndpoint), {
          limit: 1,
          type: "fetch",
          v: 1,
        })
      );
      await Effect.runPromise(
        exchangeMailbox(await openMailboxStream(aliceEndpoint), {
          limit: 1,
          type: "fetch",
          v: 1,
        })
      );

      const rateLimitedRes = await Effect.runPromise(
        Effect.tryPromise(() => openMailboxStream(aliceEndpoint)).pipe(
          Effect.flatMap((stream) =>
            exchangeMailbox(stream, { limit: 1, type: "fetch", v: 1 })
          ),
          Effect.result
        )
      );

      expect(rateLimitedRes._tag).toBe("Failure");

      // Bob comes online later, fetches, decrypts, and ACKs.
      const bobEndpoint = Minip2p.create({
        listen: ["/ip4/127.0.0.1/udp/0/quic-v1"],
        protocols: [MAILBOX_PROTOCOL],
        secretKey: bob.secret,
      });

      try {
        const fetchRes = await Effect.runPromise(
          exchangeMailbox(await openMailboxStream(bobEndpoint), {
            limit: 10,
            type: "fetch",
            v: 1,
          })
        );

        expect(fetchRes.type).toBe("messages");

        if (fetchRes.type !== "messages") {
          return;
        }

        expect(fetchRes.items).toHaveLength(1);
        const [item] = fetchRes.items;

        const opened = await createChatCipher(bob.secret).open(
          decodeBase64(item?.envelope ?? ""),
          alice.publicKey
        );

        expect(opened).toEqual(frame);

        const ackRes = await Effect.runPromise(
          exchangeMailbox(await openMailboxStream(bobEndpoint), {
            seqs: [item?.seq ?? 0],
            type: "ack",
            v: 1,
          })
        );

        expect(ackRes).toEqual({ count: 1, type: "acked", v: 1 });
      } finally {
        bobEndpoint.close();
      }
    } finally {
      aliceEndpoint.close();
      rogueEndpoint.close();
      server.close();
      store.close();
    }
  });
});
