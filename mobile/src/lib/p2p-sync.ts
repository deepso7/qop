import {
  assertHeldMatches,
  decodeSyncResponseV1,
  encodeSyncRequestV1,
  MAX_SYNC_PAYLOAD_BYTES,
  SYNC_POLL_MAX_IDS,
  SYNC_PROTOCOL,
} from "@qop/protocol";
import type { OutboxRecordV1, SyncReceiptV1 } from "@qop/protocol";
import { Effect } from "effect";

import type { Contact } from "./db";
import type { createPeerSessions, PeerConnection } from "./p2p-sessions";

interface SyncStream extends PeerConnection {
  readonly closeWrite: () => void;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => void;
}

interface SyncEndpoint {
  readonly connectedPeers: () => readonly string[];
  readonly connect: (
    peerId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly openStream: (
    peerId: string,
    protocolId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<SyncStream>;
  readonly waitPeerReady: (
    peerId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<{ readonly peerId?: string }>;
}

export interface OwnDevice {
  readonly deviceKey: string;
  readonly handle: string;
  readonly peerId: string;
  readonly qid: string;
}

export interface PerformSyncInput {
  readonly endpoint: SyncEndpoint;
  readonly holderPeerId: string;
  readonly own: Pick<OwnDevice, "handle" | "qid">;
  readonly sessions: ReturnType<typeof createPeerSessions>;
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

const readResponseChunks = async (
  stream: SyncStream,
  chunks: Uint8Array[] = [],
  byteLength = 0
): Promise<{ readonly byteLength: number; readonly chunks: Uint8Array[] }> => {
  const chunk = await stream.read();
  if (!chunk) {
    return { byteLength, chunks };
  }
  const nextLength = byteLength + chunk.byteLength;
  if (nextLength > MAX_SYNC_PAYLOAD_BYTES) {
    throw new Error("Sync frame exceeds 16 KB");
  }
  chunks.push(chunk);
  return readResponseChunks(stream, chunks, nextLength);
};

const readResponseBytes = async (stream: SyncStream) => {
  const { byteLength, chunks } = await readResponseChunks(stream);
  if (byteLength === 0) {
    throw new Error("Sync peer closed without a response");
  }
  return concatChunks(chunks, byteLength);
};

export const otherOwnDevicePeerIds = (
  ownPeerId: string,
  devices: readonly { readonly peerId: string }[]
) =>
  devices
    .filter((device) => device.peerId !== ownPeerId)
    .map((device) => device.peerId);

export const pickHolderPeerId = (
  holderPeerIds: readonly string[],
  connectedPeerIds: readonly string[]
) =>
  holderPeerIds.find((peerId) => connectedPeerIds.includes(peerId)) ??
  holderPeerIds[0];

/** Split poll ids so every held message is requested, not only the oldest 32. */
export const chunkSyncPollIds = (ids: readonly string[]) => {
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += SYNC_POLL_MAX_IDS) {
    chunks.push(ids.slice(offset, offset + SYNC_POLL_MAX_IDS));
  }
  return chunks;
};

export const outgoingHandoffRecord = ({
  contact,
  fromHandle,
  id,
  now,
  sentAt,
  text,
}: {
  readonly contact: Pick<Contact, "handle" | "qid">;
  readonly fromHandle: string;
  readonly id: string;
  readonly now: number;
  readonly sentAt: number;
  readonly text: string;
}): OutboxRecordV1 => ({
  attempts: 0,
  frame: {
    fromHandle,
    id,
    sentAt,
    text,
    v: 1,
  },
  lastError: null,
  nextAttemptAt: now,
  queuedAt: sentAt,
  status: "queued",
  toHandle: contact.handle,
  toQid: contact.qid,
  updatedAt: now,
  v: 1,
});

export const performHandoff = async ({
  composedBy,
  endpoint,
  holderPeerId,
  own,
  record,
  sessions,
  signal,
  timeoutMs,
}: PerformSyncInput & {
  readonly composedBy: string;
  readonly record: OutboxRecordV1;
}): Promise<void> => {
  let stream: SyncStream | undefined;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        if (!endpoint.connectedPeers().includes(holderPeerId)) {
          yield* Effect.tryPromise({
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
            try: () => endpoint.connect(holderPeerId, { timeoutMs }),
          });
        }
        yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => endpoint.waitPeerReady(holderPeerId, { timeoutMs }),
        });
        const opened = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: async (abortSignal) => {
            const lateStream = await endpoint.openStream(
              holderPeerId,
              SYNC_PROTOCOL,
              { timeoutMs }
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
        yield* sessions.verify(opened, own.handle);
        if (!sessions.isVerified(opened, own.qid)) {
          return yield* Effect.fail(
            new Error("Sync connection is no longer authorized")
          );
        }
        const bytes = yield* encodeSyncRequestV1({
          composedBy,
          record,
          type: "handoff",
          v: 1,
        });
        opened.write(bytes);
        opened.closeWrite();
        const responseBytes = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => readResponseBytes(opened),
        });
        const response = yield* decodeSyncResponseV1(responseBytes);
        if (response.type !== "held") {
          return yield* Effect.fail(
            new Error("CLI did not accept the handoff")
          );
        }
        assertHeldMatches(response, record.frame.id);
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(new Error("Timed out waiting for sync response")),
        })
      ),
      { signal }
    );
  } catch (error) {
    stream?.reset();
    throw error;
  }
};

