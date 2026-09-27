import type { Path } from "@minip2p/react-native";
import type { ListRenderItem } from "@shopify/flash-list";
import { Effect, Fiber, Schedule } from "effect";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import * as React from "react";
import { View } from "react-native";
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  interpolate,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerInput,
} from "@/components/ui/chat-composer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Message,
  MessageBubble,
  MessageContent,
  MessageMeta,
  MessageStatus,
} from "@/components/ui/message";
import { MessageScroller } from "@/components/ui/message-scroller";
import { Text } from "@/components/ui/text";
import { listMessages, markConversationRead } from "@/lib/db";
import type { Contact, StoredMessage } from "@/lib/db";
import { selectionHaptic } from "@/lib/haptics";
import { useP2pStore } from "@/lib/p2p-store";

const REDIAL_INTERVAL_MS = 15_000;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const getMessageId = ({ id }: StoredMessage) => id;
const ConversationSeparator = () => <View className="h-2.5" />;

const getMessagePresentation = (item: StoredMessage) => {
  const outgoing = item.direction === "out";
  if (item.status === "failed") {
    return { metaStatus: undefined, outgoing, tone: "failed" as const };
  }
  if (item.status === "sending") {
    return {
      metaStatus: "sending" as const,
      outgoing,
      tone: "pending" as const,
    };
  }
  if (item.status === "held") {
    return {
      metaStatus: "sending" as const,
      outgoing,
      tone: "pending" as const,
    };
  }
  return {
    metaStatus: item.status === "sent" ? ("sent" as const) : undefined,
    outgoing,
    tone: outgoing ? ("outgoing" as const) : ("incoming" as const),
  };
};

const ConversationMessageRow = ({
  item,
  retry,
}: {
  item: StoredMessage;
  retry: (id: string) => void;
}) => {
  const { metaStatus, outgoing, tone } = getMessagePresentation(item);
  return (
    <Message align={outgoing ? "end" : "start"}>
      <MessageContent>
        <MessageBubble tone={tone}>
          <Text selectable>{item.text}</Text>
          <MessageMeta
            status={metaStatus}
            time={timeFormatter.format(new Date(item.receivedAt))}
          />
        </MessageBubble>
        {item.status === "failed" ? (
          <MessageStatus
            label="Not sent · Tap to retry"
            onPress={() => retry(item.id)}
            tone="failed"
          />
        ) : null}
        {item.status === "held" ? (
          <MessageStatus disabled label="Waiting on your CLI" />
        ) : null}
      </MessageContent>
    </Message>
  );
};
const ConversationMessage = React.memo(ConversationMessageRow);
ConversationMessage.displayName = "ConversationMessage";

