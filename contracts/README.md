# QOP identity contracts

Foundry project for the QOP identity registry and its protocol tests.

The registry is the authority for account ownership, multiple concurrent raw 32-byte Ed25519 device keys, owner versions, permanent handles, and account-action nonces. Registration begins launch-gated by a second registration-signer signature. A separate cold registration admin may rotate that hot signer while the gate is closed and can irreversibly call `openRegistration()` to make registration permissionless. After registration, anyone may relay a valid signed action.

The registration admin is immutable. Deployments must use a multisig or equivalent durable contract account from genesis; an operational EOA is not an acceptable admin because the registry cannot rotate it.

Registry policies enforced by the contract:

- Handles contain 1–32 ASCII characters, start with a lowercase letter or digit, and then use lowercase letters, digits, or underscores. They are permanent.
- `qid` values begin at 1 and increase sequentially.
- Registration always requires the owner signature over a nonzero first device key; while gated, it also requires the registration-signer signature over that exact intent.
- Owner rotation requires signatures from both the current and new owners, proving control of the destination key. Active devices are preserved on planned owner rotation.
- Device keys belong to one account at a time while active. An account may have up to four active devices. Zero active devices is allowed.
- `addDevice` / `removeDevice` authorize concurrent devices. Removed keys cannot be re-added (fresh key required on relink).
- `wipeDevices` clears every active key for owner recovery after compromise; devices must be re-added.
- Owner, device add/remove, and wipe actions share one account nonce.

Cross-language formats pinned by the contract tests and `@qop/identity`:

- Contract signatures accept 65-byte `r || s || v` with either canonical wire parity (`0`/`1`) or wallet-style `v` (`27`/`28`). Offchain wire schemas remain canonical `0`/`1`.
- EIP-712 domains bind every signature to the chain and immutable registry address.
- Registry intent digests share golden vectors.

The registry signs these EIP-712 intent types:

- `RegisterV1(string handle,address owner,bytes32 deviceKey,bytes32 nonce,uint64 deadline)`
- `RotateOwnerV1(uint256 qid,address newOwner,uint256 nonce,uint64 deadline)`
- `AddDeviceV1(uint256 qid,bytes32 deviceKey,uint256 nonce,uint64 deadline)`
- `RemoveDeviceV1(uint256 qid,bytes32 deviceKey,uint256 nonce,uint64 deadline)`
- `WipeDevicesV1(uint256 qid,uint256 nonce,uint64 deadline)`

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
