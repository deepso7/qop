import type {
  ConnectTarget,
  Minip2p,
  Path,
  Stream,
  Unsubscribe,
} from "@minip2p/react-native";
import { deviceKeyFromPeerId, Hex32, PeerId } from "@qop/identity";
import { PAIR_PROTOCOL, SYNC_PROTOCOL } from "@qop/protocol";
import type { SyncInboxItem } from "@qop/protocol";
import { Effect, Schema } from "effect";
import { create } from "zustand";
import type { StoreApi } from "zustand";

import {
  CHAT_PROTOCOL,
  createChatCipher,
  encodeAck,
  encodeFrame,
} from "./chat-wire";
import type { ChatCipher, ChatFrame } from "./chat-wire";
import {
  advanceMessageStatus,
  clearMessageRetryDeadline,
  expediteMessageRetries,
  failRejectedHandoff,
  getContactByHandle,
  getContactByPeerId,
  getContactByQid,
  getHolderInboxCursor,
  getMessageById,
  hasQueuedMessages,
  insertMessage,
  listOutgoingPending,
  markMessageHeld,
  recordMessageRetry,
  resetHolderInboxCursor,
  retryFailedMessage,
  setHolderInboxCursor,
  upsertContact,
} from "./db";
import type { Contact, MessageInput, StoredMessage } from "./db";
import type { loadDeviceSecretKey } from "./identity-vault";
import { createMobileOutbox } from "./mobile-outbox";
import type { DeliveryOutcome } from "./mobile-outbox";
import { readVerifiedChat } from "./p2p-receive";
import { isTerminalSendError, withTimeout } from "./p2p-send";
import type { performSend } from "./p2p-send";
import { createPeerSessions } from "./p2p-sessions";
import type { PeerConnection } from "./p2p-sessions";
import {
  HANDOFF_REJECTED_MESSAGE,
  HandoffUndeliveredError,
  orderHolderPeerIds,
  otherOwnDevicePeerIds,
  outgoingHandoffRecord,
} from "./p2p-sync";
import type {
  OwnDevice,
  performCatchup,
  performHandoff,
  performPoll,
  PerformSyncInput,
} from "./p2p-sync";
import type { lookupDeviceKey, lookupHandle, lookupQid } from "./registry";

/** The local endpoint's lifecycle. Peer data exists only while running. */
export type P2pConnection =
  | { readonly status: "starting" | "stopped" }
  | {
      readonly status: "running";
      /** Peers that finished Identify (usable for streams), not just connected. */
      readonly connectedPeerIds: readonly string[];
      /** Transport path (direct, hole-punched, relayed) per connected peer. */
      readonly peerPaths: Readonly<Record<string, Path>>;
      readonly relayReserved: boolean;
    }
  | { readonly status: "failed"; readonly reason: string };

type RunningConnection = Extract<P2pConnection, { status: "running" }>;

interface P2pState {
  readonly connection: P2pConnection;
  /** Bumped whenever stored chat data changes; screens reload on it. */
  readonly revision: number;
}

