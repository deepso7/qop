import { Minip2p, PeerDisconnectedError } from "@minip2p/node";
import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import {
  assertAckMatches,
  CHAT_PROTOCOL,
  createPeerSessions,
  decodeAck,
  decodeFrame,
  encodeAck,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
  PeerVerificationError,
  SYNC_PROTOCOL,
} from "@qop/protocol";
import type {
  ChatFrame,
  InboxRecordV1,
  PeerConnection,
  SessionContact,
  SessionContactInput,
} from "@qop/protocol";
import { Effect, Schema } from "effect";

import { CliConfigError, cliRelays, configuredRegistry } from "./config.ts";
import type { createCliIdentityStore } from "./identity-store.ts";
import {
  CliOutboxStoreError,
  createCliOutboxStore,
  describeCliOutboxStoreError,
} from "./outbox-store.ts";
import type { PutInboxResult } from "./outbox-store.ts";
import {
  CliOutboxDeliverError,
  createOutboxRuntime,
  describeOutboxEvent,
} from "./outbox.ts";
import {
  isMessagingLifecycleAllowed,
  UNPROVEN_MACOS_LIFECYCLE_OVERRIDE_ENV,
  withMessagingLifecycle,
} from "./process-lifecycle.ts";
import { handleInboundSyncStream } from "./sync.ts";
import type { CliSyncIdentity, CliSyncStore } from "./sync.ts";

const MAX_INBOUND_STREAMS = 8;
const INBOUND_READ_TIMEOUT_MS = 15_000;
export const OUTBOUND_ACK_TIMEOUT_MS = 15_000;
export const CHAT_CONNECT_TIMEOUT_MS = 15_000;

export interface ChatStream extends PeerConnection {
  readonly closeWrite: () => void;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => void;
}

export interface ChatDialResult {
  readonly peerId?: string;
}

