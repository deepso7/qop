export {
  makeCacheNamespace,
  type CacheNamespace,
  type CacheNamespaceOptions,
  type CacheNamespacePolicy,
  type CacheNamespaceRead,
} from "./cache/namespace.ts";
export { Database, DatabaseLive } from "./db/database.ts";
export {
  apiSchemaVersion,
  registrationHandleLeases,
  registrationIntents,
} from "./db/schema.ts";
export { decodeEnv, Env } from "./env.ts";
export {
  confirmedRegistryBlock,
  RegistryChain,
  RegistryChainError,
  RegistryChainLive,
  type RegistryChainReadError,
  type RegistryChainShape,
} from "./registry/chain.ts";
export {
  normalizeCertificateDigest,
  normalizeRegistryHandle,
  normalizeRegistryOwner,
  RegistryInputError,
} from "./registry/inputs.ts";
export {
  RegistryReader,
  RegistryReaderLive,
  type RegistryInvalidations,
  type RegistryRead,
  type RegistryReaderShape,
  type RegistryReads,
} from "./registry/reader.ts";
export type { RegistryAccount, RegistrySnapshot } from "./registry/types.ts";
export {
  HandleLeaseConflict,
  registrationExpirationBatchSize,
  RegistrationIntentConflict,
  RegistrationIntentExpired,
  RegistrationIntentNotFound,
  RegistrationStore,
  type RegistrationStoreError,
  RegistrationStoreLive,
  type RegistrationStorePersistenceError,
  type RegistrationStoreShape,
  RegistrationTransitionConflict,
  type StoredRegistrationIntent,
} from "./registration/store.ts";
export {
  normalizeCreateRegistrationIntent,
  normalizeRegistrationAuthorization,
  normalizeRegistrationDigest,
  normalizeRegistrationQid,
  normalizeTransactionHash,
  RegistrationInputError,
} from "./registration/inputs.ts";
export {
  canTransitionRegistrationIntent,
  type RegistrationTransition,
  registrationTransitionSources,
} from "./registration/state.ts";
export type {
  CreateRegistrationIntent,
  RegistrationAuthorization,
  RegistrationIntentStatus,
} from "./registration/types.ts";
export { registrationIntentStatuses } from "./registration/types.ts";

export const apiVersion = 1 as const;
