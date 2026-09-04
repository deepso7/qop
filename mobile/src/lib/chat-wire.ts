import { Handle } from "@qop/identity";
import { Schema } from "effect";

export const CHAT_PROTOCOL = "/qop/chat/1";
export const MAX_CHAT_PAYLOAD_BYTES = 16 * 1024;

const Uuid = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    { expected: "a UUID" }
  )
);

export const ChatFrameV1 = Schema.Struct({
  fromHandle: Handle,
  id: Uuid,
  sentAt: Schema.Int,
  text: Schema.String.check(Schema.isLengthBetween(1, 4000)),
  v: Schema.Literal(1),
});

export const ChatAckV1 = Schema.Struct({
  ack: Uuid,
  v: Schema.Literal(1),
});

export type ChatFrame = typeof ChatFrameV1.Type;
export type ChatAck = typeof ChatAckV1.Type;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const encode = (value: ChatAck | ChatFrame): Uint8Array => {
  const encoded = textEncoder.encode(JSON.stringify(value));
  if (encoded.byteLength > MAX_CHAT_PAYLOAD_BYTES) {
    throw new Error("Chat payload exceeds 16 KB");
  }
  return encoded;
};

const ensureAllowedSize = (bytes: Uint8Array) => {
  if (bytes.byteLength > MAX_CHAT_PAYLOAD_BYTES) {
    throw new Error("Chat payload exceeds 16 KB");
  }
};

export const encodeFrame = (frame: ChatFrame) =>
  encode(Schema.decodeUnknownSync(ChatFrameV1)(frame));
export const decodeFrame = (bytes: Uint8Array) => {
  ensureAllowedSize(bytes);
  // SAFETY: The Effect schema validates the parsed JSON before it is returned.
  const value = JSON.parse(textDecoder.decode(bytes)) as unknown;
  return Schema.decodeUnknownSync(ChatFrameV1)(value);
};
export const encodeAck = (ack: ChatAck) =>
  encode(Schema.decodeUnknownSync(ChatAckV1)(ack));
export const decodeAck = (bytes: Uint8Array) => {
  ensureAllowedSize(bytes);
  // SAFETY: The Effect schema validates the parsed JSON before it is returned.
  const value = JSON.parse(textDecoder.decode(bytes)) as unknown;
  return Schema.decodeUnknownSync(ChatAckV1)(value);
};

export const assertAckMatches = (ack: ChatAck, messageId: string): void => {
  if (ack.ack !== messageId) {
    throw new Error("Chat ack does not match the message id");
  }
};
