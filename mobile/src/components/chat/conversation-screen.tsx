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
  { id: "date-yesterday", kind: "date", text: "Yesterday" },
  {
    id: "message-yesterday-1",
    kind: "message",
    outgoing: false,
    text: "I pushed the transport changes to the test branch.",
    time: "6:42 PM",
  },
  {
    id: "message-yesterday-2",
    kind: "message",
    outgoing: true,
    status: "read",
    text: "nice — I’ll run it on both devices",
    time: "6:45 PM",
  },
  {
    id: "message-yesterday-3",
    kind: "message",
    outgoing: false,
    text: "Try Wi-Fi first, then switch one phone to mobile data.",
    time: "6:46 PM",
  },
  {
    id: "message-yesterday-4",
    kind: "message",
    outgoing: false,
    text: "That should force the relay path without restarting the session.",
    time: "6:47 PM",
  },
  {
    id: "message-yesterday-5",
    kind: "message",
    outgoing: true,
    status: "read",
    text: "direct path works — switching networks now",
    time: "6:51 PM",
  },
  {
    id: "message-yesterday-6",
    kind: "message",
    outgoing: true,
    status: "read",
    text: "connection recovered in about two seconds",
    time: "6:52 PM",
  },
  {
    id: "message-yesterday-7",
    kind: "message",
    outgoing: false,
    reactions: ["👍"],
    text: "Perfect. I’ll clean up the debug logs before the next build.",
    time: "6:54 PM",
  },
  {
    id: "session-secured",
    kind: "system",
    text: "Session secured with end-to-end encryption",
  },
  { id: "date-today", kind: "date", text: "Today" },
  {
    id: "message-1",
    kind: "message",
    outgoing: false,
    text: "did the handshake land on your side?",
    time: "8:13",
  },
  {
    id: "message-2",
    kind: "message",
    outgoing: false,
    reactions: ["🎉", "🔥"],
    text: "relay fallback shipped 🎉",
    time: "8:14",
  },
  {
    id: "message-3",
    kind: "message",
    outgoing: true,
    status: "read",
    text: "yes — straight p2p, no relay",
    time: "8:14",
  },
  {
    id: "message-4",
    kind: "message",
    outgoing: false,
    reply: { author: "You", preview: "yes — straight p2p, no relay" },
    text: "then we can drop the relay entirely",
    time: "8:15",
  },
  {
    id: "message-5",
    kind: "message",
    outgoing: true,
    reactions: ["👏"],
    status: "read",
    text: "no relay in the path now",
    time: "8:16",
  },
  {
    id: "keys-changed",
    kind: "system",
    text: "Aisha’s keys changed · verify again",
  },
  { id: "typing", kind: "typing" },
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
  peerName: string;
}

const ConversationScreen = ({ peerName }: ConversationScreenProps) => {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const [draft, setDraft] = React.useState("");
  const [messages, setMessages] = React.useState(initialMessages);

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

  const sendMessage = React.useCallback(() => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setMessages((current) => [
      ...current.filter((item) => item.kind !== "typing"),
      {
        id: `message-${Date.now()}`,
        kind: "message",
        outgoing: true,
        status: "sending",
        text,
        time: timeFormatter.format(new Date()),
      },
    ]);
    setDraft("");
  }, [draft]);

  const canSend = draft.trim().length > 0;
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
