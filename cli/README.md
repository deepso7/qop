# @qop/cli

Phone-approved device linking and diagnostic chat for a second QOP device.

`qop link --account HANDLE` creates a device key, prints a `qop-pair1.` payload, and waits until that key is an active member of the account. Approve the payload on the phone (Profile → Devices → Link device). `qop link` waits for a relay reservation before printing its payload and falls back to concrete LAN addresses when the relay is unavailable. `qop start` verifies membership, then runs the holder. On Linux, messaging starts with SIGCONT, stall observe, and verify-boundary invalidation — no env override. macOS still requires `QOP_ALLOW_UNPROVEN_MACOS_LIFECYCLE=1` until lid sleep/wake is demonstrated. Outbound `--to/--message` is persisted in `outbox.json` before delivery. If the recipient is offline, the CLI keeps the message queued (not sent) and retries while it runs, including after restart. Inbound chat is saved to `inbox.json` before the acknowledgement. A linked phone can hand off pending text over `/qop/sync/1`; the CLI replies `held` only after that record is in `outbox.json`, then emits a receipt once Bob ACKs. `qop status` prints the queued count. `qop --help` lists `link`, `status`, and `start`.

Copy `.env.example` and export the variables (or use a direnv-style loader). `QOP_DATA_DIR` defaults to `~/.local/share/qop`. macOS and Linux only for `qop start`.
