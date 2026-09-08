import { expect, it, vi } from "vitest";

import {
  CHAT_PROTOCOL,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "@/lib/chat-wire";
import type { Contact } from "@/lib/db";
import { readVerifiedChat } from "@/lib/p2p-receive";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";
const frame = {
  fromHandle: "alice",
  id,
  sentAt: 1,
  text: "hello",
  v: 1 as const,
};
const contact: Contact = {
  createdAt: 1,
  deviceKey: "device",
  handle: "alice",
  keyChanged: false,
  lastReadAt: 0,
  owner: "owner",
  peerId: "peer-alice",
  qid: "1",
};

const eofRead = async (): Promise<undefined> => {
  await Promise.resolve();
};

const frameChunks = (bytes: Uint8Array) => {
  const chunks: (Uint8Array | undefined)[] = [bytes, undefined];
  return () => Promise.resolve(chunks.shift());
};

const makeStream = (
  read: () => Promise<Uint8Array | undefined>,
  protocolId = CHAT_PROTOCOL
) => ({
  connId: 1,
  peerId: "peer-alice",
  protocolId,
  read,
});

it("passes the actual transport connection to sender verification", async () => {
  const stream = makeStream(frameChunks(encodeFrame(frame)));
  const verify = vi.fn(() => Promise.resolve(null));
  expect(await readVerifiedChat(stream, verify, 100)).toBeNull();
  expect(verify).toHaveBeenCalledWith(stream, "alice");
});

it("returns the verified frame and contact", async () => {
  const stream = makeStream(frameChunks(encodeFrame(frame)));
  await expect(
    readVerifiedChat(stream, () => Promise.resolve(contact), 100)
  ).resolves.toEqual({ contact, frame });
});

it("rejects a non-chat protocol without reading", async () => {
  const read = vi.fn(eofRead);
  expect(
    await readVerifiedChat(
      makeStream(read, "/other/1"),
      () => Promise.resolve(contact),
      100
    )
  ).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it("rejects an empty EOF frame payload", async () => {
  await expect(
    readVerifiedChat(makeStream(eofRead), () => Promise.resolve(null), 100)
  ).rejects.toThrow();
});

it("rejects a streaming frame that exceeds the payload limit", async () => {
  const oversized = new Uint8Array(MAX_CHAT_PAYLOAD_BYTES + 1);
  await expect(
    readVerifiedChat(
      makeStream(frameChunks(oversized)),
      () => Promise.resolve(null),
      100
    )
  ).rejects.toThrow("Chat frame exceeds 16 KB");
});

it("rejects a malformed frame payload", async () => {
  await expect(
    readVerifiedChat(
      makeStream(frameChunks(new TextEncoder().encode("{"))),
      () => Promise.resolve(null),
      100
    )
  ).rejects.toThrow();
});

it("times out when the peer never finishes the frame", async () => {
  const hung = Promise.withResolvers<Uint8Array | undefined>();
  await expect(
    readVerifiedChat(
      makeStream(() => hung.promise),
      () => Promise.resolve(null),
      5
    )
  ).rejects.toThrow("Timed out receiving chat frame");
});
