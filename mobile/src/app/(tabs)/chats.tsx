import { FlashList } from "@shopify/flash-list";
import type { ListRenderItem } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { SquarePen } from "lucide-react-native";
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
import { useFocusLoad } from "@/hooks/use-focus-load";
import { listConversations } from "@/lib/db";
import type { Conversation } from "@/lib/db";
import { useP2pStore } from "@/lib/p2p-store";

const noPeers: readonly string[] = [];
const noRows: readonly Conversation[] = [];

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
  const [conversations, retryLoad] = useFocusLoad(listConversations);

  const connection = useP2pStore((state) => state.connection);
  const contentContainerStyle = useResolveClassNames("pb-24");

  const connectedPeerIds =
    connection.status === "running" ? connection.connectedPeerIds : noPeers;

  // Keep a single tap guarded until the screen is focused again.
  useFocusEffect(
    React.useCallback(() => {
      isOpeningConversation.current = false;
    }, [])
  );

  const normalizedQuery = query.trim().toLocaleLowerCase();

  const rows = conversations.kind === "ready" ? conversations.value : noRows;

  const loadFailed =
    conversations.kind === "failed" ||
    (conversations.kind === "ready" && conversations.refreshFailed);

  const filteredConversations = React.useMemo(
    () =>
      rows.filter(({ handle, latestMessageText }) =>
        [handle, latestMessageText]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
      ),
    [normalizedQuery, rows]
  );

  const openConversation = React.useCallback(async (item: Conversation) => {
    if (isOpeningConversation.current) {
      return;
    }

    isOpeningConversation.current = true;

    try {
      await KeyboardController.dismiss();
      router.push({ params: { id: item.qid }, pathname: "/chat/[id]" });
    } catch {
      // Hold the guard until this screen refocuses after a successful push.
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
        <View className="flex-row items-center justify-between gap-4">
          <Text className="min-w-0 flex-1" variant="title">
            Chats
          </Text>
          <Button
            onPress={() => router.push("../new-chat")}
            accessibilityLabel="New chat"
            size="iconRound"
            variant="secondary"
          >
            <Icon as={SquarePen} className="size-5" />
          </Button>
        </View>
        <ChatSearch onChangeText={setQuery} value={query} />
      </View>
    ),
    [query]
  );

  const empty = React.useMemo(() => {
    if (conversations.kind !== "ready") {
      return null;
    }

    if (rows.length > 0) {
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
  }, [conversations.kind, rows.length]);

  return (
    <View className="bg-background flex-1">
      {loadFailed ? (
        <View className="gap-3 p-5">
          <Text>Could not load your chats.</Text>
          <Button onPress={retryLoad} variant="outline">
            <Text>Retry</Text>
          </Button>
        </View>
      ) : null}
      <FlashList
        contentContainerStyle={contentContainerStyle}
        contentInsetAdjustmentBehavior="automatic"
        data={filteredConversations}
        keyboardDismissMode={
          process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
        }
        keyboardShouldPersistTaps="handled"
        keyExtractor={conversationKey}
        ListEmptyComponent={loadFailed ? null : empty}
        ListHeaderComponent={listHeader}
        renderItem={renderConversation}
      />
    </View>
  );
};

export default ChatsScreen;
