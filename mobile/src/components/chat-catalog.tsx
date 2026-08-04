import {
  Copy,
  Forward,
  MessageCircle,
  MoreHorizontal,
  Reply,
  Star,
  Trash2,
} from "lucide-react-native";
import * as React from "react";
import { View } from "react-native";

import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerInput,
  ChatRecording,
} from "@/components/ui/chat-composer";
import {
  Message,
  MessageAttachment,
  MessageBubble,
  MessageContent,
  MessageDate,
  MessageFooter,
  MessageGroup,
  MessageLongPressMenu,
  MessageMeta,
  MessageReply,
  MessageReaction,
  MessageReactionAdd,
  MessageReactionPicker,
  MessageReactionPickerItem,
  MessageReactions,
  MessageReactor,
  MessageReactors,
  MessageStatus,
  MessageSystem,
  MessageTyping,
} from "@/components/ui/message";
import type { MessageAction } from "@/components/ui/message";
import { SectionLabel } from "@/components/ui/section-label";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Icon } from "@/components/ui/icon";
import {
  MessageScroller,
  type MessageScrollerHandle,
} from "@/components/ui/message-scroller";

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

type ScrollerMessage = {
  id: string;
  outgoing: boolean;
  text: string;
};

const initialScrollerMessages: ScrollerMessage[] = [
  { id: "demo-1", outgoing: false, text: "connected directly" },
  { id: "demo-2", outgoing: true, text: "checking the route" },
  { id: "demo-3", outgoing: false, text: "relay is idle" },
  { id: "demo-4", outgoing: true, text: "sending the payload" },
  { id: "demo-5", outgoing: false, text: "payload received" },
  { id: "demo-6", outgoing: true, text: "great — staying p2p" },
];

