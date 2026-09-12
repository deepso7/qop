import { Minip2p } from "@minip2p/node";
import {
  CHAT_PROTOCOL,
  createLifecycleAdapter,
  createPeerSessions,
  decodeAck,
  decodeFrame,
  encodeAck,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "@qop/protocol";
import type { SessionContact, SessionContactInput } from "@qop/protocol";
import { Effect } from "effect";

import { CliConfigError, cliRelays, configuredRegistry } from "./config.ts";
import type { createCliIdentityStore } from "./identity-store.ts";

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

  const lifecycle = createLifecycleAdapter({
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
  });
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
  const invalidateIfNeeded = () => {
    if (lifecycle.takeInvalidation()) {
      sessions.invalidateAuthorization();
    }
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
  const closeEndpoint = Effect.sync(() => {
    endpoint.close();
  });

  const program = Effect.gen(function* () {
    lifecycle.observe();
    endpoint.on("connectionEstablished", (connection) => {
      sessions.opened(connection);
    });
    endpoint.on("connectionClosed", (connection) => {
      sessions.closed(connection);
    });
    endpoint.on("stream", (stream) => {
      if (stream.protocolId !== CHAT_PROTOCOL) {
        stream.reset();
        return;
      }
      Effect.runFork(
        Effect.gen(function* () {
          invalidateIfNeeded();
          const bytes = yield* Effect.tryPromise({
            catch: (cause) =>
              cause instanceof Error ? cause : new Error(String(cause)),
            try: () => readUntilEof(() => stream.read()),
          });
          const frame = decodeFrame(bytes);
          const contact = yield* sessions.verify(stream, frame.fromHandle);
          if (!sessions.isVerified(stream, contact.qid)) {
            stream.reset();
            return;
          }
          stream.write(encodeAck({ ack: frame.id, v: 1 }));
          stream.closeWrite();
          console.log(`@${frame.fromHandle}: ${frame.text}`);
        }).pipe(
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
    console.log("Lifecycle invalidation is armed for suspend/stall.");

    if (options.to && options.message) {
      invalidateIfNeeded();
      const recipient = yield* reader.lookupHandle(options.to);
      if (!recipient) {
        console.error(`Account @${options.to} was not found.`);
        return;
      }
      const frame = {
        fromHandle: identity.handle,
        id: crypto.randomUUID(),
        sentAt: Date.now(),
        text: options.message,
        v: 1 as const,
      };
      const peerId = yield* sessions.recipientPeerId({
        handle: recipient.handle,
        qid: recipient.qid.toString(),
      });
      if (!endpoint.connectedPeers().includes(peerId)) {
        yield* Effect.tryPromise({
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
          try: () => endpoint.connect(peerId, { timeoutMs: 15_000 }),
        });
      }
      const stream = yield* Effect.tryPromise({
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        try: () =>
          endpoint.openStream(peerId, CHAT_PROTOCOL, { timeoutMs: 15_000 }),
      });
      yield* sessions.verify(stream, recipient.handle);
      if (!sessions.isVerified(stream, recipient.qid.toString())) {
        stream.reset();
        console.error("Could not authorize a chat connection.");
        return;
      }
      stream.write(encodeFrame(frame));
      stream.closeWrite();
      const ackBytes = yield* Effect.tryPromise({
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        try: () => readUntilEof(() => stream.read()),
      });
      decodeAck(ackBytes);
      console.log(`Sent diagnostic message to @${recipient.handle}.`);
    }

    yield* Effect.never;
  });

  return yield* program.pipe(Effect.ensuring(closeEndpoint));
});
