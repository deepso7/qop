import {
  AddDeviceIntentV1,
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  decodeRemoveDeviceIntentV1,
  EcdsaSignature,
  EthereumAddress,
  hashAddDeviceIntentV1,
  hashRemoveDeviceIntentV1,
  Hex32,
  IdentityEip712DomainV1,
  RemoveDeviceIntentV1,
} from "@qop/identity";
import type {
  AddDeviceIntentV1Encoded,
  IdentityEip712DomainV1Encoded,
  RemoveDeviceIntentV1Encoded,
} from "@qop/identity";
import { Data, Effect, Schema } from "effect";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const CanonicalHex32 = Hex32.pipe(Schema.decodeTo(Hex32.pipe(Schema.flip)));
const CanonicalSignature = EcdsaSignature.pipe(
  Schema.decodeTo(EcdsaSignature.pipe(Schema.flip))
);
const CanonicalDomain = IdentityEip712DomainV1.pipe(
  Schema.decodeTo(IdentityEip712DomainV1.pipe(Schema.flip))
);
const CanonicalAddIntent = AddDeviceIntentV1.pipe(
  Schema.decodeTo(AddDeviceIntentV1.pipe(Schema.flip))
);
const CanonicalRemoveIntent = RemoveDeviceIntentV1.pipe(
  Schema.decodeTo(RemoveDeviceIntentV1.pipe(Schema.flip))
);

const AddApprovalV1Schema = Schema.Struct({
  digest: CanonicalHex32,
  domain: CanonicalDomain,
  expectedOwner: EthereumAddress,
  intent: CanonicalAddIntent,
  operation: Schema.Literal("add"),
  ownerSignature: CanonicalSignature,
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected add-device approval field",
  parseOptions: strictParseOptions,
});

const RemoveApprovalV1Schema = Schema.Struct({
  digest: CanonicalHex32,
  domain: CanonicalDomain,
  expectedOwner: EthereumAddress,
  intent: CanonicalRemoveIntent,
  operation: Schema.Literal("remove"),
  ownerSignature: CanonicalSignature,
  v: Schema.Literal(1),
}).annotate({
  messageUnexpectedKey: "Unexpected remove-device approval field",
  parseOptions: strictParseOptions,
});

export const DeviceActionApprovalV1Schema = Schema.Union([
  AddApprovalV1Schema,
  RemoveApprovalV1Schema,
]);
export { DeviceActionApprovalV1Schema as DeviceActionApprovalV1 };
export type DeviceActionApprovalV1 = typeof DeviceActionApprovalV1Schema.Type;
export type DeviceActionApprovalV1Encoded =
  typeof DeviceActionApprovalV1Schema.Encoded;

export class ApprovalError extends Data.TaggedError("ApprovalError")<{
  readonly operation: "conflict" | "decode" | "digest" | "mismatch";
}> {}

export type ApprovalAck =
  | { readonly digest: string; readonly kind: "conflict" }
  | { readonly digest: string; readonly kind: "saved" };

const encodedApproval = (record: DeviceActionApprovalV1) =>
  Schema.encodeSync(DeviceActionApprovalV1Schema)(record);

/** Persist-before-ack: identical digest replays; a different digest conflicts. */
export const acknowledgeApproval = (
  pending: DeviceActionApprovalV1 | null,
  incoming: DeviceActionApprovalV1
): ApprovalAck => {
  if (!pending) {
    return { digest: incoming.digest, kind: "saved" };
  }
  if (
    pending.digest === incoming.digest &&
    JSON.stringify(encodedApproval(pending)) ===
      JSON.stringify(encodedApproval(incoming))
  ) {
    return { digest: pending.digest, kind: "saved" };
  }
  return { digest: pending.digest, kind: "conflict" };
};

export const decodeDeviceActionApprovalV1 = Effect.fn(
  "@qop/protocol/decodeDeviceActionApprovalV1"
)((input: DeviceActionApprovalV1Encoded) =>
  Schema.decodeEffect(DeviceActionApprovalV1Schema)(input).pipe(
    Effect.mapError(() => new ApprovalError({ operation: "decode" }))
  )
);

export const encodeDeviceActionApprovalV1 = Effect.fn(
  "@qop/protocol/encodeDeviceActionApprovalV1"
)((record: DeviceActionApprovalV1) =>
  Schema.encodeEffect(DeviceActionApprovalV1Schema)(record).pipe(
    Effect.mapError(() => new ApprovalError({ operation: "decode" }))
  )
);

export const verifyApprovalDigest = Effect.fn(
  "@qop/protocol/verifyApprovalDigest"
)(function* (record: DeviceActionApprovalV1) {
  const domain = yield* decodeIdentityEip712DomainV1(record.domain).pipe(
    Effect.mapError(() => new ApprovalError({ operation: "decode" }))
  );
  const digest =
    record.operation === "add"
      ? yield* hashAddDeviceIntentV1(
          domain,
          yield* decodeAddDeviceIntentV1(record.intent).pipe(
            Effect.mapError(() => new ApprovalError({ operation: "decode" }))
          )
        ).pipe(
          Effect.mapError(() => new ApprovalError({ operation: "digest" }))
        )
      : yield* hashRemoveDeviceIntentV1(
          domain,
          yield* decodeRemoveDeviceIntentV1(record.intent).pipe(
            Effect.mapError(() => new ApprovalError({ operation: "decode" }))
          )
        ).pipe(
          Effect.mapError(() => new ApprovalError({ operation: "digest" }))
        );
  if (digest !== record.digest) {
    return yield* new ApprovalError({ operation: "digest" });
  }
  return digest;
});

export const approvalsMatch = (
  displayed: DeviceActionApprovalV1,
  requested: DeviceActionApprovalV1
) =>
  JSON.stringify(encodedApproval(displayed)) ===
  JSON.stringify(encodedApproval(requested));

export type DeviceActionIntentEncoded =
  | AddDeviceIntentV1Encoded
  | RemoveDeviceIntentV1Encoded;

export type TrustedDomain = IdentityEip712DomainV1Encoded;
