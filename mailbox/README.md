# `@qop/mailbox`

Self-hostable encrypted store-and-forward mailbox node for QOP (`/qop/mailbox/1`).

The mailbox stores only signed per-device HPKE envelopes (`chat-envelope.ts`) in SQLite and never sees plaintext message bodies. Callers authenticate by their minip2p Ed25519 transport peer ID, checked against `qidByDeviceKey` on the on-chain QOP registry.

> **v1 scope:** Clients point at configured mailbox addresses via `QOP_MAILBOX_ADDRS` / `EXPO_PUBLIC_QOP_MAILBOX_ADDRS` and mark mailbox-accepted messages as `sent`. Per-recipient mailbox discovery and separate stored-vs-delivered receipts are follow-ups.

## Run locally or self-host

```bash
QOP_RPC_URL=http://127.0.0.1:8545 \
QOP_REGISTRY_ADDRESS=0x... \
QOP_LISTEN_ADDRS=/ip4/0.0.0.0/udp/19877/quic-v1 \
pnpm --filter @qop/mailbox run start
```

On startup it prints its peer ID and bound listen multiaddr(s):

```text
qop-mailbox peerId=12D3KooW...
qop-mailbox addr=/ip4/0.0.0.0/udp/19877/quic-v1/p2p/12D3KooW...
```

> **Note:** `0.0.0.0` is a bind wildcard printed as-is by minip2p. For remote clients, replace `/ip4/0.0.0.0/` with the host's reachable public IP (or `/dns4/<host>/`) while keeping the UDP port and `/p2p/<peerId>`, then pass it to clients:
>
> ```bash
> # CLI / Desktop
> QOP_MAILBOX_ADDRS=/dns4/mailbox.example.com/udp/19877/quic-v1/p2p/12D3KooW...
> # Mobile
> EXPO_PUBLIC_QOP_MAILBOX_ADDRS=/dns4/mailbox.example.com/udp/19877/quic-v1/p2p/12D3KooW...
> ```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `QOP_RPC_URL` | required | JSON-RPC URL for the QOP registry chain |
| `QOP_REGISTRY_ADDRESS` | required | QOP registry contract address |
| `QOP_REGISTRY_CHAIN_ID` | `31337` | Expected chain ID (verified against RPC at startup) |
| `QOP_LISTEN_ADDRS` | `/ip4/0.0.0.0/udp/19877/quic-v1` | Comma-separated minip2p listen multiaddrs |
| `QOP_RELAY_ADDRS` | empty | Optional minip2p relay multiaddrs for NAT traversal |
| `QOP_MAILBOX_DATA_DIR` | `~/.qop-mailbox` | Directory for `mailbox.key` and `mailbox.db` |
| `QOP_MAILBOX_TTL_DAYS` | `30` | Envelope retention window before automatic expiry |

## Optional mobile push wakeups

The mailbox can send a content-free wake signal after committing an envelope. When the device key is available, the app fetches and decrypts the envelope, saves the message, and only then acknowledges delivery. Push providers receive the device token and wake signal, never the sender, handle, or message. The configured mailbox can associate the token with the recipient's device key.

Build the native app with `EXPO_PUBLIC_QOP_MAILBOX_PUSH=1` and `EXPO_PUBLIC_QOP_MAILBOX_ADDRS` set. Open it once with an enrolled device so it can register for wakes.

The iOS device key stays accessible only while unlocked. If a wake runs while the key is unavailable, the app can show a generic local alert (if notifications are allowed) without fetching, decrypting, or acknowledging anything. The mailbox retains the ciphertext until a wake or poll runs with the key available. Unlocking the phone alone does not guarantee that iOS will run the app. The account recovery key's storage is unchanged.

| Platform | Native app build | Mailbox server |
| --- | --- | --- |
| Android | Set `GOOGLE_SERVICES_JSON` to a [Firebase configuration file](https://firebase.google.com/docs/android/setup) for the selected `APP_VARIANT` package. | Set `QOP_FCM_PROJECT_ID` and configure [Application Default Credentials](https://firebase.google.com/docs/cloud-messaging/send/v1-api#authorize-http-v1-send-requests) with Cloud Messaging send permission. |
| iOS | Enable Push Notifications on the matching Apple App ID and use a provisioning profile with the push entitlement. Set `QOP_APNS_ENVIRONMENT=development` for a sandbox build. | Set `QOP_APNS_KEY_FILE` (path to the `.p8` key), `QOP_APNS_KEY_ID`, `QOP_APNS_TEAM_ID`, and `QOP_APNS_TOPIC` (the app's bundle ID). Set `QOP_APNS_ENVIRONMENT` to match the app (defaults to `production`). |

Push is best effort: providers may delay or drop wakes, and the OS can block background launches (including after iOS force-quit or Android Force stop). Envelopes remain stored for the next successful mailbox poll or wake.
