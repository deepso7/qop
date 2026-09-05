import { Effect } from "effect";

import {
  CHAT_PROTOCOL,
  assertAckMatches,
  decodeAck,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import type { Contact } from "./db";
import type { createPeerSessions, PeerConnection } from "./p2p-sessions";

interface SendStream extends PeerConnection {
  readonly closeWrite: () => void;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => void;
}

interface SendEndpoint {
  readonly connectedPeers: () => readonly string[];
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
  readonly contact: Pick<Contact, "handle" | "qid">;
  readonly sessions: ReturnType<typeof createPeerSessions>;
  readonly endpoint: SendEndpoint;
  readonly frame: ChatFrame;
  readonly signal?: AbortSignal;
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

export const withTimeout = <A>(
  promise: Promise<A>,
  timeoutMs: number,
  message = "Timed out waiting for chat ack"
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- A timer needs a rejecting promise for Promise.race.
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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
  signal,
  sessions,
  timeoutMs,
}: PerformSendInput): Promise<void> => {
  let stream: SendStream | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const peerId = yield* sessions.recipientPeerId(contact);
        if (!endpoint.connectedPeers().includes(peerId)) {
          yield* Effect.tryPromise({
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
            try: () => endpoint.connect(peerId, { timeoutMs }),
          });
        }
        const opened = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: async (abortSignal) => {
            const lateStream = await endpoint.openStream(
              peerId,
              CHAT_PROTOCOL,
              {
                timeoutMs,
              }
            );
            if (abortSignal.aborted) {
              lateStream.reset();
              throw abortSignal.reason;
            }
            return lateStream;
          },
        });
        stream = opened;
        yield* sessions.verify(opened, contact.handle);
        if (!sessions.isVerified(opened, contact.qid)) {
          return yield* Effect.fail(
            new Error("Chat connection is no longer authorized")
          );
        }
        opened.write(encodeFrame(frame));
        opened.closeWrite();
        const ack = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => readAck(opened),
        });
        assertAckMatches(ack, frame.id);
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(new Error("Timed out waiting for chat ack")),
        })
      ),
      { signal }
    );
  } catch (error) {
    stream?.reset();
    throw error;
  }
};