export interface ChatTransport {
  readonly connectedPeers: () => readonly string[];
  readonly connect: (
    peerId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<ChatDialResult>;
  readonly openStream: (
    peerId: string,
    protocolId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<ChatStream>;
  readonly waitPeerReady: (
    peerId: string,
    options?: { readonly timeoutMs?: number }
  ) => Promise<ChatDialResult>;
}

const concatChunks = (chunks: readonly Uint8Array[], byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readUntilEof = async (
  read: () => Promise<Uint8Array | undefined>,
  chunks: Uint8Array[] = [],
  byteLength = 0
): Promise<Uint8Array> => {
  const chunk = await read();
  if (!chunk) {
    return concatChunks(chunks, byteLength);
  }
  const nextLength = byteLength + chunk.byteLength;
  if (nextLength > MAX_CHAT_PAYLOAD_BYTES) {
    throw new Error("Chat frame exceeds 16 KB");
  }
  chunks.push(chunk);
  return readUntilEof(read, chunks, nextLength);
};

/** Preserve disconnect so setup can retry once; map other transport failures. */
const catchOpenStreamError = (cause: unknown) =>
  cause instanceof PeerDisconnectedError
    ? cause
    : new CliOutboxDeliverError({ operation: "transport" });

const asDeliverError = (cause: unknown) =>
  cause instanceof CliOutboxDeliverError
    ? cause
    : new CliOutboxDeliverError({ operation: "transport" });

/** Connect, wait for Identify, open `/qop/chat/1`, then authorize the live stream. */
export const openAuthorizedChatStream = Effect.fn(
  "qop.openAuthorizedChatStream"
)(function* (
  transport: ChatTransport,
  sessions: ReturnType<typeof createPeerSessions>,
  peerId: string,
  recipient: { readonly handle: string; readonly qid: string }
) {
  const stream = yield* Effect.gen(function* () {
    if (!transport.connectedPeers().includes(peerId)) {
      yield* Effect.tryPromise({
        catch: catchOpenStreamError,
        try: () =>
          transport.connect(peerId, { timeoutMs: CHAT_CONNECT_TIMEOUT_MS }),
      });
    }
    // Path-up is not Identify. Wait again if a replacement connection wins.
    yield* Effect.tryPromise({
      catch: catchOpenStreamError,
      try: () =>
        transport.waitPeerReady(peerId, { timeoutMs: CHAT_CONNECT_TIMEOUT_MS }),
    });
    return yield* Effect.tryPromise({
      catch: catchOpenStreamError,
      try: () =>
        transport.openStream(peerId, CHAT_PROTOCOL, {
          timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
        }),
    });
  }).pipe(
    // Relay-to-direct upgrades can close the initial connection during setup.
    // Retry only before a stream is returned; never replay a sent chat frame.
    Effect.retry({
      times: 1,
      while: (error) => error instanceof PeerDisconnectedError,
    })
  );
  // Bind before verify: connectionEstablished can lag connect/openStream.
  sessions.opened(stream);
  return yield* Effect.gen(function* () {
    const contact = yield* sessions.verify(stream, recipient.handle);
    // Chat frames have no recipient field — bind to the QID the user selected,
    // not whichever account currently owns the connected device.
    if (contact.qid !== recipient.qid) {
      return yield* new PeerVerificationError({ operation: "identity" });
    }
    if (!sessions.isVerified(stream, recipient.qid)) {
      return yield* new CliOutboxDeliverError({ operation: "unauthorized" });
    }
    return stream;
  }).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Success"
        ? Effect.void
        : Effect.sync(() => {
            stream.reset();
          })
    )
  );
});

/** Write one chat frame and wait for a matching ack. Does not persist. */
export const deliverChatFrame = Effect.fn("qop.deliverChatFrame")(function* (
  transport: ChatTransport,
  sessions: ReturnType<typeof createPeerSessions>,
  recipient: { readonly handle: string; readonly qid: string },
  frame: ChatFrame
) {
  const peerIds = yield* sessions
    .recipientPeerIds(recipient)
    .pipe(Effect.mapError(asDeliverError));
  let lastError: CliOutboxDeliverError | undefined;
  for (const peerId of peerIds) {
    const opened = yield* openAuthorizedChatStream(
      transport,
      sessions,
      peerId,
      recipient
    ).pipe(Effect.mapError(asDeliverError), Effect.result);
    if (opened._tag === "Failure") {
      lastError = asDeliverError(opened.failure);
      continue;
    }
    const stream = opened.success;
    // A verified stream is committed — do not fall through after a write.
    return yield* Effect.gen(function* () {
      // Recheck immediately before write: SIGCONT/stall can invalidate after verify.
      if (!sessions.isVerified(stream, recipient.qid)) {
        return yield* Effect.fail(
          new CliOutboxDeliverError({ operation: "unauthorized" })
        );
      }
      yield* Effect.try({
        catch: asDeliverError,
        try: () => {
          stream.write(encodeFrame(frame));
          stream.closeWrite();
        },
      });
      const ackBytes = yield* Effect.tryPromise({
        catch: asDeliverError,
        try: () => readUntilEof(() => stream.read()),
      }).pipe(
        Effect.timeoutOrElse({
          duration: OUTBOUND_ACK_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(new CliOutboxDeliverError({ operation: "timeout" })),
        })
      );
      const ack = yield* Effect.try({
        catch: asDeliverError,
        try: () => decodeAck(ackBytes),
      });
      yield* Effect.try({
        catch: asDeliverError,
        try: () => {
          assertAckMatches(ack, frame.id);
        },
      });
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => {
              stream.reset();
            })
      )
    );
  }
  return yield* Effect.fail(
    lastError ?? new CliOutboxDeliverError({ operation: "transport" })
  );
});

/** Persist inbound, then ACK. Callers print only when `inserted` is true. */
export const ackInboundChatFrame = Effect.fn("qop.ackInboundChatFrame")(
  function* (
    stream: ChatStream,
    record: InboxRecordV1,
    putInbox: (
      record: InboxRecordV1
    ) => Effect.Effect<PutInboxResult, CliOutboxStoreError>
  ) {
    const saved = yield* putInbox(record);
    stream.write(encodeAck({ ack: record.frame.id, v: 1 }));
    stream.closeWrite();
    return saved;
  }
);

