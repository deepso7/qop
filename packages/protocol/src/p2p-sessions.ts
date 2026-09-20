import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import { Data, Effect, Schema, Semaphore } from "effect";

import type { SessionContact, SessionContactInput } from "./contacts.ts";
import type {
  RegistryAccount,
  RegistryReaderError,
} from "./registry-reader.ts";

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
  readonly contact: SessionContact;
  readonly deviceKey: string;
}

interface PeerSession extends PeerConnection {
  authorization?: AuthorizedContact;
  /** Last confirmed registry head. Survives stale-block reject and resume invalidate. */
  lastConfirmedBlockNumber?: bigint;
  readonly semaphore: Semaphore.Semaphore;
  /** Bumped by invalidateAuthorization so in-flight verify cannot write auth. */
  verifyEpoch: number;
}

interface PeerSessionDependencies {
  readonly getContactByQid: (qid: string) => Promise<SessionContact | null>;
  readonly lookupDeviceKey: (
    deviceKey: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  readonly lookupHandle: (
    handle: string
  ) => Effect.Effect<RegistryAccount | null, RegistryReaderError>;
  /** Monotonic elapsed-time clock (e.g. performance.now). */
  readonly now?: () => number;
  /** Own account qid. Verify must not insert this identity as a chat contact. */
  readonly ownQid?: () => string | undefined;
  readonly upsertContact: (contact: SessionContactInput) => Promise<void>;
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
  ownQid,
  upsertContact,
}: PeerSessionDependencies) => {
  const sessions = new Map<number, PeerSession>();

  // Resume invalidation must cancel in-flight verify writers.
  let verifyEpoch = 0;

  // Safe to call from a live stream when connectionEstablished has not arrived
  // yet. Same connId+peerId keeps cached authorization; a reused connId with a
  // different peer replaces the session.
  const opened = (connection: PeerConnection) => {
    const existing = sessions.get(connection.connId);
    if (existing?.peerId === connection.peerId) {
      return;
    }
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
   * Preserve lastConfirmedBlockNumber — a stuck/cached RPC replaying the same
   * membership must not mint another MAX_AUTH_AGE_MS after resume. Re-auth
   * requires freshness === "fresh" and a strictly newer live head.
   */
  const invalidateAuthorization = () => {
    verifyEpoch += 1;
    for (const session of sessions.values()) {
      delete session.authorization;
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
                delete session.authorization;
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
              delete session.authorization;
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
              delete session.authorization;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            // Only a fresh chain membership read may reset the live-auth window.
            // Stale/cached RPC success must not mint another MAX_AUTH_AGE_MS.
            if (account.freshness !== "fresh") {
              delete session.authorization;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            // Same or older block is not a new live confirmation — including
            // after resume. Freshness history survives invalidate, so a stuck
            // RPC replaying the old membership cannot remint auth age.
            // Require freshness === "fresh" (above) AND a strictly newer head.
            const priorBlock = session.lastConfirmedBlockNumber;
            if (priorBlock !== undefined && account.blockNumber <= priorBlock) {
              delete session.authorization;
              return yield* new PeerVerificationError({
                operation: "identity",
              });
            }
            // Auth window starts at registry confirmation, not after storage.
            // Slow DB/upsert must not stretch live auth past MAX_AUTH_AGE_MS.
            const confirmedAtMs = now();
            const fresh: SessionContactInput = {
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
            // Own devices share this qid. They are not chat contacts.
            yield* Effect.tryPromise({
              catch: () => new PeerVerificationError({ operation: "storage" }),
              try: () =>
                ownQid?.() === fresh.qid
                  ? Promise.resolve()
                  : upsertContact(fresh),
            });
            if (!isCurrent(session) || session.verifyEpoch !== epochAtStart) {
              return yield* new PeerVerificationError({ operation: "closed" });
            }
            // Second authorized device is roster noise, not keyChanged.
            const contact: SessionContact = {
              ...fresh,
              keyChanged: known?.keyChanged ?? false,
              lastReadAt: known?.lastReadAt ?? 0,
            };
            session.lastConfirmedBlockNumber = account.blockNumber;
            session.authorization = {
              confirmedAtMs,
              confirmedBlockNumber: account.blockNumber,
              contact,
              deviceKey: deviceKeyHex,
            };
            return contact;
          })
        );
      })
  );

  const authorizedPeerIds = (
    contact: Pick<SessionContact, "handle" | "qid">
  ) => {
    const peerIds: string[] = [];
    const seen = new Set<string>();
    for (const session of sessions.values()) {
      const { authorization } = session;
      if (
        authorization &&
        authorization.contact.qid === contact.qid &&
        authorization.contact.handle === contact.handle &&
        authAgeMs(authorization) < MAX_AUTH_AGE_MS &&
        !seen.has(session.peerId)
      ) {
        seen.add(session.peerId);
        peerIds.push(session.peerId);
      }
    }
    return peerIds;
  };

  const rosterPeerIds = (
    devices: readonly { readonly peerId: string }[]
  ): string[] => {
    const peerIds: string[] = [];
    const seen = new Set<string>();
    const push = (peerId: string) => {
      if (seen.has(peerId)) {
        return;
      }
      seen.add(peerId);
      peerIds.push(peerId);
    };
    for (const session of sessions.values()) {
      if (devices.some((device) => device.peerId === session.peerId)) {
        push(session.peerId);
      }
    }
    for (const device of devices) {
      push(device.peerId);
    }
    return peerIds;
  };

  /** Live auth first, then the rest of the roster. Lookup failure keeps live auth only. */
  const recipientPeerIds = Effect.fn("PeerSessions.recipientPeerIds")(
    function* (
      contact: Pick<SessionContact, "handle" | "qid">,
      // Dial hints only. Authorization still comes from verify's own
      // lookupDeviceKey at a fresh, strictly-newer head with the 60 s window.
      // Do not pass the account into verify; do not use it to extend or seed
      // the auth cache.
      accountHint?: RegistryAccount
    ) {
      const authorized = authorizedPeerIds(contact);
      const lookedUp = accountHint
        ? { _tag: "Success" as const, success: accountHint }
        : yield* lookupHandle(contact.handle).pipe(
            Effect.mapError(mapLookupError),
            Effect.result
          );
      if (lookedUp._tag === "Failure") {
        if (authorized.length > 0) {
          return authorized;
        }
        return yield* lookedUp.failure;
      }
      const account = lookedUp.success;
      if (
        !account ||
        account.handle !== contact.handle ||
        account.qid.toString() !== contact.qid ||
        account.devices.length === 0
      ) {
        if (authorized.length > 0) {
          return authorized;
        }
        return yield* new PeerVerificationError({ operation: "identity" });
      }
      const seen = new Set(authorized);
      const peerIds = [...authorized];
      for (const peerId of rosterPeerIds(account.devices)) {
        if (seen.has(peerId)) {
          continue;
        }
        seen.add(peerId);
        peerIds.push(peerId);
      }
      if (peerIds.length === 0) {
        return yield* new PeerVerificationError({ operation: "identity" });
      }
      return peerIds;
    }
  );

  const recipientPeerId = Effect.fn("PeerSessions.recipientPeerId")(function* (
    contact: Pick<SessionContact, "handle" | "qid">
  ) {
    const [peerId] = yield* recipientPeerIds(contact);
    if (!peerId) {
      return yield* new PeerVerificationError({ operation: "identity" });
    }
    return peerId;
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
    recipientPeerIds,
    verify,
  };
};
