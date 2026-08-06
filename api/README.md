# @qop/api

QOP's general-purpose API service.

The current package exports:

- Schema-validated database and registry RPC configuration.
- A native Effect PostgreSQL service for future API-owned records.
- An on-demand registry chain reader.
- A bounded, memory-only, request-coalesced Effect cache with fresh and stale windows.
- Registry-specific cached, fresh, and invalidation operations.

The registry cache stores the observed block number with every value. Ordinary reads may return a stale value while refreshing it in the background. Sensitive authorization and owner mutations must use the explicit `fresh` operations.

Postgres does not project or authoritatively store onchain identity state. The current schema is intentionally empty; enrollment, pairing, and session tables will be added as those routes land.

Once API-owned tables are added, push the schema directly to the configured development database:

```sh
pnpm --filter @qop/api db:push
```

Schema changes use `db:push`; this package does not generate or commit migration files.

The API depends on `@qop/identity`; transport and persistence implementations remain service-local.
