import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import { Data, Effect, Schema, Semaphore } from "effect";

import type { Contact, ContactInput } from "./db";
import type { RegistryAccount, RegistryReaderError } from "./registry-core";

export interface PeerConnection {
  readonly connId: number;
  readonly peerId: string;
}

export class PeerVerificationError extends Data.TaggedError(
  "PeerVerificationError"
)<{
  readonly operation: "closed" | "identity" | "storage";
}> {}

interface PeerSession extends PeerConnection {
  contact?: Contact;
  readonly semaphore: Semaphore.Semaphore;
}

interface PeerSessionDependencies {
  readonly getContactByQid: (qid: string) => Promise<Contact | null>;
  readonly lookupDeviceKey: (
    deviceKey: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly lookupHandle: (
    handle: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly upsertContact: (contact: ContactInput) => Promise<void>;
}

// Authorization belongs to one live transport connection, never to a persisted contact.
export const createPeerSessions = ({
  getContactByQid,
  lookupDeviceKey,
  lookupHandle,
  upsertContact,
}: PeerSessionDependencies) => {
  const sessions = new Map<number, PeerSession>();

  const opened = (connection: PeerConnection) => {
    sessions.set(connection.connId, {
      ...connection,
      semaphore: Semaphore.makeUnsafe(1),
    });
  };
  const closed = ({ connId, peerId }: PeerConnection) => {
    if (sessions.get(connId)?.peerId === peerId) {
      sessions.delete(connId);
    }
  };
  const clear = () => sessions.clear();
  const isCurrent = (session: PeerSession) =>
    sessions.get(session.connId) === session;

  const verify = Effect.fn("PeerSessions.verify")(
    (connection: PeerConnection, handle: string) =>
      Effect.suspend(() => {
        const session = sessions.get(connection.connId);
        if (!session || session.peerId !== connection.peerId) {
          return Effect.fail(
            new PeerVerificationError({ operation: "closed" })
          );
        }
        return session.semaphore.withPermit(
          Effect.gen(function* () {
            if (!isCurrent(session)) {
              return yield* new PeerVerificationError({ operation: "closed" });
            }
            if (session.contact) {
              if (session.contact.handle !== handle) {
                return yield* new PeerVerificationError({
                  operation: "identity",
                });
              }
              return session.contact;
            }

            // Ground identity in the transport peerId, then assert the claimed handle.
            const peerId = yield* Schema.decodeUnknownEffect(PeerId)(
              connection.peerId
            ).pipe(
              Effect.mapError(
                () => new PeerVerificationError({ operation: "identity" })
              )
            );
            const deviceKey = yield* deviceKeyFromPeerId(peerId).pipe(
              Effect.mapError(
                () => new PeerVerificationError({ operation: "identity" })
              )
            );
            const deviceKeyHex = yield* Schema.encodeEffect(Hex32)(
              deviceKey
            ).pipe(
              Effect.mapError(
                () => new PeerVerificationError({ operation: "identity" })
              )
            );
            const account = yield* lookupDeviceKey(deviceKeyHex);
            if (
              !account ||
              account.handle !== handle ||
              account.peerId !== connection.peerId
            ) {
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            const fresh: ContactInput = {
              createdAt: Number(account.registeredAt) * 1000,
              deviceKey: account.deviceKey,
              handle: account.handle,
              owner: account.owner,
              peerId: account.peerId,
              qid: account.qid.toString(),
            };
            const known = yield* Effect.tryPromise({
              catch: () => new PeerVerificationError({ operation: "storage" }),
              try: () => getContactByQid(fresh.qid),
            });
            if (!isCurrent(session)) {
              return yield* new PeerVerificationError({ operation: "closed" });
            }
            yield* Effect.tryPromise({
              catch: () => new PeerVerificationError({ operation: "storage" }),
              try: () => upsertContact(fresh),
            });
            if (!isCurrent(session)) {
              return yield* new PeerVerificationError({ operation: "closed" });
            }
            const contact: Contact = {
              ...fresh,
              keyChanged: known
                ? known.keyChanged || known.deviceKey !== fresh.deviceKey
                : false,
              lastReadAt: known?.lastReadAt ?? 0,
            };
            session.contact = contact;
            return contact;
          })
        );
      })
  );

  const recipientPeerId = Effect.fn("PeerSessions.recipientPeerId")(function* (
    contact: Pick<Contact, "handle" | "qid">
  ) {
    for (const session of sessions.values()) {
      if (
        session.contact?.qid === contact.qid &&
        session.contact.handle === contact.handle
      ) {
        return session.peerId;
      }
    }
    const account = yield* lookupHandle(contact.handle);
    if (
      !account ||
      account.handle !== contact.handle ||
      account.qid.toString() !== contact.qid
    ) {
      return yield* new PeerVerificationError({ operation: "identity" });
    }
    return account.peerId;
  });

  const isVerified = ({ connId, peerId }: PeerConnection, qid: string) => {
    const session = sessions.get(connId);
    return session?.peerId === peerId && session.contact?.qid === qid;
  };

  return { clear, closed, isVerified, opened, recipientPeerId, verify };
};
