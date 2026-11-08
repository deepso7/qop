#!/usr/bin/env node
/**
 * Plays the approving phone in desktop linking e2e runs, against a local chain and API
 * (`docs/testing/desktop-linking-e2e.md`). Never point it at a real deployment: it registers
 * throwaway accounts with the registration signer's key.
 *
 *   node scripts/desktop-phone.ts register <handle>     register an account whose one device is "the phone"
 *   node scripts/desktop-phone.ts approve <qop-pair1.…> [--no-submit]
 *                                                       hello + owner-signed approval, then submit it
 *   node scripts/desktop-phone.ts submit                submit the saved approval and wait for the API
 *
 * The phone's state (owner key, device secret, pending approval) lives in `QOP_E2E_PHONE`
 * (default `/tmp/qop-e2e/phone.json`). Pairing reuses the app's own handshake
 * (`mobile/src/lib/pairing-client-core.ts`) and API client; like the app, `approve` resends a
 * pending approval for the same desktop key instead of signing a new one.
 *
 * Environment: the CLI's `QOP_RPC_URL`, `QOP_REGISTRY_ADDRESS`, `QOP_REGISTRY_CHAIN_ID`,
 * `QOP_API_URL`, optional `QOP_RELAY_ADDRS`, plus `QOP_E2E_REGISTRATION_KEY` (the registry's
 * registration signer) and `QOP_E2E_FUNDER_KEY` (pays for the registration transaction).
 */
import { readFileSync, writeFileSync } from "node:fs";

import { NodeRuntime } from "@effect/platform-node";
import { generateSecretKey, Minip2p } from "@minip2p/node";
import {
  decodeAddDeviceIntentV1,
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  deviceKeyFromEd25519SecretKey,
  EcdsaSignature,
  encodeRegisterIntentV1,
  hashAddDeviceIntentV1,
  Hex32,
  signAddDeviceIntentV1,
  signRegisterIntentV1,
} from "@qop/identity";
import {
  asHex,
  DEVICE_ACTION_DEADLINE_SECONDS,
  PAIR_PROTOCOL,
} from "@qop/protocol";
import type { DeviceActionApprovalV1Encoded } from "@qop/protocol";
import { Data, Effect, Schema } from "effect";
import {
  bytesToHex,
  createWalletClient,
  hexToBytes,
  http,
  isHex,
  parseAbi,
  publicActions,
} from "viem";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createDeviceActionClient } from "../../mobile/src/lib/device-action-client-core.ts";
import {
  decodePairingPayload,
  handshakePairing,
  sendPairingApproval,
} from "../../mobile/src/lib/pairing-client-core.ts";
import { cliRelays, configuredRegistry } from "../src/config.ts";

class PhoneError extends Data.TaggedError("PhoneError")<{
  readonly reason: string;
}> {}

const fail = (reason: string) => new PhoneError({ reason });

interface PhoneState {
  readonly handle: string;
  readonly ownerKey: Hex;
  readonly pending?: DeviceActionApprovalV1Encoded;
  readonly phoneSecret: Hex;
  readonly qid: string;
}

const statePath = process.env.QOP_E2E_PHONE ?? "/tmp/qop-e2e/phone.json";

const loadState = () =>
  Effect.try({
    catch: () => fail(`no phone state at ${statePath}; run register first`),
    // SAFETY: Only this script writes the file, with this shape.
    try: () => JSON.parse(readFileSync(statePath, "utf-8")) as PhoneState,
  });

const saveState = (state: PhoneState) =>
  Effect.sync(() => {
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  });

/** `value` as viem's `Hex`, or a failure naming `what` it should have been. */
const hex = (value: string | undefined, what: string) =>
  value !== undefined && isHex(value)
    ? Effect.succeed(value)
    : Effect.fail(fail(`${what} must be 0x-prefixed hex`));

const registerAbi = parseAbi([
  "function register((string handle,address owner,bytes32 deviceKey,bytes32 nonce,uint64 deadline) intent, bytes ownerSignature, bytes registrationSignature) returns (uint256 qid)",
]);

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

const encodeSignature = Schema.encodeEffect(EcdsaSignature);

