import {
  readSyncResponseFrom,
  SYNC_POLL_MAX_IDS,
  SYNC_PROTOCOL,
  writeSyncRequestTo,
} from "@qop/protocol";
import type {
  InboxRecordV1,
  OutboxRecordV1,
  SyncReceiptV1,
  SyncRequestV1,
  SyncStream,
} from "@qop/protocol";
import { Effect } from "effect";

import type { Contact } from "./db";
import type { createPeerSessions } from "./p2p-sessions";

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

/** Permanent CLI reject — do not auto-retry; the phone should leave `held`. */
export const HANDOFF_REJECTED_MESSAGE = "CLI did not accept the handoff";

const HANDOFF_TRANSIENT_RETRIES = 1;

const openAuthorizedSyncStream = (
  endpoint: SyncEndpoint,
  holderPeerId: string,
  own: Pick<OwnDevice, "handle" | "qid">,
  sessions: ReturnType<typeof createPeerSessions>,
  timeoutMs: number
) =>
  Effect.gen(function* () {
    if (!endpoint.connectedPeers().includes(holderPeerId)) {
      yield* Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        try: () => endpoint.connect(holderPeerId, { timeoutMs }),
      });
    }
    // Path-up is not Identify. Opening sync before peerReady yields StreamClosedError.
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
    return yield* Effect.gen(function* () {
      sessions.opened(opened);
      yield* sessions.verify(opened, own.handle);
      if (!sessions.isVerified(opened, own.qid)) {
        return yield* Effect.fail(
          new Error("Sync connection is no longer authorized")
        );
      }
      return opened;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => {
              opened.reset();
            })
      )
    );
  });

const exchangeSyncRequest = (stream: SyncStream, request: SyncRequestV1) =>
  Effect.gen(function* () {
    yield* writeSyncRequestTo(stream, request);
    return yield* readSyncResponseFrom(stream);
  });

const withAuthorizedSyncStream = <A, E>(
  endpoint: SyncEndpoint,
  holderPeerId: string,
  own: Pick<OwnDevice, "handle" | "qid">,
  sessions: ReturnType<typeof createPeerSessions>,
  timeoutMs: number,
  use: (stream: SyncStream) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    openAuthorizedSyncStream(endpoint, holderPeerId, own, sessions, timeoutMs),
    use,
    (stream, exit) =>
      exit._tag === "Success"
        ? Effect.void
        : Effect.sync(() => {
            stream.reset();
          })
  );

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

export const performHandoff = ({
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
}): Promise<void> =>
  Effect.runPromise(
    withAuthorizedSyncStream(
      endpoint,
      holderPeerId,
      own,
      sessions,
      timeoutMs,
      (stream) =>
        Effect.gen(function* () {
          const response = yield* exchangeSyncRequest(stream, {
            composedBy,
            record,
            type: "handoff",
            v: 1,
          });
          if (response.type !== "held") {
            return yield* Effect.fail(new Error(HANDOFF_REJECTED_MESSAGE));
          }
          if (response.id !== record.frame.id) {
            return yield* Effect.fail(
              new Error("Sync held does not match the message id")
            );
          }
        })
    ).pipe(
      Effect.retry({
        times: HANDOFF_TRANSIENT_RETRIES,
        while: (error) =>
          !signal?.aborted &&
          !(
            error instanceof Error && error.message === HANDOFF_REJECTED_MESSAGE
          ),
      }),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new Error("Timed out waiting for sync response")),
      })
    ),
    { signal }
  );

const pollHeldChunk = ({
  endpoint,
  holderPeerId,
  ids,
  own,
  sessions,
  signal,
  timeoutMs,
}: PerformSyncInput & {
  readonly ids: readonly string[];
}): Promise<readonly SyncReceiptV1[]> =>
  Effect.runPromise(
    withAuthorizedSyncStream(
      endpoint,
      holderPeerId,
      own,
      sessions,
      timeoutMs,
      (stream) =>
        Effect.gen(function* () {
          const response = yield* exchangeSyncRequest(stream, {
            ids: [...ids],
            type: "poll",
            v: 1,
          });
          if (response.type !== "receipts") {
            return yield* Effect.fail(new Error("CLI did not return receipts"));
          }
          return response.receipts;
        })
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new Error("Timed out waiting for sync response")),
      })
    ),
    { signal }
  );

export const performCatchup = ({
  after,
  endpoint,
  holderPeerId,
  own,
  sessions,
  signal,
  timeoutMs,
}: PerformSyncInput & {
  readonly after: number;
}): Promise<
  readonly { readonly record: InboxRecordV1; readonly seq: number }[]
> =>
  Effect.runPromise(
    withAuthorizedSyncStream(
      endpoint,
      holderPeerId,
      own,
      sessions,
      timeoutMs,
      (stream) =>
        Effect.gen(function* () {
          const response = yield* exchangeSyncRequest(stream, {
            after,
            type: "catchup",
            v: 1,
          });
          if (response.type === "error") {
            return yield* Effect.fail(new Error("CLI rejected inbox catch-up"));
          }
          if (response.type !== "inbox") {
            return yield* Effect.fail(new Error("CLI did not return inbox"));
          }
          return response.records;
        })
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new Error("Timed out waiting for sync response")),
      })
    ),
    { signal }
  );

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
