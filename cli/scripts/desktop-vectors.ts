/**
 * Golden vectors for the Rust desktop port (`desktop/src/wire`, `registry.rs`).
 *
 * Every expected value comes from the real TS encoders and decoders, run on
 * fixed keys, nonces and timestamps. After a protocol change run
 * `pnpm --filter @qop/cli vectors:desktop`, then make the Rust tests pass.
 * `test/desktop-vectors.test.ts` fails when the committed files drift.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import {
  deviceKeyFromEd25519SecretKey,
  deviceKeyFromPeerId,
  EcdsaSignature,
  Handle,
  hashAddDeviceIntentV1,
  identityEip712DomainName,
  identityEip712DomainVersion,
  PeerId,
  peerIdFromDeviceKey,
  recoverAddDeviceIntentSignerV1,
  signAddDeviceIntentV1,
  strictParseOptions,
} from "@qop/identity";
import type { AddDeviceIntentV1 } from "@qop/identity";
import {
  createRegistryReader,
  decodeAck,
  decodeFrame,
  decodePairingFrameV1,
  decodePairingOfferV1,
  decodeSyncRequestV1,
  decodeSyncResponseV1,
  DeviceActionApprovalV1,
  encodeAck,
  encodeDeviceActionApprovalV1,
  encodeFrame,
  encodePairingFrameV1,
  encodePairingOfferV1,
  encodeSyncRequestV1,
  encodeSyncResponseV1,
  pairingFingerprint,
  registryAbi,
  verifyApprovalDigest,
} from "@qop/protocol";
import type {
  ChatFrame,
  PairingFrame,
  PairingOfferV1Encoded,
  RegistryReadClient,
  SyncRequest,
  SyncResponse,
} from "@qop/protocol";
import { Effect, Result, Schema } from "effect";
import {
  bytesToHex,
  decodeFunctionResult,
  domainSeparator,
  encodeFunctionData,
  encodeFunctionResult,
  hexToBytes,
  keccak256,
  toBytes,
} from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getDeviceActionStatus } from "../src/device-action-status.ts";

// --- Shared helpers --------------------------------------------------------

/** What a TS call did: its JSON-safe result, or the kind of error it raised. */
type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly error: string; readonly ok: false };

/** Every failure is an Error; qop codec errors add an `operation`. */
interface Failure {
  readonly message: string;
  readonly operation?: string;
}

const errorKind = (error: Failure) => error.operation ?? "invalid";

const settle = async <A, E extends Failure>(
  effect: Effect.Effect<A, E>
): Promise<Outcome<A>> => {
  const result = await Effect.runPromise(Effect.result(effect));

  return Result.isSuccess(result)
    ? { ok: true, value: result.success }
    : { error: errorKind(result.failure), ok: false };
};

/** For the throwing chat codecs: size errors say "exceeds". */
const settleSync = <A>(run: () => A): Outcome<A> => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    const oversized =
      error instanceof Error && error.message.includes("exceeds");

    return { error: oversized ? "oversized" : "invalid", ok: false };
  }
};

const mapOutcome = <A, B>(outcome: Outcome<A>, f: (value: A) => B) =>
  outcome.ok ? { ok: true as const, value: f(outcome.value) } : outcome;

const textEncoder = new TextEncoder();
const utf8 = (text: string) => textEncoder.encode(text);
const fromUtf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const concat = (...parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

const fill = (byte: number, length = 32) => new Uint8Array(length).fill(byte);
const hexFill = (byte: string, length = 32): Hex => `0x${byte.repeat(length)}`;
const upperHex = (value: string) => `0x${value.slice(2).toUpperCase()}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const dropLastByte = (data: Hex): Hex => `0x${data.slice(2, -2)}`;

/**
 * A decoder input: readable text when it is valid UTF-8, hex otherwise.
 * `padTo` (size-limit cases) means: append spaces up to that many bytes.
 */
type Input =
  | { readonly hex: string }
  | { readonly padTo?: number; readonly text: string };

const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const INVALID_UTF8 = Uint8Array.from([0xff, 0xfe]);
const LONG_PADDING = /\s{1000,}$/u;

const asInput = (bytes: Uint8Array): Input => {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    if (text.startsWith("\uFEFF")) {
      return { hex: bytesToHex(bytes) };
    }

    return LONG_PADDING.test(text)
      ? { padTo: bytes.byteLength, text: text.trimEnd() }
      : { text };
  } catch {
    return { hex: bytesToHex(bytes) };
  }
};

/** Swap the `|` in `json` for bytes that are not valid UTF-8. */
const withInvalidUtf8 = (json: string) => {
  const [head = "", tail = ""] = json.split("|");

  return concat(utf8(head), INVALID_UTF8, utf8(tail));
};

/** Replace the first occurrence of `from` with another raw JSON fragment. */
const patch = (json: string, from: string, to: string) => {
  if (!json.includes(from)) {
    throw new Error(`vector patch target missing: ${from}`);
  }

  return json.replace(from, to);
};

/** Pad JSON with trailing whitespace to an exact byte length. */
const padTo = (json: string, byteLength: number) =>
  json + " ".repeat(byteLength - utf8(json).byteLength);

interface DecodeCase {
  readonly bytes: Uint8Array;
  readonly name: string;
}

// --- Fixtures --------------------------------------------------------------

const CHAIN_ID = 31_337n;
const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const QID = 42n;
const NONCE = 7n;
const NOW = 1_700_000_000n;
const DEADLINE = NOW + 600n;
const OWNER_KEY = concat(fill(0, 31), Uint8Array.of(1));
const OWNER = privateKeyToAccount(bytesToHex(OWNER_KEY)).address.toLowerCase();
const DOMAIN = { chainId: CHAIN_ID, verifyingContract: REGISTRY };
const ENCODED_DOMAIN = { chainId: "31337", verifyingContract: REGISTRY };

const SECP256K1_N =
  0xff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_fe_ba_ae_dc_e6_af_48_a0_3b_bf_d2_5e_8c_d0_36_41_41n;

const DEVICE_SECRETS = [
  fill(0x01),
  fill(0x42),
  Uint8Array.from({ length: 32 }, (_, index) => index),
];

const SESSION_ID = hexFill("a1");
const SECRET = hexFill("b2");
const CHALLENGE = hexFill("c3");
const ID_A = "0b6f5c4e-8f1d-4a2b-9c3d-1e2f3a4b5c6d";
const ID_B = "9a8b7c6d-5e4f-4321-8abc-def012345678";

const RELAY_ADDR =
  "/ip4/203.0.113.7/udp/4001/quic-v1/p2p/12D3KooWGzBkEvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/p2p-circuit";

const LAN_ADDR = "/ip4/192.168.1.20/udp/53110/quic-v1";

const deviceKeyOf = (secret: Uint8Array) =>
  Effect.runSync(deviceKeyFromEd25519SecretKey(secret));

const DESKTOP_KEY = bytesToHex(deviceKeyOf(fill(0x01)));
const PHONE_KEY = bytesToHex(deviceKeyOf(fill(0x42)));

const addIntent = (
  overrides: Partial<AddDeviceIntentV1> = {}
): AddDeviceIntentV1 => ({
  deadline: DEADLINE,
  deviceKey: hexToBytes(DESKTOP_KEY),
  nonce: NONCE,
  qid: QID,
  ...overrides,
});

const encodedIntent = (intent: AddDeviceIntentV1) => ({
  deadline: intent.deadline.toString(),
  deviceKey: bytesToHex(intent.deviceKey),
  nonce: intent.nonce.toString(),
  qid: intent.qid.toString(),
});

const sign = (intent: AddDeviceIntentV1) =>
  Effect.runPromise(
    signAddDeviceIntentV1(DOMAIN, intent, OWNER_KEY).pipe(
      Effect.map(bytesToHex)
    )
  );

const digestOf = (intent: AddDeviceIntentV1) =>
  Effect.runSync(hashAddDeviceIntentV1(DOMAIN, intent));

const signature = (r: bigint, s: bigint, parity: string): Hex =>
  `0x${word(r)}${word(s)}${parity}`;

/** The same signature with s mirrored to n - s (and parity flipped). */
const highS = (sig: Hex) =>
  signature(
    BigInt(`0x${sig.slice(2, 66)}`),
    SECP256K1_N - BigInt(`0x${sig.slice(66, 130)}`),
    sig.slice(130) === "00" ? "01" : "00"
  );

const uuids = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`
  );

