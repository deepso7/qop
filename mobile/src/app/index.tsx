import { FlashList } from "@shopify/flash-list";
import type { ListRenderItem } from "@shopify/flash-list";
import * as React from "react";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { ChatRow } from "@/components/ui/chat-row";
import type { ChatRowProps } from "@/components/ui/chat-row";
import { ChatSearch } from "@/components/ui/chat-search";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";

interface Conversation extends ChatRowProps {
  id: string;
}

const conversations: Conversation[] = [
  {
    avatarFallback: "AK",
    id: "aisha",
    name: "Aisha K.",
    online: true,
    preview: "sent the keys — check when you’re free",
    security: "verified",
    time: "2m",
    unreadCount: 3,
  },
  {
    group: true,
    id: "minip2p-devs",
    name: "minip2p devs",
    preview: "relay fallback shipped 🎉 — ready to test",
    previewAuthor: "Ravi",
    time: "18m",
  },
  {
    avatarFallback: "D",
    draft: true,
    id: "devon",
    name: "Devon",
    preview: "sounds good, let’s do it",
    security: "changed",
    time: "1h",
  },
  {
    avatarFallback: "M",
    id: "mum",
    name: "Mum",
    preview: "Offline · last seen Tuesday",
    security: "unverified",
  },
];

const renderConversation: ListRenderItem<Conversation> = ({ item }) => (
  <ChatRow {...item} showSeparator={false} />
);

const conversationKey = ({ id }: Conversation) => id;

const ConversationSeparator = () => <Separator className="ml-21 w-auto" />;

const NoSearchResults = () => (
  <View className="items-center gap-1 px-6 py-12">
    <Text className="font-semibold">No chats found</Text>
    <Text className="text-center text-foreground-secondary" variant="caption">
      Try a name or a word from a recent message.
    </Text>
  </View>
);

const HomeScreen = () => {
  const [query, setQuery] = React.useState("");
  const contentContainerStyle = useResolveClassNames("pb-24");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredConversations = React.useMemo(
    () =>
      conversations.filter(({ name, preview, previewAuthor }) =>
        [name, preview, previewAuthor]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
      ),
    [normalizedQuery]
  );

  const listHeader = React.useMemo(
    () => (
      <View className="gap-4 px-5 pt-10 pb-4">
        <View className="gap-1">
          <Text variant="title">Chats</Text>
          <Text className="text-foreground-secondary" variant="caption">
            Direct conversations with your peers.
          </Text>
        </View>
        <ChatSearch onChangeText={setQuery} value={query} />
      </View>
    ),
    [query]
  );

  return (
    <View className="flex-1 bg-background">
      <FlashList
        contentContainerStyle={contentContainerStyle}
        contentInsetAdjustmentBehavior="automatic"
        data={filteredConversations}
        ItemSeparatorComponent={ConversationSeparator}
        keyboardDismissMode={
          process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
        }
        keyboardShouldPersistTaps="handled"
        keyExtractor={conversationKey}
        ListEmptyComponent={NoSearchResults}
        ListHeaderComponent={listHeader}
        renderItem={renderConversation}
      />
    </View>
  );
};

export default HomeScreen;
