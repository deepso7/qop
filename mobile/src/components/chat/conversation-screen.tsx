import type { ListRenderItem } from "@shopify/flash-list";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
  Copy,
  Forward,
  MoreHorizontal,
  Reply,
  Star,
  Trash2,
} from "lucide-react-native";
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
  Message,
  MessageBubble,
  MessageContent,
  MessageDate,
  MessageLongPressMenu,
  MessageMeta,
  MessageReply,
  MessageReaction,
  MessageReactions,
  MessageSystem,
  MessageTyping,
} from "@/components/ui/message";
import type { MessageAction } from "@/components/ui/message";
import { MessageScroller } from "@/components/ui/message-scroller";
import { Text } from "@/components/ui/text";
import { useMinip2pChat } from "@/hooks/use-minip2p-chat";
import type { ReceivedChatMessage } from "@/hooks/use-minip2p-chat";

type DeliveryStatus = "read" | "sending" | "sent";

interface ChatMessage {
  id: string;
  kind: "message";
  outgoing: boolean;
  reactions?: string[];
  reply?: { author: string; preview: string };
  status?: DeliveryStatus;
  text: string;
  time: string;
}

interface ChatDate {
  id: string;
  kind: "date";
  text: string;
}

interface ChatSystemMessage {
  id: string;
  kind: "system";
  text: string;
}

interface ChatTyping {
  id: string;
  kind: "typing";
}

type ConversationItem = ChatDate | ChatMessage | ChatSystemMessage | ChatTyping;

const initialMessages: ConversationItem[] = [
  { id: "date-today", kind: "date", text: "Today" },
  {
    id: "poc-notice",
    kind: "system",
    text: "Relay-backed minip2p POC · messages are not persisted",
  },
];

const messageActions: MessageAction[] = [
  { icon: Reply, id: "reply", label: "Reply" },
  { icon: Forward, id: "forward", label: "Forward" },
  { icon: Copy, id: "copy", label: "Copy" },
  { icon: Star, id: "star", label: "Star" },
  { destructive: true, icon: Trash2, id: "delete", label: "Delete" },
  {
    icon: MoreHorizontal,
    id: "more",
    label: "More…",
    separatorBefore: true,
  },
];

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const getMessageId = ({ id }: ConversationItem) => id;
const getItemType = ({ kind }: ConversationItem) => kind;
const ConversationSeparator = () => <View className="h-2.5" />;

interface ConversationMessageProps {
  item: ChatMessage;
  onReaction: (messageId: string, emoji: string) => void;
}

const ConversationMessage = ({
  item,
  onReaction,
}: ConversationMessageProps) => {
  const align = item.outgoing ? "end" : "start";
  const handleReaction = React.useCallback(
    (emoji: string) => onReaction(item.id, emoji),
    [item.id, onReaction]
  );

  return (
    <Message align={align}>
      <MessageContent>
        <MessageLongPressMenu
          accessibilityLabel={`Open actions for ${item.text}`}
          actions={messageActions}
          align={align}
          onReaction={handleReaction}
        >
          <MessageBubble tone={item.outgoing ? "outgoing" : "incoming"}>
            {item.reply ? (
              <MessageReply
                author={item.reply.author}
                preview={item.reply.preview}
              />
            ) : null}
            <Text selectable>{item.text}</Text>
            <MessageMeta status={item.status} time={item.time} />
          </MessageBubble>
        </MessageLongPressMenu>
        {item.reactions?.length ? (
          <MessageReactions>
            {item.reactions.map((emoji) => (
              <MessageReaction emoji={emoji} key={emoji} />
            ))}
          </MessageReactions>
        ) : null}
      </MessageContent>
    </Message>
  );
};

interface ConversationScreenProps {
  conversationId: string;
  peerName: string;
}

