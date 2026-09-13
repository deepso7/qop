import { Effect } from "effect";

import { PAIRING_FRAME_MAX_BYTES } from "./limits.ts";
import {
  decodePairingFrameV1,
  encodePairingFrameV1,
  PairingCodecError,
} from "./pairing.ts";
import type { PairingFrameV1 } from "./pairing.ts";

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
): Effect.Effect<Uint8Array, PairingCodecError> =>
  Effect.gen(function* () {
    const chunk = yield* Effect.tryPromise({
      catch: () => new PairingCodecError({ operation: "frame" }),
      try: () => read(),
    });
    if (!chunk) {
      return concatChunks(chunks, byteLength);
    }
    const nextLength = byteLength + chunk.byteLength;
    if (nextLength > PAIRING_FRAME_MAX_BYTES) {
      return yield* new PairingCodecError({ operation: "oversized" });
    }
    chunks.push(chunk);
    return yield* readChunks(read, chunks, nextLength);
  });

/** Read one pairing frame from a half-closed stream (write, then closeWrite). */
export const readPairingFrame = Effect.fn("@qop/protocol/readPairingFrame")(
  (read: () => Promise<Uint8Array | undefined>) =>
    readChunks(read).pipe(Effect.flatMap(decodePairingFrameV1))
);

export const writePairingFrame = Effect.fn("@qop/protocol/writePairingFrame")(
  function* (
    write: (data: Uint8Array) => void,
    closeWrite: () => void,
    frame: PairingFrameV1
  ) {
    const bytes = yield* encodePairingFrameV1(frame);
    write(bytes);
    closeWrite();
  }
);
