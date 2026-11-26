import { Effect } from "effect";

import type { PeerConnection } from "./p2p-sessions.ts";

/** Half-close duplex stream shared by `/qop/sync/1` and `/qop/mailbox/1`. */
export interface HalfCloseStream extends PeerConnection {
  readonly closeWrite: () => void;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => Promise<void>;
}

/** Read chunks iteratively into one bounded buffer until EOF, failing fast if total bytes exceed `maxBytes`. */
export const readBoundedChunks = <E>(
  read: () => Promise<Uint8Array | undefined>,
  maxBytes: number,
  onError: (kind: "frame" | "oversized") => E
): Effect.Effect<Uint8Array, E> =>
  Effect.gen(function* () {
    let buffer = new Uint8Array(0);
    let offset = 0;
    let emptyReads = 0;

    let chunk = yield* Effect.tryPromise({
      catch: () => onError("frame"),
      try: () => read(),
    });

    while (chunk) {
      if (chunk.byteLength === 0) {
        emptyReads += 1;

        if (emptyReads > 64) {
          return yield* Effect.fail(onError("frame"));
        }
      } else {
        const nextOffset = offset + chunk.byteLength;

        if (nextOffset > maxBytes) {
          return yield* Effect.fail(onError("oversized"));
        }

        if (nextOffset > buffer.byteLength) {
          const nextCapacity = Math.min(
            maxBytes,
            Math.max(nextOffset, Math.max(buffer.byteLength * 2, 1024))
          );

          const grown = new Uint8Array(nextCapacity);
          grown.set(buffer.subarray(0, offset), 0);
          buffer = grown;
        }

        buffer.set(chunk, offset);
        offset = nextOffset;
      }

      chunk = yield* Effect.tryPromise({
        catch: () => onError("frame"),
        try: () => read(),
      });
    }

    return buffer.subarray(0, offset);
  });

/** Write a complete frame and half-close the write side. */
export const writeFramedBytes = <E>(
  write: (data: Uint8Array) => Promise<void>,
  closeWrite: () => void,
  bytes: Uint8Array,
  onError: () => E
): Effect.Effect<void, E> =>
  Effect.tryPromise({
    catch: onError,
    try: async () => {
      await write(bytes);
      closeWrite();
    },
  });
