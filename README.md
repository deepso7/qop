# QOP

QOP is a simple, minimal and secure messaging app built on top of [minip2p](https://minip2p.com).

Messages travel peer to peer. Identity lives on chain. A small API sponsors invitation-gated registration and later phone-approved add/remove device actions. It never holds owner secrets and does not choose pairing endpoints.

- **Open at the core.** Completely open source and self hostable.
- **Performance without compromise.** P2P and fully decentralised apps can easily become complicated and difficult to use. QOP stays simple and intuitive without compromising decentralisation, permissionlessness, or performance.

## How it works

1. **Identity registry** (`contracts/`). A Solidity contract maps a permanent handle to an owner address and raw Ed25519 device keys. It is the single source of truth for who owns which handle. Registration starts invitation gated and can be opened permanently by the registration admin.
2. **API** (`api/`). Verifies owner-signed EIP-712 intents and relays gas for registration and add/remove device actions. Clients still confirm account and device membership over RPC.
3. **Mobile app** (`mobile/`). An Expo app that generates keys on device, registers through the API, links additional devices, resolves peers from the chain, and chats over minip2p. Each transport connection is verified against the registry with a bounded authorization cache.
4. **CLI** (`cli/`). Links a separate device key with phone approval, then runs diagnostic chat as the same account. Durable outbox handoff is a later milestone.
5. **Identity library** (`packages/identity/`). Shared key derivation, EIP-712 domains and intents, recovery key encoding, and wire codecs.
6. **Protocol library** (`packages/protocol/`). Pairing codecs and the shared registry/session/chat pieces used by phone and CLI.

## Repository layout

| Path | Package | Description |
| --- | --- | --- |
| `contracts/` | Foundry | `QOPIdentityRegistry` and its protocol tests |
| `api/` | `@qop/api` | Registration and device-action relay service (Effect, Postgres, viem) |
| `cli/` | `@qop/cli` | Phone-approved device linking and diagnostic chat |
| `mobile/` | `mobile` | Expo app (Expo Router, minip2p, Effect) |
| `packages/identity/` | `@qop/identity` | Identity primitives shared by the API, CLI, and app |
| `packages/protocol/` | `@qop/protocol` | Pairing, registry reads, and live-session authorization |

Each package has its own README with details on configuration and operation.

## Prerequisites

- Node.js 22.19 or later in the 22.x line, or Node.js 24 or newer
- pnpm
- [Foundry](https://getfoundry.sh) for the contracts
- Postgres for the API
- Xcode or Android Studio for a mobile development build. Expo Go cannot load minip2p's native module.

## Getting started

Clone the repo, pull the contract submodules, and install dependencies:

```sh
git submodule update --init --recursive
pnpm install
```

### 1. Run a local chain and deploy the registry

Start Anvil, then deploy the registry. For local development the admin and signer may be Anvil test accounts.

```sh
anvil
```

```sh
REGISTRATION_ADMIN=0x... \
REGISTRATION_SIGNER=0x... \
forge script --root contracts contracts/script/DeployQOPIdentityRegistry.s.sol:DeployQOPIdentityRegistry \
  --broadcast \
  --private-key 0x... \
  --rpc-url http://127.0.0.1:8545
```

Note the deployed registry address. See `contracts/README.md` for the full policy and deployment requirements.

### 2. Configure and run the API

Copy `api/.env.example` to `api/.env`, then set the registry address, chain ID, RPC URL, database URL, and the two private keys. `REGISTRATION_PRIVATE_KEY` must match the `REGISTRATION_SIGNER` used at deploy time. `RELAYER_PRIVATE_KEY` pays gas and should be a separate, funded key.

```sh
pnpm --filter @qop/api db:push
pnpm --filter @qop/api admission:create
pnpm --filter @qop/api dev
```

`admission:create` prints a single use code to hand to a user. See `api/README.md` for the registration flow and routes.

### 3. Configure and run the app

Copy `mobile/.env.example` to `mobile/.env` and point `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_RPC_URL`, `EXPO_PUBLIC_REGISTRY_ADDRESS`, and `EXPO_PUBLIC_REGISTRY_CHAIN_ID` at the services above. Physical devices and emulators need addresses that can reach your development machine, so `127.0.0.1` usually does not work.

```sh
pnpm --filter mobile ios
pnpm --filter mobile android
```

Both commands build a native development client and connect it to Metro. See `mobile/README.md` for the manual verification checklist that exercises the native transport.

## Checks

```sh
pnpm check            # lint, package tests, and typecheck
pnpm check:contracts  # forge fmt, lint, and tests
pnpm fix              # apply lint and format fixes
```

Automated tests cover the identity library, the API, the SQL and store lifecycle in the app, and the contract. They do not exercise the native P2P transport, which needs two development builds.