interface P2pActions {
  readonly connectTo: (
    contact: Pick<Contact, "handle" | "qid">
  ) => Promise<string | undefined>;
  /** Drop the session holder cache after own-device membership changes. */
  readonly invalidateOwnHolders: () => void;
  readonly openPairingStream: (peerId: string) => Promise<
    | {
        readonly closeWrite: () => void;
        readonly peerId: string;
        readonly protocolId: string;
        readonly read: () => Promise<Uint8Array | undefined>;
        readonly reset: () => void;
        readonly write: (data: Uint8Array) => Promise<void>;
      }
    | undefined
  >;
  readonly pairConnect: (
    target: ConnectTarget
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly pairWaitPeerReady: (peerId: string) => Promise<void>;
  readonly retryMessage: (id: string, contactQid?: string) => Promise<void>;
  readonly sendMessage: (contact: Contact, text: string) => string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

type P2pStore = P2pActions & P2pState;

const initialState: P2pState = {
  connection: { status: "stopped" },
  revision: 0,
};

export type P2pEndpoint = Pick<
  Minip2p,
  | "activeReservation"
  | "close"
  | "connectedPeers"
  | "connect"
  | "disconnect"
  | "isPeerReady"
  | "on"
  | "onClose"
  | "openStream"
  | "path"
  | "waitPeerReady"
>;

interface P2pDependencies {
  readonly createEndpoint: (options: Parameters<typeof Minip2p.create>[0]) => {
    readonly endpoint: P2pEndpoint;
    readonly bindAppState: () => Unsubscribe;
  };
  readonly getIdentityHandle: () => string | undefined;
  readonly loadDeviceSecretKey: typeof loadDeviceSecretKey;
  readonly lookupDeviceKey: typeof lookupDeviceKey;
  readonly lookupHandle: typeof lookupHandle;
  readonly lookupQid?: typeof lookupQid;
  readonly performCatchup?: typeof performCatchup;
  readonly performHandoff?: typeof performHandoff;
  readonly performPoll?: typeof performPoll;
  readonly performSend: typeof performSend;
  readonly getOwnDevice?: () => OwnDevice | undefined;
  readonly randomUUID: () => string;
  /** Called when the app resumes from background/suspend; invalidate live auth. */
  readonly subscribeAppResume?: (onResume: () => void) => Unsubscribe;
}

const errorMessage = (error: Error | string) =>
  error instanceof Error ? error.message : String(error);

const holderRosterChanged = (
  previous: readonly string[] | undefined,
  next: readonly string[]
) =>
  previous === undefined ||
  previous.length !== next.length ||
  previous.some((id) => !next.includes(id));

const isValidChatFrame = (frame: ChatFrame) => {
  try {
    encodeFrame(frame);

    return true;
  } catch {
    return false;
  }
};

const recordRetryOutcome = async (
  message: Pick<StoredMessage, "contactQid" | "id">,
  wasExpedited: () => boolean
): Promise<DeliveryOutcome> => {
  const retryAt = await recordMessageRetry(
    message.id,
    message.contactQid,
    wasExpedited()
  );

  if (retryAt === null) {
    const current = await getMessageById(message.id, message.contactQid);

    return current?.status === "sent" || current?.status === "held"
      ? { kind: "delivered" }
      : { kind: "failed" };
  }

  // Re-check after the DB write: a peer wake arriving mid-write may have been overwritten.
  if (retryAt > 0 && wasExpedited()) {
    try {
      await clearMessageRetryDeadline(message.id, message.contactQid, retryAt);

      return { kind: "retry", nextAttemptAt: 0 };
    } catch {
      // Preserve the committed retry without double-incrementing attempts.
      return { kind: "retry", nextAttemptAt: retryAt };
    }
  }

  return { kind: "retry", nextAttemptAt: retryAt };
};

const uninitializedSetState: StoreApi<P2pStore>["setState"] = () => {
  throw new Error("P2P store used before initialization");
};

export const createP2pStore = ({
  createEndpoint,
  getIdentityHandle,
  getOwnDevice,
  loadDeviceSecretKey,
  lookupDeviceKey,
  lookupHandle,
  lookupQid,
  performCatchup,
  performHandoff,
  performPoll,
  performSend,
  randomUUID,
  subscribeAppResume,
}: P2pDependencies) => {
  let endpoint: P2pEndpoint | undefined;
  let chatCipher: ChatCipher | undefined;
  let unsubscribe: Unsubscribe[] = [];
  let generation = 0;
  const inFlightJobs = new Set<Promise<unknown>>();
  /** Peer IDs currently dialed by outbox sends/handoffs -> originating message keys. */
  const outboxDialingPeers = new Map<string, Set<string>>();
  let outbox: ReturnType<typeof createMobileOutbox> | undefined;

  let cachedHolderPeerIds: readonly string[] | undefined;
  /** Last adopted roster; survives invalidation so a failed re-read can use it. */
  let lastKnownHolderPeerIds: readonly string[] | undefined;
  let holderLookup: Promise<readonly string[] | undefined> | undefined;

  let holderDiscoverLookup:
    | {
        readonly peerId: string;
        readonly promise: Promise<readonly string[] | undefined>;
      }
    | undefined;

  let holderCacheEpoch = 0;
  /** Connect-path peers absent from a successful roster read this epoch. */
  const holderDiscoverMisses = new Set<string>();
  let scheduledReconcile: Promise<void> | undefined;
  let queuedReconcile = false;
  let reconcileSeq = 0;

  const sessions = createPeerSessions({
    getContactByQid,
    lookupDeviceKey,
    lookupHandle,
    ownQid: () => getOwnDevice?.()?.qid,
    upsertContact,
  });

  const isCurrentGeneration = (jobGeneration: number) =>
    generation === jobGeneration;

  const trackJob = <A>(job: Promise<A>) => {
    inFlightJobs.add(job);

    const removeWhenDone = async () => {
      await Promise.allSettled([job]);
      inFlightJobs.delete(job);
    };

    void removeWhenDone();

    return job;
  };

  const cleanupEndpoint = (activeEndpoint: P2pEndpoint | undefined) => {
    outbox?.close();
    outbox = undefined;
    outboxDialingPeers.clear();
    sessions.clear();
    holderCacheEpoch += 1;
    cachedHolderPeerIds = undefined;
    lastKnownHolderPeerIds = undefined;
    holderLookup = undefined;
    holderDiscoverLookup = undefined;
    holderDiscoverMisses.clear();
    scheduledReconcile = undefined;
    queuedReconcile = false;
    reconcileSeq += 1;
    const listeners = unsubscribe;
    unsubscribe = [];

    for (const removeListener of listeners) {
      removeListener();
    }

    if (endpoint === activeEndpoint) {
      endpoint = undefined;
      chatCipher = undefined;
    }
  };

  const waitForInFlightJobs = async () => {
    if (inFlightJobs.size === 0) {
      return;
    }

    try {
      const settleJobs = async () => {
        await Promise.allSettled(inFlightJobs);
      };

      await withTimeout(settleJobs(), 5000, "Timed out stopping P2P jobs");
    } catch {
      // Stopping is capped so a stalled native stream cannot block identity reset.
    }
  };

  // Bridge so helpers can call setState before create() returns the hook.
  interface P2pStoreBridge {
    setState: StoreApi<P2pStore>["setState"];
  }

  const storeBridge = {
    setState: uninitializedSetState,
  } satisfies P2pStoreBridge;

  const receiveChatStream = async (
    stream: Stream,
    jobGeneration: number,
    cipher: ChatCipher
  ): Promise<void> => {
    try {
      if (isCurrentGeneration(jobGeneration)) {
        sessions.opened(stream);
      }

      const received = await readVerifiedChat(
        stream,
        (connection, fromHandle) =>
          isCurrentGeneration(jobGeneration)
            ? Effect.runPromise(sessions.verify(connection, fromHandle))
            : Promise.resolve(null),
        10_000,
        cipher
      );

      if (
        !received ||
        !isCurrentGeneration(jobGeneration) ||
        !sessions.isVerified(stream, received.contact.qid)
      ) {
        stream.reset();

        return;
      }

      const { contact, frame } = received;

      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }

      await insertMessage({
        contactQid: contact.qid,
        direction: "in",
        id: frame.id,
        sentAt: frame.sentAt,
        status: "received",
        text: frame.text,
      });

      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }

      await stream.write(encodeAck({ ack: frame.id, v: 1 }));
      stream.closeWrite();
      storeBridge.setState((state) => ({ revision: state.revision + 1 }));
    } catch {
      stream.reset();
    }
  };

  const handoffJobs = new Map<string, Promise<string | undefined>>();

  const invalidateOwnHolderPeerIds = () => {
    holderCacheEpoch += 1;
    cachedHolderPeerIds = undefined;
    holderLookup = undefined;
    holderDiscoverLookup = undefined;
    holderDiscoverMisses.clear();
  };