// --- Identity --------------------------------------------------------------

const identityVectors = async () => {
  const devices = DEVICE_SECRETS.map((secretKey) => {
    const deviceKey = deviceKeyOf(secretKey);

    const peerId = Effect.runSync(
      peerIdFromDeviceKey(deviceKey).pipe(
        Effect.flatMap(Schema.encodeEffect(PeerId))
      )
    );

    const deviceKeyHex = bytesToHex(deviceKey);

    return {
      deviceKey: deviceKeyHex,
      fingerprint: pairingFingerprint(deviceKeyHex),
      peerId,
      secretKey: bytesToHex(secretKey),
    };
  });

  const valid = devices[0]?.peerId ?? "";

  const cases = [
    ...devices.map((device) => ({ name: "derived", peerId: device.peerId })),
    { name: "one char short", peerId: valid.slice(0, -1) },
    { name: "one char long", peerId: `${valid}1` },
    { name: "non-base58 zero", peerId: `0${valid.slice(1)}` },
    { name: "other prefix", peerId: `1${"2".repeat(51)}` },
    { name: "too many bytes", peerId: "z".repeat(52) },
    {
      name: "sha256 multihash",
      peerId: "QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N",
    },
    { name: "empty", peerId: "" },
  ];

  const peerIdToDeviceKey = await Promise.all(
    cases.map(async ({ name, peerId }) => {
      const outcome = await settle(
        Schema.decodeUnknownEffect(PeerId)(peerId).pipe(
          Effect.flatMap(deviceKeyFromPeerId)
        )
      );

      return { name, peerId, ...mapOutcome(outcome, bytesToHex) };
    })
  );

  return { devices, peerIdToDeviceKey };
};

// --- EIP-712 ---------------------------------------------------------------

const recoverWith = (sig: string) =>
  settle(
    Schema.decodeUnknownEffect(EcdsaSignature)(sig).pipe(
      Effect.flatMap((bytes) =>
        recoverAddDeviceIntentSignerV1(DOMAIN, addIntent(), bytes)
      )
    )
  );

/** The smallest r below n that is no curve x-coordinate: recovery must fail. */
const offCurveR = async (
  s: bigint,
  parity: string,
  r = 1n
): Promise<bigint> => {
  const outcome = await recoverWith(signature(r, s, parity));

  return outcome.ok ? offCurveR(s, parity, r + 1n) : r;
};

const eip712Vectors = async () => {
  const intents = [
    addIntent(),
    addIntent({
      deadline: 2n ** 64n - 1n,
      deviceKey: hexToBytes(PHONE_KEY),
      nonce: 0n,
      qid: 2n ** 256n - 1n,
    }),
  ];

  const addDevice = await Promise.all(
    intents.map(async (intent) => {
      const sig = await sign(intent);

      const signer = await Effect.runPromise(
        recoverAddDeviceIntentSignerV1(DOMAIN, intent, hexToBytes(sig))
      );

      return {
        digest: digestOf(intent),
        intent: encodedIntent(intent),
        signature: sig,
        signer,
      };
    })
  );

  const hashCases = [
    {
      chainId: CHAIN_ID,
      intent: addIntent({ deviceKey: fill(0) }),
      name: "zero device key",
    },
    { chainId: CHAIN_ID, intent: addIntent({ qid: 0n }), name: "zero qid" },
    { chainId: 0n, intent: addIntent(), name: "zero chain id" },
  ];

  const hashRejections = await Promise.all(
    hashCases.map(async ({ chainId, intent, name }) => ({
      domain: { chainId: chainId.toString(), verifyingContract: REGISTRY },
      intent: encodedIntent(intent),
      name,
      ...(await settle(
        hashAddDeviceIntentV1({ chainId, verifyingContract: REGISTRY }, intent)
      )),
    }))
  );

  const valid = await sign(addIntent());
  const r = BigInt(`0x${valid.slice(2, 66)}`);
  const s = BigInt(`0x${valid.slice(66, 130)}`);
  const parity = valid.slice(130);
  const flipped = parity === "00" ? "01" : "00";
  const offCurve = await offCurveR(s, parity);

  const recoverCases = [
    { name: "valid", signature: valid },
    {
      name: "other parity recovers another signer",
      signature: signature(r, s, flipped),
    },
    { name: "high s", signature: highS(valid) },
    { name: "parity 27", signature: signature(r, s, "1b") },
    { name: "parity 2", signature: signature(r, s, "02") },
    { name: "zero r", signature: signature(0n, s, parity) },
    { name: "zero s", signature: signature(r, 0n, parity) },
    { name: "r equals n", signature: signature(SECP256K1_N, s, parity) },
    { name: "r off curve", signature: signature(offCurve, s, parity) },
    { name: "uppercase hex", signature: upperHex(valid) },
    { name: "64 bytes", signature: valid.slice(0, 130) },
    { name: "missing 0x", signature: valid.slice(2) },
  ];

  const recover = await Promise.all(
    recoverCases.map(async ({ name, signature: sig }) => ({
      name,
      signature: sig,
      ...(await recoverWith(sig)),
    }))
  );

  return {
    addDevice,
    domain: ENCODED_DOMAIN,
    domainName: identityEip712DomainName,
    domainSeparator: domainSeparator({
      domain: {
        chainId: CHAIN_ID,
        name: identityEip712DomainName,
        verifyingContract: REGISTRY,
        version: identityEip712DomainVersion,
      },
    }),
    domainVersion: identityEip712DomainVersion,
    hashRejections,
    owner: OWNER,
    ownerPrivateKey: bytesToHex(OWNER_KEY),
    recover,
  };
};

// --- Approval record -------------------------------------------------------

const approvalRecord = async (intent = addIntent()) => ({
  digest: digestOf(intent),
  domain: ENCODED_DOMAIN,
  expectedOwner: OWNER,
  intent: encodedIntent(intent),
  operation: "add" as const,
  ownerSignature: await sign(intent),
  v: 1 as const,
});

/** Decode a persisted or received approval record from JSON text. */
const decodeApprovalJson = (json: string) =>
  Effect.try({
    catch: () => new Error("invalid json"),
    try: () => JSON.parse(json),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(DeviceActionApprovalV1)(
        value,
        strictParseOptions
      )
    )
  );

