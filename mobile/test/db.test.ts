import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceMessageStatus,
  deleteAll,
  expediteMessageRetries,
  failRejectedHandoff,
  getContactByQid,
  getHolderInboxCursor,
  getMessageById,
  insertMessage,
  listConversations,
  listMessages,
  markConversationRead,
  markMessageHeld,
  recordMessageRetry,
  retryFailedMessage,
  setHolderInboxCursor,
  upsertContact,
} from "@/lib/db";
import type { MessageInput } from "@/lib/db";

beforeEach(async () => {
  await deleteAll();
  vi.useFakeTimers();
  await upsertContact({
    createdAt: 1,
    deviceKey: "device",
    handle: "alice",
    owner: "owner",
    peerId: "peer",
    qid: "1",
  });
});

afterEach(() => vi.useRealTimers());

describe("message chronology", () => {
  it("keeps a late arrival last in the conversation and preview until it is read", async () => {
    vi.setSystemTime(100);
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id: "later",
      sentAt: 20,
      status: "received",
      text: "second",
    });
    await markConversationRead("1");
    vi.setSystemTime(200);
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id: "earlier",
      sentAt: 10,
      status: "received",
      text: "first",
    });
    const messages = await listMessages("1");
    expect(messages.map(({ id }) => id)).toEqual(["later", "earlier"]);
    expect(messages.map(({ sentAt }) => sentAt)).toEqual([20, 10]);
    expect(messages.map(({ receivedAt }) => receivedAt)).toEqual([100, 200]);
    expect(await listConversations()).toMatchObject([
      { latestMessageText: "first", latestMessageTime: 200, unreadCount: 1 },
    ]);
    await markConversationRead("1");
    expect(await listConversations()).toMatchObject([{ unreadCount: 0 }]);
  });

  it.each([100, 50])(
    "keeps arrivals unread when the local clock reads %i after reading at 100",
    async (arrivalTime) => {
      vi.setSystemTime(100);
      await insertMessage({
        contactQid: "1",
        direction: "in",
        id: "read",
        sentAt: 999_999,
        status: "received",
        text: "already read",
      });
      await markConversationRead("1");
      vi.setSystemTime(arrivalTime);
      await Promise.all(
        ["new-1", "new-2"].map((id) =>
          insertMessage({
            contactQid: "1",
            direction: "in",
            id,
            sentAt: 1,
            status: "received",
            text: id,
          })
        )
      );
      const messages = await listMessages("1");
      expect(messages.map(({ id }) => id)).toEqual(["read", "new-1", "new-2"]);
      expect(await listConversations()).toMatchObject([
        { latestMessageText: "new-2", unreadCount: 2 },
      ]);
      await markConversationRead("1");
      expect(await listConversations()).toMatchObject([{ unreadCount: 0 }]);
    }
  );

  it("does not mark messages received after a loaded read boundary", async () => {
    vi.setSystemTime(100);
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id: "loaded",
      sentAt: 1,
      status: "received",
      text: "loaded message",
    });
    const loaded = await listMessages("1");
    vi.setSystemTime(200);
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id: "arrived-after-load",
      sentAt: 2,
      status: "received",
      text: "new message",
    });

    await markConversationRead("1", loaded.at(-1)?.receivedAt);

    expect(await listConversations()).toMatchObject([{ unreadCount: 1 }]);
  });

  it("sorts conversations by local activity despite sender clock skew", async () => {
    await upsertContact({
      createdAt: 2,
      deviceKey: "bob-device",
      handle: "bob",
      owner: "bob-owner",
      peerId: "bob-peer",
      qid: "2",
    });
    vi.setSystemTime(100);
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id: "future-clock",
      sentAt: 999_999,
      status: "received",
      text: "older arrival",
    });
    vi.setSystemTime(200);
    await insertMessage({
      contactQid: "2",
      direction: "out",
      id: "recent",
      sentAt: 200,
      status: "queued",
      text: "latest activity",
    });
    const conversations = await listConversations();
    expect(conversations.map(({ qid }) => qid)).toEqual(["2", "1"]);
  });
});

