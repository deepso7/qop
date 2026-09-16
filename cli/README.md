# @qop/cli

Phone-approved device linking and diagnostic chat for a second QOP device.

`qop link --account HANDLE` creates a device key, prints a `qop-pair1.` payload, and waits until that key is an active member of the account. Approve the payload on the phone (Profile → Devices → Link device). `qop link` waits for a relay reservation before printing its payload and falls back to concrete LAN addresses when the relay is unavailable. `qop start` verifies membership; diagnostic chat requires `QOP_ALLOW_UNPROVEN_LIFECYCLE=1` until real sleep/wake behavior is verified. `qop --help` lists `link`, `status`, and `start`. Durable outbox handoff is out of scope for this package revision.

Copy `.env.example` and export the variables (or use a direnv-style loader). `QOP_DATA_DIR` defaults to `~/.local/share/qop`. macOS and Linux only for `qop start`.