const approvalVectors = async () => {
  const record = await approvalRecord();
  const encoded = await Effect.runPromise(encodeDeviceActionApprovalV1(record));
  const json = JSON.stringify(encoded);

  const verifyCases = [
    { name: "matching digest", record },
    { name: "wrong digest", record: { ...record, digest: hexFill("ee") } },
    {
      name: "digest of another nonce",
      record: { ...record, intent: { ...record.intent, nonce: "8" } },
    },
  ];

  const verify = await Promise.all(
    verifyCases.map(async ({ name, record: candidate }) => ({
      name,
      record: candidate,
      ...(await settle(
        decodeApprovalJson(JSON.stringify(candidate)).pipe(
          Effect.flatMap(verifyApprovalDigest)
        )
      )),
    }))
  );

  const decodeCases = [
    { json, name: "add" },
    {
      json: JSON.stringify({ ...record, operation: "remove" }),
      name: "remove operation decodes",
    },
    { json: patch(json, '"v":1', '"v":1,"x":0'), name: "unknown field" },
    {
      json: patch(json, '"nonce":"7"', '"nonce":"7","x":0'),
      name: "unknown intent field",
    },
    {
      json: patch(json, '"operation":"add"', '"operation":"wipe"'),
      name: "unknown operation",
    },
    {
      json: patch(json, '"nonce":"7"', '"nonce":"07"'),
      name: "non-canonical nonce",
    },
    { json: patch(json, '"qid":"42"', '"qid":"0"'), name: "zero qid" },
    { json: patch(json, OWNER, upperHex(OWNER)), name: "uppercase owner" },
    { json: patch(json, DESKTOP_KEY, hexFill("00")), name: "zero device key" },
  ];

  const decode = await Promise.all(
    decodeCases.map(async ({ json: input, name }) => ({
      json: input,
      name,
      ...(await settle(decodeApprovalJson(input))),
    }))
  );

  return { decode, encode: [{ json, record }], verify };
};

// --- Pairing offer ---------------------------------------------------------

const baseOffer = {
  addrs: [RELAY_ADDR],
  chainId: "31337",
  deviceKey: DESKTOP_KEY,
  expiresAt: (NOW + 300n).toString(),
  qid: "42",
  registry: REGISTRY,
  secret: SECRET,
  sessionId: SESSION_ID,
  v: 1,
} satisfies PairingOfferV1Encoded;

type Offer = PairingOfferV1Encoded;

const encodeOffer = (offer: Offer) => settle(encodePairingOfferV1(offer));

const offerPayload = (bytes: Uint8Array) =>
  `qop-pair1.${Buffer.from(bytes).toString("base64url")}`;

/** Two addresses, the second `length` chars of padding long. */
const paddedOffer = (length: number): Offer => ({
  ...baseOffer,
  addrs: [`/${"a".repeat(255)}`, `/dns4/${"r".repeat(length)}.example`],
});

/** Longest padding whose payload still fits PAIRING_QR_MAX_CHARS. */
const largestPadding = async (length = 1): Promise<number> => {
  const next = await encodeOffer(paddedOffer(length + 1));

  return next.ok ? largestPadding(length + 1) : length;
};

const offerVectors = async () => {
  const pad = await largestPadding();

  const encodeCases = [
    { name: "one relay address", offer: baseOffer },
    {
      name: "relay and lan",
      offer: { ...baseOffer, addrs: [RELAY_ADDR, LAN_ADDR] },
    },
    { name: "largest payload", offer: paddedOffer(pad) },
    { name: "one byte over the payload limit", offer: paddedOffer(pad + 1) },
    {
      name: "three addresses",
      offer: { ...baseOffer, addrs: [LAN_ADDR, LAN_ADDR, LAN_ADDR] },
    },
    { name: "no addresses", offer: { ...baseOffer, addrs: [] } },
    {
      name: "address of 257 chars",
      offer: { ...baseOffer, addrs: [`/${"a".repeat(256)}`] },
    },
    {
      name: "address without slash",
      offer: { ...baseOffer, addrs: ["ip4/1.2.3.4"] },
    },
    { name: "zero qid", offer: { ...baseOffer, qid: "0" } },
    { name: "zero chain id", offer: { ...baseOffer, chainId: "0" } },
  ];

  const encode = await Promise.all(
    encodeCases.map(async ({ name, offer }) => ({
      name,
      offer,
      ...(await encodeOffer(offer)),
    }))
  );

  const json = JSON.stringify(baseOffer);
  const valid = offerPayload(utf8(json));
  const now = NOW.toString();
  const largest = encode[2]?.ok === true ? encode[2].value : "";
  const addrs = `"addrs":["${RELAY_ADDR}"]`;
  const expiresAt = `"expiresAt":"${baseOffer.expiresAt}"`;

  const jsonCases = [
    { json, name: "valid" },
    { json: patch(json, '"v":1', '"v":1.0'), name: "v written as 1.0" },
    { json: patch(json, '"v":1', '"v":2'), name: "v 2" },
    { json: patch(json, '"v":1', '"v":"1"'), name: "v as string" },
    {
      json: patch(json, '"v":1', '"v":1,"label":"mac"'),
      name: "unknown field",
    },
    {
      json: patch(json, '"addrs"', '"v":2,"addrs"'),
      name: "duplicate key, last wins",
    },
    { json: patch(json, '"qid":"42",', ""), name: "missing qid" },
    {
      json: patch(json, '"chainId":"31337"', '"chainId":"031337"'),
      name: "leading zero chain id",
    },
    {
      json: patch(json, '"chainId":"31337"', '"chainId":31337'),
      name: "numeric chain id",
    },
    { json: patch(json, '"qid":"42"', '"qid":"0"'), name: "zero qid" },
    { json: patch(json, '"qid":"42"', '"qid":" 42"'), name: "space in qid" },
    {
      json: patch(json, '"qid":"42"', `"qid":"${2n ** 256n - 1n}"`),
      name: "max qid",
    },
    {
      json: patch(json, '"qid":"42"', `"qid":"${2n ** 256n}"`),
      name: "qid 2^256",
    },
    {
      json: patch(json, '"qid":"42"', `"qid":"1${"0".repeat(78)}"`),
      name: "qid of 79 digits",
    },
    {
      json: patch(json, expiresAt, `"expiresAt":"${2n ** 64n - 1n}"`),
      name: "max expiry",
    },
    {
      json: patch(json, expiresAt, `"expiresAt":"${2n ** 64n}"`),
      name: "expiry 2^64",
    },
    {
      json: patch(json, DESKTOP_KEY, upperHex(DESKTOP_KEY)),
      name: "uppercase device key",
    },
    { json: patch(json, DESKTOP_KEY, hexFill("00")), name: "zero device key" },
    {
      json: patch(json, REGISTRY, upperHex(REGISTRY)),
      name: "uppercase registry",
    },
    { json: patch(json, SECRET, SECRET.slice(0, -2)), name: "short secret" },
    { json: patch(json, addrs, '"addrs":[]'), name: "no addresses" },
    {
      json: patch(
        json,
        addrs,
        `"addrs":["${LAN_ADDR}","${LAN_ADDR}","${LAN_ADDR}"]`
      ),
      name: "three addresses",
    },
    {
      json: patch(json, addrs, `"addrs":["/${"a".repeat(255)}"]`),
      name: "address of 256 chars",
    },
    {
      json: patch(json, addrs, `"addrs":["/${"a".repeat(256)}"]`),
      name: "address of 257 chars",
    },
    // Multi-byte addresses near 256 UTF-16 units cannot fit the 1024-char
    // payload, so UTF-16 length counting is covered by the chat text cases.
    { json: patch(json, addrs, '"addrs":["/é😀"]'), name: "non-ascii address" },
    {
      json: patch(json, addrs, '"addrs":["ip4/1.2.3.4"]'),
      name: "address without slash",
    },
    {
      json: patch(json, addrs, '"addrs":"/ip4/1.2.3.4"'),
      name: "addrs not an array",
    },
    { json: `  ${json}\n`, name: "surrounding whitespace" },
    { json: `[${json}]`, name: "array" },
    { json: "null", name: "null" },
    { json: json.slice(0, -1), name: "truncated json" },
  ];

  const decodeInputs = [
    ...jsonCases.map(({ json: body, name }) => ({
      input: offerPayload(utf8(body)),
      name,
      now,
    })),
    { input: valid, name: "expires at now", now: baseOffer.expiresAt },
    {
      input: valid,
      name: "expires one second after now",
      now: (NOW + 299n).toString(),
    },
    { input: largest, name: "largest payload", now },
    { input: `${largest}A`, name: "1025 chars", now },
    { input: `x${"A".repeat(1024)}`, name: "1025 chars without prefix", now },
    {
      input: valid.replace("qop-pair1.", "qop-pair2."),
      name: "version 2 prefix",
      now,
    },
    {
      input: valid.replace("qop-pair1.", "QOP-PAIR1."),
      name: "uppercase prefix",
      now,
    },
    { input: valid.slice("qop-pair1.".length), name: "no prefix", now },
    { input: `${valid}=`, name: "base64 padding", now },
    { input: `${valid.slice(0, -1)}+`, name: "standard base64 alphabet", now },
    {
      input: `${offerPayload(utf8(`${json} `)).slice(0, -1)}B`,
      name: "non-zero trailing bits",
      now,
    },
    { input: `${valid}A`, name: "base64 length 4n+1", now },
    { input: "qop-pair1.", name: "empty body", now },
    { input: offerPayload(concat(BOM, utf8(json))), name: "utf-8 bom", now },
    {
      input: offerPayload(withInvalidUtf8(patch(json, '"qid"', '"q|id"'))),
      name: "malformed utf-8",
      now,
    },
  ];

  const decode = await Promise.all(
    decodeInputs.map(async ({ input, name, now: nowSeconds }) => ({
      input,
      name,
      now: nowSeconds,
      ...(await settle(decodePairingOfferV1(input, BigInt(nowSeconds)))),
    }))
  );

  return { decode, encode };
};