describe("delivery status transitions", () => {
  it("persists capped exponential backoff and never requeues a delivered message", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "retry",
      sentAt: 1,
      status: "queued",
      text: "hello",
    });
    vi.setSystemTime(1000);

    await Effect.runPromise(
      Effect.forEach(
        [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000],
        (delay, index) =>
          Effect.promise(async () => {
            expect(await recordMessageRetry("retry", "1")).toBe(1000 + delay);
            expect(await getMessageById("retry")).toMatchObject({
              attempts: index + 1,
              nextAttemptAt: 1000 + delay,
              status: "queued",
            });
          }),
        { concurrency: 1 }
      )
    );

    // An expedited retry writes nextAttemptAt = 0 so it retries immediately.
    expect(await recordMessageRetry("retry", "1", true)).toBe(0);
    expect(await getMessageById("retry")).toMatchObject({
      attempts: 8,
      nextAttemptAt: 0,
      status: "queued",
    });

    await advanceMessageStatus("retry", "sent", "1");
    expect(await recordMessageRetry("retry", "1")).toBeNull();
    expect(await getMessageById("retry")).toMatchObject({
      attempts: 8,
      status: "sent",
    });
  });

  it("resets backoff state when manually retrying a failed message", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "manual-retry",
      sentAt: 100,
      status: "queued",
      text: "hello",
    });
    vi.setSystemTime(1000);
    await recordMessageRetry("manual-retry", "1");
    await recordMessageRetry("manual-retry", "1");
    await advanceMessageStatus("manual-retry", "failed", "1");

    expect(await retryFailedMessage("manual-retry", "1")).toBe(true);
    expect(await getMessageById("manual-retry")).toMatchObject({
      attempts: 0,
      holderPeerId: null,
      nextAttemptAt: 0,
      status: "queued",
    });
    expect(await retryFailedMessage("manual-retry", "1")).toBe(false);
  });

  it("expedites queued retries for one contact or all contacts", async () => {
    await upsertContact({
      createdAt: 2,
      deviceKey: "bob-device",
      handle: "bob",
      owner: "bob-owner",
      peerId: "bob-peer",
      qid: "2",
    });
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "m1",
      sentAt: 1,
      status: "queued",
      text: "one",
    });
    await insertMessage({
      contactQid: "2",
      direction: "out",
      id: "m2",
      sentAt: 1,
      status: "queued",
      text: "two",
    });
    vi.setSystemTime(1000);
    await recordMessageRetry("m1", "1");
    await recordMessageRetry("m2", "2");

    await expediteMessageRetries("1");
    expect(await getMessageById("m1", "1")).toMatchObject({ nextAttemptAt: 0 });
    expect(await getMessageById("m2", "2")).toMatchObject({
      nextAttemptAt: 3000,
    });

    await expediteMessageRetries();
    expect(await getMessageById("m2", "2")).toMatchObject({ nextAttemptAt: 0 });
  });

  it("does not let a late held clobber sent", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "race",
      sentAt: 100,
      status: "queued",
      text: "hello",
    });
    expect(await advanceMessageStatus("race", "sent", "1")).toBe(true);
    expect(await advanceMessageStatus("race", "held", "1")).toBe(false);
    expect(await getMessageById("race")).toMatchObject({ status: "sent" });
  });

  it("promotes held to sent on a receipt", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "held-receipt",
      sentAt: 100,
      status: "held",
      text: "hello",
    });
    expect(await advanceMessageStatus("held-receipt", "sent", "1")).toBe(true);
    expect(await getMessageById("held-receipt")).toMatchObject({
      status: "sent",
    });
  });

  it("promotes held to failed when the holder permanently rejects the id", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "held-fail",
      sentAt: 100,
      status: "held",
      text: "hello",
    });
    expect(await advanceMessageStatus("held-fail", "failed", "1")).toBe(false);
    await failRejectedHandoff("held-fail", "1");
    expect(await getMessageById("held-fail")).toMatchObject({
      holderPeerId: null,
      status: "failed",
    });
  });

  it("records the accepting holder and does not auto-unfail", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "held-by",
      sentAt: 100,
      status: "queued",
      text: "hello",
    });
    expect(await markMessageHeld("held-by", "cli-peer", "1")).toBe(true);
    expect(await getMessageById("held-by")).toMatchObject({
      holderPeerId: "cli-peer",
      status: "held",
    });
    expect(await markMessageHeld("held-by", "other-cli", "1")).toBe(true);
    expect(await getMessageById("held-by")).toMatchObject({
      holderPeerId: "other-cli",
      status: "held",
    });
    expect(await advanceMessageStatus("held-by", "sent", "1")).toBe(true);
    expect(await markMessageHeld("held-by", "cli-peer", "1")).toBe(false);
    expect(await getMessageById("held-by")).toMatchObject({
      holderPeerId: null,
      status: "sent",
    });
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "failed-stay",
      sentAt: 100,
      status: "failed",
      text: "old",
    });
    expect(await markMessageHeld("failed-stay", "cli-peer", "1")).toBe(false);
    expect(await getMessageById("failed-stay")).toMatchObject({
      holderPeerId: null,
      status: "failed",
    });
  });
});

