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
  readonly waitPeerReady: (
    peerId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<{ readonly peerId?: string }>;
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

// Stream chunks are ordered, so each read must finish before the next starts.
const readAckChunks = async (
  stream: SendStream,
  chunks: Uint8Array[] = [],
  byteLength = 0
): Promise<{ readonly byteLength: number; readonly chunks: Uint8Array[] }> => {
  const chunk = await stream.read();
  if (!chunk) {
    return { byteLength, chunks };
  }
  const nextLength = byteLength + chunk.byteLength;
  if (nextLength > MAX_CHAT_PAYLOAD_BYTES) {
    throw new Error("Chat ack exceeds 16 KB");
  }
  chunks.push(chunk);
  return readAckChunks(stream, chunks, nextLength);
};

const readAck = async (stream: SendStream) => {
  const { byteLength, chunks } = await readAckChunks(stream);
  if (byteLength === 0) {
    throw new Error("Chat peer closed without an ack");
  }
  return decodeAck(concatChunks(chunks, byteLength));
};

export const withTimeout = <A>(
  promise: Promise<A>,
  timeoutMs: number,
  message = "Timed out waiting for chat ack"
): Promise<A> =>
  Effect.runPromise(
    Effect.tryPromise({
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
      try: () => promise,
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new Error(message)),
      })
    )
  );

const asSendError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

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
        const startedAt = Date.now();
        const remainingMs = () =>
          Math.max(0, timeoutMs - (Date.now() - startedAt));
        const peerIds = yield* sessions.recipientPeerIds(contact).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(new Error("Timed out waiting for chat ack")),
          })
        );
        let lastError: Error | undefined;
        const sendToPeer = (peerId: string, attemptTimeout: number) => {
          const mark = { committed: false };
          const program = Effect.gen(function* () {
            if (!endpoint.connectedPeers().includes(peerId)) {
              yield* Effect.tryPromise({
                catch: asSendError,
                try: () =>
                  endpoint.connect(peerId, { timeoutMs: attemptTimeout }),
              });
            }
            // Path-up is not Identify. Opening chat before peerReady yields StreamClosedError.
            yield* Effect.tryPromise({
              catch: asSendError,
              try: () =>
                endpoint.waitPeerReady(peerId, { timeoutMs: attemptTimeout }),
            });
            const opened = yield* Effect.tryPromise({
              catch: asSendError,
              try: async (abortSignal) => {
                const lateStream = await endpoint.openStream(
                  peerId,
                  CHAT_PROTOCOL,
                  {
                    timeoutMs: attemptTimeout,
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
            sessions.opened(opened);
            yield* sessions.verify(opened, contact.handle);
            mark.committed = true;
            if (!sessions.isVerified(opened, contact.qid)) {
              return yield* Effect.fail(
                new Error("Chat connection is no longer authorized")
              );
            }
            opened.write(encodeFrame(frame));
            opened.closeWrite();
            const ack = yield* Effect.tryPromise({
              catch: asSendError,
              try: () => readAck(opened),
            });
            assertAckMatches(ack, frame.id);
          }).pipe(
            Effect.timeoutOrElse({
              duration: attemptTimeout,
              orElse: () =>
                Effect.fail(new Error("Timed out waiting for chat ack")),
            })
          );
          return { mark, program };
        };
        for (const peerId of peerIds) {
          const budget = remainingMs();
          if (budget <= 0) {
            return yield* Effect.fail(
              lastError ?? new Error("Timed out waiting for chat ack")
            );
          }
          const { mark, program } = sendToPeer(peerId, budget);
          const result = yield* program.pipe(Effect.result);
          if (result._tag === "Success") {
            return;
          }
          stream?.reset();
          stream = undefined;
          lastError = asSendError(result.failure);
          if (mark.committed) {
            return yield* Effect.fail(lastError);
          }
        }
        return yield* Effect.fail(
          lastError ?? new Error("No reachable recipient device")
        );
      }),
      { signal }
    );
  } catch (error) {
    stream?.reset();
    throw error;
  }
};