/** Own-device `/qop/sync/1` inbound: gate, persist/held, log accepted holds. */
const handleCliInboundSync = Effect.fn("qop.handleCliInboundSync")(function* (
  stream: ChatStream,
  sessions: ReturnType<typeof createPeerSessions>,
  identity: CliSyncIdentity,
  store: CliSyncStore,
  guardSensitive: () => boolean
) {
  if (guardSensitive()) {
    stream.reset();
    return;
  }
  const response = yield* handleInboundSyncStream(
    stream,
    sessions,
    identity,
    store,
    () => !guardSensitive()
  ).pipe(
    Effect.timeoutOrElse({
      duration: INBOUND_READ_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error("Inbound sync timed out")),
    })
  );
  if (response.type === "held") {
    console.log(`Holding ${response.id} from own device.`);
  }
});

export const runStart = Effect.fn("qop.start")(function* (
  store: ReturnType<typeof createCliIdentityStore>,
  options: {
    readonly message?: string | undefined;
    readonly to?: string | undefined;
  }
) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return yield* new CliConfigError({ operation: "platform" });
  }
  const identity = yield* store.loadIdentity();
  if (!identity) {
    console.error("No CLI identity. Run qop link --account <handle>.");
    return;
  }
  const { reader } = yield* configuredRegistry();
  const membership = yield* reader.lookupDeviceKey(identity.deviceKey);
  if (membership?.qid.toString() !== identity.qid) {
    console.error("This device is not an active member of the account.");
    return;
  }

  if (!isMessagingLifecycleAllowed()) {
    console.error(
      `CLI messaging on macOS is disabled until lid sleep/wake invalidation is demonstrated. Pairing (\`qop link\`) still works. Linux holders run without this gate. Set ${UNPROVEN_MACOS_LIFECYCLE_OVERRIDE_ENV}=1 to enable diagnostic chat with SIGCONT, stall observe, and verify-boundary invalidation — that override is not lid-sleep proof.`
    );
    return;
  }

  const contacts = new Map<string, SessionContact>();
  const sessions = createPeerSessions({
    getContactByQid: (qid) => Promise.resolve(contacts.get(qid) ?? null),
    lookupDeviceKey: reader.lookupDeviceKey,
    lookupHandle: reader.lookupHandle,
    ownQid: () => identity.qid,
    upsertContact: (input: SessionContactInput) => {
      const known = contacts.get(input.qid);
      contacts.set(input.qid, {
        ...input,
        keyChanged: known?.keyChanged ?? false,
        lastReadAt: known?.lastReadAt ?? 0,
      });
      return Promise.resolve();
    },
  });
  // SIGCONT, stall observe, and sleep clock-gap still invalidate at the
  // verify/send boundary. macOS lid sleep remains override-gated above.
  return yield* withMessagingLifecycle(
    () => {
      sessions.invalidateAuthorization();
    },
    (lifecycle) =>
      Effect.gen(function* () {
        const guardSensitive = () => {
          if (lifecycle.adapter.takeInvalidation()) {
            sessions.invalidateAuthorization();
            return true;
          }
          return false;
        };

        const secretKey = yield* store.loadSecret();
        const relays = cliRelays();
        const chatConfig = {
          agentVersion: "qop-cli/0.1.0",
          protocols: [CHAT_PROTOCOL, SYNC_PROTOCOL],
          secretKey,
        };
        const endpoint = Minip2p.create(
          relays.length > 0 ? { ...chatConfig, relays } : chatConfig
        );
        let inbound = 0;
        const closeEndpoint = Effect.sync(() => {
          endpoint.close();
        });
        const messages = createCliOutboxStore(store.root);
        const outbox = createOutboxRuntime({
          deliver: (record) => {
            if (guardSensitive()) {
              return Effect.fail(
                new CliOutboxDeliverError({ operation: "unauthorized" })
              );
            }
            return deliverChatFrame(
              endpoint,
              sessions,
              { handle: record.toHandle, qid: record.toQid },
              record.frame
            );
          },
          lookupHandle: reader.lookupHandle,
          onEvent: (event) => {
            const line = describeOutboxEvent(event);
            if (event.kind === "failed" || event.kind === "store-error") {
              console.error(line);
              return;
            }
            console.log(line);
          },
          store: messages,
        });

        const program = Effect.gen(function* () {
          lifecycle.adapter.observe();
          const connectionFlushInFlight = new Set<string>();
          endpoint.on("connectionEstablished", (connection) => {
            sessions.opened(connection);
            const { peerId } = connection;
            if (connectionFlushInFlight.has(peerId)) {
              return;
            }
            connectionFlushInFlight.add(peerId);
            Effect.runFork(
              outbox
                .flushOnConnection(
                  Schema.decodeUnknownEffect(PeerId)(peerId).pipe(
                    Effect.flatMap(deviceKeyFromPeerId),
                    Effect.flatMap((deviceKey) =>
                      Schema.encodeEffect(Hex32)(deviceKey)
                    ),
                    Effect.flatMap(reader.lookupDeviceKey),
                    Effect.map((account) => account?.qid.toString()),
                    Effect.orElseSucceed((): string | undefined => undefined)
                  )
                )
                .pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      connectionFlushInFlight.delete(peerId);
                    })
                  )
                )
            );
          });
          endpoint.on("connectionClosed", (connection) => {
            sessions.closed(connection);
          });
          endpoint.on("stream", (stream) => {
            if (
              stream.protocolId !== CHAT_PROTOCOL &&
              stream.protocolId !== SYNC_PROTOCOL
            ) {
              stream.reset();
              return;
            }
            if (inbound >= MAX_INBOUND_STREAMS) {
              stream.reset();
              return;
            }
            inbound += 1;
            const inboundProgram =
              stream.protocolId === SYNC_PROTOCOL
                ? handleCliInboundSync(
                    stream,
                    sessions,
                    {
                      handle: identity.handle,
                      qid: identity.qid,
                    },
                    messages,
                    guardSensitive
                  )
                : Effect.gen(function* () {
                    guardSensitive();
                    const bytes = yield* Effect.tryPromise({
                      catch: (cause) =>
                        cause instanceof Error
                          ? cause
                          : new Error(String(cause)),
                      try: () => readUntilEof(() => stream.read()),
                    }).pipe(
                      Effect.timeoutOrElse({
                        duration: INBOUND_READ_TIMEOUT_MS,
                        orElse: () =>
                          Effect.fail(new Error("Inbound chat read timed out")),
                      })
                    );
                    const frame = decodeFrame(bytes);
                    if (guardSensitive()) {
                      stream.reset();
                      return;
                    }
                    sessions.opened(stream);
                    const contact = yield* sessions.verify(
                      stream,
                      frame.fromHandle
                    );
                    if (
                      guardSensitive() ||
                      !sessions.isVerified(stream, contact.qid)
                    ) {
                      stream.reset();
                      return;
                    }
                    const saved = yield* ackInboundChatFrame(
                      stream,
                      {
                        frame,
                        fromQid: contact.qid,
                        receivedAt: Date.now(),
                        v: 1,
                      },
                      messages.putInbox
                    );
                    if (saved.inserted) {
                      console.log(`@${frame.fromHandle}: ${frame.text}`);
                    }
                  });
            Effect.runFork(
              inboundProgram.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    inbound -= 1;
                  })
                ),
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.sync(() => {
                      if (error instanceof CliOutboxStoreError) {
                        console.error(describeCliOutboxStoreError(error));
                      }
                      stream.reset();
                    }),
                  onSuccess: () => Effect.void,
                })
              )
            );
          });

          console.log(
            `CLI messaging ready for @${identity.handle} (${identity.peerId}).`
          );
          console.log(
            "SIGCONT, stall observe, and verify-boundary invalidation are armed."
          );

          yield* outbox.resume();

          if (options.to && options.message) {
            if (guardSensitive()) {
              console.error(
                "Authorization was invalidated. Try sending again."
              );
            } else {
              const recipient = yield* reader.lookupHandle(options.to);
              if (recipient) {
                yield* outbox.enqueue({
                  frame: {
                    fromHandle: identity.handle,
                    id: crypto.randomUUID(),
                    sentAt: Date.now(),
                    text: options.message,
                    v: 1,
                  },
                  toHandle: recipient.handle,
                  toQid: recipient.qid.toString(),
                });
              } else {
                console.error(`Account @${options.to} was not found.`);
              }
            }
          }

          yield* outbox.run;
        });

        return yield* program.pipe(Effect.ensuring(closeEndpoint));
      })
  );
});
