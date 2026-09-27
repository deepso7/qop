import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import {
  encodeSyncResponseV1,
  PeerVerificationError,
  readSyncRequestFrom,
  writeSyncResponseTo,
} from "@qop/protocol";
import type {
  OutboxRecordV1,
  PeerConnection,
  SessionContact,
  SyncErrorV1,
  SyncInboxItemV1,
  SyncResponseV1,
  SyncStream,
} from "@qop/protocol";
import { Effect, Schema } from "effect";

import type { CliOutboxStoreError, InboxPage } from "./outbox-store.ts";

export interface CliSyncIdentity {
  readonly handle: string;
  readonly qid: string;
}

/** Row cap before the byte packer trims a catch-up page. */
const INBOX_CATCHUP_ROW_LIMIT = 64;

export interface CliSyncStore {
  readonly enqueue: (
    record: OutboxRecordV1
  ) => Effect.Effect<OutboxRecordV1, CliOutboxStoreError>;
  readonly getByIds: (
    ids: readonly string[]
  ) => Effect.Effect<readonly OutboxRecordV1[], CliOutboxStoreError>;
  readonly inboxAfter: (
    seq: number,
    limit: number
  ) => Effect.Effect<InboxPage, CliOutboxStoreError>;
}

interface SyncSessions {
  readonly isVerified: (connection: PeerConnection, qid: string) => boolean;
  readonly opened: (connection: PeerConnection) => void;
  readonly verify: (
    connection: PeerConnection,
    handle: string
  ) => Effect.Effect<SessionContact, PeerVerificationError>;
}

const invalid: SyncErrorV1 = { reason: "invalid", type: "error", v: 1 };
const conflict: SyncErrorV1 = { reason: "conflict", type: "error", v: 1 };
const unavailable: SyncErrorV1 = {
  reason: "unavailable",
  type: "error",
  v: 1,
};

const reply = (stream: SyncStream, frame: SyncResponseV1) =>
  writeSyncResponseTo(stream, frame);

const deviceKeyHexForPeer = (peerId: string) =>
  Schema.decodeUnknownEffect(PeerId)(peerId).pipe(
    Effect.flatMap(deviceKeyFromPeerId),
    Effect.flatMap((deviceKey) => Schema.encodeEffect(Hex32)(deviceKey)),
    Effect.mapError(() => new PeerVerificationError({ operation: "identity" }))
  );

const inboxFrame = ({ lastSeq, records }: InboxPage) => ({
  lastSeq,
  records,
  type: "inbox" as const,
  v: 1 as const,
});

/** Greedy by encoded size. Always keeps the first row; later rows stop at 64 KB. */
const packInbox = Effect.fn("qop.sync.packInbox")(function* ({
  lastSeq,
  records,
}: InboxPage) {
  const packed: SyncInboxItemV1[] = [];
  for (const row of records) {
    const encoded = yield* encodeSyncResponseV1(
      inboxFrame({ lastSeq, records: [...packed, row] })
    ).pipe(Effect.result);
    if (encoded._tag === "Failure") {
      if (encoded.failure.operation === "oversized" && packed.length > 0) {
        break;
      }
      return yield* encoded.failure;
    }
    packed.push(row);
  }
  return inboxFrame({ lastSeq, records: packed });
});

const acceptHandoff = Effect.fn("qop.sync.acceptHandoff")(function* (
  identity: CliSyncIdentity,
  record: OutboxRecordV1,
  composedBy: string,
  peerDeviceKey: string,
  store: CliSyncStore
) {
  if (
    composedBy !== peerDeviceKey ||
    record.frame.fromHandle !== identity.handle ||
    record.toQid === identity.qid ||
    record.status !== "queued"
  ) {
    return invalid;
  }
  return yield* store.enqueue(record).pipe(
    Effect.map((saved) => {
      // Idempotent enqueue returns the existing row. Terminal `failed` must
      // not look like a live hold — poll only receipts `sent`.
      if (saved.status === "failed") {
        return invalid;
      }
      return {
        id: saved.frame.id,
        type: "held" as const,
        v: 1 as const,
      };
    }),
    // Say so instead of resetting: a reset after the request looks like a
    // lost `held`, and the phone would treat this CLI as holding it.
    Effect.catchTag("CliOutboxStoreError", (error) =>
      Effect.succeed(error.operation === "conflict" ? conflict : unavailable)
    )
  );
});

/** Own-device `/qop/sync/1`: persist handoff before `held`; receipts after Bob ACK. */
export const handleInboundSyncStream = Effect.fn("qop.handleInboundSyncStream")(
  function* (
    stream: SyncStream,
    sessions: SyncSessions,
    identity: CliSyncIdentity,
    store: CliSyncStore,
    isLive?: () => boolean
  ) {
    sessions.opened(stream);
    const contact = yield* sessions.verify(stream, identity.handle);
    if (
      contact.qid !== identity.qid ||
      !sessions.isVerified(stream, identity.qid)
    ) {
      return yield* new PeerVerificationError({ operation: "identity" });
    }
    const request = yield* readSyncRequestFrom(stream);
    // Recheck at the persist/held boundary: SIGCONT/stall can invalidate
    // during the inbound read, same as chat send-boundary.
    if (isLive?.() === false || !sessions.isVerified(stream, identity.qid)) {
      stream.reset();
      return yield* new PeerVerificationError({ operation: "identity" });
    }
    const peerDeviceKey = yield* deviceKeyHexForPeer(stream.peerId);
    if (request.type === "handoff") {
      const response = yield* acceptHandoff(
        identity,
        request.record,
        request.composedBy,
        peerDeviceKey,
        store
      );
      yield* reply(stream, response);
      return response;
    }
    if (request.type === "catchup") {
      const page = yield* store
        .inboxAfter(request.after, INBOX_CATCHUP_ROW_LIMIT)
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              stream.reset();
            })
          )
        );
      const response = yield* packInbox(page);
      yield* reply(stream, response);
      return response;
    }
    const records = yield* store.getByIds(request.ids);
    const receipts = records
      .filter((record) => record.status === "sent")
      .map((record) => ({
        deliveredAt: record.updatedAt,
        id: record.frame.id,
        toQid: record.toQid,
      }));
    const response = {
      receipts,
      type: "receipts" as const,
      v: 1 as const,
    };
    yield* reply(stream, response);
    return response;
  }
);
