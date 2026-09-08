import {
  CHAT_PROTOCOL,
  decodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "./chat-wire";
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
  if (nextLength > MAX_CHAT_PAYLOAD_BYTES) {
    throw new Error("Chat frame exceeds 16 KB");
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
  timeoutMs: number
): Promise<{ readonly contact: Contact; readonly frame: ChatFrame } | null> =>
  withTimeout(
    (async () => {
      if (stream.protocolId !== CHAT_PROTOCOL) {
        return null;
      }
      const frame = decodeFrame(await readStream(stream));
      const contact = await resolveSender(stream, frame.fromHandle);
      return contact ? { contact, frame } : null;
    })(),
    timeoutMs,
    "Timed out receiving chat frame"
  );
