import { Effect } from "effect";

import { readBoundedChunks, writeFramedBytes } from "./stream-io.ts";
import type { HalfCloseStream } from "./stream-io.ts";
import {
  decodeSyncRequestV1,
  decodeSyncResponseV1,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
  MAX_SYNC_PAYLOAD_BYTES,
  SyncCodecError,
} from "./sync.ts";
import type { SyncRequestV1, SyncResponseV1 } from "./sync.ts";

/** Half-close duplex used by phone and CLI `/qop/sync/1`. Bind methods at the call. */
export type SyncStream = HalfCloseStream;

const syncError = (operation: "frame" | "oversized") =>
  new SyncCodecError({ operation });

/** Read one sync request from a half-closed stream (write, then closeWrite). */
export const readSyncRequest = Effect.fn("@qop/protocol/readSyncRequest")(
  (read: () => Promise<Uint8Array | undefined>) =>
    readBoundedChunks(read, MAX_SYNC_PAYLOAD_BYTES, syncError).pipe(
      Effect.flatMap(decodeSyncRequestV1)
    )
);

/** Read one sync response from a half-closed stream. */
export const readSyncResponse = Effect.fn("@qop/protocol/readSyncResponse")(
  (read: () => Promise<Uint8Array | undefined>) =>
    readBoundedChunks(read, MAX_SYNC_PAYLOAD_BYTES, syncError).pipe(
      Effect.flatMap(decodeSyncResponseV1)
    )
);

export const writeSyncRequest = Effect.fn("@qop/protocol/writeSyncRequest")(
  function* (
    write: (data: Uint8Array) => Promise<void>,
    closeWrite: () => void,
    frame: SyncRequestV1
  ) {
    const bytes = yield* encodeSyncRequestV1(frame);
    yield* writeFramedBytes(write, closeWrite, bytes, () => syncError("frame"));
  }
);

export const writeSyncResponse = Effect.fn("@qop/protocol/writeSyncResponse")(
  function* (
    write: (data: Uint8Array) => Promise<void>,
    closeWrite: () => void,
    frame: SyncResponseV1
  ) {
    const bytes = yield* encodeSyncResponseV1(frame);
    yield* writeFramedBytes(write, closeWrite, bytes, () => syncError("frame"));
  }
);

/** Write then closeWrite via bound stream methods (unbound `write` throws on minip2p). */
export const writeSyncRequestTo = (
  stream: Pick<SyncStream, "closeWrite" | "write">,
  frame: SyncRequestV1
) =>
  writeSyncRequest(
    (data) => stream.write(data),
    () => stream.closeWrite(),
    frame
  );

export const writeSyncResponseTo = (
  stream: Pick<SyncStream, "closeWrite" | "write">,
  frame: SyncResponseV1
) =>
  writeSyncResponse(
    (data) => stream.write(data),
    () => stream.closeWrite(),
    frame
  );

export const readSyncRequestFrom = (stream: Pick<SyncStream, "read">) =>
  readSyncRequest(() => stream.read());

export const readSyncResponseFrom = (stream: Pick<SyncStream, "read">) =>
  readSyncResponse(() => stream.read());
