import { expect, it, vi } from "vitest";

import { CHAT_PROTOCOL, encodeFrame } from "@/lib/chat-wire";
import { readVerifiedChat } from "@/lib/p2p-receive";

it("passes the actual transport connection to sender verification", async () => {
  const bytes = encodeFrame({
    fromHandle: "alice",
    id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
    sentAt: 1,
    text: "hello",
    v: 1,
  });
  const chunks = [bytes, undefined];
  const stream = {
    connId: 7,
    peerId: "peer-alice",
    protocolId: CHAT_PROTOCOL,
    read: () => Promise.resolve(chunks.shift()),
  };
  const verify = vi.fn(() => Promise.resolve(null));
  expect(await readVerifiedChat(stream, verify, 100)).toBeNull();
  expect(verify).toHaveBeenCalledWith(stream, "alice");
});
