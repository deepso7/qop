import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, it, vi } from "vitest";

import {
  createChatCipher,
  MAX_CHAT_ENVELOPE_BYTES,
} from "../src/chat-envelope.ts";
import { encodeFrame } from "../src/chat-wire.ts";

const frame = {
  fromHandle: "alice",
  id: "c56a4180-65aa-42ec-a945-5fd21dec0538",
  sentAt: 1,
  text: "a secret message",
  v: 1 as const,
};

const device = (tag: number) => {
  const seed = new Uint8Array(32).fill(tag);

  return { cipher: createChatCipher(seed), key: ed25519.getPublicKey(seed) };
};

const alice = device(1);
const bob = device(2);
const bobLaptop = device(3);
const aliceLaptop = device(4);

it("seals independent copies for the recipient and the sender's other devices", async () => {
  const targets = [bob, bobLaptop, aliceLaptop];

  const copies = await Promise.all(
    targets.map(({ key }) => alice.cipher.seal(frame, key))
  );

  await Promise.all(
    targets.map(async (target, index) => {
      const envelope = copies[index];

      if (!envelope) {
        throw new Error("Missing envelope");
      }

      await expect(target.cipher.open(envelope, alice.key)).resolves.toEqual(
        frame
      );
      const wrongDevice = target === bob ? bobLaptop : bob;
      await expect(
        wrongDevice.cipher.open(envelope, alice.key)
      ).rejects.toThrow();
      expect(new TextDecoder().decode(envelope)).not.toContain(frame.text);
    })
  );
});

it("rejects wrong signers, tampering, plaintext, invalid keys, and malformed envelopes", async () => {
  const envelope = await alice.cipher.seal(frame, bob.key);
  await expect(bob.cipher.open(envelope, bob.key)).rejects.toThrow();

  const tamper = (index: number) => {
    const changed = new Uint8Array(envelope);
    changed[index] = ((changed[index] ?? 0) + 1) % 256;

    return changed;
  };

  const invalid = [
    tamper(0),
    tamper(1),
    tamper(33),
    tamper(65),
    tamper(97),
    tamper(envelope.length - 1),
    envelope.subarray(0, 100),
    new Uint8Array(MAX_CHAT_ENVELOPE_BYTES + 1),
    encodeFrame(frame),
  ];

  await Promise.all(
    invalid.map((bytes) =>
      expect(bob.cipher.open(bytes, alice.key)).rejects.toThrow()
    )
  );

  await expect(alice.cipher.seal(frame, new Uint8Array(32))).rejects.toThrow(
    "Invalid recipient device key"
  );
  await expect(alice.cipher.seal(frame, new Uint8Array(16))).rejects.toThrow(
    "Invalid recipient device key"
  );
  await expect(bob.cipher.open(envelope, new Uint8Array(16))).rejects.toThrow(
    "Chat envelope does not authenticate these devices"
  );
});

it("does not require Web Crypto beyond secure random bytes", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });

  try {
    const freshAlice = device(11);
    const freshBob = device(12);
    const envelope = await freshAlice.cipher.seal(frame, freshBob.key);
    await expect(
      freshBob.cipher.open(envelope, freshAlice.key)
    ).resolves.toEqual(frame);
  } finally {
    vi.unstubAllGlobals();
  }
});