  const adoptOwnHolderPeerIds = (
    ids: readonly string[] | undefined,
    epoch: number
  ) => {
    // Empty means no other own device yet. Do not cache it — a CLI
    // linked later must be visible to handoff/reconcile without resume.
    if (!ids || ids.length === 0 || epoch !== holderCacheEpoch) {
      return;
    }

    const previous = cachedHolderPeerIds;
    cachedHolderPeerIds = ids;
    lastKnownHolderPeerIds = ids;

    if (holderRosterChanged(previous, ids)) {
      holderDiscoverMisses.clear();
    } else {
      for (const id of ids) {
        holderDiscoverMisses.delete(id);
      }
    }
  };

  const readOwnHolderPeerIds = async (jobGeneration: number) => {
    const own = getOwnDevice?.();

    if (!own) {
      return;
    }

    const account = await Effect.runPromise(lookupHandle(own.handle));

    if (!isCurrentGeneration(jobGeneration)) {
      return;
    }

    if (!account || account.qid.toString() !== own.qid) {
      return;
    }

    return otherOwnDevicePeerIds(own.peerId, account.devices);
  };

  const loadOwnHolderPeerIds = () => {
    if (cachedHolderPeerIds !== undefined) {
      return Promise.resolve(cachedHolderPeerIds);
    }

    if (holderLookup) {
      return holderLookup;
    }

    const jobGeneration = generation;
    const epoch = holderCacheEpoch;
    holderLookup = (async () => {
      try {
        const ids = await readOwnHolderPeerIds(jobGeneration);
        adoptOwnHolderPeerIds(ids, epoch);

        return ids;
      } catch (error) {
        // Reconcile re-reads the roster every run; a registry blip must not
        // stall re-homing and catch-up. Not cached, so the next call retries.
        if (lastKnownHolderPeerIds !== undefined) {
          return lastKnownHolderPeerIds;
        }

        throw error;
      } finally {
        if (epoch === holderCacheEpoch) {
          holderLookup = undefined;
        }
      }
    })();

    return holderLookup;
  };

  const ownHolderPeerIds = async (activeEndpoint: P2pEndpoint) => {
    const connected = activeEndpoint.connectedPeers();
    const hadCachedRoster = cachedHolderPeerIds !== undefined;
    const loaded = (await loadOwnHolderPeerIds()) ?? [];

    if (
      loaded.some((peerId) => connected.includes(peerId)) ||
      !hadCachedRoster
    ) {
      return loaded;
    }

    // Cached roster has no connected holder — a CLI linked since the last
    // lookup may be the only device that can take the handoff.
    invalidateOwnHolderPeerIds();

    return (await loadOwnHolderPeerIds()) ?? [];
  };

  const resolveHolderPeerIds = async (activeEndpoint: P2pEndpoint) =>
    orderHolderPeerIds(
      await ownHolderPeerIds(activeEndpoint),
      activeEndpoint.connectedPeers()
    );

  const hasConnectedCachedHolder = () => {
    const connected = endpoint?.connectedPeers() ?? [];

    return cachedHolderPeerIds?.some((id) => connected.includes(id)) === true;
  };

  /**
   * Own-device check for `connectionEstablished`. Transport connect is not
   * auth: strangers must not clear the session cache or spam the registry.
   * Skip lookup when a cached holder is connected. Otherwise probe this
   * peer (in-flight coalesced only for the same peerId). Record a miss
   * only after a successful roster read that did not include them, and
   * drop misses when the roster changes or enrollment invalidates.
   * Send/poll still refresh via `resolveHolderPeerIds`.
   */
  const isOwnHolderPeer = async (peerId: string): Promise<boolean> => {
    if (cachedHolderPeerIds?.includes(peerId) === true) {
      return true;
    }

    if (hasConnectedCachedHolder() || holderDiscoverMisses.has(peerId)) {
      return false;
    }

    const inflight = holderDiscoverLookup;

    if (inflight) {
      const ids = await inflight.promise;

      if (inflight.peerId === peerId) {
        return ids?.includes(peerId) === true;
      }

      if (ids?.includes(peerId) === true) {
        return true;
      }

      return isOwnHolderPeer(peerId);
    }

    const jobGeneration = generation;
    const epoch = holderCacheEpoch;

    const runDiscover = async () => {
      try {
        const ids =
          cachedHolderPeerIds === undefined
            ? await loadOwnHolderPeerIds()
            : await readOwnHolderPeerIds(jobGeneration);

        if (epoch !== holderCacheEpoch) {
          return ids;
        }

        adoptOwnHolderPeerIds(ids, epoch);

        return ids;
      } finally {
        if (
          epoch === holderCacheEpoch &&
          holderDiscoverLookup?.peerId === peerId
        ) {
          holderDiscoverLookup = undefined;
        }
      }
    };

    const promise = runDiscover();
    holderDiscoverLookup = { peerId, promise };
    const ids = await promise;

    if (ids?.includes(peerId) === true) {
      return true;
    }

    if (ids !== undefined && epoch === holderCacheEpoch) {
      holderDiscoverMisses.add(peerId);
    }

    return false;
  };

