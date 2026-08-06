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

The registry cache stores the observed block number with every value. Ordinary reads may return a stale value while refreshing it in the background. Sensitive authorization and owner mutations must use the explicit `fresh` operations.

Postgres does not project or authoritatively store onchain identity state. Registration rows hold admission workflow state only. A per-handle lease prevents concurrent live registration intents for one handle; the registry remains first-wins and authoritative.

Unsigned intents may expire locally. Once both signatures exist, the lease is held until registration is confirmed or the enrollment reconciler proves terminal failure from one confirmed block's nonce, handle, owner, and timestamp state; wall-clock expiry alone cannot release a relayed intent.

The enrollment service receives the registrar signer as an Effect capability. Secret loading and HTTP exposure are intentionally left to the API composition layer.

Push the API-owned schema directly to the configured development database:

```sh
pnpm --filter @qop/api db:push
```

Schema changes use `db:push`; this package does not generate or commit migration files.

The API depends on `@qop/identity`; transport and persistence implementations remain service-local.
