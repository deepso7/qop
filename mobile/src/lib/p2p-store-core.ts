import type { Minip2p, Stream, Unsubscribe } from "@minip2p/react-native";
import { PAIR_PROTOCOL, SYNC_PROTOCOL } from "@qop/protocol";
import { Effect } from "effect";
import { create } from "zustand";
import type { StoreApi } from "zustand";

import { CHAT_PROTOCOL, encodeAck } from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import {
  advanceMessageStatus,
  failInterruptedMessages,
  failRejectedHandoff,
  getContactByQid,
  getMessageById,
  insertMessage,
  listOutgoingPending,
  markMessageHeld,
  upsertContact,
} from "./db";
import type { Contact, MessageInput, StoredMessage } from "./db";
import type { loadDeviceSecretKey } from "./identity-vault";
import { readVerifiedChat } from "./p2p-receive";
import { withTimeout } from "./p2p-send";
import type { performSend } from "./p2p-send";
import { createPeerSessions } from "./p2p-sessions";
import {
  HANDOFF_REJECTED_MESSAGE,
  otherOwnDevicePeerIds,
  outgoingHandoffRecord,
  pickHolderPeerId,
} from "./p2p-sync";
import type { OwnDevice, performHandoff, performPoll } from "./p2p-sync";
import type { lookupDeviceKey, lookupHandle } from "./registry";

type P2pStatus = "failed" | "running" | "starting" | "stopped";

