# QOP identity contracts

Foundry project for the QOP identity registry and its protocol tests.

The registry is the authority for account ownership, owner versions, permanent handles, account-action nonces, and revoked certificate digests. Registration begins launch-gated by a second registration-signer signature. A separate cold registration admin may rotate that hot signer while the gate is closed and can irreversibly call `openRegistration()` to make registration permissionless. After registration, anyone may relay a valid signed action.

The registration admin is immutable. Deployments must use a multisig or equivalent durable contract account from genesis; an operational EOA is not an acceptable admin because the registry cannot rotate it.

Registry policies enforced by the contract:

- Handles contain 1–32 ASCII characters, start with a lowercase letter or digit, and then use lowercase letters, digits, or underscores. They are permanent.
- `qid` values begin at 1 and increase sequentially.
- Registration always requires the owner signature over a nonzero initial-device commitment; while gated, it also requires the registration-signer signature over that exact intent.
- Owner rotation requires signatures from both the current and new owners, proving control of the destination key.
- Owner rotation and device revocation share one account nonce.

Cross-language formats pinned by the contract tests and `@qop/identity`:

- Contract signatures accept 65-byte `r || s || v` with either canonical wire parity (`0`/`1`) or wallet-style `v` (`27`/`28`). Offchain wire schemas remain canonical `0`/`1`.
- EIP-712 domains bind every signature to the chain and immutable registry address.
- Registration, rotation, revocation, and device-certificate digests share golden vectors.

Initialize dependencies after cloning with:

```sh
git submodule update --init --recursive
```

Run the complete contract gate from the repository root with `pnpm check:contracts`, or run `forge test` from this directory.

## Deploy

The deployment script requires the durable registration-admin address and the hot registration-signer address. For local Anvil development they may be test accounts; a real deployment must use a multisig or equivalent durable account as `REGISTRATION_ADMIN`.

```sh
REGISTRATION_ADMIN=0x... \
REGISTRATION_SIGNER=0x... \
forge script --root contracts contracts/script/DeployQOPIdentityRegistry.s.sol:DeployQOPIdentityRegistry \
  --broadcast \
  --private-key 0x... \
  --rpc-url http://127.0.0.1:8545
```

Copy the deployed address into the API's `REGISTRY_ADDRESS`, and keep its chain ID aligned with `CHAIN_ID`. The API's funded `RELAYER_PRIVATE_KEY` is operational only and should not be either the registration admin or registration signer.
