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
  RegistryAccount,
  RegistryReaderError,
  SessionContact,
  SessionContactInput,
} from "@qop/protocol";
import { Effect, FiberSet, Schema } from "effect";

import { CliConfigError, cliRelays, configuredRegistry } from "./config.ts";
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
  let claimed = false;
  let claimedStream: ChatStream | undefined;
  const dial = (peerId: string) =>
    Effect.uninterruptibleMask((restore) =>
      restore(
        openAuthorizedChatStream(transport, sessions, peerId, recipient)
      ).pipe(
        Effect.flatMap((stream) =>
          Effect.suspend(() => {
            if (claimed) {
              stream.reset();
              return Effect.fail(
                new CliOutboxDeliverError({ operation: "transport" })
              );
            }
            claimed = true;
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
    Effect.mapError(asDeliverError),
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

const decodeInboundChatFrame = (bytes: Uint8Array) =>
  Effect.try({
    catch: () => new Error(UNREADABLE_INBOUND_CHAT),
    try: () => decodeFrame(bytes),
  });

/**
 * Holder wiring: inbound dispatch, outbox flush, and FiberSet handlers.
 * FiberSet is acquired here so LIFO finalizers interrupt (and await) those
 * fibers before the caller's `messages.db` close.
 */
export const createHolder = Effect.fn("qop.createHolder")(function* ({
  endpoint,
  identity,
  lifecycle,
  messages,
  options = {},
  out,
  reader,
  sessions,
}: {
  readonly endpoint: HolderEndpoint;
  readonly identity: HolderIdentity;
  readonly lifecycle: ArmedProcessLifecycle;
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

  const runHandler = yield* FiberSet.makeRuntime();
  let inbound = 0;
  const outbox = yield* createOutboxRuntime({
    deliver: (record, account) => {
      if (guardSensitive()) {
        return Effect.fail(
          new CliOutboxDeliverError({ operation: "unauthorized" })
        );
      }
      return deliverChatFrame(
        endpoint,
        sessions,
        { handle: record.toHandle, qid: record.toQid },
        record.frame,
        account
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
              try: () => readUntilEof(() => stream.read()),
            }).pipe(
              Effect.timeoutOrElse({
                duration: INBOUND_READ_TIMEOUT_MS,
                orElse: () =>
                  Effect.fail(new Error("Inbound chat read timed out")),
              })
            );
            const frame = yield* decodeInboundChatFrame(bytes);
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
    runHandler(
      inboundProgram.pipe(
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
            inbound -= 1;
          })
        )
      )
    );
  });

  out.log(`CLI messaging ready for @${identity.handle} (${identity.peerId}).`);
  out.log(
    "SIGCONT, stall observe, and verify-boundary invalidation are armed."
  );

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

  yield* outbox.run;
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
        const chatConfig = {
          agentVersion: "qop-cli/0.1.0",
          protocols: [CHAT_PROTOCOL, SYNC_PROTOCOL],
          secretKey,
        };
        const endpoint = Minip2p.create(
          relays.length > 0 ? { ...chatConfig, relays } : chatConfig
        );
        return yield* createHolder({
          endpoint,
          identity,
          lifecycle,
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