  /**
   * Hand `message` to a linked CLI and return the holder that took it.
   * A message whose holder is still linked goes back to that holder only
   * (idempotent on the CLI); switching CLIs could send Bob a second copy.
   */
  const handoffToHolder = (
    message: Pick<
      MessageInput,
      "contactQid" | "holderPeerId" | "id" | "sentAt" | "text"
    >,
    contact: Contact,
    jobGeneration: number,
    signal?: AbortSignal,
    syncEndpoint?: PerformSyncInput["endpoint"]
  ) => {
    const jobKey = `${message.contactQid}:${message.id}`;
    const existing = handoffJobs.get(jobKey);

    if (existing) {
      return existing;
    }

    const job = (async () => {
      const own = getOwnDevice?.();
      const activeEndpoint = endpoint;

      if (!own || !performHandoff || !activeEndpoint) {
        return;
      }

      const handoffEndpoint = syncEndpoint ?? activeEndpoint;

      const roster = await resolveHolderPeerIds(activeEndpoint);
      const current = message.holderPeerId;

      const holderPeerIds =
        current && roster.includes(current) ? [current] : roster;

      if (holderPeerIds.length === 0 || !isCurrentGeneration(jobGeneration)) {
        return;
      }

      const record = outgoingHandoffRecord({
        contact,
        fromHandle: own.handle,
        id: message.id,
        now: Date.now(),
        sentAt: message.sentAt,
        text: message.text,
      });

      try {
        encodeFrame(record.frame);
      } catch {
        throw new Error(HANDOFF_REJECTED_MESSAGE);
      }

      const tryHolder = async (index: number): Promise<string | undefined> => {
        const holderPeerId = holderPeerIds[index];

        if (
          holderPeerId === undefined ||
          !isCurrentGeneration(jobGeneration) ||
          signal?.aborted
        ) {
          return;
        }

        try {
          await performHandoff({
            composedBy: own.deviceKey,
            endpoint: handoffEndpoint,
            holderPeerId,
            own,
            record,
            sessions,
            signal,
            timeoutMs: 10_000,
          });

          return holderPeerId;
        } catch (error) {
          // Only fall through when this CLI never saw the request; after
          // that, a second holder would send Bob a duplicate.
          if (error instanceof HandoffUndeliveredError) {
            return tryHolder(index + 1);
          }

          if (
            signal?.aborted ||
            (error instanceof Error &&
              error.message === HANDOFF_REJECTED_MESSAGE)
          ) {
            throw error;
          }

          // Sent but the reply was lost: this CLI may hold it. Treat it as
          // held here; reconcile re-confirms with this holder while connected.
          return holderPeerId;
        }
      };

      return tryHolder(0);
    })();

    handoffJobs.set(jobKey, job);

    const removeWhenDone = async () => {
      await Promise.allSettled([job]);

      if (handoffJobs.get(jobKey) === job) {
        handoffJobs.delete(jobKey);
      }
    };

    void removeWhenDone();

    return job;
  };