// --- Pairing frames --------------------------------------------------------

const pairingFrameVectors = async () => {
  const record = await approvalRecord();

  const frames: readonly PairingFrame[] = [
    {
      challenge: CHALLENGE,
      secret: SECRET,
      sessionId: SESSION_ID,
      type: "hello",
      v: 1,
    },
    {
      chainId: "31337",
      challenge: CHALLENGE,
      deviceKey: DESKTOP_KEY,
      qid: "42",
      registry: REGISTRY,
      sessionId: SESSION_ID,
      type: "helloAck",
      v: 1,
    },
    { record, sessionId: SESSION_ID, type: "approval", v: 1 },
    {
      digest: record.digest,
      sessionId: SESSION_ID,
      type: "approvalSaved",
      v: 1,
    },
    {
      digest: record.digest,
      sessionId: SESSION_ID,
      type: "approvalConflict",
      v: 1,
    },
  ];

  const encode = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      ...(await settle(encodePairingFrameV1(frame).pipe(Effect.map(fromUtf8)))),
    }))
  );

  const json = (index: number) => {
    const entry = encode[index];

    return entry?.ok === true ? entry.value : "";
  };

  const hello = json(0);
  const helloAck = json(1);
  const approval = json(2);
  const sig = record.ownerSignature;

  const decodeCases: readonly DecodeCase[] = [
    ...frames.map((frame, index) => ({
      bytes: utf8(json(index)),
      name: frame.type,
    })),
    {
      bytes: utf8(patch(hello, '"v":1', '"v":1,"x":0')),
      name: "hello unknown field",
    },
    { bytes: utf8(patch(hello, '"v":1', '"v":2')), name: "hello v 2" },
    {
      bytes: utf8(patch(hello, '"type":"hello"', '"type":"Hello"')),
      name: "unknown type",
    },
    { bytes: utf8(patch(hello, '"type":"hello",', "")), name: "missing type" },
    {
      bytes: utf8(patch(hello, SECRET, upperHex(SECRET))),
      name: "uppercase secret",
    },
    {
      bytes: utf8(patch(helloAck, '"qid":"42"', '"qid":"042"')),
      name: "helloAck leading zero qid",
    },
    {
      bytes: utf8(patch(helloAck, '"chainId":"31337"', '"chainId":"0"')),
      name: "helloAck zero chain id",
    },
    {
      bytes: utf8(patch(approval, '"operation":"add"', '"operation":"remove"')),
      name: "approval with remove record",
    },
    {
      bytes: utf8(patch(approval, '"nonce":"7"', '"nonce":"7","x":1')),
      name: "approval nested unknown field",
    },
    {
      bytes: utf8(patch(approval, sig, highS(sig))),
      name: "approval high-s signature",
    },
    {
      bytes: utf8(patch(approval, sig, `${sig.slice(0, 130)}1b`)),
      name: "approval parity 27 signature",
    },
    {
      bytes: utf8(patch(approval, sig, upperHex(sig))),
      name: "approval uppercase signature",
    },
    {
      bytes: utf8(patch(approval, record.digest, hexFill("ee"))),
      name: "approval with wrong digest still decodes",
    },
    {
      bytes: utf8(
        patch(approval, `"deadline":"${DEADLINE}"`, `"deadline":"${2n ** 64n}"`)
      ),
      name: "approval deadline 2^64",
    },
    { bytes: utf8(padTo(hello, 16 * 1024)), name: "exactly 16 KiB" },
    { bytes: utf8(padTo(hello, 16 * 1024 + 1)), name: "16 KiB plus one" },
    { bytes: concat(BOM, utf8(hello)), name: "utf-8 bom" },
    {
      bytes: withInvalidUtf8(patch(hello, '"type"', '"ty|pe"')),
      name: "malformed utf-8",
    },
    { bytes: new Uint8Array(), name: "empty" },
    { bytes: utf8(`[${hello}]`), name: "array" },
  ];

  const decode = await Promise.all(
    decodeCases.map(async ({ bytes, name }) => ({
      input: asInput(bytes),
      name,
      ...(await settle(decodePairingFrameV1(bytes))),
    }))
  );

  return { decode, encode };
};

// --- Registry --------------------------------------------------------------

type ReadParams = Parameters<RegistryReadClient["readContract"]>[0];

type FunctionName = ReadParams["functionName"];

type Responses = Partial<Record<FunctionName, Hex>>;

type Reader = ReturnType<typeof createRegistryReader>;

/** A reader whose RPC answers come from raw ABI fixtures, decoded by viem. */
const readerWith = (responses: Responses, calls: ReadParams[] = []) =>
  createRegistryReader({
    client: {
      getBlockNumber: () => Promise.resolve(99n),
      // oxlint-disable-next-line require-await -- viem's readContract is async
      readContract: async (params) => {
        calls.push(params);
        const data = responses[params.functionName];

        if (!data) {
          throw new Error(`no fixture for ${params.functionName}`);
        }

        return decodeFunctionResult({
          abi: registryAbi,
          data,
          functionName: params.functionName,
        });
      },
    },
  });

