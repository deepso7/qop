import { Hex32, strictParseOptions } from "@qop/identity";
import { base64 } from "@scure/base";
import { Data, Effect, Schema } from "effect";

import { MAX_CHAT_ENVELOPE_BYTES } from "./chat-envelope.ts";
import { MAX_ACTIVE_DEVICES } from "./limits.ts";

/**
 * Encrypted store-and-forward mailbox v1 on `/qop/mailbox/1`.
 *
 * A mailbox node stores only signed per-device HPKE envelopes
 * (`chat-envelope.ts`), never plaintext. Callers authenticate by their
 * transport peer ID (Ed25519 device key) verified against the registry:
 *
 * - `deposit{items}`: deposit envelopes for up to `MAILBOX_MAX_DEPOSIT_ITEMS`
 *   active recipient device keys. Retries for the same `(recipient, sender, id)`
 *   are idempotent (first committed envelope wins).
 * - `fetch{limit}`: fetch up to `limit` pending envelopes for the caller's own
 *   device key, oldest-first by mailbox `seq`.
 * - `ack{seqs}`: delete persisted envelopes for the caller's own device key.
 * - `register-push{platform,token}`: replace the caller's own push token.
 */
export const MAILBOX_PROTOCOL = "/qop/mailbox/1";
export const MAILBOX_WAKE_DATA = { qopMailboxWake: "1" } as const;

/** Fits 4 max-size base64 envelopes (~88 KiB) plus JSON framing with headroom. */
export const MAX_MAILBOX_PAYLOAD_BYTES = 128 * 1024;
export const MAILBOX_MAX_DEPOSIT_ITEMS = MAX_ACTIVE_DEVICES;
export const MAILBOX_MAX_FETCH_LIMIT = 16;
export const MAILBOX_MAX_ACK_SEQS = 16;

const MAX_BASE64_ENVELOPE_CHARS = Math.ceil(MAX_CHAT_ENVELOPE_BYTES / 3) * 4;

// Canonical RFC 4648 standard base64 (rejects whitespace and non-zero padding bits).
const STRICT_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/]{4})$/u;

/** Standard base64 encoder backed by `@scure/base` (Node + React Native). */
export const encodeBase64 = (bytes: Uint8Array): string => base64.encode(bytes);

/** Strict standard base64 decoder; rejects empty strings, whitespace, and non-canonical padding. */
export const decodeBase64 = (value: string): Uint8Array => {
  if (value.length === 0) {
    throw new Error("Invalid base64 length");
  }

  return base64.decode(value);
};

const decodedBase64Length = (value: string) => {
  let padding = 0;

  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }

  return (value.length / 4) * 3 - padding;
};

const Uuid = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    { expected: "a UUID" }
  )
);

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));

const TimestampMillis = Schema.Int.check(
  Schema.makeFilter((value) => value >= 0 && value <= 8_640_000_000_000_000, {
    expected: "a valid nonnegative millisecond timestamp",
  })
);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const Base64Envelope = Schema.String.check(
  Schema.isBetweenLength(4, MAX_BASE64_ENVELOPE_CHARS),
  Schema.makeFilter(
    (value) =>
      STRICT_BASE64_PATTERN.test(value) &&
      decodedBase64Length(value) <= MAX_CHAT_ENVELOPE_BYTES,
    { expected: "a valid base64 chat envelope" }
  )
);

export const MailboxDepositItemV1Schema = Schema.Struct({
  envelope: Base64Envelope,
  id: Uuid,
  recipientDeviceKey: CanonicalHex32,
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox deposit item field",
});

export { MailboxDepositItemV1Schema as MailboxDepositItemV1 };

export type MailboxDepositItemV1 = typeof MailboxDepositItemV1Schema.Type;