const EmptyConversation = () => (
  <Empty className="min-h-64">
    <EmptyHeader>
      <EmptyTitle>No messages yet</EmptyTitle>
      <EmptyDescription>Send the first message.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

/** Header title: handle plus an "online" line while the contact is connected. */
const ConversationTitle = ({
  handle,
  online,
}: {
  handle: string;
  online: boolean;
}) => (
  <View className="items-center">
    <Text className="text-foreground text-[17px] font-semibold">@{handle}</Text>
    {online ? (
      <Text className="text-foreground-secondary text-xs">online</Text>
    ) : null}
  </View>
);

const pathLabel = (path: Path | undefined) => {
  switch (path?.kind) {
    case "directDialed": {
      return "Direct";
    }
    case "directPunched": {
      return "Direct (hole-punched)";
    }
    case "relayed": {
      return "Relayed";
    }
    default: {
      return "None";
    }
  }
};

const ConversationScreen = ({ contact }: { contact: Contact }) => {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const [draft, setDraft] = React.useState("");
  const [messages, setMessages] = React.useState<StoredMessage[]>([]);
  const [loadError, setLoadError] = React.useState(false);
  const [retryCount, retryLoad] = React.useReducer(
    (count: number) => count + 1,
    0
  );
  // A dial may resolve a newer peerId than the persisted contact after device-key rotation.
  const [dialTarget, setDialTarget] = React.useState(() => ({
    contactPeerId: contact.peerId,
    peerId: contact.peerId,
  }));
  const connectedPeerIds = useP2pStore((state) => state.connectedPeerIds);
  const connectTo = useP2pStore((state) => state.connectTo);
  const retryMessage = useP2pStore((state) => state.retryMessage);
  const revision = useP2pStore((state) => state.revision);
  const sendMessage = useP2pStore((state) => state.sendMessage);
  const status = useP2pStore((state) => state.status);
  const relayReserved = useP2pStore((state) => state.relayReserved);
  const peerPaths = useP2pStore((state) => state.peerPaths);
  const p2pError = useP2pStore((state) => state.error);
  const dialPeerId =
    dialTarget.contactPeerId === contact.peerId
      ? dialTarget.peerId
      : contact.peerId;

  // revision is process-global (any chat send/receive). Reloading here keeps the
  // focused thread live. Advance the read cursor only through messages that the
  // refresh loaded, so a concurrent arrival remains unread until the next refresh.
  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      const refresh = async (_revision: number, _retryCount: number) => {
        try {
          const rows = await listMessages(contact.qid);
          if (active) {
            setMessages(rows);
            setLoadError(false);
            const latestReceivedAt = rows.at(-1)?.receivedAt;
            if (latestReceivedAt !== undefined) {
              try {
                await markConversationRead(contact.qid, latestReceivedAt);
              } catch {
                // Message loading still succeeds if the read cursor write fails.
              }
            }
          }
        } catch {
          if (active) {
            setLoadError(true);
          }
        }
      };
      void refresh(revision, retryCount);
      return () => {
        active = false;
      };
    }, [contact.qid, revision, retryCount])
  );

  const reachable = connectedPeerIds.includes(dialPeerId);
  // While focused, P2P is up, and this peer is not connected, dial now and
  // again REDIAL_INTERVAL_MS after each attempt settles, so the header flips
  // to online soon after the contact opens qop. Blur or reconnect interrupts.
  useFocusEffect(
    React.useCallback(() => {
      if (status !== "running" || reachable) {
        return;
      }
      const fiber = Effect.runFork(
        Effect.promise(() =>
          connectTo({ handle: contact.handle, qid: contact.qid })
        ).pipe(
          Effect.tap((peerId) =>
            Effect.sync(() => {
              if (peerId) {
                setDialTarget({ contactPeerId: contact.peerId, peerId });
              }
            })
          ),
          Effect.repeat(Schedule.spaced(REDIAL_INTERVAL_MS))
        )
      );
      return () => {
        Effect.runFork(Fiber.interrupt(fiber));
      };
    }, [
      connectTo,
      contact.handle,
      contact.peerId,
      contact.qid,
      reachable,
      status,
    ])
  );

  const retry = React.useCallback(
    (id: string) => {
      void selectionHaptic();
      void retryMessage(id, contact.qid);
    },
    [contact.qid, retryMessage]
  );
  const renderItem = React.useCallback<ListRenderItem<StoredMessage>>(
    ({ item }) => <ConversationMessage item={item} retry={retry} />,
    [retry]
  );
  const submit = React.useCallback(() => {
    const text = draft.trim();
    if (!text || status !== "running") {
      return;
    }
    void selectionHaptic();
    setDraft("");
    void sendMessage(contact, text);
  }, [contact, draft, sendMessage, status]);

  let connectionLabel = "Not connected";
  if (status === "failed" || status === "stopped") {
    connectionLabel = "P2P unavailable";
  } else if (status === "starting") {
    connectionLabel = "Starting P2P";
  } else if (reachable) {
    connectionLabel = "Connected";
  }
  const copyPeerId = React.useCallback(async () => {
    await Clipboard.setStringAsync(dialPeerId);
  }, [dialPeerId]);
  const canSend = status === "running" && draft.trim().length > 0;
  const composerStyle = useAnimatedStyle(
    () => ({
      paddingBottom: interpolate(
        keyboardProgress.get(),
        [0, 1],
        [Math.max(insets.bottom, 8), 8]
      ),
    }),
    [insets.bottom]
  );

  return (
    <KeyboardAvoidingView
      behavior="height"
      className="bg-background flex-1"
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Title asChild>
        <ConversationTitle handle={contact.handle} online={reachable} />
      </Stack.Title>
      {/* Connection diagnostics stay out of the way behind the header menu. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" title="Connection">
          {/* Every row has an icon so iOS keeps titles aligned. */}
          <Stack.Toolbar.MenuAction
            disabled
            icon="antenna.radiowaves.left.and.right"
            subtitle={connectionLabel}
          >
            Status
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled
            icon="arrow.triangle.branch"
            subtitle={pathLabel(peerPaths[dialPeerId])}
          >
            Path
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            disabled
            icon="server.rack"
            subtitle={relayReserved ? "Reserved" : "Not reserved"}
          >
            Relay
          </Stack.Toolbar.MenuAction>
          {status === "failed" && p2pError ? (
            <Stack.Toolbar.MenuAction
              disabled
              icon="exclamationmark.triangle"
              subtitle={p2pError}
            >
              Error
            </Stack.Toolbar.MenuAction>
          ) : null}
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction
              icon="doc.on.doc"
              onPress={copyPeerId}
              subtitle={`…${dialPeerId.slice(-8)}`}
            >
              Copy peer ID
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {loadError ? (
        <View className="gap-3 p-4">
          <Text>Could not load messages.</Text>
          <Button onPress={retryLoad} variant="outline">
            <Text>Retry</Text>
          </Button>
        </View>
      ) : null}
      <MessageScroller
        contentClassName="gap-0 px-4 py-3"
        data={messages}
        followOutput
        getMessageId={getMessageId}
        ItemSeparatorComponent={ConversationSeparator}
        ListEmptyComponent={loadError ? null : EmptyConversation}
        renderItem={renderItem}
      />
      <Animated.View
        className="border-border bg-background border-t px-3 pt-2"
        style={composerStyle}
      >
        <ChatComposer className="border-0 p-0">
          <ChatComposerInput
            accessibilityLabel="Message"
            editable={status === "running"}
            maxLength={4000}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            value={draft}
          />
          <ChatComposerButton disabled={!canSend} onPress={submit} />
        </ChatComposer>
      </Animated.View>
    </KeyboardAvoidingView>
  );
};

export { ConversationScreen };
