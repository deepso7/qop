import { peerIdFromSecretKey, useMinip2p } from "@minip2p/react-native";
import * as React from "react";
import { Platform } from "react-native";

const CHAT_TOPIC_PREFIX = "/qop/chat/1";
const RELAY_ADDRESS =
  "/ip6/2406:da1a:515:6cb6:8928:6c77:ed2:2ebe/udp/4001/quic-v1/p2p/12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const KEEPALIVE_INTERVAL_MS = 10_000;
const CONNECT_RETRY_INTERVAL_MS = 3000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_WIRE_LENGTH = 16_000;

// Deliberately public and deterministic POC identities. Never ship these keys.
const IOS_POC_SECRET_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1
);
const ANDROID_POC_SECRET_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 65
);
const IS_ANDROID_CONNECTOR = Platform.OS === "android";
const LOCAL_SECRET_KEY = IS_ANDROID_CONNECTOR
  ? ANDROID_POC_SECRET_KEY
  : IOS_POC_SECRET_KEY;
const TARGET_SECRET_KEY = IS_ANDROID_CONNECTOR
  ? IOS_POC_SECRET_KEY
  : ANDROID_POC_SECRET_KEY;

interface WireChatMessage {
  id: string;
  sentAt: number;
  text: string;
  version: 1;
}

interface ReceivedChatMessage extends WireChatMessage {
  fromPeerId: string;
}

type Minip2pChatStatus =
  | "closed"
  | "connecting"
  | "failed"
  | "ready"
  | "searching"
  | "starting";

