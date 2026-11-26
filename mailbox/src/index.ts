export { loadOrCreateKey } from "./main.ts";

export {
  createDeviceAuthorizer,
  createMailboxHandler,
  createPeerRateLimiter,
  startMailboxServer,
} from "./server.ts";

export type {
  DeviceAuthorizer,
  DeviceAuthResult,
  MailboxHandlerDeps,
  MailboxRegistry,
  MailboxServerConfig,
  RunningMailboxServer,
} from "./server.ts";

export {
  DEFAULT_MAILBOX_TTL_MS,
  DEFAULT_MAX_BYTES_PER_RECIPIENT,
  DEFAULT_MAX_ENVELOPES_PER_RECIPIENT,
  DEFAULT_MAX_ENVELOPES_PER_SENDER,
  defaultMailboxLimits,
  MailboxStoreError,
  openMailboxStore,
} from "./store.ts";

export type {
  DepositedItem,
  DepositRecord,
  MailboxLimits,
  MailboxStore,
} from "./store.ts";
