import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteAll,
  failInterruptedMessages,
  getContactByQid,
  getMessageById,
  insertMessage,
  listConversations,
  listMessages,
  markConversationRead,
  markMessageHeld,
  upsertContact,
  advanceMessageStatus,
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
      status: "sending",
      text: "latest activity",
    });
    const conversations = await listConversations();
    expect(conversations.map(({ qid }) => qid)).toEqual(["2", "1"]);
  });
});

describe("interrupted sends", () => {
  it("makes only outgoing sending messages retryable without changing their contents", async () => {
    const inputs: MessageInput[] = [
      {
        contactQid: "1",
        direction: "out",
        id: "sending",
        sentAt: 100,
        status: "sending",
        text: "keep for retry",
      },
      {
        contactQid: "1",
        direction: "out",
        id: "sent",
        sentAt: 100,
        status: "sent",
        text: "delivered",
      },
      {
        contactQid: "1",
        direction: "out",
        id: "failed",
        sentAt: 100,
        status: "failed",
        text: "already failed",
      },
      {
        contactQid: "1",
        direction: "in",
        id: "received",
        sentAt: 100,
        status: "received",
        text: "incoming",
      },
      {
        contactQid: "1",
        direction: "in",
        id: "incoming-sending",
        sentAt: 100,
        status: "sending",
        text: "incoming state",
      },
    ];
    await Promise.all(inputs.map((input) => insertMessage(input)));
    const before = await listMessages("1");
    await failInterruptedMessages();
    const after = await listMessages("1");
    expect(after).toEqual(
      before.map((message) =>
        message.id === "sending" ? { ...message, status: "failed" } : message
      )
    );
    expect(await getMessageById("sending")).toEqual({
      ...before[0],
      status: "failed",
    });
    await failInterruptedMessages();
    expect(await listMessages("1")).toEqual(after);
  });

  it("keeps held messages pending across restart", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "held",
      sentAt: 100,
      status: "held",
      text: "waiting on CLI",
    });
    await failInterruptedMessages();
    expect(await getMessageById("held")).toMatchObject({ status: "held" });
  });
});

describe("delivery status transitions", () => {
  it("does not let a late held clobber sent", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "race",
      sentAt: 100,
      status: "sending",
      text: "hello",
    });
    expect(await advanceMessageStatus("race", "sent")).toBe(true);
    expect(await advanceMessageStatus("race", "held")).toBe(false);
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
    expect(await advanceMessageStatus("held-receipt", "sent")).toBe(true);
    expect(await getMessageById("held-receipt")).toMatchObject({
      status: "sent",
    });
  });

  it("promotes held to failed when the CLI permanently rejects the id", async () => {
    await insertMessage({
      contactQid: "1",
      direction: "out",
      id: "held-fail",
      sentAt: 100,
      status: "held",
      text: "hello",
    });
    expect(await advanceMessageStatus("held-fail", "failed")).toBe(true);
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
      status: "sending",
      text: "hello",
    });
    expect(await markMessageHeld("held-by", "cli-peer")).toBe(true);
    expect(await getMessageById("held-by")).toMatchObject({
      holderPeerId: "cli-peer",
      status: "held",
    });
    expect(await markMessageHeld("held-by", "other-cli")).toBe(true);
    expect(await getMessageById("held-by")).toMatchObject({
      holderPeerId: "other-cli",
      status: "held",
    });
    expect(await advanceMessageStatus("held-by", "sent")).toBe(true);
    expect(await markMessageHeld("held-by", "cli-peer")).toBe(false);
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
    expect(await markMessageHeld("failed-stay", "cli-peer")).toBe(false);
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
  it("ignores a second insert with the same message id", async () => {
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
});
