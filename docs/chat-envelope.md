# Chat envelopes

`/qop/chat/2` sends a signed envelope as the request and an unchanged `ChatAckV1` on the same authenticated stream. Clients still authorize the sender against the registry and persist before acknowledging. The inner `ChatFrameV1` and deduplication key are unchanged.

| Field                          |    Bytes |
| ------------------------------ | -------: |
| Version (1)                    |        1 |
| Sender Ed25519 public key      |       32 |
| Recipient Ed25519 public key   |       32 |
| HPKE encapsulated key          |       32 |
| HPKE ciphertext, including tag | variable |
| Ed25519 signature              |       64 |

The first three fields are the HPKE associated data. The suite is RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, and ChaCha20-Poly1305, with info `qop/chat-envelope/1`. The recipient's X25519 key is converted from its existing Ed25519 device key. The signature covers the UTF-8 domain `qop/chat-envelope/1/sign` followed by a zero byte and all preceding envelope bytes. The receiver checks the expected sender and its own recipient key, verifies the signature, then opens the ciphertext. The maximum envelope size is 16 KiB of plaintext plus 177 bytes.

Each device copy is independently sealed. The sender and recipient device keys and message length are visible, but the message ID and contents are encrypted. A compromised recipient device key can decrypt that device's past envelopes; version 1 does not provide forward secrecy.

Live chat still sends to one verified device and uses its ACK. The TypeScript batch sealer takes recipient and sender-device keys together, skips the local device, and deduplicates device keys. Routing and retaining the additional copies is mailbox work, not part of the live chat protocol. Existing linked-device sync is a separate, same-account protocol: trusted CLI and desktop holders still see plaintext for their existing handoff and catch-up flows. A third-party mailbox must not use that protocol.
