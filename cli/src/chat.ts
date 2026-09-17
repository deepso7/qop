import { Minip2p, PeerDisconnectedError } from "@minip2p/node";
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
} from "@qop/protocol";
import type {
  ChatFrame,
  PeerConnection,
  SessionContact,
  SessionContactInput,
} from "@qop/protocol";
import { Effect } from "effect";

import { CliConfigError, cliRelays, configuredRegistry } from "./config.ts";
import type { createCliIdentityStore } from "./identity-store.ts";
import { createCliOutboxStore } from "./outbox-store.ts";
import { createOutboxRuntime, describeOutboxEvent } from "./outbox.ts";
import {
  isUnprovenLifecycleOverride,
  UNPROVEN_LIFECYCLE_OVERRIDE_ENV,
  withMessagingLifecycle,
} from "./process-lifecycle.ts";

const MAX_INBOUND_STREAMS = 8;
const INBOUND_READ_TIMEOUT_MS = 15_000;
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

const transportError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

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
        catch: transportError,
        try: () =>
          transport.connect(peerId, { timeoutMs: CHAT_CONNECT_TIMEOUT_MS }),
      });
    }
    // Path-up is not Identify. Wait again if a replacement connection wins.
    yield* Effect.tryPromise({
      catch: transportError,
      try: () =>
        transport.waitPeerReady(peerId, { timeoutMs: CHAT_CONNECT_TIMEOUT_MS }),
    });
    return yield* Effect.tryPromise({
      catch: transportError,
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
  return yield* sessions.verify(stream, recipient.handle).pipe(
    Effect.flatMap((contact) => {
      // Chat frames have no recipient field — bind to the QID the user selected,
      // not whichever account currently owns the connected device.
      if (contact.qid !== recipient.qid) {
        return Effect.fail(
          new PeerVerificationError({ operation: "identity" })
        );
      }
      if (!sessions.isVerified(stream, recipient.qid)) {
        return Effect.fail(
          new Error("Chat connection is no longer authorized")
        );
      }
      return Effect.succeed(stream);
    }),
    Effect.tapError(() =>
      Effect.sync(() => {
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
  const peerId = yield* sessions.recipientPeerId(recipient);
  const stream = yield* openAuthorizedChatStream(
    transport,
    sessions,
    peerId,
    recipient
  );
  stream.write(encodeFrame(frame));
  stream.closeWrite();
  const ackBytes = yield* Effect.tryPromise({
    catch: transportError,
    try: () => readUntilEof(() => stream.read()),
  });
  const ack = yield* Effect.try({
    catch: transportError,
    try: () => decodeAck(ackBytes),
  });
  yield* Effect.try({
    catch: transportError,
    try: () => {
      assertAckMatches(ack, frame.id);
    },
  });
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

  if (!isUnprovenLifecycleOverride()) {
    console.error(
      `CLI messaging is disabled until real macOS/Linux sleep/wake invalidation is demonstrated. Pairing (\`qop link\`) still works. Set ${UNPROVEN_LIFECYCLE_OVERRIDE_ENV}=1 to enable diagnostic chat with SIGCONT, stall observe, and verify-boundary invalidation — that override is not lid-sleep proof.`
    );
    return;
  }

  const contacts = new Map<string, SessionContact>();
  const sessions = createPeerSessions({
    getContactByQid: (qid) => Promise.resolve(contacts.get(qid) ?? null),
    lookupDeviceKey: reader.lookupDeviceKey,
    lookupHandle: reader.lookupHandle,
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
  // SIGCONT and stall observe still invalidate at the verify/send boundary.
  // They are not proof of lid sleep/wake; messaging is override-gated above.
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
          protocols: [CHAT_PROTOCOL],
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
              return Effect.fail(new Error("Authorization was invalidated"));
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
            if (event.kind === "failed") {
              console.error(line);
              return;
            }
            console.log(line);
          },
          store: messages,
        });

        const program = Effect.gen(function* () {
          lifecycle.adapter.observe();
          endpoint.on("connectionEstablished", (connection) => {
            sessions.opened(connection);
            Effect.runFork(outbox.flushDue().pipe(Effect.ignore));
          });
          endpoint.on("connectionClosed", (connection) => {
            sessions.closed(connection);
          });
          endpoint.on("stream", (stream) => {
            if (stream.protocolId !== CHAT_PROTOCOL) {
              stream.reset();
              return;
            }
            if (inbound >= MAX_INBOUND_STREAMS) {
              stream.reset();
              return;
            }
            inbound += 1;
            Effect.runFork(
              Effect.gen(function* () {
                guardSensitive();
                const bytes = yield* Effect.tryPromise({
                  catch: (cause) =>
                    cause instanceof Error ? cause : new Error(String(cause)),
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
                yield* messages.putInbox({
                  frame,
                  fromQid: contact.qid,
                  receivedAt: Date.now(),
                  v: 1,
                });
                stream.write(encodeAck({ ack: frame.id, v: 1 }));
                stream.closeWrite();
                console.log(`@${frame.fromHandle}: ${frame.text}`);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    inbound -= 1;
                  })
                ),
                Effect.matchEffect({
                  onFailure: () =>
                    Effect.sync(() => {
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
            `${UNPROVEN_LIFECYCLE_OVERRIDE_ENV}=1: SIGCONT, stall observe, and verify-boundary invalidation are armed. This is not proof of macOS/Linux lid sleep/wake.`
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
