import { Effect } from "effect";

import type { PeerConnection } from "./p2p-sessions.ts";

/** Half-close duplex stream shared by `/qop/sync/1` and `/qop/mailbox/1`. */
export interface HalfCloseStream extends PeerConnection {
  readonly closeWrite: () => void;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => Promise<void>;
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

/** Read chunks until EOF, failing fast if total bytes exceed `maxBytes`. */
export const readBoundedChunks = <E>(
  read: () => Promise<Uint8Array | undefined>,
  maxBytes: number,
  onError: (kind: "frame" | "oversized") => E
): Effect.Effect<Uint8Array, E> => {
  const loop = (
    chunks: Uint8Array[],
    byteLength: number
  ): Effect.Effect<Uint8Array, E> =>
    Effect.gen(function* () {
      const chunk = yield* Effect.tryPromise({
        catch: () => onError("frame"),
        try: () => read(),
      });

      if (!chunk) {
        return concatChunks(chunks, byteLength);
      }

      const nextLength = byteLength + chunk.byteLength;

      if (nextLength > maxBytes) {
        return yield* Effect.fail(onError("oversized"));
      }

      chunks.push(chunk);

      return yield* loop(chunks, nextLength);
    });

  return loop([], 0);
};

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
