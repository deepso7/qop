import { Minip2p, PeerDisconnectedError } from "@minip2p/node";
import {
  deviceKeyBytesFromPeerId,
  deviceKeyFromPeerId,
  Hex32,
  PeerId,
} from "@qop/identity";
import {
  assertAckMatches,
  CHAT_PROTOCOL,
  createChatCipher,
  createPeerSessions,
  decodeAck,
  depositToMailbox,
  drainMailbox,
  encodeAck,
  MAILBOX_PROTOCOL,
  MAX_CHAT_ENVELOPE_BYTES,
  MAX_CHAT_PAYLOAD_BYTES,
  PeerVerificationError,
  SYNC_PROTOCOL,
} from "@qop/protocol";
import type {
  ChatCipher,
  ChatFrame,
  InboxRecordV1,
  MailboxPeer,
  PeerConnection,
  RegistryAccount,
  RegistryReaderError,
  SessionContact,
  SessionContactInput,
} from "@qop/protocol";
import { Effect, FiberSet, Schema, Semaphore } from "effect";

import {
  CliConfigError,
  cliMailboxes,
  cliRelays,
  configuredRegistry,
} from "./config.ts";
import type { createCliIdentityStore } from "./identity-store.ts";
import {
  CliOutboxStoreError,
  describeCliOutboxStoreError,
  openCliOutboxStore,
} from "./outbox-store.ts";
import type { CliOutboxStore, PutInboxResult } from "./outbox-store.ts";
import {
  CliOutboxDeliverError,
  createOutboxRuntime,
  describeOutboxEvent,
  newOutboxRecord,
} from "./outbox.ts";
import {
  isMessagingLifecycleAllowed,
  withMessagingLifecycle,
} from "./process-lifecycle.ts";
import type { ArmedProcessLifecycle } from "./process-lifecycle.ts";
import { handleInboundSyncStream } from "./sync.ts";
import type { CliSyncIdentity, CliSyncStore } from "./sync.ts";

export const MAX_INBOUND_STREAMS = 8;
const MAX_INBOUND_SYNC_STREAMS = 8;
export const UNREADABLE_INBOUND_CHAT = "Inbound chat frame was unreadable";
const INBOUND_READ_TIMEOUT_MS = 15_000;
export const OUTBOUND_ACK_TIMEOUT_MS = 15_000;
export const CHAT_CONNECT_TIMEOUT_MS = 15_000;

/** Hard bound on the concurrent roster dial phase, before any chat write. */
export const CHAT_DIAL_BUDGET_MS = 30_000;

