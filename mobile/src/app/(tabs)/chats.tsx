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
import { listConversations } from "@/lib/db";
import type { Conversation } from "@/lib/db";
import { useP2pStore } from "@/lib/p2p-store";

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
  const [loadError, setLoadError] = React.useState(false);
  const [retryCount, retryLoad] = React.useReducer(
    (count: number) => count + 1,
    0
  );
  const connectedPeerIds = useP2pStore((state) => state.connectedPeerIds);
  const revision = useP2pStore((state) => state.revision);
  const contentContainerStyle = useResolveClassNames("pb-24");

  // Keep a single tap guarded until the screen is focused again.
  useFocusEffect(
    React.useCallback(() => {
      isOpeningConversation.current = false;
    }, [])
  );

  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      const load = async (_revision: number, _retryCount: number) => {
        try {
          const rows = await listConversations();
          if (active) {
            setConversations(rows);
            setLoadError(false);
          }
        } catch {
          if (active) {
            setLoadError(true);
          }
        }
        if (active) {
          setLoaded(true);
        }
      };
      void load(revision, retryCount);
      return () => {
        active = false;
      };
    }, [revision, retryCount])
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
            size="icon"
            variant="secondary"
            className="rounded-full"
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
      {loadError ? (
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
        ListEmptyComponent={loadError ? null : empty}
        ListHeaderComponent={listHeader}
        renderItem={renderConversation}
      />
    </View>
  );
};

export default ChatsScreen;
