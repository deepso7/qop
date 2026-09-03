# @qop/api

QOP's API handles invitation-gated registration. It verifies an owner-signed EIP-712 registration intent, claims a single-use admission code, adds the registrar signature, and relays the transaction to the registry.

The HTTP API has two registration routes:

- `POST /v1/registrations` validates and submits a complete registration.
- `GET /v1/registrations/:digest` reconciles a submitted registration with the confirmed registry state and may rebroadcast its transaction.

OpenAPI is available at `GET /openapi.json`.

Postgres stores admission codes, registration progress, and relayer nonce allocation. The registry remains authoritative for accounts. Each confirmed account includes its Ed25519 device key, so clients resolve handles over RPC. After registration confirms, the client never needs this service again.

`REGISTRATION_PRIVATE_KEY` signs gated registration intents. `RELAYER_PRIVATE_KEY` pays gas and submits them. Use separate keys so the funded relayer cannot authorize registrations.

## Admission codes

Create a single-use admission code after pushing the development schema:

```sh
pnpm --filter @qop/api admission:create
```

Only give the printed code to the user. Postgres stores its domain-separated hash. Development codes contain six uppercase letters or digits and print as `XXX-XXX`. The API also accepts lowercase input and the compact `XXXXXX` form. This short format needs request throttling before public deployment.

The API claims a code when it stores a signed registration. Confirmation consumes the code. A terminal registration failure releases it so the user can retry.

## Database schema

Push the API-owned schema to the configured development database:

```sh
pnpm --filter @qop/api db:push
```

Schema changes use `db:push`; this package does not commit migration files. This development revision has no production backfill. Replace existing development databases before the next push if they contain the removed draft, device certificate, or device session tables.
