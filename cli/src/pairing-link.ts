import { Minip2p } from "@minip2p/node";
import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import {
  asHex,
  encodePairingOfferV1,
  isTerminalDeviceActionStatus,
  PAIR_PROTOCOL,
  PAIRING_MAX_ADDRESSES,
  PAIRING_TTL_SECONDS,
  pairingFingerprint,
  PairingCodecError,
  PairingOfferV1,
  readPairingFrame,
  writePairingFrame,
} from "@qop/protocol";
import { Effect, Schema } from "effect";
import { hexToBytes, isHex } from "viem";

import { cliRelays, configuredRegistry } from "./config.ts";
import { getDeviceActionStatus } from "./device-action-status.ts";
import { pollEnrollmentState, readEnrollmentState } from "./enrollment-poll.ts";
import type { createCliIdentityStore } from "./identity-store.ts";
import {
  createCliPairingSession,
  PairingSessionError,
} from "./pairing-session.ts";

const randomHex32 = Effect.fn("cli.randomHex32")(function* () {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return yield* Schema.encodeEffect(Hex32)(bytes);
});

const secretBytes = (value: string | Uint8Array) => {
  if (value instanceof Uint8Array) {
    return Effect.succeed(value);
  }
  const hex = asHex(value);
  if (!isHex(hex)) {
    return Effect.fail(new PairingSessionError({ operation: "secret" }));
  }
  return Effect.succeed(hexToBytes(hex));
};

const selectPairingAddrs = (
  listen: readonly string[],
  circuit: string | undefined
) => {
  const preferred = [
    ...(circuit ? [circuit] : []),
    ...listen.filter(
      (address) =>
        !address.includes("127.0.0.1") && !address.includes("/ip6/::1/")
    ),
    ...listen,
  ];
  const unique: string[] = [];
  for (const address of preferred) {
    if (!unique.includes(address) && unique.length < PAIRING_MAX_ADDRESSES) {
      unique.push(address);
    }
  }
  return unique;
};

