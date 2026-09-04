import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteAll,
  insertMessage,
  listConversations,
  listMessages,
  markConversationRead,
  upsertContact,
} from "@/lib/db";

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
      status: "sending",
      text: "latest activity",
    });
    const conversations = await listConversations();
    expect(conversations.map(({ qid }) => qid)).toEqual(["2", "1"]);
  });
});
