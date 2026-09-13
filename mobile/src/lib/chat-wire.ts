export {
  CHAT_PROTOCOL,
  MAX_CHAT_PAYLOAD_BYTES,
  ChatFrameV1,
  ChatAckV1,
  encodeFrame,
  decodeFrame,
  encodeAck,
  decodeAck,
  assertAckMatches,
} from "@qop/protocol";
export type { ChatFrame, ChatAck } from "@qop/protocol";
