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
 *   node scripts/desktop-phone.ts handoff <handle> <text…>
 *                                                       hand a queued message to the linked device
 *   node scripts/desktop-phone.ts poll                  ask it for receipts of handed-off messages
 *   node scripts/desktop-phone.ts catchup               fetch what it received past the cursor
 *   node scripts/desktop-phone.ts remove                remove the linked device from the account
 *
 * The phone's state (owner key, device secret, pending approval, handed-off ids, catch-up
 * cursors) lives in `QOP_E2E_PHONE` (default `/tmp/qop-e2e/phone.json`). Pairing reuses the
 * app's own handshake (`mobile/src/lib/pairing-client-core.ts`) and API client; like the app,
 * `approve` resends a pending approval for the same desktop key instead of signing a new one.
 * Sync reuses the app's `/qop/sync/1` client (`mobile/src/lib/p2p-sync.ts`) and peer sessions,
 * against the account's one other device (the desktop); it needs `QOP_RELAY_ADDRS` to reach
 * it by peer ID.
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
  decodeRemoveDeviceIntentV1,
  deviceKeyFromEd25519SecretKey,
  EcdsaSignature,
  encodeRegisterIntentV1,
  hashAddDeviceIntentV1,
  hashRemoveDeviceIntentV1,
  Hex32,
  signAddDeviceIntentV1,
  signRegisterIntentV1,
  signRemoveDeviceIntentV1,
} from "@qop/identity";
import {
  asHex,
  createPeerSessions,
  DEVICE_ACTION_DEADLINE_SECONDS,
  PAIR_PROTOCOL,
  SYNC_PROTOCOL,
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
  outgoingHandoffRecord,
  performCatchup,
  performHandoff,
  performPoll,
} from "../../mobile/src/lib/p2p-sync.ts";
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
  /** Catch-up cursor per holder peer ID, as the app keeps it. */
  readonly cursors?: Readonly<Record<string, number>>;
  readonly handle: string;
  /** Message ids handed off and not yet reported delivered. */
  readonly held?: readonly string[];
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