const accountFixture = (handle = "alice", ownerVersion = 3) =>
  encodeFunctionResult({
    abi: registryAbi,
    functionName: "account",
    result: {
      handle,
      nonce: NONCE,
      owner: privateKeyToAccount(bytesToHex(OWNER_KEY)).address,
      ownerVersion,
      registeredAt: 1_699_000_000n,
    },
  });

const devicesFixture = (keys: readonly Hex[]) =>
  encodeFunctionResult({
    abi: registryAbi,
    functionName: "listActiveDevices",
    result: keys,
  });

const uintFixture = (value: bigint): Hex => `0x${word(value)}`;

/** Replace one 32-byte ABI word (by index) of a fixture. */
const withWord = (data: Hex, index: number, value: string): Hex => {
  const body = data.slice(2);

  return `0x${body.slice(0, index * 64)}${value.padStart(64, "0")}${body.slice((index + 1) * 64)}`;
};

const GOOD_RESPONSES: Responses = {
  account: accountFixture(),
  deviceKeyRemoved: uintFixture(0n),
  listActiveDevices: devicesFixture([PHONE_KEY, DESKTOP_KEY]),
  qidByDeviceKey: uintFixture(QID),
  qidByHandleHash: uintFixture(QID),
};

const readCases = <A, E extends Failure>(
  field: FunctionName,
  cases: readonly { readonly data: Hex; readonly name: string }[],
  run: (reader: Reader) => Effect.Effect<A, E>
) =>
  Promise.all(
    cases.map(async ({ data, name }) => ({
      data,
      name,
      ...(await settle(run(readerWith({ ...GOOD_RESPONSES, [field]: data })))),
    }))
  );

/** Calldata for every read a linked device makes, captured from the reader. */
const registryCalldata = async () => {
  const calls: ReadParams[] = [];
  const reader = readerWith(GOOD_RESPONSES, calls);
  await Effect.runPromise(reader.lookupHandle("alice"));
  await Effect.runPromise(reader.lookupDeviceKey(DESKTOP_KEY));
  await Effect.runPromise(reader.deviceKeyRemoved(DESKTOP_KEY));
  const unique = new Map(calls.map((call) => [call.functionName, call]));

  return [...unique.values()].map(({ args, functionName }) => ({
    args: args.map(String),
    // SAFETY: args are the reader's own arguments for this functionName.
    data: encodeFunctionData({
      abi: registryAbi,
      args: args as never,
      functionName,
    }),
    functionName,
  }));
};

const registryVectors = async () => {
  const handles = [
    "alice",
    "a",
    "0_bob",
    "x".repeat(32),
    "x".repeat(33),
    "",
    "Alice",
    "_bob",
    "al-ice",
    "alicé",
    " alice",
  ];

  // Same validation and hashing as `lookupHandle` (registry-reader.ts).
  const handleHash = handles.map((handle) => ({
    handle,
    ...settleSync(() =>
      keccak256(toBytes(Schema.decodeUnknownSync(Handle)(handle)))
    ),
  }));

  const qid = await readCases(
    "qidByDeviceKey",
    [
      { data: uintFixture(QID), name: "qid 42" },
      { data: uintFixture(0n), name: "zero means none" },
      { data: uintFixture(2n ** 256n - 1n), name: "max uint256" },
      { data: `${uintFixture(QID)}ff`, name: "trailing bytes ignored" },
      { data: dropLastByte(uintFixture(QID)), name: "31 bytes" },
      { data: "0x", name: "empty" },
    ],
    (reader) =>
      reader
        .lookupDeviceKey(DESKTOP_KEY)
        .pipe(
          Effect.map((account) =>
            account === null ? "0" : account.qid.toString()
          )
        )
  );

  const bool = await readCases(
    "deviceKeyRemoved",
    [
      { data: uintFixture(0n), name: "false" },
      { data: uintFixture(1n), name: "true" },
      { data: uintFixture(2n), name: "two" },
      { data: `0x01${"0".repeat(62)}`, name: "high byte set" },
      { data: `${uintFixture(1n)}00`, name: "trailing bytes ignored" },
      { data: "0x", name: "empty" },
    ],
    (reader) => reader.deviceKeyRemoved(DESKTOP_KEY)
  );

  const twoDevices = devicesFixture([PHONE_KEY, DESKTOP_KEY]);

  const devices = await readCases(
    "listActiveDevices",
    [
      { data: twoDevices, name: "two devices" },
      { data: devicesFixture([]), name: "no devices" },
      { data: devicesFixture([hexFill("00")]), name: "zero device key" },
      { data: withWord(twoDevices, 1, "3"), name: "length past the data" },
      { data: withWord(twoDevices, 0, "40"), name: "offset to a later word" },
      { data: withWord(twoDevices, 0, "1000"), name: "offset past the data" },
      {
        data: withWord(twoDevices, 0, "f".repeat(64)),
        name: "offset above 2^53",
      },
      { data: `${twoDevices}00`, name: "trailing bytes ignored" },
      { data: dropLastByte(twoDevices), name: "truncated" },
    ],
    (reader) => reader.listActiveDevices(QID)
  );

  // Layout: [0] tuple offset, [1] owner, [2] ownerVersion, [3] registeredAt,
  // [4] nonce, [5] handle offset, [6] handle length, [7] handle bytes.
  const account = accountFixture();

  const badUtf8Handle = `${bytesToHex(utf8("ali")).slice(2)}ff00`.padEnd(
    64,
    "0"
  );

  const accounts = await readCases(
    "account",
    [
      { data: account, name: "alice" },
      { data: accountFixture("x".repeat(32)), name: "32-char handle" },
      { data: accountFixture("Alice"), name: "uppercase handle" },
      { data: accountFixture(""), name: "empty handle" },
      { data: accountFixture("x".repeat(33)), name: "33-char handle" },
      { data: accountFixture("alice", 2 ** 32 - 1), name: "max owner version" },
      { data: withWord(account, 2, "100000000"), name: "owner version 2^32" },
      {
        data: withWord(account, 3, "ffffffffffffffff"),
        name: "max registeredAt",
      },
      {
        data: withWord(account, 3, "10000000000000000"),
        name: "registeredAt 2^64",
      },
      {
        data: withWord(account, 1, `ff${OWNER.slice(2).padStart(62, "0")}`),
        name: "dirty address high bytes ignored",
      },
      {
        data: withWord(account, 5, "1000"),
        name: "handle offset past the data",
      },
      { data: withWord(account, 6, "40"), name: "handle length past the data" },
      {
        data: withWord(withWord(account, 6, "5"), 7, badUtf8Handle),
        name: "malformed utf-8 handle",
      },
      { data: `${account}00`, name: "trailing bytes ignored" },
      { data: `0x${account.slice(2, 2 + 64 * 5)}`, name: "truncated" },
    ],
    (reader) =>
      reader.lookupQid(QID).pipe(
        Effect.map((found) =>
          found === null
            ? null
            : {
                handle: found.handle,
                nonce: found.nonce.toString(),
                owner: found.owner,
                ownerVersion: found.ownerVersion,
                registeredAt: found.registeredAt.toString(),
              }
        )
      )
  );

  return {
    account: accounts,
    bool,
    calldata: await registryCalldata(),
    devices,
    handleHash,
    qid,
  };
};

// --- Device-action API status ----------------------------------------------