const ConversationScreen = ({
  conversationId,
  peerName,
}: ConversationScreenProps) => {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const [draft, setDraft] = React.useState("");
  const [messages, setMessages] = React.useState(initialMessages);

  const receiveMessage = React.useCallback((message: ReceivedChatMessage) => {
    const id = `${message.fromPeerId}:${message.id}`;
    setMessages((current) => {
      if (current.some((item) => item.id === id)) {
        return current;
      }
      return [
        ...current,
        {
          id,
          kind: "message",
          outgoing: false,
          text: message.text,
          time: timeFormatter.format(new Date(message.sentAt)),
        },
      ];
    });
  }, []);
  const p2p = useMinip2pChat(conversationId, receiveMessage);
  const { canPublish, diagnostics, label, peerId, publish, status } = p2p;

  const addReaction = React.useCallback((messageId: string, emoji: string) => {
    setMessages((current) =>
      current.map((item) => {
        if (item.kind !== "message" || item.id !== messageId) {
          return item;
        }
        const reactions = item.reactions ?? [];
        return reactions.includes(emoji)
          ? item
          : { ...item, reactions: [...reactions, emoji] };
      })
    );
  }, []);

  const renderItem = React.useCallback<ListRenderItem<ConversationItem>>(
    ({ item }) => {
      if (item.kind === "date") {
        return <MessageDate>{item.text}</MessageDate>;
      }
      if (item.kind === "system") {
        return <MessageSystem>{item.text}</MessageSystem>;
      }
      if (item.kind === "typing") {
        return <MessageTyping label={`${peerName} is typing`} />;
      }
      return <ConversationMessage item={item} onReaction={addReaction} />;
    },
    [addReaction, peerName]
  );

  const sendMessage = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    let published;
    try {
      published = publish(text);
    } catch {
      return;
    }
    setMessages((current) => [
      ...current,
      {
        id: published.id,
        kind: "message",
        outgoing: true,
        status: "sent",
        text: published.text,
        time: timeFormatter.format(new Date(published.sentAt)),
      },
    ]);
    setDraft("");
  };

  const canSend = draft.trim().length > 0 && canPublish;
  let statusIndicatorClassName = "size-2 rounded-full bg-amber-500";
  if (status === "ready") {
    statusIndicatorClassName = "size-2 rounded-full bg-green-500";
  } else if (status === "failed" || status === "closed") {
    statusIndicatorClassName = "bg-destructive size-2 rounded-full";
  }
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
      className="flex-1 bg-background"
      keyboardVerticalOffset={headerHeight}
    >
      <View className="border-border gap-1 border-b px-4 py-2">
        <View className="flex-row items-center gap-2">
          <View className={statusIndicatorClassName} />
          <Text
            className="text-foreground-secondary min-w-0 flex-1 text-xs"
            numberOfLines={1}
            selectable
          >
            {label}
          </Text>
          {peerId ? (
            <Text
              className="text-foreground-secondary text-xs opacity-60"
              selectable
            >
              {peerId.slice(0, 8)}
            </Text>
          ) : null}
        </View>
        {diagnostics ? (
          <Text
            className="text-foreground-secondary font-mono text-[10px] opacity-70"
            numberOfLines={3}
            selectable
          >
            {diagnostics}
          </Text>
        ) : null}
      </View>
      <MessageScroller
        contentClassName="gap-0 px-4 py-3"
        data={messages}
        followOutput
        getItemType={getItemType}
        getMessageId={getMessageId}
        ItemSeparatorComponent={ConversationSeparator}
        renderItem={renderItem}
      />
      <Animated.View
        className="border-border border-t bg-background px-3 pt-2"
        style={composerStyle}
      >
        <ChatComposer className="border-0 p-0">
          <ChatComposerButton kind="add" />
          <ChatComposerInput
            accessibilityLabel="Message"
            onChangeText={setDraft}
            onSubmitEditing={sendMessage}
            value={draft}
          />
          <ChatComposerButton disabled={!canSend} onPress={sendMessage} />
        </ChatComposer>
      </Animated.View>
    </KeyboardAvoidingView>
  );
};

export { ConversationScreen };