export const MailboxDepositV1Schema = Schema.Struct({
  items: Schema.Array(MailboxDepositItemV1Schema).check(
    Schema.isBetweenLength(1, MAILBOX_MAX_DEPOSIT_ITEMS)
  ),
  type: Schema.Literal("deposit"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox deposit field",
});

export { MailboxDepositV1Schema as MailboxDepositV1 };

export type MailboxDepositV1 = typeof MailboxDepositV1Schema.Type;

export const MailboxFetchV1Schema = Schema.Struct({
  limit: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MAILBOX_MAX_FETCH_LIMIT)
  ),
  type: Schema.Literal("fetch"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox fetch field",
});

export { MailboxFetchV1Schema as MailboxFetchV1 };

export type MailboxFetchV1 = typeof MailboxFetchV1Schema.Type;

export const MailboxAckV1Schema = Schema.Struct({
  seqs: Schema.Array(PositiveInt).check(
    Schema.isBetweenLength(1, MAILBOX_MAX_ACK_SEQS)
  ),
  type: Schema.Literal("ack"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox ack field",
});

export { MailboxAckV1Schema as MailboxAckV1 };

export type MailboxAckV1 = typeof MailboxAckV1Schema.Type;

const pushRegistration = {
  type: Schema.Literal("register-push"),
  v: Schema.Literal(1),
};

const MailboxRegisterPush = Schema.Union([
  Schema.Struct({
    ...pushRegistration,
    platform: Schema.Literal("apns"),
    token: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{2}){16,128}$/iu)),
  }),
  Schema.Struct({
    ...pushRegistration,
    platform: Schema.Literal("fcm"),
    token: Schema.String.check(
      Schema.isBetweenLength(1, 4096),
      Schema.isPattern(/^[\w.:-]+$/u)
    ),
  }),
]);

export type MailboxPushTarget = Pick<
  typeof MailboxRegisterPush.Type,
  "platform" | "token"
>;

export const MailboxRequestV1Schema = Schema.Union([
  MailboxDepositV1Schema,
  MailboxFetchV1Schema,
  MailboxAckV1Schema,
  MailboxRegisterPush,
]);

export { MailboxRequestV1Schema as MailboxRequestV1 };

export type MailboxRequestV1 = typeof MailboxRequestV1Schema.Type;

export const MailboxDepositedItemV1Schema = Schema.Struct({
  id: Uuid,
  recipientDeviceKey: CanonicalHex32,
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox deposited item field",
});

export { MailboxDepositedItemV1Schema as MailboxDepositedItemV1 };

export type MailboxDepositedItemV1 = typeof MailboxDepositedItemV1Schema.Type;

