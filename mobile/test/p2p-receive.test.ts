import { deviceKeyBytesFromPeerId } from "@qop/identity";
import {
  createChatCipher,
  MAX_CHAT_ENVELOPE_BYTES,
} from "@qop/protocol/chat-envelope";
import { expect, it, vi } from "vitest";

import { CHAT_PROTOCOL } from "@/lib/chat-wire";
import type { Contact } from "@/lib/db";
import { readVerifiedChat as readEncryptedChat } from "@/lib/p2p-receive";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";
const peerAlice = "12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5";
const peerBob = "12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN";
const alice = createChatCipher(new Uint8Array(32).fill(1));
const bob = createChatCipher(new Uint8Array(32));

const readVerifiedChat = (
  stream: Parameters<typeof readEncryptedChat>[0],
  verify: Parameters<typeof readEncryptedChat>[1],
  timeoutMs: number
) => readEncryptedChat(stream, verify, timeoutMs, bob);

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
  peerId: peerAlice,
  qid: "1",
};

// Promise.resolve(undefined) without tripping unicorn/no-useless-undefined.
const resolvedUndefined = async (): Promise<undefined> => {
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
  peerId: peerAlice,
  protocolId,
  read,
});

it("passes the actual transport connection to sender verification", async () => {
  const stream = makeStream(
    frameChunks(await alice.seal(frame, deviceKeyBytesFromPeerId(peerBob)))
  );

  const verify = vi.fn(() => Promise.resolve(null));
  expect(await readVerifiedChat(stream, verify, 100)).toBeNull();
  expect(verify).toHaveBeenCalledWith(stream, "alice");
});

it("returns the verified frame and contact", async () => {
  const stream = makeStream(
    frameChunks(await alice.seal(frame, deviceKeyBytesFromPeerId(peerBob)))
  );

  await expect(
    readVerifiedChat(stream, () => Promise.resolve(contact), 100)
  ).resolves.toEqual({ contact, frame });
});

it("rejects a non-chat protocol without reading", async () => {
  const read = vi.fn(resolvedUndefined);
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
    readVerifiedChat(
      makeStream(resolvedUndefined),
      () => Promise.resolve(null),
      100
    )
  ).rejects.toThrow();
});

it("rejects a streaming frame that exceeds the payload limit", async () => {
  const oversized = new Uint8Array(MAX_CHAT_ENVELOPE_BYTES + 1);
  await expect(
    readVerifiedChat(
      makeStream(frameChunks(oversized)),
      () => Promise.resolve(null),
      100
    )
  ).rejects.toThrow("Chat envelope exceeds its size limit");
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
