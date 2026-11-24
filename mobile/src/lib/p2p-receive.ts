import { deviceKeyBytesFromPeerId } from "@qop/identity";
import { MAX_CHAT_ENVELOPE_BYTES } from "@qop/protocol/chat-envelope";
import type { ChatCipher } from "@qop/protocol/chat-envelope";

import { CHAT_PROTOCOL } from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import type { Contact } from "./db";
import { withTimeout } from "./p2p-send";
import type { PeerConnection } from "./p2p-sessions";

interface ReceiveStream extends PeerConnection {
  readonly protocolId: string;
  readonly read: () => Promise<Uint8Array | undefined>;
}

// Stream chunks are ordered, so each read must finish before the next starts.
const readStreamChunks = async (
  stream: Pick<ReceiveStream, "read">,
  chunks: Uint8Array[] = [],
  byteLength = 0
): Promise<{ readonly byteLength: number; readonly chunks: Uint8Array[] }> => {
  const chunk = await stream.read();

  if (!chunk) {
    return { byteLength, chunks };
  }

  const nextLength = byteLength + chunk.byteLength;

  if (nextLength > MAX_CHAT_ENVELOPE_BYTES) {
    throw new Error("Chat envelope exceeds its size limit");
  }

  chunks.push(chunk);

  return readStreamChunks(stream, chunks, nextLength);
};

const readStream = async (stream: Pick<ReceiveStream, "read">) => {
  const { byteLength, chunks } = await readStreamChunks(stream);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

export const readVerifiedChat = (
  stream: ReceiveStream,
  resolveSender: (
    connection: PeerConnection,
    fromHandle: string
  ) => Promise<Contact | null>,
  timeoutMs: number,
  cipher: Pick<ChatCipher, "open">
): Promise<{ readonly contact: Contact; readonly frame: ChatFrame } | null> =>
  withTimeout(
    (async () => {
      if (stream.protocolId !== CHAT_PROTOCOL) {
        return null;
      }

      const frame = await cipher.open(
        await readStream(stream),
        deviceKeyBytesFromPeerId(stream.peerId)
      );

      const contact = await resolveSender(stream, frame.fromHandle);

      return contact ? { contact, frame } : null;
    })(),
    timeoutMs,
    "Timed out receiving chat frame"
  );
