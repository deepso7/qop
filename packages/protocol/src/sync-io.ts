import { Effect } from "effect";

import {
  decodeSyncRequestV1,
  decodeSyncResponseV1,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
  MAX_SYNC_PAYLOAD_BYTES,
  SyncCodecError,
} from "./sync.ts";
import type { SyncRequestV1, SyncResponseV1 } from "./sync.ts";

const concatChunks = (chunks: readonly Uint8Array[], byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readChunks = (
  read: () => Promise<Uint8Array | undefined>,
  chunks: Uint8Array[] = [],
  byteLength = 0
): Effect.Effect<Uint8Array, SyncCodecError> =>
  Effect.gen(function* () {
    const chunk = yield* Effect.tryPromise({
      catch: () => new SyncCodecError({ operation: "frame" }),
      try: () => read(),
    });
    if (!chunk) {
      return concatChunks(chunks, byteLength);
    }
    const nextLength = byteLength + chunk.byteLength;
    if (nextLength > MAX_SYNC_PAYLOAD_BYTES) {
      return yield* new SyncCodecError({ operation: "oversized" });
    }
    chunks.push(chunk);
    return yield* readChunks(read, chunks, nextLength);
  });

/** Read one sync request from a half-closed stream (write, then closeWrite). */
export const readSyncRequest = Effect.fn("@qop/protocol/readSyncRequest")(
  (read: () => Promise<Uint8Array | undefined>) =>
    readChunks(read).pipe(Effect.flatMap(decodeSyncRequestV1))
);

/** Read one sync response from a half-closed stream. */
export const readSyncResponse = Effect.fn("@qop/protocol/readSyncResponse")(
  (read: () => Promise<Uint8Array | undefined>) =>
    readChunks(read).pipe(Effect.flatMap(decodeSyncResponseV1))
);

export const writeSyncRequest = Effect.fn("@qop/protocol/writeSyncRequest")(
  function* (
    write: (data: Uint8Array) => void,
    closeWrite: () => void,
    frame: SyncRequestV1
  ) {
    const bytes = yield* encodeSyncRequestV1(frame);
    write(bytes);
    closeWrite();
  }
);

export const writeSyncResponse = Effect.fn("@qop/protocol/writeSyncResponse")(
  function* (
    write: (data: Uint8Array) => void,
    closeWrite: () => void,
    frame: SyncResponseV1
  ) {
    const bytes = yield* encodeSyncResponseV1(frame);
    write(bytes);
    closeWrite();
  }
);
