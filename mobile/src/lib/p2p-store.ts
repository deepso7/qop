import { Minip2p, bindAppState } from "@minip2p/react-native";
import type { Stream, Unsubscribe } from "@minip2p/react-native";
import { Effect } from "effect";
import { randomUUID } from "expo-crypto";
import { create } from "zustand";

import {
  CHAT_PROTOCOL,
  decodeFrame,
  encodeAck,
  MAX_CHAT_PAYLOAD_BYTES,
} from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import {
  getContactByPeerId,
  getContactByQid,
  getMessageById,
  insertMessage,
  updateMessageStatus,
  upsertContact,
} from "./db";
import type { Contact, StoredMessage } from "./db";
import { useIdentityStore } from "./identity-store";
import { loadDeviceSecretKey } from "./identity-vault";
import { performSend } from "./p2p-send";
import { lookupHandle } from "./registry";
import type { RegistryAccount } from "./registry";

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
  readonly connectTo: (peerId: string) => Promise<void>;
  readonly retryMessage: (id: string) => Promise<void>;
  readonly sendMessage: (contact: Contact, text: string) => string;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
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

const errorMessage = (error: Error | string) =>
  error instanceof Error ? error.message : String(error);

const contactFromAccount = (account: RegistryAccount) => ({
  createdAt: Number(account.registeredAt) * 1000,
  deviceKey: account.deviceKey,
  handle: account.handle,
  owner: account.owner,
  peerId: account.peerId,
  qid: account.qid.toString(),
});

const readStream = async (stream: Pick<Stream, "read">) => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    // Stream chunks are ordered, so reads cannot run concurrently.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const chunk = await stream.read();
    if (!chunk) {
      break;
    }
    byteLength += chunk.byteLength;
    if (byteLength > MAX_CHAT_PAYLOAD_BYTES) {
      throw new Error("Chat frame exceeds 16 KB");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const resolveSender = async (
  peerId: string,
  fromHandle: string
): Promise<Contact | null> => {
  const known = await getContactByPeerId(peerId);
  if (known?.handle === fromHandle) {
    return known;
  }

  const account = await Effect.runPromise(lookupHandle(fromHandle));
  if (!account || account.peerId !== peerId) {
    return null;
  }
  await upsertContact(contactFromAccount(account));
  return getContactByQid(account.qid.toString());
};

export const receiveChatStream = async (stream: Stream): Promise<void> => {
  try {
    if (stream.protocolId !== CHAT_PROTOCOL) {
      stream.reset();
      return;
    }
    const frame = decodeFrame(await readStream(stream));
    const contact = await resolveSender(stream.peerId, frame.fromHandle);
    if (!contact) {
      stream.reset();
      return;
    }
    const inserted = await insertMessage({
      contactQid: contact.qid,
      direction: "in",
      id: frame.id,
      sentAt: frame.sentAt,
      status: "received",
      text: frame.text,
    });
    stream.write(encodeAck({ ack: frame.id, v: 1 }));
    stream.closeWrite();
    if (inserted) {
      useP2pStore.setState((state) => ({ revision: state.revision + 1 }));
    }
  } catch {
    stream.reset();
  }
};

const sendStoredMessage = async (
  message: StoredMessage,
  contact: Contact
): Promise<void> => {
  try {
    const activeEndpoint = endpoint;
    const fromHandle = useIdentityStore.getState().identity?.handle;
    if (!activeEndpoint || !fromHandle) {
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
      timeoutMs: 10_000,
    });
    await updateMessageStatus(message.id, "sent");
  } catch {
    try {
      await updateMessageStatus(message.id, "failed");
    } catch {
      // A storage failure is reflected in the store without leaking a rejection.
    }
  } finally {
    useP2pStore.setState((state) => ({ revision: state.revision + 1 }));
  }
};

export const useP2pStore = create<P2pStore>((set, get) => ({
  ...initialState,

  connectTo: async (peerId) => {
    try {
      await endpoint?.connect(peerId, { timeoutMs: 15_000 });
    } catch {
      // The screen reports reachability from authoritative connection events.
    }
  },

  retryMessage: async (id) => {
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
      if (!contact) {
        return;
      }
      await updateMessageStatus(id, "sending");
      set((state) => ({ revision: state.revision + 1 }));
      void sendStoredMessage({ ...message, status: "sending" }, contact);
    } catch (error) {
      set({
        error: errorMessage(error instanceof Error ? error : String(error)),
      });
    }
  },

  sendMessage: (contact, text) => {
    const id = randomUUID();
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
        await insertMessage(message);
        set((state) => ({ revision: state.revision + 1 }));
        await sendStoredMessage(message, contact);
      } catch (error) {
        set({
          error: errorMessage(error instanceof Error ? error : String(error)),
        });
      }
    };
    void persistAndSend();
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
        set({ connectedPeerIds: created.connectedPeers() });
      };
      unsubscribe = [
        bindAppState(created),
        created.on("relayReserved", () => set({ relayReserved: true })),
        created.on("relayReservationLost", () =>
          set({ relayReserved: created.activeReservation() !== undefined })
        ),
        created.on("peerReady", refreshPeers),
        created.on("connectionClosed", refreshPeers),
        created.on("driverFailed", ({ detail }) =>
          set({ error: detail, status: "failed" })
        ),
        created.on("queueOverflow", refreshPeers),
        created.on("stream", (stream) => {
          if (stream.protocolId === CHAT_PROTOCOL) {
            void receiveChatStream(stream);
          } else {
            stream.reset();
          }
        }),
      ];
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

  stop: () => {
    generation += 1;
    for (const removeListener of unsubscribe) {
      removeListener();
    }
    unsubscribe = [];
    endpoint?.close();
    endpoint = undefined;
    set(initialState);
  },
}));