/** Registers `handle` with a fresh owner key and this phone as its only device. */
const register = Effect.fn("phone.register")(function* (handle: string) {
  const { chainId, reader, registryAddress, rpcUrl } =
    yield* configuredRegistry();

  const registrationKey = yield* hex(
    process.env.QOP_E2E_REGISTRATION_KEY,
    "QOP_E2E_REGISTRATION_KEY"
  );

  const funderKey = yield* hex(
    process.env.QOP_E2E_FUNDER_KEY,
    "QOP_E2E_FUNDER_KEY"
  );

  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey).address.toLowerCase();
  const phoneSecret = generateSecretKey();

  const deviceKey = yield* deviceKeyFromEd25519SecretKey(phoneSecret).pipe(
    Effect.flatMap(Schema.encodeEffect(Hex32))
  );

  const domain = yield* decodeIdentityEip712DomainV1({
    chainId,
    verifyingContract: registryAddress,
  });

  const chainTime = yield* reader.latestTimestamp();

  const intent = yield* decodeRegisterIntentV1({
    deadline: (chainTime + 300n).toString(),
    deviceKey,
    handle,
    nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    owner,
  });

  const encoded = yield* encodeRegisterIntentV1(intent);

  const ownerSignature = yield* signRegisterIntentV1(
    domain,
    intent,
    hexToBytes(ownerKey)
  ).pipe(Effect.flatMap(encodeSignature));

  const registrationSignature = yield* signRegisterIntentV1(
    domain,
    intent,
    hexToBytes(registrationKey)
  ).pipe(Effect.flatMap(encodeSignature));

  const args = [
    {
      deadline: BigInt(encoded.deadline),
      deviceKey: yield* hex(encoded.deviceKey, "device key"),
      handle,
      nonce: yield* hex(encoded.nonce, "registration nonce"),
      owner: yield* hex(owner, "owner"),
    },
    yield* hex(ownerSignature, "owner signature"),
    yield* hex(registrationSignature, "registration signature"),
  ] as const;

  const address = yield* hex(registryAddress, "registry address");

  const wallet = createWalletClient({
    account: privateKeyToAccount(funderKey),
    transport: http(rpcUrl),
  }).extend(publicActions);

  yield* Effect.tryPromise({
    catch: (cause) => fail(`register transaction failed: ${String(cause)}`),
    try: async () => {
      const hash = await wallet.writeContract({
        abi: registerAbi,
        address,
        args,
        chain: null,
        functionName: "register",
      });

      await wallet.waitForTransactionReceipt({ hash });
    },
  });

  const account = yield* reader.lookupHandle(handle);

  if (!account) {
    return yield* fail(`@${handle} is not on chain after registering`);
  }

  yield* saveState({
    handle,
    ownerKey,
    phoneSecret: bytesToHex(phoneSecret),
    qid: account.qid.toString(),
  });
  console.log(`registered @${handle} qid=${account.qid} phone=${deviceKey}`);
});

/** Signs an add-device approval for `deviceKey`, as the app's owner key would. */
const signApproval = Effect.fn("phone.signApproval")(function* (
  state: PhoneState,
  deviceKey: string
) {
  const { chainId, reader, registryAddress } = yield* configuredRegistry();
  const account = yield* reader.lookupQid(BigInt(state.qid));

  if (!account) {
    return yield* fail(`qid ${state.qid} is not on chain`);
  }

  const chainTime = yield* reader.latestTimestamp();
  const domainInput = { chainId, verifyingContract: registryAddress };

  const intentInput = {
    deadline: (chainTime + BigInt(DEVICE_ACTION_DEADLINE_SECONDS)).toString(),
    deviceKey,
    nonce: account.nonce.toString(),
    qid: state.qid,
  };

  const domain = yield* decodeIdentityEip712DomainV1(domainInput);
  const intent = yield* decodeAddDeviceIntentV1(intentInput);

  const ownerSignature = yield* signAddDeviceIntentV1(
    domain,
    intent,
    hexToBytes(state.ownerKey)
  ).pipe(Effect.flatMap(encodeSignature));

  return {
    digest: yield* hashAddDeviceIntentV1(domain, intent),
    domain: domainInput,
    expectedOwner: account.owner,
    intent: intentInput,
    operation: "add",
    ownerSignature,
    v: 1,
  } satisfies DeviceActionApprovalV1Encoded;
});