const pollHeldChunk = async ({
  endpoint,
  holderPeerId,
  ids,
  own,
  sessions,
  signal,
  timeoutMs,
}: PerformSyncInput & {
  readonly ids: readonly string[];
}): Promise<readonly SyncReceiptV1[]> => {
  let stream: SyncStream | undefined;
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        if (!endpoint.connectedPeers().includes(holderPeerId)) {
          yield* Effect.tryPromise({
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
            try: () => endpoint.connect(holderPeerId, { timeoutMs }),
          });
        }
        yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => endpoint.waitPeerReady(holderPeerId, { timeoutMs }),
        });
        const opened = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: async (abortSignal) => {
            const lateStream = await endpoint.openStream(
              holderPeerId,
              SYNC_PROTOCOL,
              { timeoutMs }
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
        yield* sessions.verify(opened, own.handle);
        if (!sessions.isVerified(opened, own.qid)) {
          return yield* Effect.fail(
            new Error("Sync connection is no longer authorized")
          );
        }
        const bytes = yield* encodeSyncRequestV1({
          ids: [...ids],
          type: "poll",
          v: 1,
        });
        opened.write(bytes);
        opened.closeWrite();
        const responseBytes = yield* Effect.tryPromise({
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
          try: () => readResponseBytes(opened),
        });
        const response = yield* decodeSyncResponseV1(responseBytes);
        if (response.type !== "receipts") {
          return yield* Effect.fail(new Error("CLI did not return receipts"));
        }
        return response.receipts;
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(new Error("Timed out waiting for sync response")),
        })
      ),
      { signal }
    );
  } catch (error) {
    stream?.reset();
    throw error;
  }
};

export const performPoll = ({
  endpoint,
  holderPeerId,
  ids,
  own,
  sessions,
  signal,
  timeoutMs,
}: PerformSyncInput & {
  readonly ids: readonly string[];
}): Promise<readonly SyncReceiptV1[]> => {
  const pollChunks = async (
    chunks: readonly (readonly string[])[],
    offset = 0
  ): Promise<readonly SyncReceiptV1[]> => {
    const pollIds = chunks[offset];
    if (!pollIds) {
      return [];
    }
    const receipts = await pollHeldChunk({
      endpoint,
      holderPeerId,
      ids: pollIds,
      own,
      sessions,
      signal,
      timeoutMs,
    });
    return [...receipts, ...(await pollChunks(chunks, offset + 1))];
  };
  return pollChunks(chunkSyncPollIds(ids));
};