interface StatusBody {
  readonly digest?: string;
  readonly extra?: { readonly nested: boolean };
  readonly failureCode?: number | string | null;
  readonly operation?: string;
  readonly status?: string;
  readonly transactionHash?: string | null;
  readonly x?: string;
}

const statusVectors = async () => {
  const digest = hexFill("ab");
  const tx = hexFill("cd");

  const body = (fields: StatusBody) =>
    JSON.stringify({
      digest,
      failureCode: null,
      status: "ready",
      transactionHash: null,
      ...fields,
    });

  const cases = [
    ...["ready", "submitted", "confirmed", "reverted", "expired"].map(
      (status) => ({
        body: utf8(
          body({ status, transactionHash: status === "ready" ? null : tx })
        ),
        name: status,
        status: 200,
      })
    ),
    {
      body: utf8(
        body({ failureCode: "nonce", status: "reverted", transactionHash: tx })
      ),
      name: "failure code",
      status: 200,
    },
    {
      body: utf8(body({ extra: { nested: true }, operation: "add" })),
      name: "extra fields accepted",
      status: 200,
    },
    {
      body: utf8(body({ status: "pending" })),
      name: "unknown status",
      status: 200,
    },
    {
      body: utf8(body({ digest: upperHex(digest) })),
      name: "uppercase digest",
      status: 200,
    },
    {
      body: utf8(body({ transactionHash: "0x12" })),
      name: "short transaction hash",
      status: 200,
    },
    {
      body: utf8(
        JSON.stringify({ digest, status: "ready", transactionHash: null })
      ),
      name: "missing failureCode",
      status: 200,
    },
    {
      body: utf8(body({ failureCode: 3 })),
      name: "numeric failureCode",
      status: 200,
    },
    { body: utf8("not json"), name: "invalid json", status: 200 },
    { body: concat(BOM, utf8(body({}))), name: "utf-8 bom", status: 200 },
    {
      body: withInvalidUtf8(body({ failureCode: "a|b" })),
      name: "malformed utf-8 in failureCode",
      status: 200,
    },
    {
      body: withInvalidUtf8(body({ x: "|" })),
      name: "malformed utf-8 in extra field",
      status: 200,
    },
    {
      body: withInvalidUtf8(body({ status: "|" })),
      name: "malformed utf-8 in status",
      status: 200,
    },
    { body: utf8(body({})), name: "201 created", status: 201 },
    { body: utf8("{}"), name: "404", status: 404 },
    { body: utf8("not json"), name: "404 with junk", status: 404 },
    {
      body: utf8(JSON.stringify({ error: "boom" })),
      name: "500 json",
      status: 500,
    },
    { body: utf8("Bad gateway"), name: "502 text", status: 502 },
  ];

  const original = globalThis.fetch;

  try {
    const vectors = [];

    for (const { body: bytes, name, status } of cases) {
      globalThis.fetch = () => Promise.resolve(new Response(bytes, { status }));

      // oxlint-disable-next-line no-await-in-loop -- fetch is swapped per case
      const outcome = await settle(
        getDeviceActionStatus("http://api.test", digest)
      );

      vectors.push({ body: asInput(bytes), name, status, ...outcome });
    }

    return vectors;
  } finally {
    globalThis.fetch = original;
  }
};

// --- Chat ------------------------------------------------------------------

const FRAME: ChatFrame = {
  fromHandle: "alice",
  id: ID_A,
  sentAt: 1_700_000_000_123,
  text: "hi bob",
  v: 1,
};

const chatVectors = () => {
  const frameCases = [
    { frame: FRAME, name: "plain" },
    {
      frame: {
        ...FRAME,
        text: 'quote " backslash \\ tab \t newline \n nul \u0000 del \u007F ls \u2028 emoji 😀 é',
      },
      name: "escapes",
    },
    { frame: { ...FRAME, id: ID_A.toUpperCase() }, name: "uppercase id" },
    { frame: { ...FRAME, sentAt: 0 }, name: "epoch" },
    { frame: { ...FRAME, text: "a".repeat(4000) }, name: "4000 chars" },
    { frame: { ...FRAME, text: "a".repeat(4001) }, name: "4001 chars" },
    { frame: { ...FRAME, text: "😀".repeat(2000) }, name: "2000 emoji" },
    {
      frame: { ...FRAME, text: "\u0001".repeat(4000) },
      name: "control chars over 16 KB",
    },
    { frame: { ...FRAME, text: "" }, name: "empty text" },
    { frame: { ...FRAME, fromHandle: "Alice" }, name: "uppercase handle" },
  ];

  const encodeFrames = frameCases.map(({ frame, name }) => ({
    frame,
    name,
    ...settleSync(() => fromUtf8(encodeFrame(frame))),
  }));

  const json = JSON.stringify(FRAME);
  const sentAt = `"sentAt":${FRAME.sentAt}`;
  const text = '"text":"hi bob"';

  const frameDecodeCases: readonly DecodeCase[] = [
    { bytes: utf8(json), name: "plain" },
    {
      bytes: utf8(patch(json, '"v":1', '"v":1,"x":{"y":[1]}')),
      name: "extra fields dropped",
    },
    { bytes: utf8(patch(json, '"v":1', '"v":1.0')), name: "v 1.0" },
    { bytes: utf8(patch(json, '"v":1', '"v":2')), name: "v 2" },
    { bytes: utf8(patch(json, '"v":1', '"v":"1"')), name: "v as string" },
    { bytes: utf8(patch(json, sentAt, '"sentAt":1e3')), name: "sentAt 1e3" },
    { bytes: utf8(patch(json, sentAt, '"sentAt":5.0')), name: "sentAt 5.0" },
    { bytes: utf8(patch(json, sentAt, '"sentAt":1.5')), name: "sentAt 1.5" },
    { bytes: utf8(patch(json, sentAt, '"sentAt":-1')), name: "sentAt -1" },
    { bytes: utf8(patch(json, sentAt, '"sentAt":-0')), name: "sentAt -0" },
    {
      bytes: utf8(patch(json, sentAt, '"sentAt":8640000000000000')),
      name: "max sentAt",
    },
    {
      bytes: utf8(patch(json, sentAt, '"sentAt":8640000000000001')),
      name: "sentAt above max",
    },
    {
      bytes: utf8(patch(json, sentAt, '"sentAt":"1"')),
      name: "sentAt as string",
    },
    { bytes: utf8(patch(json, sentAt, '"sentAt":null')), name: "sentAt null" },
    {
      bytes: utf8(patch(json, ID_A, "0b6f5c4e-8f1d-9a2b-9c3d-1e2f3a4b5c6d")),
      name: "uuid version 9",
    },
    {
      bytes: utf8(patch(json, ID_A, "0b6f5c4e-8f1d-4a2b-cc3d-1e2f3a4b5c6d")),
      name: "uuid variant c",
    },
    {
      bytes: utf8(patch(json, ID_A, ID_A.toUpperCase())),
      name: "uppercase uuid",
    },
    { bytes: utf8(patch(json, ID_A, `${ID_A}0`)), name: "uuid too long" },
    {
      bytes: utf8(
        patch(json, '"fromHandle":"alice"', `"fromHandle":"${"a".repeat(33)}"`)
      ),
      name: "33-char handle",
    },
    { bytes: utf8(patch(json, text, '"text":""')), name: "empty text" },
    {
      bytes: utf8(patch(json, text, `"text":"${"😀".repeat(2001)}"`)),
      name: "4002 UTF-16 units",
    },
    {
      bytes: utf8(patch(json, text, `"text":"${"€".repeat(4000)}"`)),
      name: "4000 three-byte chars",
    },
    {
      bytes: utf8(patch(json, text, '"text":"\\u00e9\\n"')),
      name: "escaped text",
    },
    { bytes: utf8(patch(json, `${text},`, "")), name: "missing text" },
    {
      bytes: utf8(patch(json, '"v":1', '"v":1,"text":"last"')),
      name: "duplicate key, last wins",
    },
    { bytes: utf8(padTo(json, 16 * 1024)), name: "exactly 16 KiB" },
    { bytes: utf8(padTo(json, 16 * 1024 + 1)), name: "16 KiB plus one" },
    { bytes: concat(BOM, utf8(json)), name: "utf-8 bom" },
    {
      bytes: withInvalidUtf8(patch(json, "hi bob", "hi |bob")),
      name: "malformed utf-8",
    },
    { bytes: utf8(`[${json}]`), name: "array" },
    { bytes: new Uint8Array(), name: "empty" },
  ];

  const decodeFrames = frameDecodeCases.map(({ bytes, name }) => ({
    input: asInput(bytes),
    name,
    ...settleSync(() => decodeFrame(bytes)),
  }));

  const ack = { ack: ID_A, v: 1 as const };
  const ackJson = JSON.stringify(ack);

  const encodeAcks = [
    { ack, name: "plain" },
    { ack: { ...ack, ack: "nope" }, name: "invalid id" },
  ].map(({ ack: input, name }) => ({
    ack: input,
    name,
    ...settleSync(() => fromUtf8(encodeAck(input))),
  }));

  const ackDecodeCases: readonly DecodeCase[] = [
    { bytes: utf8(ackJson), name: "plain" },
    {
      bytes: utf8(patch(ackJson, '"v":1', '"v":1,"x":0')),
      name: "extra field dropped",
    },
    { bytes: utf8(patch(ackJson, '"v":1', '"v":2')), name: "v 2" },
    { bytes: utf8(patch(ackJson, ID_A, "not-a-uuid")), name: "invalid id" },
    { bytes: utf8('{"v":1}'), name: "missing ack" },
    { bytes: utf8(padTo(ackJson, 16 * 1024 + 1)), name: "16 KiB plus one" },
    { bytes: concat(INVALID_UTF8, utf8(ackJson)), name: "malformed utf-8" },
  ];

  const decodeAcks = ackDecodeCases.map(({ bytes, name }) => ({
    input: asInput(bytes),
    name,
    ...settleSync(() => decodeAck(bytes)),
  }));

  return {
    acks: { decode: decodeAcks, encode: encodeAcks },
    frames: { decode: decodeFrames, encode: encodeFrames },
  };
};

