import { ed25519 } from "@noble/curves/ed25519.js";
import {
  AEAD_ChaCha20Poly1305,
  KDF_HKDF_SHA256,
  KEM_DHKEM_X25519_HKDF_SHA256,
} from "@panva/hpke-noble";
import { CipherSuite } from "hpke";

import {
  decodeFrame,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "./chat-wire.ts";
import type { ChatFrame } from "./chat-wire.ts";

const VERSION = 1;
const KEY_BYTES = 32;
const HEADER_BYTES = 1 + 2 * KEY_BYTES;
const SIGNATURE_BYTES = 64;
const TAG_BYTES = 16;
const OVERHEAD_BYTES = HEADER_BYTES + KEY_BYTES + TAG_BYTES + SIGNATURE_BYTES;
export const MAX_CHAT_ENVELOPE_BYTES = MAX_CHAT_PAYLOAD_BYTES + OVERHEAD_BYTES;

const INFO = new TextEncoder().encode("qop/chat-envelope/1");
const SIGNATURE_DOMAIN = new TextEncoder().encode("qop/chat-envelope/1/sign\0");

const concat = (...parts: readonly Uint8Array[]) => {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  );

  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return bytes;
};

const equalKeys = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const isDeviceKey = (key: Uint8Array) => {
  const point = ed25519.Point.fromBytes(key);

  return !point.isSmallOrder() && point.isTorsionFree();
};

const read = (bytes: Uint8Array) => {
  if (
    bytes.length <= OVERHEAD_BYTES ||
    bytes.length > MAX_CHAT_ENVELOPE_BYTES ||
    bytes[0] !== VERSION
  ) {
    throw new Error("Invalid chat envelope");
  }

  const envelope = new Uint8Array(bytes);

  return {
    ciphertext: envelope.subarray(HEADER_BYTES + KEY_BYTES, -SIGNATURE_BYTES),
    enc: envelope.subarray(HEADER_BYTES, HEADER_BYTES + KEY_BYTES),
    header: envelope.subarray(0, HEADER_BYTES),
    recipient: envelope.subarray(1 + KEY_BYTES, HEADER_BYTES),
    sender: envelope.subarray(1, 1 + KEY_BYTES),
    signature: envelope.subarray(-SIGNATURE_BYTES),
    signed: envelope.subarray(0, -SIGNATURE_BYTES),
  };
};

/** Opens only mail for this device; the caller still authorizes the sender against the registry. */
export const createChatCipher = (
  secretKey: Uint8Array,
  randomBytes: (length: number) => Uint8Array = (length) =>
    globalThis.crypto.getRandomValues(new Uint8Array(length))
) => {
  const senderKey = new Uint8Array(secretKey);
  const ownKey = ed25519.getPublicKey(senderKey);

  const suite = new CipherSuite(
    () => ({
      ...KEM_DHKEM_X25519_HKDF_SHA256(),
      GenerateKeyPair(extractable) {
        return this.DeriveKeyPair(randomBytes(KEY_BYTES), extractable);
      },
    }),
    KDF_HKDF_SHA256,
    AEAD_ChaCha20Poly1305
  );

  const seal = async (frame: ChatFrame, recipientDeviceKey: Uint8Array) => {
    const plaintext = encodeFrame(frame);

    if (!isDeviceKey(recipientDeviceKey)) {
      throw new Error("Invalid recipient device key");
    }

    const header = concat(Uint8Array.of(VERSION), ownKey, recipientDeviceKey);

    const publicKey = await suite.DeserializePublicKey(
      ed25519.utils.toMontgomery(recipientDeviceKey)
    );

    const { ciphertext, encapsulatedSecret } = await suite.Seal(
      publicKey,
      plaintext,
      {
        aad: header,
        info: INFO,
      }
    );

    const signed = concat(header, encapsulatedSecret, ciphertext);
    const signature = ed25519.sign(concat(SIGNATURE_DOMAIN, signed), senderKey);

    return concat(signed, signature);
  };

  return {
    async open(
      envelope: Uint8Array,
      senderDeviceKey: Uint8Array
    ): Promise<ChatFrame> {
      const { ciphertext, enc, header, recipient, sender, signature, signed } =
        read(envelope);

      if (
        !equalKeys(sender, senderDeviceKey) ||
        !equalKeys(recipient, ownKey) ||
        !isDeviceKey(sender) ||
        !ed25519.verify(signature, concat(SIGNATURE_DOMAIN, signed), sender, {
          zip215: false,
        })
      ) {
        throw new Error("Chat envelope does not authenticate these devices");
      }

      const privateKey = await suite.DeserializePrivateKey(
        ed25519.utils.toMontgomerySecret(senderKey)
      );

      return decodeFrame(
        await suite.Open(privateKey, enc, ciphertext, {
          aad: header,
          info: INFO,
        })
      );
    },
    seal,
    /** Uses the same message ID for each independently sealed device copy. */
    sealForDevices(
      frame: ChatFrame,
      devices: readonly Uint8Array[]
    ): Promise<Uint8Array[]> {
      const targets: Uint8Array[] = [];

      for (const device of devices) {
        if (
          !equalKeys(device, ownKey) &&
          !targets.some((target) => equalKeys(target, device))
        ) {
          targets.push(device);
        }
      }

      return Promise.all(targets.map((device) => seal(frame, device)));
    },
  };
};

export type ChatCipher = ReturnType<typeof createChatCipher>;
