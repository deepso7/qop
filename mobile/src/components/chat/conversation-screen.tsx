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
              time={timeFormatter.format(new Date(item.sentAt))}
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
  const focused = React.useRef(false);
  const connectedPeerIds = useP2pStore((state) => state.connectedPeerIds);
  const connectTo = useP2pStore((state) => state.connectTo);
  const retryMessage = useP2pStore((state) => state.retryMessage);
  const revision = useP2pStore((state) => state.revision);
  const sendMessage = useP2pStore((state) => state.sendMessage);
  const status = useP2pStore((state) => state.status);

  const refresh = React.useCallback(
    async (_revision?: number) => {
      if (focused.current) {
        await markConversationRead(contact.qid);
      }
      setMessages(await listMessages(contact.qid));
    },
    [contact.qid]
  );

  useFocusEffect(
    React.useCallback(() => {
      focused.current = true;
      void refresh();
      return () => {
        focused.current = false;
      };
    }, [refresh])
  );

  React.useEffect(() => {
    if (focused.current) {
      void refresh(revision);
    }
  }, [refresh, revision]);

  React.useEffect(() => {
    void connectTo(contact.peerId);
  }, [connectTo, contact.peerId]);

  const retry = React.useCallback(
    (id: string) => {
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
    setDraft("");
    void sendMessage(contact, text);
  }, [contact, draft, sendMessage, status]);

  const reachable = connectedPeerIds.includes(contact.peerId);
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
      <MessageScroller
        contentClassName="gap-0 px-4 py-3"
        data={messages}
        followOutput
        getMessageId={getMessageId}
        ItemSeparatorComponent={ConversationSeparator}
        ListEmptyComponent={EmptyConversation}
        renderItem={renderItem}
      />
      <Animated.View
        className="border-border bg-background border-t px-3 pt-2"
        style={composerStyle}
      >
        <ChatComposer className="border-0 p-0">
          <ChatComposerButton disabled kind="add" />
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
