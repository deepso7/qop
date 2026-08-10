# QOP identity contracts

Foundry project for the QOP identity registry and its protocol tests.

The registry is the authority for account ownership, owner versions, permanent handles, account-action nonces, and revoked certificate digests. Registration begins launch-gated by a second registration-signer signature. The signer may rotate while the gate is closed, and can irreversibly call `openRegistration()` to make registration permissionless. After registration, anyone may relay a valid signed action.

Registry policies enforced by the contract:

- Handles contain 1–32 lowercase ASCII letters and are permanent.
- `qid` values begin at 1 and increase sequentially.
- Registration always requires the owner signature over a nonzero initial-device commitment; while gated, it also requires the registration-signer signature over that exact intent.
- Owner rotation requires signatures from both the current and new owners, proving control of the destination key.
- Owner rotation and device revocation share one account nonce.

Cross-language formats pinned by the contract tests and `@qop/identity`:

- Contract signatures use canonical 65-byte `r || s || yParity` encoding, with `yParity` equal to 0 or 1.
- EIP-712 domains bind every signature to the chain and immutable registry address.
- Registration, rotation, revocation, and device-certificate digests share golden vectors.

Initialize dependencies after cloning with:

```sh
git submodule update --init --recursive
```

Run the complete contract gate from the repository root with `pnpm check:contracts`, or run `forge test` from this directory.
