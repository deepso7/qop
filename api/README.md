# @qop/api

QOP's general-purpose API service.

The current package exports:

- Schema-validated database and registry RPC configuration.
- A native Effect PostgreSQL service for future API-owned records.
- An on-demand registry chain reader.
- A bounded, memory-only, request-coalesced Effect cache with fresh and stale windows.
- Registry-specific cached, fresh, and invalidation operations.
- Transactional registration-intent storage with single-live-handle leases.
- Registration enrollment that checks fresh onchain availability, prepares the EIP-712 intent, verifies the owner, and only then applies the registrar signature.
- Registration HTTP routes: `POST /v1/registrations`, `POST /v1/registrations/:digest/authorize`, and `POST /v1/registrations/:digest/reconcile`; OpenAPI is served at `GET /openapi.json`.
- Capability-gated initial device observation at `POST /v1/devices/observe`, backed by public certificate storage and a single-use registration-to-certificate claim.
- A five-minute device-session challenge service that rechecks certificate rotation/revocation state, verifies MiniP2P Ed25519 proof of possession, and atomically consumes each challenge once. HTTP and token issuance are not yet exposed.

The registry cache stores the observed block number with every value. Ordinary reads may return a stale value while refreshing it in the background. Sensitive authorization and owner mutations must use the explicit `fresh` operations.

Postgres does not project or authoritatively store onchain identity state. Registration rows hold admission workflow state only. A per-handle lease prevents concurrent live registration intents for one handle; the registry remains first-wins and authoritative.

Unsigned intents may expire locally. Once both signatures exist, the lease is held until registration is confirmed or the enrollment reconciler proves terminal failure from one confirmed block's nonce, handle, owner, and timestamp state; wall-clock expiry alone cannot release a relayed intent.

The enrollment service receives the registrar signer as an Effect capability. The HTTP route layer remains runtime-agnostic; secret loading, server binding, and production middleware belong to the final API composition layer.

Prepare requests include a client-generated random 32-byte `idempotencyKey`. It authorizes replay of a lost response without disclosing the observe capability through public owner, handle, or PeerId fields. The API derives the observe token and persists only its hash.

Device observation transport errors are stable tagged responses: `DeviceObservationUnauthorized` (401), `DeviceObservationConflict` (409), `DeviceCertificateRejected` (422), `DeviceObservationInvalid` (422), and `DeviceObservationServiceUnavailable` (503). A `capability-consumed` conflict includes the certificate digest already bound to that capability. Exact retries return the original observation even if later rotation or revocation makes the certificate unusable for new authorization; observation stores public material only and does not mint a session.

Registration transport errors are stable tagged responses: `RegistrationUnauthorized` (401), `RegistrationNotFound` (404), `RegistrationConflict` (409), `RegistrationExpired` (410), `RegistrationInvalid` (422), and `RegistrationServiceUnavailable` (503).

Push the API-owned schema directly to the configured development database:

```sh
pnpm --filter @qop/api db:push
```

Schema changes use `db:push`; this package does not generate or commit migration files.

The API depends on `@qop/identity`; transport and persistence implementations remain service-local.
