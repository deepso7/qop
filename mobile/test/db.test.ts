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
  it("orders delayed delivery by send time while counting it as unread", async () => {
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
    expect(messages.map(({ id }) => id)).toEqual(["earlier", "later"]);
    expect(await listConversations()).toMatchObject([
      { latestMessageText: "second", latestMessageTime: 20, unreadCount: 1 },
    ]);
    await markConversationRead("1");
    expect(await listConversations()).toMatchObject([{ unreadCount: 0 }]);
  });
});
