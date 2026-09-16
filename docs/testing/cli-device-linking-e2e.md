# CLI device linking E2E, 2026-09-16

PR #10, starting commit `31c1837`, tested with the fixes in this working tree.

## Result

Passed registration, CLI linking, removal, and fresh-key relinking on the existing iOS and Android emulators against a newly deployed Sepolia registry. All six add/remove transactions reached API `confirmed` status. Both phones retained their identity keys and existing chat history.

- iOS: existing iPhone 17 Pro simulator, iOS 26.5, installed `sh.qop.dev` client with the current Metro bundle.
- Android: existing `minip2p_pixel_10_pro_xl_16k_api37_1` emulator. Rebuilt and installed `sh.qop.dev` on that emulator without clearing its data. The handshake stalled with the old installed native client and succeeded after rebuilding.
- CLI: Node 24.21.0 on macOS, isolated test data directories, real native minip2p transport.
- UI automation: AXe CLI and `xcrun simctl` on iOS; `adb` on Android. No browser or UI connector automation.
- Transport: direct LAN QUIC. The configured public relay did not grant a reservation within 15 seconds; relay traversal was not verified.

## Deployment and configuration

Registry: `0x48cb5477f1cb10930a530545fa53f3840bed525e`, chain ID `11155111`.

[Deployment transaction](https://sepolia.etherscan.io/tx/0xd119dc88d0ada938af385a6ce7302e9af0b40da5426648d519dbde3147b5f26f), block `11713700`.

Used the existing Sepolia deployer, registration admin, and registration signer configuration. Updated the ignored `.env.sepolia`, `api/.env`, and `mobile/.env` files. API records for this deployment use the fresh `qop_pr10_20260916` database schema; old records remain intact. The direct database endpoint supports the schema search path, unlike its pooler.

API URL for these emulators is `http://127.0.0.1:3002`. Android reverses TCP ports 3002 and 8081 to the host. Metro uses port 8081. Real physical phones need a reachable host address instead.

## Cases exercised

| Case | iOS | Android |
| --- | --- | --- |
| Existing identity registers on new registry | Passed, @deepso / QID 2 | Passed, @qop_android_0905v / QID 1 |
| Profile → Devices shows current phone | Passed | Passed |
| Malformed payload rejected | Passed | Passed |
| Review payload, connect, approve CLI | Passed | Passed |
| Phone displays Linked; CLI status independently shows linked | Passed | Passed |
| Default CLI start retains diagnostic messaging gate | Passed | Passed |
| Remove CLI and retain phone history | Passed | Passed |
| Removed CLI start refuses inactive membership | Passed | Passed |
| Restart link rotates the permanently removed key | EB8BB2D2 → 768E8D1E | C7D34052 → 0632EE2A |
| Fresh-key relink confirms on phone and CLI | Passed | Passed |

The iOS account also rejected the Android account's payload before connecting or signing, and removed the stale Link button after rejection. iOS clipboard paste and the native paste-consent dialog were exercised; Android payloads were entered with `adb shell input text`.

## Issues fixed during testing

1. The CLI advertised wildcard `0.0.0.0` before relay readiness. It now waits for a relay reservation and expands wildcard IPv4 listeners to concrete local interface addresses.
2. Pairing used a browser `crypto` global absent in Hermes. The phone now supplies Expo Crypto random bytes through the handshake's explicit dependency.
3. API deadline validation used confirmation-depth block time, rejecting fresh phone approvals. It now uses latest chain time for deadlines while retaining confirmed roster reads.
4. A mined prior action still marked submitted blocked the next digest. The API now reconciles that prior action before retrying storage; genuinely pending actions still conflict.
5. Retrying an already enrolled device attempted another approval. The phone now recognizes its saved, active enrollment and reconciles it.
6. Local registration records were reused across registries. Storage is now scoped by chain and registry, preserving the underlying identity and conversation data.
7. Failed roster reads appeared as an empty device list. The screen now reports the load error and provides Retry.
8. Wrong-account review left a stale Link button. It now clears the paired peer as well as the offer.

The first iOS add submission was retried directly against the API using the CLI's already saved, phone-signed approval while diagnosing deadline validation. The subsequent iOS removal/relink and all successful Android actions used the phone UI with the fixes applied.

## Confirmed device actions

| Account | Action | Device fingerprint | Transaction |
| --- | --- | --- | --- |
| @deepso | add | EB8BB2D2 | [0xc6f66fca7e…](https://sepolia.etherscan.io/tx/0xc6f66fca7e70eed783de0e0ac68f260256f79d762feb31573859373390eb908d) |
| @deepso | remove | EB8BB2D2 | [0x3d159db904…](https://sepolia.etherscan.io/tx/0x3d159db9047793c95a672d8700e5f93b40217d0571e316944b6624fa07953030) |
| @deepso | add | 768E8D1E | [0x6399bfd57a…](https://sepolia.etherscan.io/tx/0x6399bfd57ae11d1593741bfe455cf1c99414deedfb7690854f54f793c663e7c7) |
| @qop_android_0905v | add | C7D34052 | [0xc37ba0b8f7…](https://sepolia.etherscan.io/tx/0xc37ba0b8f70ebb87ed0c818f50ee2f6784f2c715a9400dc883671aedf997e39b) |
| @qop_android_0905v | remove | C7D34052 | [0x9a90c2a6eb…](https://sepolia.etherscan.io/tx/0x9a90c2a6eb9696ee60470e3a1b06a766784e37887e9ddfdd52aa3a5f09dfc2a9) |
| @qop_android_0905v | add | 0632EE2A | [0x2d65fb8f4a…](https://sepolia.etherscan.io/tx/0x2d65fb8f4a9d1348ef4f811234900a7802b67cf8eac09f6463ad8e3d1f68e67e) |

## Verification and limits

### Offline delivery follow-up

Offline CLI delivery did **not** pass. With both phone apps terminated using `simctl terminate` and `adb shell am force-stop`, ran the linked Android account CLI with `start --to deepso --message offline-ios-20260916-test` and the linked iOS account CLI with `start --to qop_android_0905v --message offline-android-20260916-test`. Both runs explicitly enabled `QOP_ALLOW_UNPROVEN_LIFECYCLE=1` for diagnostic messaging.

Both commands exited with code 1 after `ConnectFailedError: connect deadline elapsed before any path was established`. Reopened both existing apps, confirmed their Chats screens, and queried their SQLite message stores. Neither offline test message was present. The CLI has no message persistence or automatic retry path: its outgoing frame exists only in memory, and a connection failure terminates the command. Reopening the recipient cannot recover that message. Durable outbox handoff is explicitly outside this CLI revision's documented scope.

Online controls did not establish a successful baseline either: the iOS destination run failed with `PeerVerificationError` at the session-closed check, and the Android destination run failed with `StreamClosedError` after the app was fully loaded. Therefore the offline timeouts alone do not isolate an offline-specific transport defect. Automatic offline delivery remains unsupported, and online CLI messaging needs further diagnosis before it can be called working. The earlier successful results apply to enrollment only.

Saved command logs under `.codex-tasks/pr10-e2e/offline-*.log` and `online-*.log`. Both phone apps were left open. No application code changed during this follow-up.

- `pnpm check`: 304 package tests passed; formatting, lint, and all package typechecks passed. The final test-fixture adjustment also passed the focused API enrollment suite and API typecheck. The final UI change passed lint/typecheck and its emulator rejection check.
- `forge test --root contracts`: 33 passed, including fuzz and invariant coverage.
- Android native build: successful; 520 Gradle tasks.
- `git diff --check`: passed.
- Screenshots and transaction records are in the ignored `.codex-tasks/pr10-e2e/` directory.
- No claim of relay traversal, physical-device testing, real laptop sleep/wake validation, or phone↔CLI message-history synchronization. CLI diagnostic messaging remains gated as designed.
