import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { decodeBase64, encodeMailboxResponseV1 } from "@qop/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { openMailboxStore } from "../src/store.ts";

const tempDirs: string[] = [];

const makeTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qop-mailbox-store-"));
  tempDirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const aliceKey = `0x${"11".repeat(32)}`;
const bobKey = `0x${"22".repeat(32)}`;
const carolKey = `0x${"33".repeat(32)}`;
const aliceQid = "1";

describe("mailbox store", () => {
  it("persists tokens per device and does not revoke replacements on stale provider errors", async () => {
    const dir = await makeTempDir();
    const oldToken = { platform: "fcm", token: "old-token" } as const;
    const newToken = { platform: "fcm", token: "new-token" } as const;
    const initial = await Effect.runPromise(openMailboxStore(dir));

    try {
      await Effect.runPromise(initial.registerPush(bobKey, oldToken, 1000));
      await Effect.runPromise(initial.registerPush(bobKey, newToken, 1001));
      await Effect.runPromise(initial.removePush(bobKey, oldToken));
    } finally {
      initial.close();
    }

    const reopened = await Effect.runPromise(openMailboxStore(dir));

    try {
      expect(
        await Effect.runPromise(reopened.pushTarget(bobKey, 1002))
      ).toEqual(newToken);
      expect(
        await Effect.runPromise(reopened.pushTarget(carolKey, 1002))
      ).toBeUndefined();

      const expiry = 1001 + 90 * 24 * 60 * 60 * 1000;
      expect(
        await Effect.runPromise(reopened.pushTarget(bobKey, expiry))
      ).toBeUndefined();
      await Effect.runPromise(reopened.pruneExpired(expiry));
      expect(
        await Effect.runPromise(reopened.pushTarget(bobKey, 1002))
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("deposits idempotently, fetches FIFO, and deletes only on matching recipient ack", async () => {
    const dir = await makeTempDir();
    const store = await Effect.runPromise(openMailboxStore(dir));

    try {
      const env1 = Uint8Array.from([1, 2, 3, 4]);
      const env2 = Uint8Array.from([5, 6, 7, 8]);
      const id1 = "c56a4180-65aa-42ec-a945-5fd21dec0538";
      const id2 = "d56a4180-65aa-42ec-a945-5fd21dec0538";

      const ids = await Effect.runPromise(
        store.deposit(
          [
            {
              envelope: env1,
              id: id1,
              recipientDeviceKey: bobKey,
              senderDeviceKey: aliceKey,
              senderQid: aliceQid,
            },
            {
              envelope: env2,
              id: id2,
              recipientDeviceKey: bobKey,
              senderDeviceKey: aliceKey,
              senderQid: aliceQid,
            },
          ],
          1000
        )
      );

      expect(ids.items).toEqual([
        { id: id1, recipientDeviceKey: bobKey },
        { id: id2, recipientDeviceKey: bobKey },
      ]);
      expect(ids.insertedRecipients).toEqual(new Set([bobKey]));

      // Retrying with newly-sealed HPKE bytes keeps the first envelope idempotently.
      const reSealedIds = await Effect.runPromise(
        store.deposit(
          [
            {
              envelope: Uint8Array.from([9, 9, 9, 9]),
              id: id1,
              recipientDeviceKey: bobKey,
              senderDeviceKey: aliceKey,
              senderQid: aliceQid,
            },
          ],
          1010
        )
      );

      expect(reSealedIds.items).toEqual([
        { id: id1, recipientDeviceKey: bobKey },
      ]);
      expect(reSealedIds.insertedRecipients.size).toBe(0);

      const fetched = await Effect.runPromise(
        store.fetch(bobKey, 10, 128 * 1024, 1020)
      );

      expect(fetched.hasMore).toBe(false);
      expect(fetched.items).toHaveLength(2);
      expect(fetched.items[0]?.id).toBe(id1);
      expect(decodeBase64(fetched.items[0]?.envelope ?? "")).toEqual(env1);
      expect(fetched.items[1]?.id).toBe(id2);

      // Carol cannot ack Bob's envelopes.
      expect(
        await Effect.runPromise(
          store.ack(carolKey, [fetched.items[0]?.seq ?? 0])
        )
      ).toBe(0);

      // Bob acks both.
      expect(
        await Effect.runPromise(
          store.ack(
            bobKey,
            fetched.items.map((item) => item.seq)
          )
        )
      ).toBe(2);

      const afterAck = await Effect.runPromise(
        store.fetch(bobKey, 10, 128 * 1024, 1030)
      );

      expect(afterAck.items).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("enforces quotas, expires old envelopes, and packs pages within exact byte budget", async () => {
    const dir = await makeTempDir();

    const store = await Effect.runPromise(
      openMailboxStore(dir, {
        maxEnvelopesPerRecipient: 3,
        maxEnvelopesPerSender: 2,
        ttlMs: 1000,
      })
    );

    try {
      const makeRecord = (
        id: string,
        senderQid = aliceQid,
        senderDeviceKey = aliceKey
      ) => ({
        envelope: new Uint8Array(64).fill(7),
        id,
        recipientDeviceKey: bobKey,
        senderDeviceKey,
        senderQid,
      });

      await Effect.runPromise(
        store.deposit(
          [
            makeRecord("11111111-1111-4111-8111-111111111111"),
            makeRecord("22222222-2222-4222-8222-222222222222"),
          ],
          100
        )
      );

      // Sender quota blocks Alice's 3rd envelope while leaving room for Carol.
      const senderOver = await Effect.runPromise(
        store
          .deposit([makeRecord("33333333-3333-4333-8333-333333333333")], 200)
          .pipe(Effect.result)
      );

      expect(senderOver._tag).toBe("Failure");

      if (senderOver._tag === "Failure") {
        expect(senderOver.failure.operation).toBe("quota");
      }

      // A full secondary device queue must not roll back another device in the same batch.
      const bobSecondKey = `0x${"44".repeat(32)}`;

      const partial = await Effect.runPromise(
        store.deposit(
          [
            makeRecord("33333333-3333-4333-8333-333333333333"),
            {
              ...makeRecord("33333333-3333-4333-8333-333333333333"),
              recipientDeviceKey: bobSecondKey,
            },
          ],
          200
        )
      );

      expect(partial.items).toEqual([
        {
          id: "33333333-3333-4333-8333-333333333333",
          recipientDeviceKey: bobSecondKey,
        },
      ]);

      // Carol can still deposit into the reserved headroom.
      await Effect.runPromise(
        store.deposit(
          [makeRecord("44444444-4444-4444-8444-444444444444", "2", carolKey)],
          200
        )
      );

      // Fetch with exact byte budget for 2 items: must split cleanly and encode within budget.
      const allThree = await Effect.runPromise(
        store.fetch(bobKey, 10, 128 * 1024, 300)
      );

      const twoBytes = await Effect.runPromise(
        encodeMailboxResponseV1({
          hasMore: false,
          items: allThree.items.slice(0, 2),
          type: "messages",
          v: 1,
        })
      );

      const capped = await Effect.runPromise(
        store.fetch(bobKey, 10, twoBytes.byteLength, 300)
      );

      expect(capped.hasMore).toBe(true);
      expect(capped.items).toHaveLength(2);

      const encodedCapped = await Effect.runPromise(
        encodeMailboxResponseV1({
          hasMore: capped.hasMore,
          items: capped.items,
          type: "messages",
          v: 1,
        })
      );

      expect(encodedCapped.byteLength).toBeLessThanOrEqual(twoBytes.byteLength);

      // Expired rows are hidden on fetch and reclaimed on next deposit.
      const expiredFetch = await Effect.runPromise(
        store.fetch(bobKey, 10, 128 * 1024, 1200)
      );

      expect(expiredFetch.items).toHaveLength(0);

      const afterExpiry = await Effect.runPromise(
        store.deposit(
          [makeRecord("33333333-3333-4333-8333-333333333333")],
          1200
        )
      );

      expect(afterExpiry.items).toEqual([
        {
          id: "33333333-3333-4333-8333-333333333333",
          recipientDeviceKey: bobKey,
        },
      ]);
    } finally {
      store.close();
    }
  });
});