interface UseMinip2pChatResult {
  canPublish: boolean;
  diagnostics?: string;
  label: string;
  peerId?: string;
  publish: (text: string) => WireChatMessage;
  status: Minip2pChatStatus;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const decodeWireMessage = (data: ArrayBuffer): WireChatMessage | undefined => {
  const raw = new TextDecoder().decode(data);
  if (raw.length > MAX_WIRE_LENGTH) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Partial<WireChatMessage>;
  if (
    candidate.version !== 1 ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.length > 200 ||
    typeof candidate.text !== "string" ||
    candidate.text.length === 0 ||
    candidate.text.length > MAX_MESSAGE_LENGTH ||
    typeof candidate.sentAt !== "number" ||
    !Number.isSafeInteger(candidate.sentAt)
  ) {
    return undefined;
  }

  return candidate as WireChatMessage;
};

const removePeer = (peers: readonly string[], peerId: string) =>
  peers.filter((candidate) => candidate !== peerId);

const addPeer = (peers: readonly string[], peerId: string) =>
  peers.includes(peerId) ? peers : [...peers, peerId];

const useMinip2pChat = (
  conversationId: string,
  onMessage: (message: ReceivedChatMessage) => void
): UseMinip2pChatResult => {
  const targetPeerId = React.useMemo(
    () => peerIdFromSecretKey(TARGET_SECRET_KEY),
    []
  );
  const createConfig = React.useCallback(
    () => ({
      agentVersion: "qop-minip2p-poc/0.1.0",
      forceRelay: false,
      relays: [RELAY_ADDRESS],
      secretKey: LOCAL_SECRET_KEY,
    }),
    []
  );
  const node = useMinip2p(createConfig);
  const topic = React.useMemo(
    () => `${CHAT_TOPIC_PREFIX}/${encodeURIComponent(conversationId)}`,
    [conversationId]
  );
  const [connectedPeers, setConnectedPeers] = React.useState<readonly string[]>(
    []
  );
  const [topicPeers, setTopicPeers] = React.useState<readonly string[]>([]);
  const [diagnostics, setDiagnostics] = React.useState<string>();
  const [warning, setWarning] = React.useState<string>();

  const endpoint = node.status === "running" ? node.endpoint : undefined;

  React.useEffect(() => {
    if (!endpoint) {
      return;
    }

    let connectPending = false;
    let disposed = false;

    const refreshConnectedPeers = () => {
      setConnectedPeers(endpoint.connectedPeers());
    };
    const refreshDiagnostics = () => {
      try {
        const reservation = endpoint.activeReservation();
        const connected = endpoint.connectedPeers();
        const path = endpoint.path(targetPeerId);
        const pathLabel =
          path?.kind === "relayed"
            ? `relayed via ${path.relayPeerId.slice(0, 8)}`
            : (path?.kind ?? "none");

        setDiagnostics(
          `relay debug · ${reservation ? "reserved" : "pending"} · ${IS_ANDROID_CONNECTOR ? "Android connector" : "iOS listener"} · target ${targetPeerId.slice(0, 12)} · connected ${connected.length} · path ${pathLabel}`
        );
      } catch (error) {
        setDiagnostics(`relay debug unavailable: ${errorMessage(error)}`);
      }
    };
    const connectTarget = async () => {
      if (
        !IS_ANDROID_CONNECTOR ||
        disposed ||
        connectPending ||
        endpoint.activeReservation() === undefined ||
        endpoint.connectedPeers().includes(targetPeerId)
      ) {
        return;
      }

      connectPending = true;
      try {
        await endpoint.connect(targetPeerId, { timeoutMs: 12_000 });
        if (!disposed) {
          setWarning(undefined);
        }
      } catch (error) {
        if (!disposed) {
          setWarning(`Relay connect retrying: ${errorMessage(error)}`);
        }
      } finally {
        connectPending = false;
        if (!disposed) {
          refreshConnectedPeers();
          refreshDiagnostics();
        }
      }
    };
    const keepPeerAlive = async (peerId: string) => {
      try {
        await endpoint.ping(peerId, { timeoutMs: 5000 });
      } catch {
        // Connection events provide the authoritative state after a miss.
      }
    };
    const unsubscribe = [
      endpoint.on("message", (event) => {
        if (!event.signed || !event.topics.includes(topic)) {
          return;
        }
        const message = decodeWireMessage(event.data);
        if (!message) {
          setWarning("Ignored an invalid chat payload");
          return;
        }
        onMessage({ ...message, fromPeerId: event.fromPeerId });
      }),
      endpoint.on("peerReady", ({ peerId }) => {
        setConnectedPeers((current) => addPeer(current, peerId));
        setWarning(undefined);
        refreshDiagnostics();
      }),
      endpoint.on("connectionEstablished", refreshDiagnostics),
      endpoint.on("connectionClosed", ({ peerId }) => {
        setConnectedPeers((current) => removePeer(current, peerId));
        setTopicPeers((current) => removePeer(current, peerId));
        refreshDiagnostics();
      }),
      endpoint.on("peerSubscribed", ({ peerId, topic: remoteTopic }) => {
        if (remoteTopic === topic) {
          setTopicPeers((current) => addPeer(current, peerId));
          setWarning(undefined);
        }
      }),
      endpoint.on("peerUnsubscribed", ({ peerId, topic: remoteTopic }) => {
        if (remoteTopic === topic) {
          setTopicPeers((current) => removePeer(current, peerId));
        }
      }),
      endpoint.on("queueOverflow", ({ dropped }) => {
        refreshConnectedPeers();
        setWarning(`Event queue overflowed; ${dropped} event(s) were dropped`);
      }),
      endpoint.on("endpointError", ({ detail }) => {
        setWarning(`Network error: ${detail}`);
      }),
      endpoint.on("driverFailed", ({ detail, kind }) => {
        setWarning(`minip2p ${kind} driver failed: ${detail}`);
        refreshDiagnostics();
      }),
      endpoint.on("relayReserved", () => {
        setWarning(undefined);
        refreshDiagnostics();
        void connectTarget();
      }),
      endpoint.on("relayReservationLost", () => {
        setWarning("Relay reservation lost; reconnecting…");
        refreshDiagnostics();
      }),
      endpoint.on("pathEstablished", refreshDiagnostics),
      endpoint.on("pathUpgraded", refreshDiagnostics),
      endpoint.on("fellBackToRelay", refreshDiagnostics),
      endpoint.on("holePunchFailed", ({ reason }) => {
        setWarning(`Hole punch failed; using relay: ${reason}`);
        refreshDiagnostics();
      }),
      endpoint.on("pubsubOutboundFailure", ({ reason }) => {
        setWarning(`Message forwarding failed: ${reason}`);
      }),
      endpoint.on("connectFailed", ({ detail }) => {
        setWarning(`Relay connection failed; retrying: ${detail}`);
        refreshDiagnostics();
      }),
    ];

    endpoint.subscribe(topic);
    refreshDiagnostics();
    void connectTarget();
    const diagnosticsPoll = setInterval(() => {
      refreshDiagnostics();
      void connectTarget();
    }, CONNECT_RETRY_INTERVAL_MS);
    const keepalive = setInterval(() => {
      for (const peerId of endpoint.connectedPeers()) {
        void keepPeerAlive(peerId);
      }
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(diagnosticsPoll);
      clearInterval(keepalive);
      for (const removeListener of unsubscribe) {
        removeListener();
      }
      if (endpoint.isRunning()) {
        endpoint.unsubscribe(topic);
      }
    };
  }, [endpoint, onMessage, targetPeerId, topic]);

  const publish = React.useCallback(
    (text: string): WireChatMessage => {
      const trimmed = text.trim();
      if (!endpoint) {
        throw new Error("minip2p is not running");
      }
      if (topicPeers.length === 0) {
        throw new Error("No peer is ready in this chat yet");
      }
      if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`Messages must be 1–${MAX_MESSAGE_LENGTH} characters`);
      }

      const sentAt = Date.now();
      const message: WireChatMessage = {
        id: `${node.peerId}-${sentAt}-${Math.random().toString(36).slice(2, 8)}`,
        sentAt,
        text: trimmed,
        version: 1,
      };
      try {
        endpoint.publish(topic, JSON.stringify(message));
        setWarning(undefined);
        return message;
      } catch (error) {
        setWarning(`Could not queue message: ${errorMessage(error)}`);
        throw error;
      }
    },
    [endpoint, node, topic, topicPeers.length]
  );

