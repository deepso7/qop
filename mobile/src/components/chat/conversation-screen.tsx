import type { ListRenderItem } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router";
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
  return {
    metaStatus: item.status === "sent" ? ("sent" as const) : undefined,
    outgoing,
    tone: outgoing ? ("outgoing" as const) : ("incoming" as const),
  };
};

const ConversationMessage = React.memo(
  // oxlint-disable-next-line eslint/prefer-arrow-callback -- A name keeps the memoized row identifiable in DevTools.
  function ConversationMessage({
    item,
    retry,
  }: {
    item: StoredMessage;
    retry: (id: string) => void;
  }) {
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
        </MessageContent>
      </Message>
    );
  }
);
ConversationMessage.displayName = "ConversationMessage";

const EmptyConversation = () => (
  <Empty className="min-h-64">
    <EmptyHeader>
      <EmptyTitle>No messages yet</EmptyTitle>
      <EmptyDescription>Send the first message.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

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
  // Dial may resolve a newer peerId than the persisted contact after device-key rotation.
  const [dialPeerId, setDialPeerId] = React.useState(contact.peerId);
  const connectedPeerIds = useP2pStore((state) => state.connectedPeerIds);
  const connectTo = useP2pStore((state) => state.connectTo);
  const retryMessage = useP2pStore((state) => state.retryMessage);
  const revision = useP2pStore((state) => state.revision);
  const sendMessage = useP2pStore((state) => state.sendMessage);
  const status = useP2pStore((state) => state.status);

  React.useEffect(() => {
    setDialPeerId(contact.peerId);
  }, [contact.peerId]);

  // Mark read once per focus — not on every global revision bump.
  useFocusEffect(
    React.useCallback(() => {
      void markConversationRead(contact.qid).catch(() => {
        // Reachability/message load still proceed if the read cursor write fails.
      });
    }, [contact.qid])
  );

  // revision is process-global (any chat send/receive). Reloading here keeps the
  // focused thread live; scoped invalidation would need store support.
  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      const refresh = async () => {
        try {
          const rows = await listMessages(contact.qid);
          if (active) {
            setMessages(rows);
            setLoadError(false);
          }
        } catch {
          if (active) {
            setLoadError(true);
          }
        }
      };
      void refresh();
      return () => {
        active = false;
      };
    }, [contact.qid, revision, retryCount])
  );

  const reachable = connectedPeerIds.includes(dialPeerId);
  // Redial when focus is active, P2P is up, and this peer is not connected.
  useFocusEffect(
    React.useCallback(() => {
      if (status !== "running" || reachable) {
        return;
      }
      let cancelled = false;
      void (async () => {
        const peerId = await connectTo({
          handle: contact.handle,
          qid: contact.qid,
        });
        if (!cancelled && peerId) {
          setDialPeerId(peerId);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [
      connectTo,
      contact.handle,
      contact.qid,
      reachable,
      status,
    ])
  );

  const retry = React.useCallback(
    (id: string) => {
      void selectionHaptic();
      void retryMessage(id);
    },
    [retryMessage]
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

  const unavailable = status === "failed" || status === "stopped";
  let statusLabel = "Not connected";
  let statusClassName = "bg-amber-500";
  if (unavailable) {
    statusLabel = "P2P unavailable";
    statusClassName = "bg-destructive";
  } else if (reachable) {
    statusLabel = "Reachable";
    statusClassName = "bg-green-500";
  }
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
      <View className="border-border flex-row items-center gap-2 border-b px-4 py-2">
        <View className={`size-2 rounded-full ${statusClassName}`} />
        <Text className="text-foreground-secondary text-xs" selectable>
          {statusLabel}
        </Text>
      </View>
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