const deviceActions = Effect.fn("phone.deviceActions")(function* () {
  const { apiUrl } = yield* configuredRegistry();

  if (!apiUrl) {
    return yield* fail("QOP_API_URL is required");
  }

  // The app's client reads its base URL from the Expo environment.
  process.env.EXPO_PUBLIC_API_URL = apiUrl;

  return createDeviceActionClient({ fetch });
});

/** Submits the pending approval, then waits until the API settles it. */
const submit = Effect.fn("phone.submit")(function* () {
  const state = yield* loadState();
  const record = state.pending;

  if (!record) {
    return yield* fail("no pending approval; run approve first");
  }

  const client = yield* deviceActions();

  const submitted = yield* client.submit({
    intent: record.intent,
    operation: "add",
    ownerSignature: record.ownerSignature,
  });

  console.log(`submitted ${submitted.digest} status=${submitted.status}`);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const row = yield* client.get(record.digest);

    if (row.status !== "ready" && row.status !== "submitted") {
      console.log(`api status=${row.status} tx=${row.transactionHash}`);

      return;
    }

    yield* Effect.sleep(1000);
  }

  return yield* fail("the API did not settle the approval in 60 s");
});

/** Dials the desktop's offer, says hello, hands over the approval; then submits it. */
const approve = Effect.fn("phone.approve")(function* (
  code: string,
  submitAfter: boolean
) {
  const state = yield* loadState();
  const { chainId, registryAddress } = yield* configuredRegistry();
  const offer = yield* decodePairingPayload(code, nowSeconds());
  const deviceKey = asHex(offer.deviceKey);
  const relays = cliRelays();

  const config = {
    agentVersion: "qop-e2e-phone/0.1.0",
    protocols: [PAIR_PROTOCOL],
    secretKey: hexToBytes(state.phoneSecret),
  };

  const endpoint = Minip2p.create(
    relays.length > 0 ? { ...config, relays } : config
  );

  const transport = {
    connect: (target: Parameters<typeof endpoint.connect>[0]) =>
      endpoint.connect(target, { timeoutMs: 15_000 }),
    openPairingStream: (peerId: string) =>
      endpoint.openStream(peerId, PAIR_PROTOCOL, { timeoutMs: 15_000 }),
    waitPeerReady: async (peerId: string) => {
      await endpoint.waitPeerReady(peerId, { timeoutMs: 15_000 });
    },
  };

  const program = Effect.gen(function* () {
    const { fingerprint, peerId } = yield* handshakePairing(
      transport,
      offer,
      { chainId, qid: state.qid, registry: registryAddress },
      () => Promise.resolve(crypto.getRandomValues(new Uint8Array(32)))
    );

    console.log(`hello acknowledged by ${fingerprint} (${peerId})`);

    // Like the app: a pending approval for this desktop key is resent, never re-signed.
    const record =
      state.pending && asHex(state.pending.intent.deviceKey) === deviceKey
        ? state.pending
        : yield* signApproval(state, deviceKey);

    yield* saveState({ ...state, pending: record });
    const digest = yield* sendPairingApproval(transport, offer, peerId, record);
    console.log(`approvalSaved ${digest}`);
  }).pipe(
    Effect.ensuring(Effect.promise(() => endpoint.close()).pipe(Effect.ignore))
  );

  yield* program;

  if (submitAfter) {
    yield* submit();
  }
});

const [command, ...args] = process.argv.slice(2);

if (command === "register") {
  NodeRuntime.runMain(register(args[0] ?? ""));
} else if (command === "approve") {
  NodeRuntime.runMain(approve(args[0] ?? "", !args.includes("--no-submit")));
} else if (command === "submit") {
  NodeRuntime.runMain(submit());
} else {
  console.error("usage: desktop-phone.ts register|approve|submit");
  process.exitCode = 1;
}