  if (node.status === "starting") {
    return {
      canPublish: false,
      label: "Starting minip2p…",
      publish,
      status: "starting",
    };
  }
  if (node.status === "failed") {
    return {
      canPublish: false,
      label: `minip2p failed: ${errorMessage(node.error)}`,
      publish,
      status: "failed",
    };
  }
  if (node.status === "closed") {
    return {
      canPublish: false,
      label: "minip2p endpoint closed",
      publish,
      status: "closed",
    };
  }
  if (warning) {
    return {
      canPublish: topicPeers.length > 0,
      diagnostics,
      label: warning,
      peerId: node.peerId,
      publish,
      status: "connecting",
    };
  }
  if (topicPeers.length > 0) {
    const path = endpoint?.path(targetPeerId);
    let pathLabel = "P2P · inbound path unreported";
    if (path?.kind === "relayed") {
      pathLabel = "relayed P2P";
    } else if (path?.kind === "directPunched") {
      pathLabel = "hole-punched P2P";
    } else if (path?.kind === "directDialed") {
      pathLabel = "direct P2P";
    }
    return {
      canPublish: true,
      diagnostics,
      label: `${topicPeers.length} peer${topicPeers.length === 1 ? "" : "s"} ready · ${pathLabel}`,
      peerId: node.peerId,
      publish,
      status: "ready",
    };
  }
  if (connectedPeers.includes(targetPeerId)) {
    return {
      canPublish: false,
      diagnostics,
      label: "Peer connected · joining chat…",
      peerId: node.peerId,
      publish,
      status: "connecting",
    };
  }
  if (endpoint?.activeReservation()) {
    return {
      canPublish: false,
      diagnostics,
      label: IS_ANDROID_CONNECTOR
        ? "Relay reserved · connecting to iOS…"
        : "Relay reserved · waiting for Android…",
      peerId: node.peerId,
      publish,
      status: "connecting",
    };
  }
  return {
    canPublish: false,
    diagnostics,
    label: "Reserving AWS relay…",
    peerId: node.peerId,
    publish,
    status: "searching",
  };
};

export { useMinip2pChat };
export type { ReceivedChatMessage, UseMinip2pChatResult, WireChatMessage };
