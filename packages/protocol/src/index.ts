export { asHex, asQidString } from "./canonical.ts";
export {
  acknowledgeApproval,
  approvalsMatch,
  decodeDeviceActionApprovalV1,
  DeviceActionApprovalV1,
  encodeDeviceActionApprovalV1,
  verifyApprovalDigest,
  ApprovalError,
} from "./approval.ts";
export type {
  DeviceActionApprovalV1Encoded,
  DeviceActionIntentEncoded,
  TrustedDomain,
  ApprovalAck,
} from "./approval.ts";
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
} from "./chat-wire.ts";
export type { ChatFrame, ChatAck } from "./chat-wire.ts";
export type { SessionContact, SessionContactInput } from "./contacts.ts";
export {
  OutboxRecordV1,
  InboxRecordV1,
  OutboxStatusV1,
  outboxRecordsConflict,
  inboxRecordsConflict,
} from "./outbox.ts";
export type {
  OutboxRecordV1 as OutboxRecord,
  InboxRecordV1 as InboxRecord,
  OutboxStatus,
} from "./outbox.ts";
export {
  SYNC_PROTOCOL,
  MAX_SYNC_PAYLOAD_BYTES,
  SYNC_POLL_MAX_IDS,
  SyncHandoffV1,
  SyncPollV1,
  SyncCatchupV1,
  SyncRequestV1,
  SyncHeldV1,
  SyncReceiptV1,
  SyncReceiptsV1,
  SyncInboxItemV1,
  SyncInboxV1,
  SyncErrorV1,
  SyncResponseV1,
  SyncCodecError,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
  decodeSyncRequestV1,
  decodeSyncResponseV1,
} from "./sync.ts";
export type {
  SyncHandoffV1 as SyncHandoff,
  SyncPollV1 as SyncPoll,
  SyncCatchupV1 as SyncCatchup,
  SyncRequestV1 as SyncRequest,
  SyncHeldV1 as SyncHeld,
  SyncReceiptV1 as SyncReceipt,
  SyncReceiptsV1 as SyncReceipts,
  SyncInboxItemV1 as SyncInboxItem,
  SyncInboxV1 as SyncInbox,
  SyncErrorV1 as SyncError,
  SyncResponseV1 as SyncResponse,
} from "./sync.ts";
export {
  readSyncRequest,
  readSyncRequestFrom,
  readSyncResponse,
  readSyncResponseFrom,
  writeSyncRequest,
  writeSyncRequestTo,
  writeSyncResponse,
  writeSyncResponseTo,
} from "./sync-io.ts";
export type { SyncStream } from "./sync-io.ts";
export {
  DEVICE_ACTION_DEADLINE_SECONDS,
  MAX_ACTIVE_DEVICES,
  PAIR_PROTOCOL,
  PAIRING_FRAME_MAX_BYTES,
  PAIRING_MAX_ADDRESSES,
  PAIRING_QR_MAX_CHARS,
  PAIRING_TTL_SECONDS,
} from "./limits.ts";
export { createLifecycleAdapter } from "./lifecycle.ts";
export type { LifecycleAdapter } from "./lifecycle.ts";
export {
  deviceActionDeadlineExpired,
  enrollmentMembership,
  enrollmentPollComplete,
  isTerminalDeviceActionStatus,
  neverSubmittedDigestMissing,
  occupiesApprovalSlot,
} from "./membership.ts";
export type {
  DeviceActionApiRecord,
  DeviceActionApiStatus,
  DeviceActionOperation,
  EnrollmentMembership,
} from "./membership.ts";
export {
  decodePairingFrameV1,
  decodePairingOfferV1,
  encodePairingFrameV1,
  encodePairingOfferV1,
  pairingFingerprint,
  PairingCodecError,
  PairingFrameV1,
  PairingOfferV1,
} from "./pairing.ts";
export { readPairingFrame, writePairingFrame } from "./pairing-io.ts";
export type {
  PairingFrameV1 as PairingFrame,
  PairingOfferV1Encoded,
} from "./pairing.ts";
export {
  createPeerSessions,
  MAX_AUTH_AGE_MS,
  PeerVerificationError,
} from "./p2p-sessions.ts";
export type { PeerConnection } from "./p2p-sessions.ts";
export {
  createRegistryReader,
  RegistryReaderError,
  registryAbi,
} from "./registry-reader.ts";
export type {
  RegistryAccount,
  RegistryDevice,
  RegistryFreshness,
  RegistryReadClient,
} from "./registry-reader.ts";