const ChatCatalog = () => {
  const scrollerRef = React.useRef<MessageScrollerHandle>(null);
  const [scrollerMessages, setScrollerMessages] = React.useState(
    initialScrollerMessages
  );

  const appendScrollerMessage = () => {
    setScrollerMessages((messages) => [
      ...messages,
      {
        id: `demo-${messages.length + 1}`,
        outgoing: messages.length % 2 === 0,
        text: `new message ${messages.length + 1}`,
      },
    ]);
  };

  return (
  <View className="gap-7">
    <View className="gap-3">
      <SectionLabel>Message bubbles</SectionLabel>
      <View className="border-border gap-3 rounded-[22px] border p-4">
        <MessageDate>Today</MessageDate>

        <MessageGroup>
          <Message>
            <MessageContent>
              <MessageBubble position="first">
                <Text selectable>did the handshake land on your side?</Text>
              </MessageBubble>
            </MessageContent>
          </Message>
          <Message>
            <MessageContent>
              <MessageBubble position="last">
                <Text selectable>grouped follow-up, tighter corner</Text>
                <MessageMeta time="8:13" />
              </MessageBubble>
            </MessageContent>
          </Message>
        </MessageGroup>

        <Message align="end">
          <MessageContent>
            <MessageBubble tone="outgoing">
              <Text selectable>yes — straight p2p, no relay</Text>
              <MessageMeta status="sent" time="8:14" />
            </MessageBubble>
          </MessageContent>
        </Message>

        <Message align="end">
          <MessageContent>
            <MessageBubble tone="pending">
              <Text className="text-foreground-secondary" selectable>
                sending…
              </Text>
              <MessageMeta status="sending" time="8:14" />
            </MessageBubble>
          </MessageContent>
        </Message>

        <Message align="end">
          <MessageContent>
            <MessageBubble tone="failed">
              <Text selectable>couldn’t reach peer</Text>
            </MessageBubble>
            <MessageFooter>
              <MessageStatus label="Not sent · Tap to retry" tone="failed" />
            </MessageFooter>
          </MessageContent>
        </Message>

        <Message>
          <MessageContent>
            <MessageBubble>
              <MessageReply
                author="You"
                preview="yes — straight p2p, no relay"
              />
              <Text selectable>then we can drop the relay entirely</Text>
            </MessageBubble>
          </MessageContent>
        </Message>

        <MessageAttachment
          name="payload-test.png"
          preview={
            <View className="bg-background-selected flex-1 items-center justify-center">
              <Text className="text-foreground-secondary" variant="mono">
                image attachment
              </Text>
            </View>
          }
          size="240 KB"
        />

        <MessageTyping />
        <MessageSystem>Aisha’s keys changed · verify again</MessageSystem>
      </View>
    </View>

    <View className="gap-3">
      <SectionLabel>Reactions</SectionLabel>
      <View className="border-border gap-5 rounded-[22px] border p-4">
        <Message>
          <MessageContent>
            <MessageLongPressMenu actions={messageActions} align="start">
              <MessageBubble>
                <Text>relay fallback shipped 🎉</Text>
                <MessageMeta time="8:15" />
              </MessageBubble>
            </MessageLongPressMenu>
            <MessageReactions>
              <MessageReaction emoji="🎉" />
              <MessageReaction emoji="🔥" />
            </MessageReactions>
          </MessageContent>
        </Message>

        <Message align="end">
          <MessageContent>
            <MessageLongPressMenu actions={messageActions} align="end">
              <MessageBubble tone="outgoing">
                <Text>no relay in the path now</Text>
                <MessageMeta status="read" time="8:16" />
              </MessageBubble>
            </MessageLongPressMenu>
            <MessageReactions>
              <MessageReaction emoji="👏" selected />
              <MessageReactionAdd />
            </MessageReactions>
          </MessageContent>
        </Message>

        <View className="gap-2">
          <Text className="text-foreground-secondary" variant="caption">
            Picker · touch and hold the outgoing bubble
          </Text>
          <MessageReactionPicker>
            {["👍", "❤️", "😂", "🎉", "🙏"].map((emoji) => (
              <MessageReactionPickerItem emoji={emoji} key={emoji} />
            ))}
            <MessageReactionAdd className="bg-background-selected border-0" />
          </MessageReactionPicker>
        </View>

        <View className="gap-2">
          <Text className="text-foreground-secondary" variant="caption">
            Who reacted
          </Text>
          <MessageReactors>
            <MessageReactor emoji="🎉" meta="8:15" name="Aisha K." />
            <MessageReactor emoji="🎉" meta="8:16" name="Ravi" />
            <MessageReactor
              actionLabel="Remove"
              emoji="🔥"
              name="You"
              showSeparator={false}
            />
          </MessageReactors>
        </View>
      </View>
    </View>

    <View className="gap-3">
      <SectionLabel>Message scroller</SectionLabel>
      <View className="border-border h-64 overflow-hidden rounded-[22px] border">
        <MessageScroller
          data={scrollerMessages}
          followOutput
          getMessageId={(item) => item.id}
          initialMessageId="demo-3"
          nestedScrollEnabled
          newMessageCount={1}
          ref={scrollerRef}
          renderItem={({ item }) => (
            <Message align={item.outgoing ? "end" : "start"}>
              <MessageContent>
                <MessageBubble tone={item.outgoing ? "outgoing" : "incoming"}>
                  <Text>{item.text}</Text>
                </MessageBubble>
              </MessageContent>
            </Message>
          )}
        />
      </View>
      <View className="flex-row gap-2">
        <Button className="flex-1" onPress={appendScrollerMessage} size="sm" variant="outline">
          <Text>Add message</Text>
        </Button>
        <Button
          className="flex-1"
          onPress={() => scrollerRef.current?.scrollToLatest()}
          size="sm"
          variant="outline"
        >
          <Text>Jump to latest</Text>
        </Button>
      </View>
    </View>

    <View className="gap-3">
      <SectionLabel>Empty conversation</SectionLabel>
      <Empty className="min-h-64" variant="outline">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon as={MessageCircle} className="text-foreground-secondary size-6" />
          </EmptyMedia>
          <EmptyTitle>No messages yet</EmptyTitle>
          <EmptyDescription>
            Say hello — the connection is direct, so both of you need to be
            online.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button>
            <Text>Send a first message</Text>
          </Button>
        </EmptyContent>
      </Empty>
    </View>

    <View className="gap-3">
      <SectionLabel>Composer</SectionLabel>
      <View className="border-border gap-3 rounded-[22px] border p-4">
        <ChatComposer className="border-0 p-0">
          <ChatComposerButton kind="add" />
          <ChatComposerInput multiline={false} />
          <ChatComposerButton />
        </ChatComposer>

        <ChatComposer className="border-0 p-0">
          <ChatComposerButton kind="add" />
          <ChatComposerInput defaultValue="going to send the new build over now, should be a few" />
          <ChatComposerButton />
        </ChatComposer>

        <ChatComposer className="border-0 p-0">
          <ChatComposerButton disabled kind="add" />
          <ChatComposerInput
            editable={false}
            placeholder="Verify keys to send"
          />
          <ChatComposerButton disabled />
        </ChatComposer>

        <ChatComposer className="border-0 p-0">
          <ChatRecording duration="0:07" />
          <ChatComposerButton kind="stop" />
        </ChatComposer>
      </View>
    </View>
  </View>
  );
};

export { ChatCatalog };
