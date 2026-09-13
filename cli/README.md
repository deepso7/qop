# @qop/cli

Phone-approved device linking and diagnostic chat for a second QOP device.

`qop link --account HANDLE` creates a device key, prints a `qop-pair1.` payload, and waits until that key is an active member of the account. Approve the payload on the phone (Profile → Devices → Link device). `qop start` verifies membership, then enables diagnostic chat. `qop --help` lists `link`, `status`, and `start`. Durable outbox handoff is out of scope for this package revision.

Copy `.env.example` and export the variables (or use a direnv-style loader). `QOP_DATA_DIR` defaults to `~/.local/share/qop`. macOS and Linux only for `qop start`.