  const applyReceipts = async (
    messages: readonly Pick<
      StoredMessage,
      "contactQid" | "holderPeerId" | "id"
    >[],
    jobGeneration: number
  ) => {
    const own = getOwnDevice?.();
    const activeEndpoint = endpoint;

    if (!own || !performPoll || !activeEndpoint || messages.length === 0) {
      return;
    }

    const needsFallback = messages.some((message) => !message.holderPeerId);

    const orderedHolders = needsFallback
      ? await resolveHolderPeerIds(activeEndpoint)
      : [];

    const [fallbackHolderPeerId] = orderedHolders;

    if (!isCurrentGeneration(jobGeneration)) {
      return;
    }

    const idsByHolder = new Map<string, string[]>();

    for (const message of messages) {
      const holderPeerId = message.holderPeerId ?? fallbackHolderPeerId;

      if (!holderPeerId) {
        continue;
      }

      const queued = idsByHolder.get(holderPeerId);

      if (queued) {
        queued.push(message.id);
      } else {
        idsByHolder.set(holderPeerId, [message.id]);
      }
    }

    await Promise.all(
      [...idsByHolder].map(async ([holderPeerId, ids]) => {
        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }

        // One offline holder must not abort reconcile: re-homing and inbox
        // catch-up for the other holders run after this.
        const receipts = await performPoll({
          endpoint: activeEndpoint,
          holderPeerId,
          ids,
          own,
          sessions,
          timeoutMs: 10_000,
        }).catch(() => []);

        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }

        await Promise.all(
          receipts.map((receipt) => {
            const row = messages.find(
              (message) =>
                message.id === receipt.id &&
                message.contactQid === receipt.toQid
            );

            return row
              ? advanceMessageStatus(row.id, "sent", row.contactQid)
              : Promise.resolve(false);
          })
        );
      })
    );
  };

  const ensureCatchupSender = async (
    record: SyncInboxItem["record"]
  ): Promise<"ready" | "retry" | "skip"> => {
    if (await getContactByQid(record.fromQid)) {
      return "ready";
    }

    if (!lookupQid) {
      return "retry";
    }

    const lookedUp = await Effect.runPromise(
      lookupQid(BigInt(record.fromQid)).pipe(Effect.result)
    );

    if (lookedUp._tag === "Failure") {
      return "retry";
    }

    const account = lookedUp.success;
    const device = account?.devices[0];

    if (
      !account ||
      !device ||
      account.handle !== record.frame.fromHandle ||
      account.qid.toString() !== record.fromQid
    ) {
      // Handle reassigned or no devices: skip so one row cannot stall the cursor.
      return "skip";
    }

    const handleOwner = await getContactByHandle(account.handle);

    if (handleOwner && handleOwner.qid !== record.fromQid) {
      // Stale local row still owns this handle, so UNIQUE(handle) would throw
      // on every retry. Live verify hits the same limit; skip and advance.
      return "skip";
    }

    // Storage errors throw: the cursor stays put and the next reconcile retries.
    await upsertContact({
      createdAt: Number(account.registeredAt) * 1000,
      deviceKey: device.deviceKey,
      handle: account.handle,
      owner: account.owner,
      peerId: device.peerId,
      qid: account.qid.toString(),
    });

    return "ready";
  };

  const pullHolderInbox = async (
    holderPeerId: string,
    jobGeneration: number
  ) => {
    const own = getOwnDevice?.();
    const activeEndpoint = endpoint;

    if (!own || !performCatchup || !activeEndpoint) {
      return;
    }

    let after = await getHolderInboxCursor(holderPeerId);
    let touched = false;

    const applyItems = async (
      items: readonly SyncInboxItem[],
      index: number
    ): Promise<boolean> => {
      const item = items[index];

      if (!item) {
        return true;
      }

      if (!isCurrentGeneration(jobGeneration) || item.seq <= after) {
        return false;
      }

      const sender = await ensureCatchupSender(item.record);

      if (sender === "retry") {
        return false;
      }

      if (sender === "ready") {
        await insertMessage({
          contactQid: item.record.fromQid,
          direction: "in",
          id: item.record.frame.id,
          sentAt: item.record.frame.sentAt,
          status: "received",
          text: item.record.frame.text,
        });
      }

      await setHolderInboxCursor(holderPeerId, item.seq);
      after = item.seq;
      touched = true;

      return applyItems(items, index + 1);
    };

    const pull = async (): Promise<void> => {
      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }

      const page = await performCatchup({
        after,
        endpoint: activeEndpoint,
        holderPeerId,
        own,
        sessions,
        timeoutMs: 10_000,
      });

      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }

      if (after > page.lastSeq) {
        // The CLI inbox was wiped and rowids restarted; replay it from 0.
        await resetHolderInboxCursor(holderPeerId);
        after = 0;
        await pull();

        return;
      }

      if (page.records.length === 0) {
        return;
      }

      const advanced = await applyItems(page.records, 0);

      if (advanced) {
        await pull();
      }
    };

    try {
      await pull();
    } catch {
      // Dial/timeout is best-effort; the cursor stays on the last saved row.
    }

    if (touched && isCurrentGeneration(jobGeneration)) {
      storeBridge.setState((state) => ({ revision: state.revision + 1 }));
    }
  };

  /**
   * One catch-up per holder at a time, across generations. `stop` stops
   * waiting after 5s and `cleanupEndpoint` does not clear this map, so a
   * stalled older run finishes before a new one reads or resets the cursor.
   */
  const holderCatchups = new Map<string, Promise<void>>();

  const catchUpHolder = (holderPeerId: string, jobGeneration: number) => {
    const previous = holderCatchups.get(holderPeerId);

    const job = (async () => {
      await Promise.allSettled([previous]);
      await pullHolderInbox(holderPeerId, jobGeneration);
    })();

    holderCatchups.set(holderPeerId, job);

    const removeWhenDone = async () => {
      await Promise.allSettled([job]);

      if (holderCatchups.get(holderPeerId) === job) {
        holderCatchups.delete(holderPeerId);
      }
    };

    void removeWhenDone();

    return job;
  };

  const catchUpInboxes = async (jobGeneration: number) => {
    const activeEndpoint = endpoint;

    if (
      !performCatchup ||
      !activeEndpoint ||
      !isCurrentGeneration(jobGeneration)
    ) {
      return;
    }

    // Holders have independent cursors, so an offline one only costs its own
    // dial timeout instead of delaying the rest.
    const holderPeerIds = await ownHolderPeerIds(activeEndpoint);
    await Promise.all(
      holderPeerIds.map((holderPeerId) =>
        catchUpHolder(holderPeerId, jobGeneration)
      )
    );
  };

  const reconcileOwnHolders = async (jobGeneration: number) => {
    try {
      if (!getOwnDevice?.() || !isCurrentGeneration(jobGeneration)) {
        return;
      }

      // Re-homing trusts the roster, and a device can be linked or unlinked
      // elsewhere while a cached holder stays connected. Read it fresh.
      invalidateOwnHolderPeerIds();
      const pending = await listOutgoingPending();
      await applyReceipts(
        pending.filter((message) => message.status === "held"),
        jobGeneration
      );
      const remaining = await listOutgoingPending();
      const activeEndpoint = endpoint;

      const roster = new Set(
        activeEndpoint ? await ownHolderPeerIds(activeEndpoint) : []
      );

      const connected = new Set(activeEndpoint?.connectedPeers());
      await Promise.all(
        remaining
          .filter((message) => {
            if (message.status === "queued") {
              return (
                outbox?.isInFlight(message.contactQid, message.id) === true
              );
            }

            if (message.status !== "held") {
              return false;
            }

            // Re-home when the accepting holder left the roster. Re-confirm with
            // a connected holder: a held after a lost reply is optimistic, and
            // the same-id handoff is idempotent on the holder.
            return (
              message.holderPeerId === null ||
              !roster.has(message.holderPeerId) ||
              connected.has(message.holderPeerId)
            );
          })
          .map(async (message) => {
            if (!isCurrentGeneration(jobGeneration)) {
              return;
            }

            const contact = await getContactByQid(message.contactQid);

            if (!contact) {
              return;
            }

            try {
              const holderPeerId = await handoffToHolder(
                message,
                contact,
                jobGeneration
              );

              if (holderPeerId) {
                await markMessageHeld(
                  message.id,
                  holderPeerId,
                  message.contactQid
                );
              }
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === HANDOFF_REJECTED_MESSAGE
              ) {
                await failRejectedHandoff(message.id, message.contactQid);
              }
              // Dial/timeout is opportunistic; local status stays pending.
            }
          })
      );
      await catchUpInboxes(jobGeneration);

      if (isCurrentGeneration(jobGeneration)) {
        storeBridge.setState((state) => ({ revision: state.revision + 1 }));
      }
    } catch {
      // Reconcile is best-effort; live chat must keep running.
    }
  };

  const scheduleReconcile = (jobGeneration: number) => {
    if (scheduledReconcile) {
      queuedReconcile = true;

      return scheduledReconcile;
    }

    reconcileSeq += 1;
    const seq = reconcileSeq;

    const job = (async () => {
      try {
        await Promise.resolve();
        queuedReconcile = false;
        await reconcileOwnHolders(jobGeneration);

        if (queuedReconcile && isCurrentGeneration(jobGeneration)) {
          queuedReconcile = false;
          await reconcileOwnHolders(jobGeneration);
        }
      } finally {
        if (reconcileSeq === seq) {
          scheduledReconcile = undefined;
        }
      }
    })();

    scheduledReconcile = job;

    return trackJob(job);
  };

  const trackOutboxDials = (
    activeEndpoint: P2pEndpoint,
    messageKey: string
  ) => {
    const dialedPeers = new Set<string>();
    let released = false;

    const trackedEndpoint: Parameters<typeof performSend>[0]["endpoint"] = {
      connect: (peerId, options) => {
        if (!released && !dialedPeers.has(peerId)) {
          dialedPeers.add(peerId);
          const keys = outboxDialingPeers.get(peerId);

          if (keys) {
            keys.add(messageKey);
          } else {
            outboxDialingPeers.set(peerId, new Set([messageKey]));
          }
        }

        return activeEndpoint.connect(peerId, options);
      },
      connectedPeers: () => activeEndpoint.connectedPeers(),
      openStream: (peerId, protocolId, options) =>
        activeEndpoint.openStream(peerId, protocolId, options),
      waitPeerReady: (peerId, options) =>
        activeEndpoint.waitPeerReady(peerId, options),
    };

    const release = () => {
      if (released) {
        return;
      }

      released = true;

      for (const peerId of dialedPeers) {
        const keys = outboxDialingPeers.get(peerId);

        if (!keys) {
          continue;
        }

        keys.delete(messageKey);

        if (keys.size === 0) {
          outboxDialingPeers.delete(peerId);
        }
      }

      dialedPeers.clear();
    };

    return { release, trackedEndpoint };
  };

  const sendStoredMessage = async (
    message: StoredMessage,
    contact: Contact,
    jobGeneration: number,
    signal: AbortSignal,
    wasExpedited: () => boolean
  ): Promise<DeliveryOutcome> => {
    const isAborted = () =>
      signal.aborted || !isCurrentGeneration(jobGeneration);

    if (isAborted()) {
      return { kind: "aborted" };
    }

    const handoffController = new AbortController();
    let releaseDials: (() => void) | undefined;

    const abortHandoff = () => {
      handoffController.abort(signal.reason);
    };

    signal.addEventListener("abort", abortHandoff, { once: true });

    try {
      const activeEndpoint = endpoint;
      const fromHandle = getIdentityHandle();
      const cipher = chatCipher;

      if (!activeEndpoint || !fromHandle || !cipher) {
        return await recordRetryOutcome(message, wasExpedited);
      }

      const frame: ChatFrame = {
        fromHandle,
        id: message.id,
        sentAt: message.sentAt,
        text: message.text,
        v: 1,
      };

      // Validate locally before racing a holder handoff so malformed frames fail fast.
      if (!isValidChatFrame(frame)) {
        await advanceMessageStatus(message.id, "failed", message.contactQid);

        return { kind: "failed" };
      }

      const { release, trackedEndpoint } = trackOutboxDials(
        activeEndpoint,
        `${message.contactQid}:${message.id}`
      );

      releaseDials = release;

      let terminal = false;

      const delivered = (async () => {
        try {
          await performSend({
            cipher,
            contact,
            endpoint: trackedEndpoint,
            frame,
            sessions,
            signal,
            timeoutMs: 10_000,
          });

          return true;
        } catch (error) {
          terminal = error instanceof Error && isTerminalSendError(error);

          return false;
        }
      })();

      let handoffRejected = false;

      const handedOff = (async () => {
        try {
          return await handoffToHolder(
            message,
            contact,
            jobGeneration,
            handoffController.signal,
            trackedEndpoint
          );
        } catch (error) {
          handoffRejected =
            error instanceof Error &&
            error.message === HANDOFF_REJECTED_MESSAGE;
        }
      })();

      const bobAcked = await delivered;

      if (!isCurrentGeneration(jobGeneration)) {
        return { kind: "aborted" };
      }

      if (bobAcked) {
        // Prefer sent as soon as Bob ACKs. Do not wait for holder dial/timeout.
        await advanceMessageStatus(message.id, "sent", message.contactQid);
        void handedOff;

        return { kind: "delivered" };
      }

      if (terminal) {
        handoffController.abort();
      }

      const holderPeerId = await handedOff;

      if (isAborted()) {
        return { kind: "aborted" };
      }

      if (holderPeerId) {
        await markMessageHeld(message.id, holderPeerId, message.contactQid);

        return { kind: "delivered" };
      }

      if (terminal || handoffRejected) {
        await advanceMessageStatus(message.id, "failed", message.contactQid);

        return { kind: "failed" };
      }

      return await recordRetryOutcome(message, wasExpedited);
    } catch {
      if (isAborted()) {
        return { kind: "aborted" };
      }

      try {
        return await recordRetryOutcome(message, wasExpedited);
      } catch {
        // A storage failure is reflected in the store without leaking a rejection.
        return { kind: "retry", nextAttemptAt: Date.now() + 2000 };
      }
    } finally {
      signal.removeEventListener("abort", abortHandoff);
      releaseDials?.();

      if (isCurrentGeneration(jobGeneration)) {
        storeBridge.setState((state) => ({ revision: state.revision + 1 }));
      }
    }
  };

  const lookupPeerAccount = (rawPeerId: string) =>
    Effect.gen(function* () {
      const peerId = yield* Schema.decodeUnknownEffect(PeerId)(rawPeerId);
      const deviceKey = yield* deviceKeyFromPeerId(peerId);
      const deviceKeyHex = yield* Schema.encodeEffect(Hex32)(deviceKey);

      return yield* lookupDeviceKey(deviceKeyHex);
    });

  const findQueuedContactForPeer = async (
    peerId: string,
    jobGeneration: number
  ): Promise<Contact | null> => {
    // Fast path: match the peer's last-seen contact locally so verify is the only RPC.
    const local = await getContactByPeerId(peerId);

    if (local && (await hasQueuedMessages(local.qid))) {
      return local;
    }

    // Fallback for secondary devices: O(1) lookup by the connecting peer's key.
    const lookedUp = await Effect.runPromise(
      lookupPeerAccount(peerId).pipe(Effect.timeout(10_000), Effect.result)
    );

    if (
      lookedUp._tag !== "Success" ||
      !lookedUp.success ||
      !isCurrentGeneration(jobGeneration)
    ) {
      return null;
    }

    const qid = lookedUp.success.qid.toString();

    if (!(await hasQueuedMessages(qid))) {
      return null;
    }

    const candidate = await getContactByQid(qid);

    return candidate && candidate.handle === lookedUp.success.handle
      ? candidate
      : null;
  };

  const handleConnectionEstablished = async (
    connection: PeerConnection,
    jobGeneration: number
  ) => {
    // Snapshot originating outbox keys synchronously before any await so a dial
    // that fails and releases before verify finishes cannot cancel its own backoff.
    const dialingKeys = new Set(outboxDialingPeers.get(connection.peerId));
    const fromOutboxDial = dialingKeys.size > 0;

    try {
      if (await isOwnHolderPeer(connection.peerId)) {
        const reconcile = scheduleReconcile(jobGeneration);

        if (isCurrentGeneration(jobGeneration)) {
          await outbox?.wake({
            excludeKeys: fromOutboxDial ? dialingKeys : undefined,
            expediteAll: true,
            skipInFlight: fromOutboxDial,
          });
        }

        await reconcile;

        return;
      }

      if (!(await hasQueuedMessages()) || !isCurrentGeneration(jobGeneration)) {
        return;
      }

      const contact = await findQueuedContactForPeer(
        connection.peerId,
        jobGeneration
      );

      if (!contact || !isCurrentGeneration(jobGeneration)) {
        return;
      }

      const verified = await Effect.runPromise(
        sessions
          .verify(connection, contact.handle)
          .pipe(Effect.timeout(10_000), Effect.result)
      );

      if (
        verified._tag === "Success" &&
        verified.success.qid === contact.qid &&
        isCurrentGeneration(jobGeneration)
      ) {
        await outbox?.wake({
          contactQid: contact.qid,
          excludeKeys: fromOutboxDial ? dialingKeys : undefined,
          skipInFlight: fromOutboxDial,
        });
      }
    } catch {
      // Discovery hints cannot bypass backoff until membership is verified.
    }
  };

  // Starts a failed/stopped node and waits (up to 15s) for it to be running.
  const ensureRunning = async (get: () => P2pStore) => {
    const { status } = get().connection;

    if (status === "failed" || status === "stopped") {
      // Must not run inside trackJob — start() waits for in-flight jobs.
      await get().start();
    }

    const startedAt = Date.now();

    // Poll sequentially until start settles or the wait budget expires.
    const waitWhileStarting = async (): Promise<boolean> => {
      const current = get().connection.status;

      if (current !== "starting" || Date.now() - startedAt >= 15_000) {
        return current === "running";
      }

      await Effect.runPromise(Effect.sleep(50));

      return waitWhileStarting();
    };

    return waitWhileStarting();
  };

  const useP2pStore = create<P2pStore>((set, get) => ({
    ...initialState,

    connectTo: async (contact) => {
      const activeEndpoint = endpoint;
      const jobGeneration = generation;

      if (!activeEndpoint) {
        return;
      }

      try {
        const peerIds = await Effect.runPromise(
          sessions.recipientPeerIds(contact).pipe(
            Effect.timeoutOrElse({
              duration: 10_000,
              orElse: () => Effect.fail(new Error("Timed out looking up peer")),
            })
          )
        );

        const dialRoster = async (
          index: number
        ): Promise<string | undefined> => {
          const peerId = peerIds[index];

          if (peerId === undefined || !isCurrentGeneration(jobGeneration)) {
            return;
          }

          try {
            if (
              activeEndpoint.connectedPeers().includes(peerId) &&
              !activeEndpoint.isPeerReady(peerId)
            ) {
              // Transport is up but Identify has not finished. Give it a
              // moment, then replace the stalled connection with a fresh dial.
              try {
                await activeEndpoint.waitPeerReady(peerId, {
                  timeoutMs: 10_000,
                });
              } catch {
                // The wait can time out just as Identify lands; never drop a
                // peer that is ready by now.
                if (!activeEndpoint.isPeerReady(peerId)) {
                  activeEndpoint.disconnect(peerId);
                }
              }
            }

            if (!activeEndpoint.isPeerReady(peerId)) {
              await activeEndpoint.connect(peerId, { timeoutMs: 15_000 });
            }

            return peerId;
          } catch {
            // Offline first roster device (usually the phone) — try the next holder.
            return dialRoster(index + 1);
          }
        };

        return await dialRoster(0);
      } catch {
        // The screen reports reachability from authoritative connection events.
      }
    },

    invalidateOwnHolders: () => {
      invalidateOwnHolderPeerIds();
    },

    openPairingStream: async (peerId) => {
      const activeEndpoint = endpoint;

      if (!activeEndpoint) {
        return;
      }

      const stream = await activeEndpoint.openStream(peerId, PAIR_PROTOCOL, {
        timeoutMs: 15_000,
      });

      return stream;
    },

    pairConnect: async (target) => {
      const activeEndpoint = endpoint;

      if (!activeEndpoint) {
        return;
      }

      return await activeEndpoint.connect(target, {
        cancelOnTimeout: true,
        timeoutMs: 15_000,
      });
    },

    pairWaitPeerReady: async (peerId) => {
      const activeEndpoint = endpoint;

      if (!activeEndpoint) {
        return;
      }

      await activeEndpoint.waitPeerReady(peerId, { timeoutMs: 15_000 });
    },

    retryMessage: async (id, contactQid) => {
      if (!(await ensureRunning(get))) {
        return;
      }

      // Capture generation after start so a restart does not void this retry.
      const jobGeneration = generation;

      await trackJob(
        (async () => {
          try {
            const message = await getMessageById(id, contactQid);

            if (
              !message ||
              message.direction !== "out" ||
              (message.status !== "failed" && message.status !== "queued") ||
              !isCurrentGeneration(jobGeneration)
            ) {
              return;
            }

            if (message.status === "failed") {
              const retried = await retryFailedMessage(id, message.contactQid);

              if (!retried) {
                return;
              }

              set((state) => ({ revision: state.revision + 1 }));
            }

            await outbox?.wake({ contactQid: message.contactQid });
          } catch {
            // The message keeps its stored status; the user can retry again.
          }
        })()
      );
    },

    sendMessage: (contact, text) => {
      const id = randomUUID();
      const jobGeneration = generation;

      const message: MessageInput = {
        contactQid: contact.qid,
        direction: "out",
        id,
        sentAt: Date.now(),
        status: "queued",
        text: text.trim(),
      };

      const persistAndSend = async () => {
        try {
          if (!isCurrentGeneration(jobGeneration)) {
            return;
          }

          await insertMessage(message);

          if (!isCurrentGeneration(jobGeneration)) {
            return;
          }

          set((state) => ({ revision: state.revision + 1 }));

          await outbox?.wake();
        } catch {
          // Storage failed; the conversation shows only what was saved.
        }
      };

      void trackJob(persistAndSend());

      return id;
    },

    start: async () => {
      const { status } = get().connection;

      if (status === "starting" || status === "running") {
        return;
      }

      const startGeneration = generation + 1;
      generation = startGeneration;
      set({ connection: { status: "starting" } });

      try {
        await waitForInFlightJobs();

        if (generation !== startGeneration) {
          return;
        }

        set((state) => ({ revision: state.revision + 1 }));

        const relays = (process.env.EXPO_PUBLIC_RELAY_ADDRS ?? "")
          .split(",")
          .map((address) => address.trim())
          .filter(Boolean);

        if (relays.length === 0) {
          throw new Error(
            "EXPO_PUBLIC_RELAY_ADDRS must contain a relay address"
          );
        }

        const secretKey = await Effect.runPromise(loadDeviceSecretKey());

        if (generation !== startGeneration) {
          return;
        }

        const cipher = createChatCipher(secretKey);

        const binding = createEndpoint({
          agentVersion: "qop/0.1.0",
          protocols: [CHAT_PROTOCOL, PAIR_PROTOCOL, SYNC_PROTOCOL],
          relays,
          secretKey,
        });

        const created = binding.endpoint;

        if (generation !== startGeneration) {
          created.close();

          return;
        }

        endpoint = created;
        chatCipher = cipher;

        // Online means Identify finished, not just a transport path: streams
        // cannot open before peerReady.
        const readPeers = () => {
          const connectedPeerIds = created
            .connectedPeers()
            .filter((peerId) => created.isPeerReady(peerId));

          const peerPaths: Record<string, Path> = {};

          for (const peerId of connectedPeerIds) {
            const path = created.path(peerId);

            if (path) {
              peerPaths[peerId] = path;
            }
          }

          return { connectedPeerIds, peerPaths };
        };

        // Peer events before "running" are dropped; going running re-reads all.
        const updateRunning = (patch: () => Partial<RunningConnection>) => {
          if (generation === startGeneration) {
            set(({ connection }) =>
              connection.status === "running"
                ? { connection: { ...connection, ...patch() } }
                : {}
            );
          }
        };

        const refreshPeers = () => updateRunning(readPeers);

        const invalidateConnections = () => {
          if (generation !== startGeneration) {
            return;
          }

          // Lost lifecycle events make connection authorization unreliable.
          sessions.clear();

          for (const peerId of created.connectedPeers()) {
            created.disconnect(peerId);
          }

          refreshPeers();
        };

        // Shared path for onClose and driverFailed so teardown cannot leave a
        // half-failed endpoint (status failed without cleanup).
        const failEndpoint = (error: string) => {
          if (generation !== startGeneration || endpoint !== created) {
            return;
          }

          generation += 1;
          cleanupEndpoint(created);
          set({ connection: { reason: error, status: "failed" } });
        };

        unsubscribe = [
          binding.bindAppState(),
          ...(subscribeAppResume
            ? [
                subscribeAppResume(() => {
                  if (generation === startGeneration) {
                    sessions.invalidateAuthorization();
                    invalidateOwnHolderPeerIds();
                    void scheduleReconcile(startGeneration);
                    void outbox?.wake({ expediteAll: true });
                  }
                }),
              ]
            : []),
          created.onClose((reason) => {
            failEndpoint(
              reason.reason === "driverFailed"
                ? errorMessage(reason.error)
                : "P2P endpoint closed"
            );
          }),
          created.on("relayReserved", () => {
            updateRunning(() => ({ relayReserved: true }));
          }),
          created.on("relayReservationLost", () => {
            updateRunning(() => ({
              relayReserved: created.activeReservation() !== undefined,
            }));
          }),
          created.on("connectionEstablished", (connection) => {
            if (generation === startGeneration) {
              sessions.opened(connection);
              void trackJob(
                handleConnectionEstablished(connection, startGeneration)
              );
            }
          }),
          created.on("peerReady", refreshPeers),
          created.on("pathEstablished", refreshPeers),
          created.on("inboundPathEstablished", refreshPeers),
          created.on("pathUpgraded", refreshPeers),
          created.on("connectionClosed", (connection) => {
            if (generation === startGeneration) {
              sessions.closed(connection);
            }

            refreshPeers();
          }),
          created.on("driverFailed", ({ detail }) => {
            failEndpoint(detail);
          }),
          created.on("queueOverflow", invalidateConnections),
          created.on("eventsDropped", invalidateConnections),
          created.on("stream", (stream) => {
            if (
              generation === startGeneration &&
              stream.protocolId === CHAT_PROTOCOL
            ) {
              void trackJob(receiveChatStream(stream, startGeneration, cipher));
            } else {
              stream.reset();
            }
          }),
        ];

        if (generation !== startGeneration) {
          cleanupEndpoint(created);
          created.close();

          return;
        }

        outbox = createMobileOutbox({
          deliver: (message, signal, wasExpedited) =>
            trackJob(
              (async (): Promise<DeliveryOutcome> => {
                if (!isCurrentGeneration(startGeneration) || signal.aborted) {
                  return { kind: "aborted" };
                }

                const contact = await getContactByQid(message.contactQid);

                if (
                  !contact ||
                  signal.aborted ||
                  !isCurrentGeneration(startGeneration)
                ) {
                  return { kind: "aborted" };
                }

                return sendStoredMessage(
                  message,
                  contact,
                  startGeneration,
                  signal,
                  wasExpedited
                );
              })()
            ),
          expedite: expediteMessageRetries,
          list: listOutgoingPending,
          reconcile: () => scheduleReconcile(startGeneration),
        });
        set({
          connection: {
            ...readPeers(),
            relayReserved: created.activeReservation() !== undefined,
            status: "running",
          },
        });

        if (generation === startGeneration) {
          void outbox.wake();
          void scheduleReconcile(startGeneration);
        }
      } catch (error) {
        if (generation === startGeneration) {
          set({
            connection: {
              reason: errorMessage(
                error instanceof Error ? error : String(error)
              ),
              status: "failed",
            },
          });
        }
      }
    },

    stop: async () => {
      generation += 1;
      const activeEndpoint = endpoint;
      cleanupEndpoint(activeEndpoint);
      activeEndpoint?.close();
      set(initialState);
      await waitForInFlightJobs();
    },
  }));

  storeBridge.setState = useP2pStore.setState;

  return useP2pStore;
};