describe("contact device roster", () => {
  it("does not treat a second authorized device as keyChanged and keeps history", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "in",
      id: "kept",
      sentAt: 1,
      status: "received",
      text: "history",
    });
    await upsertContact({
      createdAt: 1,
      deviceKey: "cli-device",
      handle: "alice",
      owner: "owner",
      peerId: "cli-peer",
      qid: "1",
    });
    const contact = await getContactByQid("1");
    expect(contact).toMatchObject({
      deviceKey: "cli-device",
      keyChanged: false,
      peerId: "cli-peer",
      qid: "1",
    });
    expect(await listMessages("1")).toMatchObject([
      { id: "kept", text: "history" },
    ]);
  });
});

describe("message id dedupe", () => {
  it("ignores a second insert with the same message id from the same sender", async () => {
    const input: MessageInput = {
      contactQid: "1",
      direction: "in",
      id: "same-id",
      sentAt: 100,
      status: "received",
      text: "first",
    };

    expect(await insertMessage(input)).toBe(true);
    expect(
      await insertMessage({ ...input, status: "received", text: "duplicate" })
    ).toBe(false);
    expect(await listMessages("1")).toHaveLength(1);
    expect(await getMessageById("same-id")).toMatchObject({ text: "first" });
  });

  it("keeps the same message id from two senders", async () => {
    await upsertContact({
      createdAt: 2,
      deviceKey: "carol-device",
      handle: "carol",
      owner: "owner-2",
      peerId: "carol-peer",
      qid: "2",
    });
    const sharedId = "same-id";
    vi.setSystemTime(100);
    expect(
      await insertMessage({
        contactQid: "1",
        direction: "in",
        id: sharedId,
        sentAt: 100,
        status: "received",
        text: "from alice",
      })
    ).toBe(true);
    vi.setSystemTime(200);
    expect(
      await insertMessage({
        contactQid: "2",
        direction: "in",
        id: sharedId,
        sentAt: 100,
        status: "received",
        text: "from carol",
      })
    ).toBe(true);
    expect(await listMessages("1")).toMatchObject([
      { id: sharedId, text: "from alice" },
    ]);
    expect(await listMessages("2")).toMatchObject([
      { id: sharedId, text: "from carol" },
    ]);
    expect(await listConversations()).toMatchObject([
      { handle: "carol", latestMessageText: "from carol" },
      { handle: "alice", latestMessageText: "from alice" },
    ]);
  });

  it("does not let one contact's status change mutate another contact's row", async () => {
    await upsertContact({
      createdAt: 2,
      deviceKey: "carol-device",
      handle: "carol",
      owner: "owner-2",
      peerId: "carol-peer",
      qid: "2",
    });
    const sharedId = "shared-id";
    expect(
      await insertMessage({
        contactQid: "1",
        direction: "out",
        id: sharedId,
        sentAt: 100,
        status: "queued",
        text: "to alice",
      })
    ).toBe(true);
    expect(
      await insertMessage({
        contactQid: "2",
        direction: "in",
        id: sharedId,
        sentAt: 100,
        status: "received",
        text: "from carol",
      })
    ).toBe(true);
    expect(await advanceMessageStatus(sharedId, "sent", "1")).toBe(true);
    expect(await getMessageById(sharedId, "1")).toMatchObject({
      status: "sent",
      text: "to alice",
    });
    expect(await getMessageById(sharedId, "2")).toMatchObject({
      status: "received",
      text: "from carol",
    });
    expect(await markMessageHeld(sharedId, "cli-peer", "1")).toBe(false);
    expect(await getMessageById(sharedId, "2")).toMatchObject({
      status: "received",
      text: "from carol",
    });
  });

  it("scopes held and rejected-handoff updates to one contact", async () => {
    await upsertContact({
      createdAt: 2,
      deviceKey: "carol-device",
      handle: "carol",
      owner: "owner-2",
      peerId: "carol-peer",
      qid: "2",
    });
    const sharedId = "shared-held";
    expect(
      await insertMessage({
        contactQid: "1",
        direction: "out",
        id: sharedId,
        sentAt: 100,
        status: "queued",
        text: "to alice",
      })
    ).toBe(true);
    expect(
      await insertMessage({
        contactQid: "2",
        direction: "out",
        id: sharedId,
        sentAt: 100,
        status: "queued",
        text: "to carol",
      })
    ).toBe(true);
    expect(await markMessageHeld(sharedId, "cli-peer", "1")).toBe(true);
    expect(await getMessageById(sharedId, "1")).toMatchObject({
      holderPeerId: "cli-peer",
      status: "held",
    });
    expect(await getMessageById(sharedId, "2")).toMatchObject({
      holderPeerId: null,
      status: "queued",
    });
    await failRejectedHandoff(sharedId, "1");
    expect(await getMessageById(sharedId, "1")).toMatchObject({
      status: "failed",
    });
    expect(await getMessageById(sharedId, "2")).toMatchObject({
      status: "queued",
    });
  });
});

