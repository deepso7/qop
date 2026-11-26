import { Effect } from "effect";

import {
  decodeMailboxRequestV1,
  decodeMailboxResponseV1,
  encodeMailboxRequestV1,
  encodeMailboxResponseV1,
  MailboxCodecError,
  MAX_MAILBOX_PAYLOAD_BYTES,
} from "./mailbox.ts";
import type { MailboxRequestV1, MailboxResponseV1 } from "./mailbox.ts";
import { readBoundedChunks, writeFramedBytes } from "./stream-io.ts";
import type { HalfCloseStream } from "./stream-io.ts";

/** Half-close duplex used by `/qop/mailbox/1`. Bind methods at the call. */
export type MailboxStream = HalfCloseStream;

const DEFAULT_MAILBOX_EXCHANGE_TIMEOUT_MS = 15_000;

const mailboxError = (operation: "frame" | "oversized") =>
  new MailboxCodecError({ operation });

/** Read one mailbox request from a half-closed stream. */
export const readMailboxRequestFrom = Effect.fn(
  "@qop/protocol/readMailboxRequestFrom"
)((stream: Pick<MailboxStream, "read">) =>
  readBoundedChunks(
    () => stream.read(),
    MAX_MAILBOX_PAYLOAD_BYTES,
    mailboxError
  ).pipe(Effect.flatMap(decodeMailboxRequestV1))
);

/** Read one mailbox response from a half-closed stream. */
export const readMailboxResponseFrom = Effect.fn(
  "@qop/protocol/readMailboxResponseFrom"
)((stream: Pick<MailboxStream, "read">) =>
  readBoundedChunks(
    () => stream.read(),
    MAX_MAILBOX_PAYLOAD_BYTES,
    mailboxError
  ).pipe(Effect.flatMap(decodeMailboxResponseV1))
);

/** Encode, write, and half-close one mailbox request on `stream`. */
export const writeMailboxRequestTo = Effect.fn(
  "@qop/protocol/writeMailboxRequestTo"
)(function* (
  stream: Pick<MailboxStream, "closeWrite" | "write">,
  frame: MailboxRequestV1
) {
  const bytes = yield* encodeMailboxRequestV1(frame);
  yield* writeFramedBytes(
    (data) => stream.write(data),
    () => stream.closeWrite(),
    bytes,
    () => mailboxError("frame")
  );
});

/** Encode, write, and half-close one mailbox response on `stream`. */
export const writeMailboxResponseTo = Effect.fn(
  "@qop/protocol/writeMailboxResponseTo"
)(function* (
  stream: Pick<MailboxStream, "closeWrite" | "write">,
  frame: MailboxResponseV1
) {
  const bytes = yield* encodeMailboxResponseV1(frame);
  yield* writeFramedBytes(
    (data) => stream.write(data),
    () => stream.closeWrite(),
    bytes,
    () => mailboxError("frame")
  );
});

/** Write one request, half-close, and read one response with a deadline and reset on failure/interruption. */
export const exchangeMailbox = Effect.fn("@qop/protocol/exchangeMailbox")(
  function* (
    stream: Pick<MailboxStream, "closeWrite" | "read" | "write"> & {
      readonly reset?: () => void;
    },
    request: MailboxRequestV1,
    timeoutMs = DEFAULT_MAILBOX_EXCHANGE_TIMEOUT_MS
  ) {
    const io = Effect.gen(function* () {
      yield* writeMailboxRequestTo(stream, request);

      return yield* readMailboxResponseFrom(stream);
    });

    return yield* io.pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        orElse: () => Effect.fail(mailboxError("frame")),
      }),
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => {
              stream.reset?.();
            })
      )
    );
  }
);
