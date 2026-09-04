import { FlashList } from "@shopify/flash-list";
import type { ListRenderItem } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { Plus } from "lucide-react-native";
import * as React from "react";
import { View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { useResolveClassNames } from "uniwind";

import { Button } from "@/components/ui/button";
import { ChatRow } from "@/components/ui/chat-row";
import { ChatSearch } from "@/components/ui/chat-search";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { listConversations } from "@/lib/db";
import type { Conversation } from "@/lib/db";
import { useP2pStore } from "@/lib/p2p-store";

// oxlint-disable react/todo -- The opening guard must reset after navigation completes or rejects.

const conversationKey = ({ qid }: Conversation) => qid;

const formatConversationTime = (timestamp: number | null) => {
  if (!timestamp) {
    return;
  }
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
};

const ChatsScreen = () => {
  const isOpeningConversation = React.useRef(false);
  const [query, setQuery] = React.useState("");
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const connectedPeerIds = useP2pStore((state) => state.connectedPeerIds);
  const revision = useP2pStore((state) => state.revision);
  const contentContainerStyle = useResolveClassNames("pb-24");

  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      const load = async (_revision: number) => {
        try {
          const rows = await listConversations();
          if (active) {
            setConversations(rows);
          }
        } finally {
          if (active) {
            setLoaded(true);
          }
        }
      };
      void load(revision);
      return () => {
        active = false;
      };
    }, [revision])
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredConversations = React.useMemo(
    () =>
      conversations.filter(({ handle, latestMessageText }) =>
        [handle, latestMessageText]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
      ),
    [conversations, normalizedQuery]
  );
  const openConversation = React.useCallback(async (item: Conversation) => {
    if (isOpeningConversation.current) {
      return;
    }
    isOpeningConversation.current = true;
    try {
      await KeyboardController.dismiss();
      router.push({ params: { id: item.qid }, pathname: "/chat/[id]" });
    } finally {
      isOpeningConversation.current = false;
    }
  }, []);
  const renderConversation = React.useCallback<ListRenderItem<Conversation>>(
    ({ index, item }) => (
      <ChatRow
        avatarFallback={item.handle.slice(0, 2).toUpperCase()}
        name={`@${item.handle}`}
        online={connectedPeerIds.includes(item.peerId)}
        onPress={() => openConversation(item)}
        preview={item.latestMessageText ?? "No messages yet"}
        security={item.keyChanged ? "changed" : undefined}
        showSeparator={index < filteredConversations.length - 1}
        time={formatConversationTime(item.latestMessageTime)}
        unreadCount={item.unreadCount}
      />
    ),
    [connectedPeerIds, filteredConversations.length, openConversation]
  );

  const listHeader = React.useMemo(
    () => (
      <View className="gap-4 px-5 pt-10 pb-4">
        <View className="flex-row items-start justify-between gap-4">
          <View className="min-w-0 flex-1 gap-1">
            <Text variant="title">Chats</Text>
            <Text className="text-foreground-secondary" variant="caption">
              Direct conversations with your peers.
            </Text>
          </View>
          <Button
            onPress={() => router.push("../new-chat")}
            size="sm"
            variant="ghost"
          >
            <Icon as={Plus} className="size-4" />
            <Text>New chat</Text>
          </Button>
        </View>
        <ChatSearch onChangeText={setQuery} value={query} />
      </View>
    ),
    [query]
  );

  const empty = React.useMemo(() => {
    if (!loaded) {
      return null;
    }
    if (conversations.length > 0) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No chats found</EmptyTitle>
            <EmptyDescription>
              Try a handle or a word from a recent message.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No chats yet</EmptyTitle>
          <EmptyDescription>Find someone by their handle.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }, [conversations.length, loaded]);

  return (
    <View className="bg-background flex-1">
      <FlashList
        contentContainerStyle={contentContainerStyle}
        contentInsetAdjustmentBehavior="automatic"
        data={filteredConversations}
        keyboardDismissMode={
          process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
        }
        keyboardShouldPersistTaps="handled"
        keyExtractor={conversationKey}
        ListEmptyComponent={empty}
        ListHeaderComponent={listHeader}
        renderItem={renderConversation}
      />
    </View>
  );
};

export default ChatsScreen;