// --- Sync ------------------------------------------------------------------

const OUTBOX_RECORD = {
  attempts: 0,
  frame: FRAME,
  lastError: null,
  nextAttemptAt: 1_700_000_000_123,
  queuedAt: 1_700_000_000_123,
  status: "queued" as const,
  toHandle: "bob",
  toQid: "43",
  updatedAt: 1_700_000_000_123,
  v: 1 as const,
};

const INBOX_RECORD = {
  frame: { ...FRAME, fromHandle: "bob", id: ID_B },
  fromQid: "43",
  receivedAt: 1_700_000_001_000,
  v: 1 as const,
};

const receipt = (id: string) => ({
  deliveredAt: 1_700_000_002_000,
  id,
  toQid: "43",
});

const syncDecode = <A, E extends Failure>(
  cases: readonly DecodeCase[],
  decode: (bytes: Uint8Array) => Effect.Effect<A, E>
) =>
  Promise.all(
    cases.map(async ({ bytes, name }) => ({
      input: asInput(bytes),
      name,
      ...(await settle(decode(bytes))),
    }))
  );

const syncRequestVectors = async () => {
  const requests: readonly {
    readonly name: string;
    readonly request: SyncRequest;
  }[] = [
    {
      name: "handoff",
      request: {
        composedBy: PHONE_KEY,
        record: OUTBOX_RECORD,
        type: "handoff",
        v: 1,
      },
    },
    {
      name: "handoff with error note",
      request: {
        composedBy: PHONE_KEY,
        record: { ...OUTBOX_RECORD, attempts: 3, lastError: "offline" },
        type: "handoff",
        v: 1,
      },
    },
    {
      name: "handoff of sent record",
      request: {
        composedBy: PHONE_KEY,
        record: { ...OUTBOX_RECORD, status: "sent" },
        type: "handoff",
        v: 1,
      },
    },
    { name: "poll one", request: { ids: uuids(1), type: "poll", v: 1 } },
    { name: "poll 32", request: { ids: uuids(32), type: "poll", v: 1 } },
    { name: "poll 33", request: { ids: uuids(33), type: "poll", v: 1 } },
    { name: "poll none", request: { ids: [], type: "poll", v: 1 } },
    { name: "catchup 0", request: { after: 0, type: "catchup", v: 1 } },
    {
      name: "catchup max safe",
      request: { after: Number.MAX_SAFE_INTEGER, type: "catchup", v: 1 },
    },
  ];

  const encode = await Promise.all(
    requests.map(async ({ name, request }) => ({
      name,
      request,
      ...(await settle(
        encodeSyncRequestV1(request).pipe(Effect.map(fromUtf8))
      )),
    }))
  );

  const handoff = JSON.stringify(requests[0]?.request);
  const poll = JSON.stringify(requests[3]?.request);
  const catchup = JSON.stringify(requests[7]?.request);
  const after = '"after":0';

  const decode = await syncDecode(
    [
      { bytes: utf8(handoff), name: "handoff" },
      { bytes: utf8(poll), name: "poll" },
      { bytes: utf8(catchup), name: "catchup" },
      {
        bytes: utf8(
          patch(handoff, '"type":"handoff"', '"type":"handoff","x":0')
        ),
        name: "handoff unknown field",
      },
      {
        bytes: utf8(patch(handoff, '"text":"hi bob"', '"text":"hi bob","x":0')),
        name: "nested chat frame unknown field",
      },
      {
        bytes: utf8(patch(handoff, '"toQid":"43"', '"toQid":"43","x":0')),
        name: "nested record unknown field",
      },
      {
        bytes: utf8(patch(handoff, '"status":"queued"', '"status":"sent"')),
        name: "handoff of sent record",
      },
      {
        bytes: utf8(patch(handoff, '"status":"queued"', '"status":"held"')),
        name: "unknown status",
      },
      {
        bytes: utf8(patch(handoff, '"toQid":"43"', '"toQid":"043"')),
        name: "leading zero qid",
      },
      {
        bytes: utf8(patch(handoff, '"toQid":"43"', '"toQid":"0"')),
        name: "zero qid",
      },
      {
        bytes: utf8(patch(handoff, '"lastError":null', '"lastError":""')),
        name: "empty error note",
      },
      {
        bytes: utf8(
          patch(handoff, '"lastError":null', `"lastError":"${"e".repeat(400)}"`)
        ),
        name: "400-char error note",
      },
      {
        bytes: utf8(
          patch(handoff, '"lastError":null', `"lastError":"${"e".repeat(401)}"`)
        ),
        name: "401-char error note",
      },
      {
        bytes: utf8(patch(handoff, '"lastError":null,', "")),
        name: "missing error note",
      },
      {
        bytes: utf8(patch(handoff, '"attempts":0', '"attempts":1000000')),
        name: "max attempts",
      },
      {
        bytes: utf8(patch(handoff, '"attempts":0', '"attempts":1000001')),
        name: "attempts above max",
      },
      {
        bytes: utf8(patch(handoff, PHONE_KEY, hexFill("00"))),
        name: "zero composedBy",
      },
      {
        bytes: utf8(patch(poll, '"type":"poll"', '"type":"poll","x":0')),
        name: "poll unknown field",
      },
      {
        bytes: utf8(JSON.stringify({ ids: uuids(33), type: "poll", v: 1 })),
        name: "poll 33",
      },
      {
        bytes: utf8(JSON.stringify({ ids: ["nope"], type: "poll", v: 1 })),
        name: "poll invalid id",
      },
      { bytes: utf8(patch(catchup, after, '"after":-1')), name: "catchup -1" },
      {
        bytes: utf8(patch(catchup, after, '"after":9007199254740991')),
        name: "catchup max safe",
      },
      {
        bytes: utf8(patch(catchup, after, '"after":9007199254740992')),
        name: "catchup 2^53",
      },
      {
        bytes: utf8(patch(catchup, after, '"after":1.0')),
        name: "catchup 1.0",
      },
      {
        bytes: utf8(patch(catchup, after, '"after":1e400')),
        name: "catchup 1e400",
      },
      {
        bytes: utf8(patch(catchup, '"type":"catchup"', '"type":"held"')),
        name: "response type",
      },
      { bytes: utf8(padTo(catchup, 64 * 1024)), name: "exactly 64 KiB" },
      { bytes: utf8(padTo(catchup, 64 * 1024 + 1)), name: "64 KiB plus one" },
      { bytes: concat(BOM, utf8(catchup)), name: "utf-8 bom" },
      { bytes: concat(INVALID_UTF8, utf8(catchup)), name: "malformed utf-8" },
    ],
    decodeSyncRequestV1
  );

  return { decode, encode };
};

