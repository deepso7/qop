import {
  CHAT_PROTOCOL,
  assertAckMatches,
  decodeAck,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import type { Contact } from "./db";

interface SendStream {
  readonly closeWrite: () => void;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => void;
}

interface SendEndpoint {
  readonly connect: (
    peerId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly openStream: (
    peerId: string,
    protocolId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<SendStream>;
}

export interface PerformSendInput {
  readonly contact: Pick<Contact, "peerId">;
  readonly endpoint: SendEndpoint;
  readonly frame: ChatFrame;
  readonly timeoutMs: number;
}

const concatChunks = (chunks: readonly Uint8Array[], byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readAck = async (stream: SendStream) => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    // Stream chunks are ordered, so reads cannot run concurrently.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const chunk = await stream.read();
    if (!chunk) {
      break;
    }
    byteLength += chunk.byteLength;
    if (byteLength > MAX_CHAT_PAYLOAD_BYTES) {
      throw new Error("Chat ack exceeds 16 KB");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) {
    throw new Error("Chat peer closed without an ack");
  }
  return decodeAck(concatChunks(chunks, byteLength));
};

const withTimeout = <A>(promise: Promise<A>, timeoutMs: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- A timer needs a rejecting promise for Promise.race.
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for chat ack")),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
};

export const performSend = async ({
  contact,
  endpoint,
  frame,
  timeoutMs,
}: PerformSendInput): Promise<void> => {
  await endpoint.connect(contact.peerId, { timeoutMs: 15_000 });
  const stream = await endpoint.openStream(contact.peerId, CHAT_PROTOCOL);
  try {
    stream.write(encodeFrame(frame));
    stream.closeWrite();
    const ack = await withTimeout(readAck(stream), timeoutMs);
    assertAckMatches(ack, frame.id);
  } catch (error) {
    stream.reset();
    throw error;
  }
};
