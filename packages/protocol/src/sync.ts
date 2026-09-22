import { Hex32 } from "@qop/identity";
import { Data, Effect, Schema } from "effect";

import { InboxRecordV1, OutboxQid, OutboxRecordV1Schema } from "./outbox.ts";

/**
 * Phone↔CLI sync v1 on `/qop/sync/1` (extended: catch-up).
 *
 * Own devices of the same qid only. Both sides verify the peer as an active
 * device of that qid (same 60s auth age and live-revoke as chat). The phone
 * initiates. An old CLI that does not know `catchup`/`inbox` decode-fails and
 * resets; there is no compatibility shim.
 *
 * Flow: `handoff{record, composedBy}` → `held{id}` only after the CLI durably
 * persists the record into the CLI store. A later `poll{ids}` returns
 * `receipts` for ids the CLI has marked `sent` after Bob's chat ACK. Each
 * receipt carries `toQid` so the phone applies it to `(contact_qid, id)`.
 * `catchup{after}` returns `inbox{records}` of replies the CLI stored while
 * the phone was away. `after` is that holder's inbox rowid cursor. The phone
 * repeats until `records` is empty.
 *
 * Disk remains `OutboxRecordV1` / `InboxRecordV1`. `composedBy` is a sync-frame
 * field, not a disk column. Phone `held` is a local status, not a CLI outbox
 * status. `expired` and a disk V2 schema are deferred.
 */
export const SYNC_PROTOCOL = "/qop/sync/1";
/** One inbox record can wrap a max chat frame, so the cap is above 16 KB. */
export const MAX_SYNC_PAYLOAD_BYTES = 64 * 1024;
export const SYNC_POLL_MAX_IDS = 32;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

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