const syncResponseVectors = async () => {
  const bigFrame = { ...INBOX_RECORD.frame, text: "x".repeat(4000) };

  const responses: readonly {
    readonly name: string;
    readonly response: SyncResponse;
  }[] = [
    { name: "held", response: { id: ID_A, type: "held", v: 1 } },
    { name: "no receipts", response: { receipts: [], type: "receipts", v: 1 } },
    {
      name: "one receipt",
      response: { receipts: [receipt(ID_A)], type: "receipts", v: 1 },
    },
    {
      name: "32 receipts",
      response: { receipts: uuids(32).map(receipt), type: "receipts", v: 1 },
    },
    {
      name: "33 receipts",
      response: { receipts: uuids(33).map(receipt), type: "receipts", v: 1 },
    },
    {
      name: "empty inbox",
      response: { lastSeq: 0, records: [], type: "inbox", v: 1 },
    },
    {
      name: "inbox",
      response: {
        lastSeq: 9,
        records: [{ record: INBOX_RECORD, seq: 9 }],
        type: "inbox",
        v: 1,
      },
    },
    {
      name: "inbox over 64 KiB",
      response: {
        lastSeq: 20,
        records: Array.from({ length: 20 }, (_, index) => ({
          record: { ...INBOX_RECORD, frame: bigFrame },
          seq: index + 1,
        })),
        type: "inbox",
        v: 1,
      },
    },
    {
      name: "error conflict",
      response: { reason: "conflict", type: "error", v: 1 },
    },
    {
      name: "error invalid",
      response: { reason: "invalid", type: "error", v: 1 },
    },
    {
      name: "error unavailable",
      response: { reason: "unavailable", type: "error", v: 1 },
    },
  ];

  const encode = await Promise.all(
    responses.map(async ({ name, response }) => ({
      name,
      response,
      ...(await settle(
        encodeSyncResponseV1(response).pipe(Effect.map(fromUtf8))
      )),
    }))
  );

  const held = JSON.stringify(responses[0]?.response);
  const receipts = JSON.stringify(responses[2]?.response);
  const inbox = JSON.stringify(responses[6]?.response);

  const decode = await syncDecode(
    [
      { bytes: utf8(held), name: "held" },
      { bytes: utf8(receipts), name: "receipts" },
      { bytes: utf8(inbox), name: "inbox" },
      {
        bytes: utf8('{"reason":"conflict","type":"error","v":1}'),
        name: "error",
      },
      {
        bytes: utf8('{"reason":"busy","type":"error","v":1}'),
        name: "unknown error reason",
      },
      {
        bytes: utf8(patch(held, '"type":"held"', '"type":"held","x":0')),
        name: "held unknown field",
      },
      {
        bytes: utf8(patch(receipts, '"toQid":"43"', '"toQid":"43","x":0')),
        name: "receipt unknown field",
      },
      {
        bytes: utf8(patch(receipts, '"toQid":"43"', '"toQid":"0"')),
        name: "receipt zero qid",
      },
      {
        bytes: utf8(
          patch(receipts, '"deliveredAt":1700000002000', '"deliveredAt":-1')
        ),
        name: "receipt negative time",
      },
      {
        bytes: utf8(
          JSON.stringify({
            receipts: uuids(33).map(receipt),
            type: "receipts",
            v: 1,
          })
        ),
        name: "33 receipts",
      },
      { bytes: utf8(patch(inbox, '"seq":9', '"seq":0')), name: "inbox seq 0" },
      {
        bytes: utf8(patch(inbox, '"lastSeq":9', '"lastSeq":-1')),
        name: "inbox negative lastSeq",
      },
      {
        bytes: utf8(patch(inbox, '"fromQid":"43"', '"fromQid":"43","x":0')),
        name: "inbox record unknown field",
      },
      {
        bytes: utf8(patch(inbox, '"text":"hi bob"', '"text":"hi bob","x":0')),
        name: "inbox frame unknown field",
      },
      {
        bytes: utf8(patch(inbox, '"seq":9', '"seq":9,"x":0')),
        name: "inbox item unknown field",
      },
      { bytes: utf8(patch(held, ID_A, "nope")), name: "held invalid id" },
      { bytes: utf8(padTo(held, 64 * 1024 + 1)), name: "64 KiB plus one" },
    ],
    decodeSyncResponseV1
  );

  return { decode, encode };
};

// --- Output ----------------------------------------------------------------

export const VECTORS_DIR = new URL(
  "../../desktop/tests/vectors/",
  import.meta.url
);

/** Vector file name → JSON text, generated from the current TS codecs. */
export const buildDesktopVectors = async () => {
  const files = {
    "approval.json": await approvalVectors(),
    "chat.json": chatVectors(),
    "device-action-status.json": await statusVectors(),
    "eip712.json": await eip712Vectors(),
    "identity.json": await identityVectors(),
    "pairing-frame.json": await pairingFrameVectors(),
    "pairing-offer.json": await offerVectors(),
    "registry.json": await registryVectors(),
    "sync.json": {
      requests: await syncRequestVectors(),
      responses: await syncResponseVectors(),
    },
  };

  return Object.entries(files).map(
    ([name, contents]) =>
      [name, `${JSON.stringify(contents, null, 2)}\n`] as const
  );
};

if (import.meta.main) {
  mkdirSync(VECTORS_DIR, { recursive: true });

  for (const [name, contents] of await buildDesktopVectors()) {
    writeFileSync(new URL(name, VECTORS_DIR), contents);
  }
}
