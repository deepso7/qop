# CLI online chat E2E, 2026-09-17

Tested PR #11, starting at `ca52d1e`, on the existing iPhone 17 Pro simulator with iOS 26.5 and Android `minip2p_pixel_10_pro_xl_16k_api37_1` emulator. Both used `sh.qop.dev` and this branch's Metro bundle.

## Result

Online messaging passes with the two CLI fixes found during this run.

| Check | iOS | Android |
| --- | --- | --- |
| Create and register a fresh phone account | Passed | Passed |
| CLI sends; phone displays message; CLI receives acknowledgement | Passed | Passed |
| Phone replies; CLI prints reply; phone marks it sent | Passed | Passed |
| Restart CLI and send over a new connection | Passed | Passed |
| Phone-to-phone messages in both directions | Passed | Passed |
| Messages persist after terminating and reopening the phone app | Passed | Passed |

Fresh accounts were `@pr11_ios_0917` and `@pr11_android_0917`. Reused the previously linked CLI identities for `@deepso` and `@qop_android_0905v` after checking that their keys were still active registry members. No new CLI enrollment was necessary. Diagnostic sends explicitly enabled `QOP_ALLOW_UNPROVEN_LIFECYCLE=1`.

SQLite reads after restarting the apps confirmed received/sent status and one row per test message. The final CLI logs include both successful sends and the phone replies. The ordinary `qop start` command still refuses diagnostic messaging without the lifecycle override.

## Fixes found during testing

### Connection replacement during stream setup

The original PR still failed consistently when sending to iOS with `PeerDisconnectedError` during `openStream`. Rebuilding the iOS native client did not fix it.

Temporary connection logging showed Identify completing on a relayed connection, followed by that connection closing as a direct connection replaced it. The CLI aborted while opening chat on the old connection and closed the endpoint, including the new connection.

The CLI now retries connection/Identify/stream setup once for `PeerDisconnectedError`. Authorization happens on the returned stream and still checks the selected recipient QID. The retry does not include authorization, writing a message, or waiting for its acknowledgement.

The repeated iOS test completed Identify on the replacement connection, reported `directPunched`, and received an acknowledgement. Another fresh CLI run passed after removing the temporary logging. Focused tests reproduce the replacement and check that repeated disconnects stop after one retry.

### CLI shutdown cleanup

Long-running CLI sessions emitted Node's garbage-collected file-handle warning, and interrupting the process left its identity lock behind. The entry point now uses `NodeRuntime.runMain` so the runtime retains the main fiber and interrupts it on SIGINT/SIGTERM, running its existing finalizers.

Process tests launch the actual CLI against a local, deliberately pending RPC request and assert that each signal removes the lock. Both tests failed before the change and passed afterward. The emulator test sessions also removed their locks on shutdown, without the file-handle warning.

## Environment and limits

- Registry `0x48cb5477f1cb10930a530545fa53f3840bed525e`, Sepolia chain `11155111`; API port 3002 and Metro port 8081. Android reverses both ports.
- The installed apps had an older identity storage format. The user requested fresh accounts. iOS also retained a registration record for its previous identity; its chat database was backed up before using the app's reset flow.
- Android retained contacts from an older registry deployment. Sending from the old `@deepso` CLI collided with those historical QIDs/handles and failed contact storage. Using the other valid CLI identity isolated the transport checks. Registry changes still require care with existing chat data; this PR does not migrate or namespace historical contacts across deployments.
- The existing Android native client worked. iOS was rebuilt and installed without removing its fresh account. Build preparation refreshed CocoaPods, selected Xcode's SDK for pod installation, and corrected the ignored local Node executable path.
- No claim of durable offline delivery, real laptop lid sleep/wake, physical devices, or sustained relay-only messaging. The observed iOS path upgraded from relay to direct before the successful message.

`pnpm check` passed: 327 package tests, lint/format checks, and all package typechecks. The iOS simulator native build and `git diff --check` passed. Logs, screenshots, and local database evidence are in the ignored `.codex-tasks/pr11-e2e/` directory. Temporary debugging code was removed.