export const SyncHandoffV1Schema = Schema.Struct({
  composedBy: CanonicalHex32,
  record: OutboxRecordV1Schema.check(
    Schema.makeFilter((record) => record.status === "queued", {
      expected: "a queued outbox record",
    })
  ),
  type: Schema.Literal("handoff"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync handoff field",
  parseOptions: strictParseOptions,
});
export { SyncHandoffV1Schema as SyncHandoffV1 };
export type SyncHandoffV1 = typeof SyncHandoffV1Schema.Type;

export const SyncPollV1Schema = Schema.Struct({
  ids: Schema.Array(Uuid).check(Schema.isLengthBetween(1, SYNC_POLL_MAX_IDS)),
  type: Schema.Literal("poll"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync poll field",
  parseOptions: strictParseOptions,
});
export { SyncPollV1Schema as SyncPollV1 };
export type SyncPollV1 = typeof SyncPollV1Schema.Type;

export const SyncCatchupV1Schema = Schema.Struct({
  after: NonNegativeInt,
  type: Schema.Literal("catchup"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync catchup field",
  parseOptions: strictParseOptions,
});
export { SyncCatchupV1Schema as SyncCatchupV1 };
export type SyncCatchupV1 = typeof SyncCatchupV1Schema.Type;

export const SyncRequestV1Schema = Schema.Union([
  SyncHandoffV1Schema,
  SyncPollV1Schema,
  SyncCatchupV1Schema,
]);
export { SyncRequestV1Schema as SyncRequestV1 };
export type SyncRequestV1 = typeof SyncRequestV1Schema.Type;

export const SyncHeldV1Schema = Schema.Struct({
  id: Uuid,
  type: Schema.Literal("held"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync held field",
  parseOptions: strictParseOptions,
});
export { SyncHeldV1Schema as SyncHeldV1 };
export type SyncHeldV1 = typeof SyncHeldV1Schema.Type;

export const SyncReceiptV1Schema = Schema.Struct({
  deliveredAt: TimestampMillis,
  id: Uuid,
  toQid: OutboxQid,
}).annotate({
  messageUnexpectedKey: "Unexpected sync receipt field",
  parseOptions: strictParseOptions,
});
export { SyncReceiptV1Schema as SyncReceiptV1 };
export type SyncReceiptV1 = typeof SyncReceiptV1Schema.Type;

export const SyncReceiptsV1Schema = Schema.Struct({
  receipts: Schema.Array(SyncReceiptV1Schema).check(
    Schema.isMaxLength(SYNC_POLL_MAX_IDS)
  ),
  type: Schema.Literal("receipts"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync receipts field",
  parseOptions: strictParseOptions,
});
export { SyncReceiptsV1Schema as SyncReceiptsV1 };
export type SyncReceiptsV1 = typeof SyncReceiptsV1Schema.Type;

export const SyncInboxItemV1Schema = Schema.Struct({
  record: InboxRecordV1,
  seq: PositiveInt,
}).annotate({
  messageUnexpectedKey: "Unexpected sync inbox item field",
  parseOptions: strictParseOptions,
});
export { SyncInboxItemV1Schema as SyncInboxItemV1 };
export type SyncInboxItemV1 = typeof SyncInboxItemV1Schema.Type;

export const SyncInboxV1Schema = Schema.Struct({
  records: Schema.Array(SyncInboxItemV1Schema),
  type: Schema.Literal("inbox"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync inbox field",
  parseOptions: strictParseOptions,
});
export { SyncInboxV1Schema as SyncInboxV1 };
export type SyncInboxV1 = typeof SyncInboxV1Schema.Type;

export const SyncErrorV1Schema = Schema.Struct({
  reason: Schema.Literals(["conflict", "invalid"]),
  type: Schema.Literal("error"),
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected sync error field",
  parseOptions: strictParseOptions,
});
export { SyncErrorV1Schema as SyncErrorV1 };
export type SyncErrorV1 = typeof SyncErrorV1Schema.Type;

export const SyncResponseV1Schema = Schema.Union([
  SyncHeldV1Schema,
  SyncReceiptsV1Schema,
  SyncInboxV1Schema,
  SyncErrorV1Schema,
]);
export { SyncResponseV1Schema as SyncResponseV1 };
export type SyncResponseV1 = typeof SyncResponseV1Schema.Type;

export class SyncCodecError extends Data.TaggedError("SyncCodecError")<{
  readonly operation: "frame" | "oversized";
}> {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type SyncJson =
  | typeof SyncRequestV1Schema.Encoded
  | typeof SyncResponseV1Schema.Encoded;

const encodeJson = (value: SyncJson) =>
  Effect.sync(() => textEncoder.encode(JSON.stringify(value))).pipe(
    Effect.flatMap((encoded) =>
      encoded.byteLength > MAX_SYNC_PAYLOAD_BYTES
        ? Effect.fail(new SyncCodecError({ operation: "oversized" }))
        : Effect.succeed(encoded)
    )
  );

export const encodeSyncRequestV1 = Effect.fn(
  "@qop/protocol/encodeSyncRequestV1"
)((frame: SyncRequestV1) =>
  Schema.encodeEffect(SyncRequestV1Schema)(frame).pipe(
    Effect.mapError(() => new SyncCodecError({ operation: "frame" })),
    Effect.flatMap(encodeJson)
  )
);

export const encodeSyncResponseV1 = Effect.fn(
  "@qop/protocol/encodeSyncResponseV1"
)((frame: SyncResponseV1) =>
  Schema.encodeEffect(SyncResponseV1Schema)(frame).pipe(
    Effect.mapError(() => new SyncCodecError({ operation: "frame" })),
    Effect.flatMap(encodeJson)
  )
);

const parseJson = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    if (bytes.byteLength > MAX_SYNC_PAYLOAD_BYTES) {
      return yield* new SyncCodecError({ operation: "oversized" });
    }
    return yield* Effect.try({
      catch: () => new SyncCodecError({ operation: "frame" }),
      // SAFETY: JSON.parse is untyped; the sync schema is decoded next.
      try: () => JSON.parse(textDecoder.decode(bytes)) as unknown,
    });
  });

export const decodeSyncRequestV1 = Effect.fn(
  "@qop/protocol/decodeSyncRequestV1"
)(function* (bytes: Uint8Array) {
  const json = yield* parseJson(bytes);
  return yield* Schema.decodeUnknownEffect(SyncRequestV1Schema)(json).pipe(
    Effect.mapError(() => new SyncCodecError({ operation: "frame" }))
  );
});

export const decodeSyncResponseV1 = Effect.fn(
  "@qop/protocol/decodeSyncResponseV1"
)(function* (bytes: Uint8Array) {
  const json = yield* parseJson(bytes);
  return yield* Schema.decodeUnknownEffect(SyncResponseV1Schema)(json).pipe(
    Effect.mapError(() => new SyncCodecError({ operation: "frame" }))
  );
});