export const runLink = Effect.fn("qop.link")(function* (
  store: ReturnType<typeof createCliIdentityStore>,
  handle: string
) {
  const { apiUrl, chainId, reader, registryAddress } =
    yield* configuredRegistry();
  const account = yield* reader.lookupHandle(handle);
  if (!account) {
    console.error(
      `Account @${handle} was not found on the configured registry.`
    );
    return;
  }
  const publicIdentity = {
    account: handle,
    chainId,
    handle,
    qid: account.qid.toString(),
    registry: registryAddress,
  };
  let identity = yield* store.createPendingKey(publicIdentity);
  const currentMembership = yield* reader.lookupDeviceKey(identity.deviceKey);
  if (currentMembership?.qid.toString() === identity.qid) {
    console.log(`Already linked as @${handle}. Run qop start.`);
    return;
  }

  const lookupSelf = () => reader.lookupDeviceKey(identity.deviceKey);
  const getStatus = () =>
    apiUrl
      ? store
          .loadApproval()
          .pipe(
            Effect.flatMap((pending) =>
              pending
                ? getDeviceActionStatus(apiUrl, pending.digest).pipe(
                    Effect.map((row) => row.status)
                  )
                : Effect.fail(new Error("no pending digest"))
            )
          )
      : Effect.fail(new Error("no api url"));
  const prior = yield* readEnrollmentState({
    expectedQid: BigInt(identity.qid),
    getStatus,
    lookup: lookupSelf,
  });
  if (prior.state === "linked") {
    console.log(`Already linked as @${handle}. Run qop start.`);
    return;
  }
  if (prior.state === "removed") {
    identity = yield* store.rotatePendingKey(publicIdentity);
    console.log(
      "Previous pending key was added and later removed. Generated a new key."
    );
  } else if (isTerminalDeviceActionStatus(prior.apiStatus)) {
    yield* store.clearApproval();
  }

  const secretKey = yield* store.loadSecret();
  const relays = cliRelays();
  const pairingListen: [string] = ["/ip4/0.0.0.0/udp/0/quic-v1"];
  const pairingConfig = {
    agentVersion: "qop-cli/0.1.0",
    protocols: [PAIR_PROTOCOL],
    secretKey,
    transports: {
      quic: { listen: pairingListen },
    },
  };
  const endpoint = Minip2p.create(
    relays.length > 0 ? { ...pairingConfig, relays } : pairingConfig
  );

  const closeEndpoint = Effect.sync(() => {
    endpoint.close();
  });

  const program = Effect.gen(function* () {
    yield* Effect.sleep(500);
    const addrs = selectPairingAddrs(
      endpoint.listenAddrs(),
      endpoint.circuitAddress
    );
    if (addrs.length === 0) {
      console.error("No listen addresses were available for pairing.");
      return;
    }

    const expiresAt =
      BigInt(Math.floor(Date.now() / 1000)) + BigInt(PAIRING_TTL_SECONDS);
    const encodedOffer = {
      addrs,
      chainId,
      deviceKey: identity.deviceKey,
      expiresAt: expiresAt.toString(),
      qid: identity.qid,
      registry: registryAddress,
      secret: yield* randomHex32(),
      sessionId: yield* randomHex32(),
      v: 1 as const,
    };
    const offer =
      yield* Schema.decodeUnknownEffect(PairingOfferV1)(encodedOffer);
    const payload = yield* encodePairingOfferV1(offer).pipe(
      Effect.catchIf(
        (error): error is PairingCodecError =>
          error instanceof PairingCodecError &&
          error.operation === "oversized" &&
          addrs.length > 1,
        () =>
          Schema.decodeUnknownEffect(PairingOfferV1)({
            ...encodedOffer,
            addrs: addrs.slice(0, 1),
          }).pipe(Effect.flatMap(encodePairingOfferV1))
      )
    );
    const session = createCliPairingSession({
      loadApproval: () => store.loadApproval(),
      offer,
      saveApproval: (record) => store.saveApproval(record),
    });

    console.log(`Pending device ${pairingFingerprint(identity.deviceKey)}`);
    console.log(`peer ${identity.peerId}`);
    console.log("");
    console.log("Pairing payload (scan or paste on your phone):");
    console.log(payload);
    console.log("");

    const accountSnapshot = () =>
      Effect.gen(function* () {
        const current = yield* reader.lookupQid(account.qid);
        if (!current) {
          return null;
        }
        const chainTime = yield* reader.latestTimestamp();
        return {
          chainId,
          chainTime,
          devices: current.devices.map((device) => device.deviceKey),
          nonce: current.nonce,
          owner: current.owner,
          qid: current.qid,
          registry: registryAddress,
        };
      });

    endpoint.on("stream", (stream) => {
      if (stream.protocolId !== PAIR_PROTOCOL) {
        stream.reset();
        return;
      }
      Effect.runFork(
        Effect.gen(function* () {
          const frame = yield* readPairingFrame(() => stream.read());
          const snapshot = yield* accountSnapshot();
          if (!snapshot) {
            stream.reset();
            return;
          }
          const phonePeerId = yield* Schema.decodeUnknownEffect(PeerId)(
            stream.peerId
          );
          const phoneKey = yield* deviceKeyFromPeerId(phonePeerId).pipe(
            Effect.flatMap(Schema.encodeEffect(Hex32))
          );
          if (frame.type === "hello") {
            const ack = yield* session.hello(
              stream.peerId,
              yield* secretBytes(frame.secret),
              phoneKey,
              snapshot,
              frame
            );
            yield* writePairingFrame(
              (data) => stream.write(data),
              () => stream.closeWrite(),
              ack
            );
            return;
          }
          if (frame.type === "approval") {
            const ack = yield* session.receiveApproval(
              stream.peerId,
              frame.record,
              snapshot,
              frame.sessionId
            );
            yield* writePairingFrame(
              (data) => stream.write(data),
              () => stream.closeWrite(),
              {
                digest: ack.digest,
                sessionId: offer.sessionId,
                type:
                  ack.kind === "saved" ? "approvalSaved" : "approvalConflict",
                v: 1,
              }
            );
            return;
          }
          stream.reset();
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                stream.reset();
                if (error instanceof PairingSessionError) {
                  console.error(`Pairing rejected (${error.operation}).`);
                }
              }),
            onSuccess: () => Effect.void,
          })
        )
      );
    });

    console.log(
      "Waiting for phone approval. Ctrl+C cancels pairing, not a signed intent."
    );
    const snapshot = yield* pollEnrollmentState({
      expectedQid: BigInt(identity.qid),
      getStatus,
      lookup: lookupSelf,
    });
    if (snapshot.state === "linked") {
      console.log(`Linked as @${handle}. Run qop start.`);
      return;
    }
    if (snapshot.state === "removed") {
      yield* store.rotatePendingKey(publicIdentity);
      console.log(
        "This key was added and later removed. A new pending key was generated. Run qop link again."
      );
      return;
    }
    if (isTerminalDeviceActionStatus(snapshot.apiStatus)) {
      yield* store.clearApproval();
      console.log(
        "The approval expired or reverted. Run qop link to try a new enrollment."
      );
      return;
    }
    console.log("Enrollment did not complete.");
  });

  return yield* program.pipe(Effect.ensuring(closeEndpoint));
});
