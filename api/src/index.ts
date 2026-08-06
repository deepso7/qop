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
  normalizeRegistryRegistrationNonce,
  RegistryInputError,
} from "./registry/inputs.ts";
export {
  RegistryReader,
  RegistryReaderLive,
  type RegistryInvalidations,
  type RegistryRead,
  type RegistryReaderShape,
  type RegistryReads,
  type RegistryFreshReads,
} from "./registry/reader.ts";
export type {
  RegistryAccount,
  RegistryRegistrationProbe,
  RegistrySnapshot,
} from "./registry/types.ts";
export {
  RegistrationEnrollment,
  type RegistrationEnrollmentError,
  RegistrationEnrollmentLive,
  type RegistrationEnrollmentShape,
  RegistrationHandleUnavailable,
  RegistrationOwnerUnavailable,
  RegistrationProtocolError,
  registrationReconciliationFailureCodes,
  RegistrationSignatureMismatch,
  registrationIntentTtlSeconds,
  type AuthorizedRegistration,
  type AuthorizeRegistration,
  type PreparedRegistration,
  type PrepareRegistration,
  type ReconciledRegistration,
} from "./registration/enrollment.ts";
export {
  RegistrationEntropy,
  RegistrationEntropyError,
  type RegistrationEntropyShape,
} from "./registration/entropy.ts";
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
  normalizeRegistrationOwner,
  normalizeRegistrationOwnerSignature,
  normalizeRegistrationPeerId,
  normalizeRegistrationQid,
  normalizeRegistrationSignerSignature,
  normalizeTransactionHash,
  RegistrationInputError,
} from "./registration/inputs.ts";
export {
  makeRegistrationSigner,
  RegistrationSigner,
  RegistrationSignerError,
  type RegistrationSignerShape,
  registrationSignerLayer,
} from "./registration/signer.ts";
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
