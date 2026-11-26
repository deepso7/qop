export {
  CHAT_PROTOCOL,
  MAX_CHAT_ENVELOPE_BYTES,
  MAX_CHAT_PAYLOAD_BYTES,
  ChatFrameV1,
  ChatAckV1,
  createChatCipher,
  encodeFrame,
  decodeFrame,
  encodeAck,
  decodeAck,
  assertAckMatches,
} from "@qop/protocol";

export type { ChatAck, ChatCipher, ChatFrame } from "@qop/protocol";