export interface ChatStream extends PeerConnection {
  readonly closeWrite: () => void;
  readonly protocolId?: string;
  readonly read: () => Promise<Uint8Array | undefined>;
  readonly reset: () => void;
  readonly write: (data: Uint8Array) => Promise<void>;
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

/** Minip2p endpoint surface the holder actually uses. */
export type HolderEndpoint = ChatTransport & {
  readonly close: () => void;
  readonly on: (event: string, listener: (value: ChatStream) => void) => void;
};

export interface HolderIdentity {
  readonly handle: string;
  readonly qid: string;
  readonly peerId: string;
}

export interface HolderOutput {
  readonly error: (line: string) => void;
  readonly log: (line: string) => void;
}

export interface HolderReader {
  readonly lookupDeviceKey: (
    deviceKey: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly lookupHandle: (
    handle: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
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
  limit: number,
  chunks: Uint8Array[] = [],
  byteLength = 0
): Promise<Uint8Array> => {
  const chunk = await read();

  if (!chunk) {
    return concatChunks(chunks, byteLength);
  }

  const nextLength = byteLength + chunk.byteLength;

  if (nextLength > limit) {
    throw new Error("Chat payload exceeds its size limit");
  }

  chunks.push(chunk);

  return readUntilEof(read, limit, chunks, nextLength);
};

/** Preserve disconnect so setup can retry once; map other transport failures. */
const catchOpenStreamError = (cause: unknown) =>
  cause instanceof PeerDisconnectedError
    ? cause
    : new CliOutboxDeliverError({ operation: "transport" });

const isVerificationRejection = (cause: unknown): boolean =>
  (cause instanceof CliOutboxDeliverError &&
    cause.operation === "unauthorized") ||
  (cause instanceof PeerVerificationError &&
    (cause.operation === "identity" ||
      cause.operation === "reassigned" ||
      cause.operation === "invalid-recipient"));

const asDeliverError = (cause: unknown) => {
  if (cause instanceof CliOutboxDeliverError) {
    return cause;
  }

  if (isVerificationRejection(cause)) {
    return new CliOutboxDeliverError({ operation: "unauthorized" });
  }

  return new CliOutboxDeliverError({ operation: "transport" });
};

/** Connect, wait for Identify, open chat, then authorize the live stream. */
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
      try: async (signal) => {
        // Interrupt cannot cancel minip2p openStream; reset if it lands late.
        const lateStream = await transport.openStream(peerId, CHAT_PROTOCOL, {
          timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
        });

        if (signal.aborted) {
          lateStream.reset();
          throw signal.reason;
        }

        return lateStream;
      },
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
  frame: ChatFrame,
  cipher: Pick<ChatCipher, "seal">,
  account?: RegistryAccount
) {
  // Success is a non-empty roster; an empty roster fails inside recipientPeerIds.
  const peerIds = yield* sessions
    .recipientPeerIds(recipient, account)
    .pipe(Effect.mapError(asDeliverError));

  // Dial the roster concurrently; the first *authorized* stream wins.
  // Exactly one stream survives: a late second success resets itself.
  // Never write a chat frame before this claim succeeds.
  // Claim is in the same uninterruptible region as the open's tail so an
  // interrupt cannot land after verify's onExit has popped and before reset.
  let claimedStream: ChatStream | undefined;
  let verificationRejection: CliOutboxDeliverError | undefined;

  const dial = (peerId: string) =>
    Effect.uninterruptibleMask((restore) =>
      restore(
        openAuthorizedChatStream(transport, sessions, peerId, recipient)
      ).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            if (isVerificationRejection(cause)) {
              verificationRejection ??= new CliOutboxDeliverError({
                operation: "unauthorized",
              });
            }
          })
        ),
        Effect.flatMap((stream) =>
          Effect.suspend(() => {
            if (claimedStream !== undefined) {
              stream.reset();

              return Effect.fail(
                new CliOutboxDeliverError({ operation: "transport" })
              );
            }

            claimedStream = stream;

            return Effect.succeed(stream);
          })
        )
      )
    );

  const stream = yield* Effect.raceAll(peerIds.map(dial)).pipe(
    Effect.timeoutOrElse({
      duration: CHAT_DIAL_BUDGET_MS,
      orElse: () =>
        Effect.fail(new CliOutboxDeliverError({ operation: "timeout" })),
    }),
    Effect.mapError((cause) => verificationRejection ?? asDeliverError(cause)),
    Effect.onExit((exit) => {
      if (exit._tag === "Success" || claimedStream === undefined) {
        return Effect.void;
      }

      const orphan = claimedStream;

      return Effect.sync(() => {
        orphan.reset();
      });
    })
  );

  // A verified stream is committed — there is no fallback loop after a write.
  return yield* Effect.gen(function* () {
    const envelope = yield* Effect.tryPromise({
      catch: asDeliverError,
      try: () => cipher.seal(frame, deviceKeyBytesFromPeerId(stream.peerId)),
    });

    // Recheck immediately before write: SIGCONT/stall can invalidate after verify.
    if (!sessions.isVerified(stream, recipient.qid)) {
      return yield* Effect.fail(
        new CliOutboxDeliverError({ operation: "unauthorized" })
      );
    }

    yield* Effect.tryPromise({
      catch: asDeliverError,
      try: async () => {
        await stream.write(envelope);
        stream.closeWrite();
      },
    });

    const ackBytes = yield* Effect.tryPromise({
      catch: asDeliverError,
      try: () => readUntilEof(() => stream.read(), MAX_CHAT_PAYLOAD_BYTES),
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

    return stream.peerId;
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
    yield* Effect.promise(() =>
      stream.write(encodeAck({ ack: record.frame.id, v: 1 }))
    );
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
  guardSensitive: () => boolean,
  out: HolderOutput
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
    out.log(`Holding ${response.id} from own device.`);
  }
});

const decodeInboundChatFrame = (
  bytes: Uint8Array,
  peerId: string,
  cipher: ChatCipher
) =>
  Effect.tryPromise({
    catch: () => new Error(UNREADABLE_INBOUND_CHAT),
    try: () => cipher.open(bytes, deviceKeyBytesFromPeerId(peerId)),
  });

const deviceKeysFromAccount = (
  account?: RegistryAccount
): readonly string[] => {
  if (!account) {
    return [];
  }

  if (account.devices.length > 0) {
    return account.devices.map((device) => device.deviceKey);
  }

  return account.deviceKey ? [account.deviceKey] : [];
};

/**
 * Holder wiring: inbound dispatch, outbox flush, and FiberSet handlers.
 * FiberSet is acquired here so LIFO finalizers interrupt (and await) those
 * fibers before the caller's `messages.db` close.
 */
export const createHolder = Effect.fn("qop.createHolder")(function* ({
  cipher,
  connectAddrs,
  endpoint,
  identity,
  lifecycle,
  mailboxes = [],
  messages,
  options = {},
  out,
  reader,
  sessions,
}: {
  readonly cipher: ChatCipher;
  readonly connectAddrs?: (
    addrs: readonly [string, ...string[]],
    options?: { readonly timeoutMs?: number }
  ) => Promise<ChatDialResult>;
  readonly endpoint: HolderEndpoint;
  readonly identity: HolderIdentity;
  readonly lifecycle: ArmedProcessLifecycle;
  readonly mailboxes?: readonly MailboxPeer[] | undefined;
  readonly messages: CliOutboxStore;
  readonly options?: {
    readonly message?: string | undefined;
    readonly to?: string | undefined;
  };
  readonly out: HolderOutput;
  readonly reader: HolderReader;
  readonly sessions: ReturnType<typeof createPeerSessions>;
}) {
  const guardSensitive = () => {
    if (lifecycle.adapter.takeInvalidation()) {
      sessions.invalidateAuthorization();

      return true;
    }

    return false;
  };

  const openMailboxStream = async (peer: MailboxPeer) => {
    if (!endpoint.connectedPeers().includes(peer.peerId)) {
      await (connectAddrs
        ? connectAddrs([peer.addr], { timeoutMs: CHAT_CONNECT_TIMEOUT_MS })
        : endpoint.connect(peer.peerId, {
            timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
          }));
    }

    await endpoint.waitPeerReady(peer.peerId, {
      timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
    });

    return endpoint.openStream(peer.peerId, MAILBOX_PROTOCOL, {
      timeoutMs: CHAT_CONNECT_TIMEOUT_MS,
    });
  };

  const isAuthCurrent = (expectedEpoch: number) =>
    !guardSensitive() && sessions.authorizationEpoch() === expectedEpoch;

  const depositForDevices = (
    frame: ChatFrame,
    recipientDeviceKeys: readonly string[],
    expectedAuthEpoch: number
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      let pending = [
        ...new Set(recipientDeviceKeys.map((key) => key.toLowerCase())),
      ];

      if (pending.length === 0) {
        return true;
      }

      let acceptedAny = false;

      for (const peer of mailboxes) {
        if (pending.length === 0 || !isAuthCurrent(expectedAuthEpoch)) {
          break;
        }

        const result = yield* depositToMailbox({
          beforeWrite: () => isAuthCurrent(expectedAuthEpoch),
          cipher,
          frame,
          openStream: () => openMailboxStream(peer),
          recipientDeviceKeys: pending,
        }).pipe(Effect.result);

        if (result._tag === "Success" && result.success.length > 0) {
          acceptedAny = true;
          const accepted = new Set(result.success);
          pending = pending.filter((key) => !accepted.has(key));
        }
      }

      return acceptedAny;
    });

  const runHandler = yield* FiberSet.makeRuntime();
  const chatInbound = Semaphore.makeUnsafe(MAX_INBOUND_STREAMS);
  let syncInbound = 0;

  const outbox = yield* createOutboxRuntime({
    deliver: (record, account) => {
      if (guardSensitive()) {
        return Effect.fail(
          new CliOutboxDeliverError({ operation: "unauthorized" })
        );
      }

      const authEpoch = sessions.authorizationEpoch();

      return deliverChatFrame(
        endpoint,
        sessions,
        { handle: record.toHandle, qid: record.toQid },
        record.frame,
        cipher,
        account
      ).pipe(
        Effect.tap((deliveredPeerId) => {
          if (mailboxes.length === 0 || !isAuthCurrent(authEpoch)) {
            return Effect.void;
          }

          const deliveredKeyHex = `0x${Buffer.from(
            deviceKeyBytesFromPeerId(deliveredPeerId)
          ).toString("hex")}`.toLowerCase();

          const remaining = deviceKeysFromAccount(account).filter(
            (key) => key.toLowerCase() !== deliveredKeyHex
          );

          if (remaining.length === 0) {
            return Effect.void;
          }

          // Background best-effort fan-out so a slow/down mailbox never stalls live chat.
          return Effect.sync(() => {
            runHandler(
              depositForDevices(record.frame, remaining, authEpoch).pipe(
                Effect.ignore
              )
            );
          });
        }),
        Effect.asVoid,
        Effect.catch((directError) => {
          // Never mask own-auth invalidation behind a mailbox deposit.
          if (
            mailboxes.length === 0 ||
            directError.operation === "unauthorized" ||
            !isAuthCurrent(authEpoch)
          ) {
            return Effect.fail(directError);
          }

          const targetKeys = deviceKeysFromAccount(account);

          if (targetKeys.length === 0) {
            return Effect.fail(directError);
          }

          return depositForDevices(record.frame, targetKeys, authEpoch).pipe(
            Effect.flatMap((deposited) =>
              deposited ? Effect.void : Effect.fail(directError)
            )
          );
        })
      );
    },
    lookupHandle: reader.lookupHandle,
    lookupPeerQid: (peerId) =>
      Schema.decodeUnknownEffect(PeerId)(peerId).pipe(
        Effect.flatMap(deviceKeyFromPeerId),
        Effect.flatMap((deviceKey) => Schema.encodeEffect(Hex32)(deviceKey)),
        Effect.flatMap(reader.lookupDeviceKey),
        Effect.map((account) => account?.qid.toString()),
        Effect.orElseSucceed((): string | undefined => undefined)
      ),
    onEvent: (event) => {
      const line = describeOutboxEvent(event);

      if (event.kind === "failed" || event.kind === "store-error") {
        out.error(line);

        return;
      }

      out.log(line);
    },
    store: messages,
  });

  lifecycle.adapter.observe();
  endpoint.on("connectionEstablished", (connection) => {
    sessions.opened(connection);
    Effect.runSync(outbox.wake(connection.peerId));
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

    if (
      stream.protocolId === SYNC_PROTOCOL &&
      syncInbound >= MAX_INBOUND_SYNC_STREAMS
    ) {
      stream.reset();

      return;
    }

    if (stream.protocolId === SYNC_PROTOCOL) {
      syncInbound += 1;
    }

    const inboundProgram =
      stream.protocolId === SYNC_PROTOCOL
        ? handleCliInboundSync(
            stream,
            sessions,
            {
              handle: identity.handle,
              qid: identity.qid,
            },
            {
              enqueue: outbox.enqueue,
              getByIds: messages.getByIds,
              inboxAfter: messages.inboxAfter,
            },
            guardSensitive,
            out
          )
        : Effect.gen(function* () {
            guardSensitive();

            const bytes = yield* Effect.tryPromise({
              catch: (cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
              try: () =>
                readUntilEof(() => stream.read(), MAX_CHAT_ENVELOPE_BYTES),
            }).pipe(
              Effect.timeoutOrElse({
                duration: INBOUND_READ_TIMEOUT_MS,
                orElse: () =>
                  Effect.fail(new Error("Inbound chat read timed out")),
              })
            );

            const frame = yield* decodeInboundChatFrame(
              bytes,
              stream.peerId,
              cipher
            );

            if (guardSensitive()) {
              stream.reset();

              return;
            }

            sessions.opened(stream);
            const contact = yield* sessions.verify(stream, frame.fromHandle);

            if (guardSensitive() || !sessions.isVerified(stream, contact.qid)) {
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
              out.log(`@${frame.fromHandle}: ${frame.text}`);
            }
          });

    const handleInbound = inboundProgram.pipe(
      Effect.tapError((error: CliOutboxStoreError | Error) =>
        Effect.sync(() => {
          if (error instanceof CliOutboxStoreError) {
            out.error(describeCliOutboxStoreError(error));

            return;
          }

          if (error.message.startsWith("Inbound ")) {
            out.error(error.message);
          }
        })
      ),
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => {
              stream.reset();
            })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (stream.protocolId === SYNC_PROTOCOL) {
            syncInbound -= 1;
          }
        })
      )
    );

    runHandler(
      stream.protocolId === CHAT_PROTOCOL
        ? chatInbound.withPermits(1)(handleInbound)
        : handleInbound
    );
  });

  let mailboxPollInFlight = false;

  const pollMailboxes = () => {
    if (mailboxes.length === 0 || mailboxPollInFlight || guardSensitive()) {
      return;
    }

    mailboxPollInFlight = true;

    runHandler(
      Effect.forEach(
        mailboxes,
        (peer) =>
          drainMailbox({
            cipher,
            onMessage: async (frame, meta) => {
              if (guardSensitive()) {
                return "abort";
              }

              const lookupResult = await Effect.runPromise(
                reader.lookupDeviceKey(meta.senderDeviceKey).pipe(Effect.result)
              );

              if (lookupResult._tag === "Failure") {
                return "retry";
              }

              const senderAccount = lookupResult.success;

              if (!senderAccount || senderAccount.handle !== frame.fromHandle) {
                // Revoked sender or forged handle: drop from mailbox.
                return "ack";
              }

              const record: InboxRecordV1 = {
                frame,
                fromQid: senderAccount.qid.toString(),
                receivedAt: Date.now(),
                v: 1,
              };

              const persisted = await Effect.runPromise(
                messages.putInbox(record).pipe(Effect.result)
              );

              if (persisted._tag === "Failure") {
                out.error(describeCliOutboxStoreError(persisted.failure));

                // Drop deterministic conflicts so they cannot head-of-line block.
                return persisted.failure.operation === "conflict"
                  ? "ack"
                  : "retry";
              }

              if (persisted.success.inserted) {
                out.log(`@${frame.fromHandle}: ${frame.text}`);
              }

              return "ack";
            },
            openStream: () => openMailboxStream(peer),
          }).pipe(Effect.ignore),
        { concurrency: "unbounded" }
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            mailboxPollInFlight = false;
          })
        )
      )
    );
  };

  const mailboxPollTimer =
    mailboxes.length > 0
      ? setInterval(() => {
          pollMailboxes();
        }, 15_000)
      : null;

  return yield* Effect.gen(function* () {
    out.log(
      `CLI messaging ready for @${identity.handle} (${identity.peerId}).`
    );
    out.log(
      "SIGCONT, stall observe, and verify-boundary invalidation are armed."
    );

    pollMailboxes();
    yield* outbox.resume();

    if (options.to && options.message) {
      if (guardSensitive()) {
        out.error("Authorization was invalidated. Try sending again.");
      } else {
        const recipient = yield* reader.lookupHandle(options.to);

        if (recipient) {
          yield* outbox.enqueue(
            newOutboxRecord({
              frame: {
                fromHandle: identity.handle,
                id: crypto.randomUUID(),
                sentAt: Date.now(),
                text: options.message,
                v: 1,
              },
              now: Date.now(),
              toHandle: recipient.handle,
              toQid: recipient.qid.toString(),
            })
          );
        } else {
          out.error(`Account @${options.to} was not found.`);
        }
      }
    }

    return yield* outbox.run;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (mailboxPollTimer) {
          clearInterval(mailboxPollTimer);
        }
      })
    )
  );
});

