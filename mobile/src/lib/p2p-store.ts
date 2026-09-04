import { Minip2p, bindAppState } from "@minip2p/react-native";
import type { Stream, Unsubscribe } from "@minip2p/react-native";
import { Effect } from "effect";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";

import { CHAT_PROTOCOL, encodeAck } from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import {
  getContactByQid,
  getMessageById,
  insertMessage,
  updateMessageStatus,
  upsertContact,
} from "./db";
import type { Contact, StoredMessage } from "./db";
import { useIdentityStore } from "./identity-store";
import { loadDeviceSecretKey } from "./identity-vault";
import { readVerifiedChat } from "./p2p-receive";
import { performSend, withTimeout } from "./p2p-send";
import { createPeerSessions } from "./p2p-sessions";
import { lookupHandle } from "./registry";

// oxlint-disable eslint/no-use-before-define -- Store helpers run only after the store is initialized.

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
  readonly connectTo: (contact: Contact) => Promise<void>;
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

let endpoint: Minip2p | undefined;
let unsubscribe: Unsubscribe[] = [];
let generation = 0;
const inFlightJobs = new Set<Promise<void>>();

const errorMessage = (error: Error | string) =>
  error instanceof Error ? error.message : String(error);

const sessions = createPeerSessions({
  getContactByQid,
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

const cleanupEndpoint = (activeEndpoint: Minip2p | undefined) => {
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
    useP2pStore.setState((state) => ({ revision: state.revision + 1 }));
  } catch {
    stream.reset();
  }
};

const sendStoredMessage = async (
  message: StoredMessage,
  contact: Contact,
  jobGeneration: number
): Promise<void> => {
  try {
    if (!isCurrentGeneration(jobGeneration)) {
      return;
    }
    const activeEndpoint = endpoint;
    const fromHandle = useIdentityStore.getState().identity?.handle;
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
      useP2pStore.setState((state) => ({ revision: state.revision + 1 }));
    }
  }
};

export const useP2pStore = create<P2pStore>((set, get) => ({
  ...initialState,

  connectTo: async (contact) => {
    const activeEndpoint = endpoint;
    const jobGeneration = generation;
    if (!activeEndpoint) {
      return;
    }
    try {
      const peerId = await Effect.runPromise(sessions.recipientPeerId(contact));
      if (!isCurrentGeneration(jobGeneration)) {
        return;
      }
      if (!activeEndpoint.connectedPeers().includes(peerId)) {
        await activeEndpoint.connect(peerId, { timeoutMs: 15_000 });
      }
    } catch {
      // The screen reports reachability from authoritative connection events.
    }
  },

  retryMessage: (id) => {
    const jobGeneration = generation;
    const retry = async () => {
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
          jobGeneration
        );
      } catch (error) {
        if (isCurrentGeneration(jobGeneration)) {
          set({
            error: errorMessage(error instanceof Error ? error : String(error)),
          });
        }
      }
    };
    return trackJob(retry());
  },

  sendMessage: (contact, text) => {
    const id = randomUUID();
    const jobGeneration = generation;
    const message: StoredMessage = {
      contactQid: contact.qid,
      direction: "out",
      id,
      sentAt: Date.now(),
      status: "sending",
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
        await sendStoredMessage(message, contact, jobGeneration);
      } catch (error) {
        if (isCurrentGeneration(jobGeneration)) {
          set({
            error: errorMessage(error instanceof Error ? error : String(error)),
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
      const relays = (process.env.EXPO_PUBLIC_RELAY_ADDRS ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
      if (relays.length === 0) {
        throw new Error("EXPO_PUBLIC_RELAY_ADDRS must contain a relay address");
      }
      const secretKey = await Effect.runPromise(loadDeviceSecretKey());
      if (generation !== startGeneration) {
        return;
      }
      const created = Minip2p.create({
        agentVersion: "qop/0.1.0",
        protocols: [CHAT_PROTOCOL],
        relays,
        secretKey,
      });
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
      unsubscribe = [
        bindAppState(created),
        created.onClose((reason) => {
          if (generation !== startGeneration || endpoint !== created) {
            return;
          }
          generation += 1;
          cleanupEndpoint(created);
          set({
            connectedPeerIds: [],
            error:
              reason.reason === "driverFailed"
                ? errorMessage(reason.error)
                : "P2P endpoint closed",
            peerId: undefined,
            relayReserved: false,
            status: "failed",
          });
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
          if (generation === startGeneration) {
            set({ error: detail, status: "failed" });
          }
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
    await waitForInFlightJobs();
  },
}));