/** Signs an add- or remove-device record for `deviceKey`, as the app's owner key would. */
const signApproval = Effect.fn("phone.signApproval")(function* (
  state: PhoneState,
  deviceKey: string,
  operation: "add" | "remove" = "add"
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
  const ownerKey = hexToBytes(state.ownerKey);

  if (operation === "remove") {
    const intent = yield* decodeRemoveDeviceIntentV1(intentInput);

    return {
      digest: yield* hashRemoveDeviceIntentV1(domain, intent),
      domain: domainInput,
      expectedOwner: account.owner,
      intent: intentInput,
      operation,
      ownerSignature: yield* signRemoveDeviceIntentV1(
        domain,
        intent,
        ownerKey
      ).pipe(Effect.flatMap(encodeSignature)),
      v: 1,
    } satisfies DeviceActionApprovalV1Encoded;
  }

  const intent = yield* decodeAddDeviceIntentV1(intentInput);

  return {
    digest: yield* hashAddDeviceIntentV1(domain, intent),
    domain: domainInput,
    expectedOwner: account.owner,
    intent: intentInput,
    operation,
    ownerSignature: yield* signAddDeviceIntentV1(domain, intent, ownerKey).pipe(
      Effect.flatMap(encodeSignature)
    ),
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

/** Submits a signed device action, then waits until the API settles it. */
const submitRecord = Effect.fn("phone.submitRecord")(function* (
  record: DeviceActionApprovalV1Encoded
) {
  const client = yield* deviceActions();

  const submitted = yield* client.submit({
    intent: record.intent,
    operation: record.operation,
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

/** Submits the pending approval, then waits until the API settles it. */
const submit = Effect.fn("phone.submit")(function* () {
  const state = yield* loadState();

  if (!state.pending) {
    return yield* fail("no pending approval; run approve first");
  }

  yield* submitRecord(state.pending);
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

/** The account's devices other than this phone: the linked desktop (or CLI). */
const otherDevices = Effect.fn("phone.otherDevices")(function* (
  state: PhoneState
) {
  const { reader } = yield* configuredRegistry();
  const account = yield* reader.lookupQid(BigInt(state.qid));

  if (!account) {
    return yield* fail(`qid ${state.qid} is not on chain`);
  }

  const phoneKey = yield* deviceKeyFromEd25519SecretKey(
    hexToBytes(state.phoneSecret)
  ).pipe(Effect.flatMap(Schema.encodeEffect(Hex32)));

  const others = account.devices.filter(
    (device) => asHex(device.deviceKey) !== asHex(phoneKey)
  );

  const [holder] = others;

  if (!holder || others.length !== 1) {
    return yield* fail(`expected one other device, found ${others.length}`);
  }

  return { holder, phoneKey };
});

/**
 * Runs `run` against the linked device over `/qop/sync/1`, with the app's sync client: a
 * phone endpoint on the relay and peer sessions that verify the holder as our own device.
 */
const withHolder = <A>(
  run: (sync: {
    readonly composedBy: string;
    readonly holderPeerId: string;
    readonly input: Omit<
      Parameters<typeof performCatchup>[0],
      "after" | "holderPeerId"
    >;
    readonly state: PhoneState;
  }) => Promise<A>
) =>
  Effect.gen(function* () {
    const state = yield* loadState();
    const { reader } = yield* configuredRegistry();
    const { holder, phoneKey } = yield* otherDevices(state);
    const relays = cliRelays();

    if (relays.length === 0) {
      return yield* fail("QOP_RELAY_ADDRS is required to reach the holder");
    }

    const endpoint = Minip2p.create({
      agentVersion: "qop-e2e-phone/0.1.0",
      protocols: [SYNC_PROTOCOL],
      relays,
      secretKey: hexToBytes(state.phoneSecret),
    });

    const sessions = createPeerSessions({
      getContactByQid: () => Promise.resolve(null),
      lookupDeviceKey: reader.lookupDeviceKey,
      lookupHandle: reader.lookupHandle,
      ownQid: () => state.qid,
      upsertContact: () => Promise.resolve(),
    });

    const input = {
      endpoint,
      own: { handle: state.handle, qid: state.qid },
      sessions,
      timeoutMs: 20_000,
    };

    return yield* Effect.tryPromise({
      catch: (cause) => fail(`sync failed: ${String(cause)}`),
      try: () =>
        run({
          composedBy: asHex(phoneKey),
          holderPeerId: holder.peerId,
          input,
          state,
        }),
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => endpoint.close()).pipe(Effect.ignore)
      )
    );
  });

/** Hands a queued message for `toHandle` to the linked device; it answers `held` once saved. */
const handoff = Effect.fn("phone.handoff")(function* (
  toHandle: string,
  text: string
) {
  const { reader } = yield* configuredRegistry();
  const contact = yield* reader.lookupHandle(toHandle);

  if (!contact) {
    return yield* fail(`@${toHandle} is not on chain`);
  }

  const id = crypto.randomUUID();

  const state = yield* withHolder(async (sync) => {
    const now = Date.now();

    await performHandoff({
      ...sync.input,
      composedBy: sync.composedBy,
      holderPeerId: sync.holderPeerId,
      record: outgoingHandoffRecord({
        contact: { handle: contact.handle, qid: contact.qid.toString() },
        fromHandle: sync.state.handle,
        id,
        now,
        sentAt: now,
        text,
      }),
    });

    console.log(`held ${id} by ${sync.holderPeerId}`);

    return sync.state;
  });

  yield* saveState({ ...state, held: [...(state.held ?? []), id] });
});

/** Asks the linked device which handed-off messages it has delivered. */
const poll = Effect.fn("phone.poll")(function* () {
  const state = yield* loadState();
  const held = state.held ?? [];

  if (held.length === 0) {
    return yield* fail("nothing handed off; run handoff first");
  }

  const receipts = yield* withHolder((sync) =>
    performPoll({ ...sync.input, holderPeerId: sync.holderPeerId, ids: held })
  );

  for (const receipt of receipts) {
    console.log(
      `receipt ${receipt.id} to=${receipt.toQid} deliveredAt=${new Date(receipt.deliveredAt).toISOString()}`
    );
  }

  const delivered = new Set(receipts.map((receipt) => receipt.id));
  const waiting = held.filter((id) => !delivered.has(id));
  console.log(`${receipts.length} delivered, ${waiting.length} still held`);
  yield* saveState({ ...state, held: waiting });
});

/** Pages the linked device's inbox past this phone's cursor, as the app's catch-up does. */
const catchup = Effect.fn("phone.catchup")(function* () {
  const { cursor, holderPeerId, state } = yield* withHolder(async (sync) => {
    // One page at a time, until an empty one; a cursor past the holder's last seq means its
    // inbox was wiped, so start over from 0 (the app's `pull`).
    const pull = async (after: number): Promise<number> => {
      const page = await performCatchup({
        ...sync.input,
        after,
        holderPeerId: sync.holderPeerId,
      });

      if (after > page.lastSeq) {
        console.log(`holder inbox reset (lastSeq=${page.lastSeq}); from 0`);

        return pull(0);
      }

      for (const { record, seq } of page.records) {
        console.log(
          `#${seq} @${record.frame.fromHandle}: ${record.frame.text}`
        );
      }

      const last = page.records.at(-1);

      return last ? pull(last.seq) : after;
    };

    return {
      cursor: await pull(sync.state.cursors?.[sync.holderPeerId] ?? 0),
      holderPeerId: sync.holderPeerId,
      state: sync.state,
    };
  });

  console.log(`caught up to seq ${cursor}`);
  yield* saveState({
    ...state,
    cursors: { ...state.cursors, [holderPeerId]: cursor },
  });
});

/** Signs and submits removal of the account's other device, as Profile → Devices would. */
const remove = Effect.fn("phone.remove")(function* () {
  const state = yield* loadState();
  const { holder } = yield* otherDevices(state);
  const record = yield* signApproval(state, holder.deviceKey, "remove");
  console.log(`removing ${holder.peerId}`);
  yield* submitRecord(record);
});

const [command, ...args] = process.argv.slice(2);

if (command === "register") {
  NodeRuntime.runMain(register(args[0] ?? ""));
} else if (command === "approve") {
  NodeRuntime.runMain(approve(args[0] ?? "", !args.includes("--no-submit")));
} else if (command === "submit") {
  NodeRuntime.runMain(submit());
} else if (command === "handoff") {
  NodeRuntime.runMain(handoff(args[0] ?? "", args.slice(1).join(" ")));
} else if (command === "poll") {
  NodeRuntime.runMain(poll());
} else if (command === "catchup") {
  NodeRuntime.runMain(catchup());
} else if (command === "remove") {
  NodeRuntime.runMain(remove());
} else {
  console.error(
    "usage: desktop-phone.ts register|approve|submit|handoff|poll|catchup|remove"
  );
  process.exitCode = 1;
}