export const runStart = Effect.fn("qop.start")(function* (
  store: ReturnType<typeof createCliIdentityStore>,
  options: {
    readonly message?: string | undefined;
    readonly to?: string | undefined;
  }
) {
  if (!isMessagingLifecycleAllowed()) {
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
  // verify/send boundary. A verified Mac software-sleep was caught by stall
  // observe (monotonic advanced with wall; sleep-gap and SIGCONT did not fire).
  return yield* withMessagingLifecycle(
    () => {
      sessions.invalidateAuthorization();
    },
    (lifecycle) =>
      Effect.gen(function* () {
        const messages = yield* openCliOutboxStore(store.root);
        const secretKey = yield* store.loadSecret();
        const relays = cliRelays();
        const mailboxes = cliMailboxes();

        const chatConfig = {
          agentVersion: "qop-cli/0.1.0",
          inboundStreamLimits: { [CHAT_PROTOCOL]: MAX_INBOUND_STREAMS },
          protocols: [CHAT_PROTOCOL, SYNC_PROTOCOL, MAILBOX_PROTOCOL],
          secretKey,
        };

        const endpoint = Minip2p.create(
          relays.length > 0 ? { ...chatConfig, relays } : chatConfig
        );

        return yield* createHolder({
          cipher: createChatCipher(secretKey),
          connectAddrs: (addrs, opts) => endpoint.connect(addrs, opts),
          endpoint,
          identity,
          lifecycle,
          mailboxes,
          messages,
          options,
          out: {
            error: (line) => {
              console.error(line);
            },
            log: (line) => {
              console.log(line);
            },
          },
          reader,
          sessions,
        }).pipe(Effect.ensuring(Effect.sync(() => endpoint.close())));
      })
  );
});
