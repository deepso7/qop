# @qop/api

QOP's API handles invitation-gated registration and sponsored add/remove device actions. It verifies owner-signed EIP-712 intents and relays transactions to the registry. It never receives owner secrets and cannot approve devices by itself.

The HTTP API groups are:

- `POST /v1/registrations` validates and submits a complete registration.
- `GET /v1/registrations/:digest` reconciles a submitted registration with the confirmed registry state and may rebroadcast its transaction.
- `POST /v1/device-actions` validates and submits an owner-signed add or remove.
- `GET /v1/device-actions/:digest` reconciles a sponsored device action from its stored transaction receipt and matching registry event.

OpenAPI is available at `GET /openapi.json`.

Postgres stores admission codes, registration progress, device-action intents, and shared relayer nonce allocation. The registry remains authoritative for accounts. Clients resolve handles and device membership over RPC. Registration and later device-roster changes both use this service.

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

## Deployment

`pnpm --filter @qop/api build` bundles the API twice: `dist/main.mjs` is a Node server, and `.vercel/output` is a prebuilt Vercel deployment with one function serving every path.

### Docker

`api/Dockerfile` ships only `dist/main.mjs` plus the node binary. Build it from the repo root:

```sh
docker build -f api/Dockerfile -t qop-api .
```

Pass the variables from `.env.example` as container environment variables. The container listens on `PORT`, which defaults to `3000`.

### Vercel

Vercel runs `src/vercel.ts`, a fetch handler over the same routes, as a Node.js function. `vercel.json` installs only the API's workspace dependencies and runs the build. Vercel then deploys `.vercel/output` as-is rather than compiling TypeScript itself, because its TypeScript builder doesn't work with TypeScript 7. Project setup:

- Set **Root Directory** to `api` and keep "Include files outside the root directory" enabled.
- Add the variables from `.env.example` except `PORT`, plus `ENABLE_EXPERIMENTAL_COREPACK=1` so the build uses the pnpm version pinned in the root `package.json`.
- Use Neon's pooled connection string (the `-pooler` host, with `sslmode=require`) for `DATABASE_URL`, and put the function region next to the database.

Vercel only pins Node majors, so the install skips the root `engines` check on the exact Node version.