interface P2pState {
  readonly connectedPeerIds: readonly string[];
  readonly error?: string;
  readonly peerId?: string;
  readonly relayReserved: boolean;
  readonly revision: number;
  readonly status: P2pStatus;
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
        readonly write: (data: Uint8Array) => void;
      }
    | undefined
  >;
  readonly pairConnect: (
    peerId: string
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly pairConnectAddr: (
    address: string
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly pairConnectWithAddrs: (
    peerId: string,
    addresses: readonly string[]
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly pairWaitPeerReady: (peerId: string) => Promise<void>;
  readonly retryMessage: (id: string, contactQid?: string) => Promise<void>;
  readonly sendMessage: (contact: Contact, text: string) => string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

type P2pStore = P2pActions & P2pState;

const initialState: P2pState = {
  connectedPeerIds: [],
  relayReserved: false,
  revision: 0,
  status: "stopped",
};

export type P2pEndpoint = Pick<
  Minip2p,
  | "activeReservation"
  | "close"
  | "connectedPeers"
  | "connect"
  | "connectAddr"
  | "connectWithAddrs"
  | "disconnect"
  | "on"
  | "onClose"
  | "openStream"
  | "peerId"
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
  performHandoff,
  performPoll,
  performSend,
  randomUUID,
  subscribeAppResume,
}: P2pDependencies) => {
  let endpoint: P2pEndpoint | undefined;
  let unsubscribe: Unsubscribe[] = [];
  let generation = 0;
  let recoveryOperation: Promise<void> = Promise.resolve();
  const inFlightJobs = new Set<Promise<void>>();
  const retryJobs = new Map<
    string,
    { readonly controller: AbortController; readonly job: Promise<void> }
  >();
  let cachedHolderPeerIds: readonly string[] | undefined;
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

  const trackJob = (job: Promise<void>) => {
    inFlightJobs.add(job);
    const removeWhenDone = async () => {
      await Promise.allSettled([job]);
      inFlightJobs.delete(job);
    };
    void removeWhenDone();
    return job;
  };

  const cleanupEndpoint = (activeEndpoint: P2pEndpoint | undefined) => {
    for (const { controller } of retryJobs.values()) {
      controller.abort();
    }
    retryJobs.clear();
    sessions.clear();
    holderCacheEpoch += 1;
    cachedHolderPeerIds = undefined;
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

  // Finish pending database writes before recovering sends from a stopped endpoint.
  const recoverInterruptedSends = () => {
    const previous = recoveryOperation;
    const recover = async () => {
      try {
        await previous;
        await waitForInFlightJobs();
        await failInterruptedMessages();
        storeBridge.setState((state) => ({ revision: state.revision + 1 }));
      } catch (error) {
        storeBridge.setState({
          error: errorMessage(error instanceof Error ? error : String(error)),
        });
      }
    };
    recoveryOperation = recover();
    return recoveryOperation;
  };

  const receiveChatStream = async (
    stream: Stream,
    jobGeneration: number
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
        10_000
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
      stream.write(encodeAck({ ack: frame.id, v: 1 }));
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
      } finally {
        if (epoch === holderCacheEpoch) {
          holderLookup = undefined;
        }
      }
    })();
    return holderLookup;
  };

  const resolveHolderPeerId = async (activeEndpoint: P2pEndpoint) => {
    const connected = activeEndpoint.connectedPeers();
    const pick = (ids: readonly string[] | undefined) => {
      if (!ids || ids.length === 0) {
        return;
      }
      return pickHolderPeerId(ids, connected);
    };
    const hadCachedRoster = cachedHolderPeerIds !== undefined;
    const first = pick(await loadOwnHolderPeerIds());
    if (first !== undefined && connected.includes(first)) {
      return first;
    }
    // Cached roster has no connected holder — a CLI linked since the last
    // lookup may be the only device that can take the handoff.
    if (!hadCachedRoster) {
      return first;
    }
    invalidateOwnHolderPeerIds();
    return pick(await loadOwnHolderPeerIds());
  };

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
   * Send/poll still refresh via `resolveHolderPeerId`.
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

  const handoffToHolder = (
    message: Pick<StoredMessage, "id" | "sentAt" | "text">,
    contact: Contact,
    jobGeneration: number,
    signal?: AbortSignal
  ) => {
    const existing = handoffJobs.get(message.id);
    if (existing) {
      return existing;
    }
    const job = (async () => {
      const own = getOwnDevice?.();
      const activeEndpoint = endpoint;
      if (!own || !performHandoff || !activeEndpoint) {
        return;
      }
      const holderPeerId = await resolveHolderPeerId(activeEndpoint);
      if (!holderPeerId || !isCurrentGeneration(jobGeneration)) {
        return;
      }
      await performHandoff({
        composedBy: own.deviceKey,
        endpoint: activeEndpoint,
        holderPeerId,
        own,
        record: outgoingHandoffRecord({
          contact,
          fromHandle: own.handle,
          id: message.id,
          now: Date.now(),
          sentAt: message.sentAt,
          text: message.text,
        }),
        sessions,
        signal,
        timeoutMs: 10_000,
      });
      return holderPeerId;
    })();
    handoffJobs.set(message.id, job);
    const removeWhenDone = async () => {
      await Promise.allSettled([job]);
      if (handoffJobs.get(message.id) === job) {
        handoffJobs.delete(message.id);
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
    const fallbackHolderPeerId = needsFallback
      ? await resolveHolderPeerId(activeEndpoint)
      : undefined;
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
        const receipts = await performPoll({
          endpoint: activeEndpoint,
          holderPeerId,
          ids,
          own,
          sessions,
          timeoutMs: 10_000,
        });
        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }
        await Promise.all(
          receipts.map((receipt) => {
            const row = messages.find((message) => message.id === receipt.id);
            return row
              ? advanceMessageStatus(row.id, "sent", row.contactQid)
              : Promise.resolve(false);
          })
        );
      })
    );
  };

  const reconcileOwnHolders = async (jobGeneration: number) => {
    try {
      if (!getOwnDevice?.() || !isCurrentGeneration(jobGeneration)) {
        return;
      }
      const pending = await listOutgoingPending();
      await applyReceipts(
        pending.filter((message) => message.status === "held"),
        jobGeneration
      );
      const remaining = await listOutgoingPending();
      await Promise.all(
        remaining
          .filter(
            (message) =>
              message.status === "held" || message.status === "sending"
          )
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

  const sendStoredMessage = async (
    message: MessageInput,
    contact: Contact,
    jobGeneration: number,
    signal?: AbortSignal
  ): Promise<void> => {
    try {
      if (signal?.aborted || !isCurrentGeneration(jobGeneration)) {
        return;
      }
      const activeEndpoint = endpoint;
      const fromHandle = getIdentityHandle();
      if (!activeEndpoint || !fromHandle) {
        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }
        await advanceMessageStatus(message.id, "failed", message.contactQid);
        return;
      }

      const frame: ChatFrame = {
        fromHandle,
        id: message.id,
        sentAt: message.sentAt,
        text: message.text,
        v: 1,
      };
      const delivered = (async () => {
        try {
          await performSend({
            contact,
            endpoint: activeEndpoint,
            frame,
            sessions,
            signal,
            timeoutMs: 10_000,
          });
          return true;
        } catch {
          return false;
        }
      })();
      const handedOff = (async () => {
        try {
          return await handoffToHolder(message, contact, jobGeneration, signal);
        } catch {
          // Dial/timeout; the phone keeps sending/failed locally.
        }
      })();
      const bobAcked = await delivered;
      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }
      if (bobAcked) {
        // Prefer sent as soon as Bob ACKs. Do not wait for CLI dial/timeout.
        await advanceMessageStatus(message.id, "sent", message.contactQid);
        void handedOff;
        return;
      }
      const holderPeerId = await handedOff;
      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }
      await (holderPeerId
        ? markMessageHeld(message.id, holderPeerId, message.contactQid)
        : advanceMessageStatus(message.id, "failed", message.contactQid));
    } catch {
      try {
        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }
        await advanceMessageStatus(message.id, "failed", message.contactQid);
      } catch {
        // A storage failure is reflected in the store without leaking a rejection.
      }
    } finally {
      if (isCurrentGeneration(jobGeneration)) {
        storeBridge.setState((state) => ({ revision: state.revision + 1 }));
      }
    }
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
            if (!activeEndpoint.connectedPeers().includes(peerId)) {
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

    pairConnect: async (peerId) => {
      const activeEndpoint = endpoint;
      if (!activeEndpoint) {
        return;
      }
      return await activeEndpoint.connect(peerId, { timeoutMs: 15_000 });
    },

    pairConnectAddr: async (address) => {
      const activeEndpoint = endpoint;
      if (!activeEndpoint) {
        return;
      }
      return await activeEndpoint.connectAddr(address, { timeoutMs: 15_000 });
    },

    pairConnectWithAddrs: async (peerId, addresses) => {
      const activeEndpoint = endpoint;
      if (!activeEndpoint) {
        return;
      }
      return await activeEndpoint.connectWithAddrs(peerId, addresses, {
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

    retryMessage: (id, contactQid) => {
      const jobKey = contactQid === undefined ? id : `${contactQid}:${id}`;
      const existing = retryJobs.get(jobKey);
      if (existing) {
        return existing.job;
      }
      const controller = new AbortController();
      const ensureRunning = async () => {
        if (get().status === "failed" || get().status === "stopped") {
          // Must not run inside trackJob — start() waits for in-flight jobs.
          await get().start();
        }
        const startedAt = Date.now();
        // Poll sequentially until start settles or the wait budget expires.
        const waitWhileStarting = async (): Promise<boolean> => {
          if (get().status !== "starting" || Date.now() - startedAt >= 15_000) {
            return get().status === "running";
          }
          await Effect.runPromise(Effect.sleep(50));
          return waitWhileStarting();
        };
        return waitWhileStarting();
      };

      const retry = async () => {
        if (controller.signal.aborted) {
          return;
        }
        if (!(await ensureRunning())) {
          return;
        }
        if (controller.signal.aborted) {
          return;
        }
        // Capture generation after start so a restart does not void this retry.
        const jobGeneration = generation;
        const send = async () => {
          try {
            const message = await getMessageById(id, contactQid);
            if (
              !message ||
              message.direction !== "out" ||
              message.status !== "failed"
            ) {
              return;
            }
            const contact = await getContactByQid(message.contactQid);
            if (!contact || !isCurrentGeneration(jobGeneration)) {
              return;
            }
            if (
              !(await advanceMessageStatus(id, "sending", message.contactQid))
            ) {
              return;
            }
            if (!isCurrentGeneration(jobGeneration)) {
              return;
            }
            set((state) => ({ revision: state.revision + 1 }));
            await sendStoredMessage(
              { ...message, status: "sending" },
              contact,
              jobGeneration,
              controller.signal
            );
          } catch (error) {
            if (isCurrentGeneration(jobGeneration)) {
              set({
                error: errorMessage(
                  error instanceof Error ? error : String(error)
                ),
              });
            }
          }
        };
        return trackJob(send());
      };
      const job = retry();
      retryJobs.set(jobKey, { controller, job });
      const removeWhenDone = async () => {
        await Promise.allSettled([job]);
        if (retryJobs.get(jobKey)?.job === job) {
          retryJobs.delete(jobKey);
        }
      };
      void removeWhenDone();
      return job;
    },

    sendMessage: (contact, text) => {
      const id = randomUUID();
      const jobGeneration = generation;
      const message: MessageInput = {
        contactQid: contact.qid,
        direction: "out",
        id,
        sentAt: Date.now(),
        status: get().status === "running" ? "sending" : "failed",
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
          if (message.status === "sending") {
            await sendStoredMessage(message, contact, jobGeneration);
          }
        } catch (error) {
          if (isCurrentGeneration(jobGeneration)) {
            set({
              error: errorMessage(
                error instanceof Error ? error : String(error)
              ),
            });
          }
        }
      };
      void trackJob(persistAndSend());
      return id;
    },

    start: async () => {
      const { status } = get();
      if (status === "starting" || status === "running") {
        return;
      }
      const startGeneration = generation + 1;
      generation = startGeneration;
      set((state) => ({
        ...initialState,
        revision: state.revision,
        status: "starting",
      }));
      try {
        await recoveryOperation;
        await waitForInFlightJobs();
        if (generation !== startGeneration) {
          return;
        }
        await failInterruptedMessages();
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
        const refreshPeers = () => {
          if (generation === startGeneration) {
            set({ connectedPeerIds: created.connectedPeers() });
          }
        };
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
        // half-failed endpoint (status failed without cleanup/recovery).
        const failEndpoint = (error: string) => {
          if (generation !== startGeneration || endpoint !== created) {
            return;
          }
          generation += 1;
          cleanupEndpoint(created);
          set({
            connectedPeerIds: [],
            error,
            peerId: undefined,
            relayReserved: false,
            status: "failed",
          });
          void recoverInterruptedSends();
        };
        unsubscribe = [
          binding.bindAppState(),
          ...(subscribeAppResume
            ? [
                subscribeAppResume(() => {
                  if (generation === startGeneration) {
                    sessions.invalidateAuthorization();
                    invalidateOwnHolderPeerIds();
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
            if (generation === startGeneration) {
              set({ relayReserved: true });
            }
          }),
          created.on("relayReservationLost", () => {
            if (generation === startGeneration) {
              set({ relayReserved: created.activeReservation() !== undefined });
            }
          }),
          created.on("connectionEstablished", (connection) => {
            if (generation === startGeneration) {
              sessions.opened(connection);
              void trackJob(
                (async () => {
                  if (await isOwnHolderPeer(connection.peerId)) {
                    await scheduleReconcile(startGeneration);
                  }
                })()
              );
            }
          }),
          created.on("peerReady", refreshPeers),
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
              void trackJob(receiveChatStream(stream, startGeneration));
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
        set({
          connectedPeerIds: created.connectedPeers(),
          error: undefined,
          peerId: created.peerId(),
          relayReserved: created.activeReservation() !== undefined,
          status: "running",
        });
        void scheduleReconcile(startGeneration);
      } catch (error) {
        if (generation === startGeneration) {
          set({
            error: errorMessage(error instanceof Error ? error : String(error)),
            status: "failed",
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
      await recoverInterruptedSends();
    },
  }));

  storeBridge.setState = useP2pStore.setState;
  return useP2pStore;
};
