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
  readonly operation: "closed" | "identity" | "rpc" | "storage";
}> {}

/** Max authorization age while running (monotonic elapsed ms). */
export const MAX_AUTH_AGE_MS = 60_000;

interface AuthorizedContact {
  readonly confirmedAtMs: number;
  readonly confirmedBlockNumber: bigint;
  readonly contact: Contact;
  readonly deviceKey: string;
}

interface PeerSession extends PeerConnection {
  authorization?: AuthorizedContact;
  /** Last confirmed registry head. Kept on stale-block reject; cleared on resume. */
  lastConfirmedBlockNumber?: bigint;
  readonly semaphore: Semaphore.Semaphore;
  /** Bumped by invalidateAuthorization so in-flight verify cannot write auth. */
  verifyEpoch: number;
}

interface PeerSessionDependencies {
  readonly getContactByQid: (qid: string) => Promise<Contact | null>;
  readonly lookupDeviceKey: (
    deviceKey: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly lookupHandle: (
    handle: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  /** Monotonic elapsed-time clock (e.g. performance.now). */
  readonly now?: () => number;
  readonly upsertContact: (contact: ContactInput) => Promise<void>;
}

const mapLookupError = (error: RegistryReaderError) =>
  new PeerVerificationError({
    operation: error.operation === "rpc" ? "rpc" : "identity",
  });

// Authorization belongs to one live transport connection, never to a persisted contact.
export const createPeerSessions = ({
  getContactByQid,
  lookupDeviceKey,
  lookupHandle,
  now = () => performance.now(),
  upsertContact,
}: PeerSessionDependencies) => {
  const sessions = new Map<number, PeerSession>();

  // Resume invalidation must cancel in-flight verify writers.
  let verifyEpoch = 0;

  const opened = (connection: PeerConnection) => {
    sessions.set(connection.connId, {
      ...connection,
      semaphore: Semaphore.makeUnsafe(1),
      verifyEpoch,
    });
  };
  const closed = ({ connId, peerId }: PeerConnection) => {
    if (sessions.get(connId)?.peerId === peerId) {
      sessions.delete(connId);
    }
  };
  const clear = () => sessions.clear();

  /** Invalidate cached authorization on resume; keep connections open.
   * Also clear remembered head so a fresh live confirm of the *current*
   * chain head may restore auth (same blockNumber is allowed). Age-expiry
   * reject keeps lastConfirmedBlockNumber so a stuck head cannot remint 60s.
   */
  const invalidateAuthorization = () => {
    verifyEpoch += 1;
    for (const session of sessions.values()) {
      session.authorization = undefined;
      session.lastConfirmedBlockNumber = undefined;
      session.verifyEpoch = verifyEpoch;
    }
  };

  const isCurrent = (session: PeerSession) =>
    sessions.get(session.connId) === session;

  const authAgeMs = (authorization: AuthorizedContact) =>
    now() - authorization.confirmedAtMs;

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

            const epochAtStart = session.verifyEpoch;

            const cached = session.authorization;
            if (cached) {
              if (cached.contact.handle !== handle) {
                session.authorization = undefined;
                return yield* new PeerVerificationError({
                  operation: "identity",
                });
              }
              if (authAgeMs(cached) < MAX_AUTH_AGE_MS) {
                return cached.contact;
              }
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
            const account = yield* lookupDeviceKey(deviceKeyHex).pipe(
              Effect.mapError(mapLookupError)
            );
            // Active membership under the claimed handle — not a single primary peerId.
            if (!account || account.handle !== handle) {
              session.authorization = undefined;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            const membership = account.devices.some(
              (device) =>
                device.deviceKey === deviceKeyHex &&
                device.peerId === connection.peerId
            );
            if (!membership) {
              session.authorization = undefined;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            // Only a fresh chain membership read may reset the live-auth window.
            // Stale/cached RPC success must not mint another MAX_AUTH_AGE_MS.
            if (account.freshness !== "fresh") {
              session.authorization = undefined;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            // Same or older block is not a new confirmation — stuck/cached
            // heads must not mint another MAX_AUTH_AGE_MS window.
            // Freshness history lives on the session, not only on authorization,
            // so rejecting a stale block cannot erase the remembered head.
            const priorBlock = session.lastConfirmedBlockNumber;
            if (
              priorBlock !== undefined &&
              account.blockNumber <= priorBlock
            ) {
              session.authorization = undefined;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            const fresh: ContactInput = {
              createdAt: Number(account.registeredAt) * 1000,
              deviceKey: deviceKeyHex,
              handle: account.handle,
              owner: account.owner,
              peerId: connection.peerId,
              qid: account.qid.toString(),
            };
            const known = yield* Effect.tryPromise({
              catch: () => new PeerVerificationError({ operation: "storage" }),
              try: () => getContactByQid(fresh.qid),
            });
            if (!isCurrent(session) || session.verifyEpoch !== epochAtStart) {
              return yield* new PeerVerificationError({ operation: "closed" });
            }
            yield* Effect.tryPromise({
              catch: () => new PeerVerificationError({ operation: "storage" }),
              try: () => upsertContact(fresh),
            });
            if (!isCurrent(session) || session.verifyEpoch !== epochAtStart) {
              return yield* new PeerVerificationError({ operation: "closed" });
            }
            // Second authorized device is roster noise, not keyChanged.
            const contact: Contact = {
              ...fresh,
              keyChanged: known?.keyChanged ?? false,
              lastReadAt: known?.lastReadAt ?? 0,
            };
            session.lastConfirmedBlockNumber = account.blockNumber;
            session.authorization = {
              confirmedAtMs: now(),
              confirmedBlockNumber: account.blockNumber,
              contact,
              deviceKey: deviceKeyHex,
            };
            return contact;
          })
        );
      })
  );

  const recipientPeerId = Effect.fn("PeerSessions.recipientPeerId")(function* (
    contact: Pick<Contact, "handle" | "qid">
  ) {
    for (const session of sessions.values()) {
      const authorization = session.authorization;
      if (
        authorization &&
        authorization.contact.qid === contact.qid &&
        authorization.contact.handle === contact.handle &&
        authAgeMs(authorization) < MAX_AUTH_AGE_MS
      ) {
        return session.peerId;
      }
    }
    const account = yield* lookupHandle(contact.handle).pipe(
      Effect.mapError(mapLookupError)
    );
    if (
      !account ||
      account.handle !== contact.handle ||
      account.qid.toString() !== contact.qid ||
      account.devices.length === 0
    ) {
      return yield* new PeerVerificationError({ operation: "identity" });
    }
    // Prefer a live connected peer among active devices; else first active.
    for (const session of sessions.values()) {
      if (
        account.devices.some((device) => device.peerId === session.peerId)
      ) {
        return session.peerId;
      }
    }
    return account.devices[0].peerId;
  });

  const isVerified = ({ connId, peerId }: PeerConnection, qid: string) => {
    const session = sessions.get(connId);
    const authorization = session?.authorization;
    return (
      session?.peerId === peerId &&
      authorization?.contact.qid === qid &&
      authAgeMs(authorization) < MAX_AUTH_AGE_MS
    );
  };

  return {
    clear,
    closed,
    invalidateAuthorization,
    isVerified,
    opened,
    recipientPeerId,
    verify,
  };
};