export const MailboxDepositedV1Schema = Schema.Struct({
  items: Schema.Array(MailboxDepositedItemV1Schema).check(
    Schema.isBetweenLength(1, MAILBOX_MAX_DEPOSIT_ITEMS)
  ),
  type: Schema.Literal("deposited"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox deposited field",
});

export { MailboxDepositedV1Schema as MailboxDepositedV1 };

export type MailboxDepositedV1 = typeof MailboxDepositedV1Schema.Type;

export const MailboxMessageV1Schema = Schema.Struct({
  envelope: Base64Envelope,
  id: Uuid,
  senderDeviceKey: CanonicalHex32,
  seq: PositiveInt,
  storedAt: TimestampMillis,
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox message field",
});

export { MailboxMessageV1Schema as MailboxMessageV1 };

export type MailboxMessageV1 = typeof MailboxMessageV1Schema.Type;

export const MailboxMessagesV1Schema = Schema.Struct({
  hasMore: Schema.Boolean,
  items: Schema.Array(MailboxMessageV1Schema).check(
    Schema.isMaxLength(MAILBOX_MAX_FETCH_LIMIT)
  ),
  type: Schema.Literal("messages"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox messages field",
});

export { MailboxMessagesV1Schema as MailboxMessagesV1 };

export type MailboxMessagesV1 = typeof MailboxMessagesV1Schema.Type;

export const MailboxAckedV1Schema = Schema.Struct({
  count: NonNegativeInt,
  type: Schema.Literal("acked"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox acked field",
});

export { MailboxAckedV1Schema as MailboxAckedV1 };

export type MailboxAckedV1 = typeof MailboxAckedV1Schema.Type;

export const MailboxErrorV1Schema = Schema.Struct({
  reason: Schema.Literals(["invalid", "quota", "unauthorized", "unavailable"]),
  type: Schema.Literal("error"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected mailbox error field",
});

export { MailboxErrorV1Schema as MailboxErrorV1 };

export type MailboxErrorV1 = typeof MailboxErrorV1Schema.Type;

export const MailboxResponseV1Schema = Schema.Union([
  MailboxDepositedV1Schema,
  MailboxMessagesV1Schema,
  MailboxAckedV1Schema,
  MailboxErrorV1Schema,
  Schema.Struct({
    type: Schema.Literal("push-registered"),
    v: Schema.Literal(1),
  }),
]);

export { MailboxResponseV1Schema as MailboxResponseV1 };

export type MailboxResponseV1 = typeof MailboxResponseV1Schema.Type;

export class MailboxCodecError extends Data.TaggedError("MailboxCodecError")<{
  readonly operation: "frame" | "oversized";
}> {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type MailboxJson =
  | typeof MailboxRequestV1Schema.Encoded
  | typeof MailboxResponseV1Schema.Encoded;

const encodeJson = (value: MailboxJson) =>
  Effect.sync(() => textEncoder.encode(JSON.stringify(value))).pipe(
    Effect.flatMap((encoded) =>
      encoded.byteLength > MAX_MAILBOX_PAYLOAD_BYTES
        ? Effect.fail(new MailboxCodecError({ operation: "oversized" }))
        : Effect.succeed(encoded)
    )
  );

export const encodeMailboxRequestV1 = Effect.fn(
  "@qop/protocol/encodeMailboxRequestV1"
)((frame: MailboxRequestV1) =>
  Schema.encodeEffect(MailboxRequestV1Schema)(frame).pipe(
    Effect.mapError(() => new MailboxCodecError({ operation: "frame" })),
    Effect.flatMap(encodeJson)
  )
);

export const encodeMailboxResponseV1 = Effect.fn(
  "@qop/protocol/encodeMailboxResponseV1"
)((frame: MailboxResponseV1) =>
  Schema.encodeEffect(MailboxResponseV1Schema)(frame).pipe(
    Effect.mapError(() => new MailboxCodecError({ operation: "frame" })),
    Effect.flatMap(encodeJson)
  )
);

const parseJson = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    if (bytes.byteLength > MAX_MAILBOX_PAYLOAD_BYTES) {
      return yield* new MailboxCodecError({ operation: "oversized" });
    }

    return yield* Effect.try({
      catch: () => new MailboxCodecError({ operation: "frame" }),
      // SAFETY: JSON.parse is untyped; the mailbox schema is decoded next.
      try: () => JSON.parse(textDecoder.decode(bytes)) as unknown,
    });
  });

export const decodeMailboxRequestV1 = Effect.fn(
  "@qop/protocol/decodeMailboxRequestV1"
)(function* (bytes: Uint8Array) {
  const json = yield* parseJson(bytes);

  return yield* Schema.decodeUnknownEffect(MailboxRequestV1Schema)(
    json,
    strictParseOptions
  ).pipe(Effect.mapError(() => new MailboxCodecError({ operation: "frame" })));
});

export const decodeMailboxResponseV1 = Effect.fn(
  "@qop/protocol/decodeMailboxResponseV1"
)(function* (bytes: Uint8Array) {
  const json = yield* parseJson(bytes);

  return yield* Schema.decodeUnknownEffect(MailboxResponseV1Schema)(
    json,
    strictParseOptions
  ).pipe(Effect.mapError(() => new MailboxCodecError({ operation: "frame" })));
});
