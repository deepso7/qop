# Phone to CLI handoff E2E, 2026-09-18

PR #13, initially tested from `96c6e29`, then rebased onto concurrent update `60e1a2a` and retested with the fixes in this change.

## Result

Passed the durable handoff scenario in both directions on the existing installed development clients. The sender handed off a message while the recipient was offline, displayed **Waiting on your CLI**, was force-stopped, and remained stopped while its CLI restarted and delivered the message. Reopening the sender reconciled the delivery receipt to `sent`.

| Sender | Recipient | Final test message ID | Sender / CLI / recipient state | Recipient rows |
| --- | --- | --- | --- | --- |
| iOS | Android | `65d8307d-6e92-4e78-94e1-f2fc81dd71b8` | sent / sent / received | 1 |
| Android | iOS | `02e9af3c-2858-44b0-a4a1-b8bfba5615fd` | sent / sent / received | 1 |

Verified message IDs and states in both phone SQLite databases and the CLI JSON outboxes, alongside screenshots of the held and delivered UI. Neither phone gained a self-chat contact. Both CLI outboxes remained mode `600`. Existing SQLite databases migrated to schema version 2 initially and version 3 after the rebase, with their history intact. The final runs also verified persisted holder IDs and their removal after receipt reconciliation.

## Setup and procedure

- iOS: existing iPhone 17 Pro simulator, iOS 26.5, `sh.qop.dev`, account `@pr11_ios_0917`, QID 4.
- Android: existing `minip2p_pixel_10_pro_xl_16k_api37_1` emulator, installed `sh.qop.dev`. It opened at onboarding, so a fresh account `@pr13_android_0918`, QID 5, was registered through the UI.
- Linked a new independent CLI to each phone through Profile → Devices. Both enrollments confirmed on Sepolia registry `0x48cb5477f1cb10930a530545fa53f3840bed525e`.
- CLI identities used isolated directories under `/tmp/qop-pr13-e2e/`. Messaging explicitly enabled `QOP_ALLOW_UNPROVEN_LIFECYCLE=1`.
- Mobile used the current Metro bundle. No native rebuild or database reset was needed.

For each final case, stopped the recipient app and its CLI, sent a uniquely named message from the other phone, and checked that the sender remained `held` after the direct-send timeout. Force-stopped the sender, interrupted its CLI with SIGINT, and restarted that CLI against the same data directory. The CLI reported a resumed queued message. Opened the recipient and waited for its normal retry schedule. Checked one received row and a sent CLI record before reopening the sender. Finally checked receipt reconciliation to `sent`.

An online control also reached `sent` and produced one recipient row despite phone and CLI delivery attempts sharing the same message ID. Earlier diagnostic messages were retained and ultimately delivered once as well.

## Bugs found and fixed

1. The CLI passed `stream.write` and `stream.closeWrite` as unbound callbacks. Real minip2p streams use private instance fields, so replying threw `TypeError: Cannot read properties of undefined (reading '#closed')` after the outbox write. The phone reported failure although the CLI held the message. Wrapping both calls preserves their receiver for held replies and receipt responses. A regression test failed on the original code and passes with the fix.
2. A late direct-send failure could overwrite a `held` status established by concurrent reconciliation. Android demonstrated `held → failed` while its CLI still delivered successfully. Ordinary failure transitions now preserve accepted holds; a separate conditional update handles explicit CLI rejection without overwriting `sent`. A regression test reproduces the competing send and reconciliation jobs and failed before the fix. Existing permanent-rejection tests still pass.

Both final emulator cases were rerun with both fixes applied, then repeated after integrating `60e1a2a`, which persists holder IDs and batches receipt polling. The rebased runs initially failed before CLI acceptance; tapping Retry established the hold. Initial connection/handoff can still require a manual retry. The subsequent restart/delivery/receipt sequences passed.

## Evidence and limits

Local logs, database observations, and screenshots are in the ignored `.codex-tasks/pr13-e2e/` directory. This tests local emulators and real native transport against Sepolia; it does not prove physical-device behavior, relay-only traversal, or laptop lid sleep/wake. The lifecycle gate remains in place. The final emulator runs used one linked CLI per account. Multi-holder routing and more than 32 receipts were covered by the incoming commit's automated tests, not by manual emulator scenarios.

One Android development-launcher reload crashed with `App react context shouldn't be created before`; a cold launch recovered. The final cold-launch scenarios completed successfully.

The first full check timed out in the existing CLI process-start/SIGINT test while both emulators were running. The focused CLI suite passed all 90 tests, and package typechecks passed. After shutting down the test processes and emulators, `pnpm check` passed formatting, lint, all 398 package tests, and all package typechecks. `git diff --check` passed. Both emulators were confirmed shut down at the end.