describe("holder inbox cursors", () => {
  it("upserts a cursor without moving it backward", async () => {
    expect(await getHolderInboxCursor("cli-peer")).toBe(0);
    await setHolderInboxCursor("cli-peer", 4);
    await setHolderInboxCursor("cli-peer", 2);
    expect(await getHolderInboxCursor("cli-peer")).toBe(4);
    await setHolderInboxCursor("cli-peer", 9);
    expect(await getHolderInboxCursor("cli-peer")).toBe(9);
    expect(await getHolderInboxCursor("other")).toBe(0);
  });

  it("keeps v4 messages when migrating to v6", async () => {
    const sqlite = await import("expo-sqlite");
    const database = await sqlite.openDatabaseAsync("migration");
    await database.execAsync(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE contacts(
        qid TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        device_key TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        key_changed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_read_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages(
        contact_qid TEXT NOT NULL REFERENCES contacts(qid) ON DELETE CASCADE,
        id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        text TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','received','held')),
        holder_peer_id TEXT,
        PRIMARY KEY (contact_qid, id)
      );
      INSERT INTO contacts(
        qid, handle, owner, device_key, peer_id, created_at
      ) VALUES ('1', 'alice', 'owner', 'device', 'peer', 1);
      INSERT INTO messages(
        contact_qid, id, direction, text, sent_at, received_at, status
      ) VALUES ('1', 'kept', 'in', 'stay', 10, 11, 'received');
      INSERT INTO messages(
        contact_qid, id, direction, text, sent_at, received_at, status
      ) VALUES ('1', 'legacy-sending', 'out', 'retry me', 12, 13, 'sending');
      PRAGMA user_version = 4;
    `);
    vi.resetModules();
    const restartedSqlite = await import("expo-sqlite");
    vi.spyOn(restartedSqlite, "openDatabaseAsync").mockResolvedValue(database);
    const migrated = await import("@/lib/db");
    expect(await migrated.getMessageById("kept", "1")).toMatchObject({
      status: "received",
      text: "stay",
    });
    expect(await migrated.getMessageById("legacy-sending", "1")).toMatchObject({
      attempts: 0,
      nextAttemptAt: 0,
      status: "queued",
      text: "retry me",
    });
    expect(await migrated.getHolderInboxCursor("holder")).toBe(0);
    await migrated.setHolderInboxCursor("holder", 3);
    await migrated.setHolderInboxCursor("holder", 1);
    expect(await migrated.getHolderInboxCursor("holder")).toBe(3);
    vi.restoreAllMocks();
    vi.resetModules();
  });
});
