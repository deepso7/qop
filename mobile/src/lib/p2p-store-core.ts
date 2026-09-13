import type { Minip2p, Stream, Unsubscribe } from "@minip2p/react-native";
import { PAIR_PROTOCOL } from "@qop/protocol";
import { Effect } from "effect";
import { create } from "zustand";
import type { StoreApi } from "zustand";

import { CHAT_PROTOCOL, encodeAck } from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import {
  failInterruptedMessages,
  getContactByQid,
  getMessageById,
  insertMessage,
  updateMessageStatus,
  upsertContact,
} from "./db";
import type { Contact, MessageInput } from "./db";
import type { loadDeviceSecretKey } from "./identity-vault";
import { readVerifiedChat } from "./p2p-receive";
import { withTimeout } from "./p2p-send";
import type { performSend } from "./p2p-send";
import { createPeerSessions } from "./p2p-sessions";
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
  readonly pairConnectAddr: (
    address: string
  ) => Promise<{ readonly peerId: string } | undefined>;
  readonly pairWaitPeerReady: (peerId: string) => Promise<void>;
  readonly retryMessage: (id: string) => Promise<void>;
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
  readonly performSend: typeof performSend;
  readonly randomUUID: () => string;
  /** Called when the app resumes from background/suspend; invalidate live auth. */
  readonly subscribeAppResume?: (onResume: () => void) => Unsubscribe;
}

const errorMessage = (error: Error | string) =>
  error instanceof Error ? error.message : String(error);

const uninitializedSetState: StoreApi<P2pStore>["setState"] = () => {
  throw new Error("P2P store used before initialization");
};

export const createP2pStore = ({
  createEndpoint,
  getIdentityHandle,
  loadDeviceSecretKey,
  lookupDeviceKey,
  lookupHandle,
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

  const sessions = createPeerSessions({
    getContactByQid,
    lookupDeviceKey,
    lookupHandle,
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
        await updateMessageStatus(message.id, "failed");
        return;
      }

      const frame: ChatFrame = {
        fromHandle,
        id: message.id,
        sentAt: message.sentAt,
        text: message.text,
        v: 1,
      };
      await performSend({
        contact,
        endpoint: activeEndpoint,
        frame,
        sessions,
        signal,
        timeoutMs: 10_000,
      });
      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }
      await updateMessageStatus(message.id, "sent");
    } catch {
      try {
        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }
        await updateMessageStatus(message.id, "failed");
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
        const peerId = await Effect.runPromise(
          sessions.recipientPeerId(contact).pipe(
            Effect.timeoutOrElse({
              duration: 10_000,
              orElse: () => Effect.fail(new Error("Timed out looking up peer")),
            })
          )
        );
        if (!isCurrentGeneration(jobGeneration)) {
          return;
        }
        if (!activeEndpoint.connectedPeers().includes(peerId)) {
          await activeEndpoint.connect(peerId, { timeoutMs: 15_000 });
        }
        return peerId;
      } catch {
        // The screen reports reachability from authoritative connection events.
      }
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

    pairConnectAddr: async (address) => {
      const activeEndpoint = endpoint;
      if (!activeEndpoint) {
        return;
      }
      return await activeEndpoint.connectAddr(address, { timeoutMs: 15_000 });
    },

    pairWaitPeerReady: async (peerId) => {
      const activeEndpoint = endpoint;
      if (!activeEndpoint) {
        return;
      }
      await activeEndpoint.waitPeerReady(peerId, { timeoutMs: 15_000 });
    },

    retryMessage: (id) => {
      const existing = retryJobs.get(id);
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
            const message = await getMessageById(id);
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
            await updateMessageStatus(id, "sending");
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
      retryJobs.set(id, { controller, job });
      const removeWhenDone = async () => {
        await Promise.allSettled([job]);
        if (retryJobs.get(id)?.job === job) {
          retryJobs.delete(id);
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
          protocols: [CHAT_PROTOCOL, PAIR_PROTOCOL],
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
