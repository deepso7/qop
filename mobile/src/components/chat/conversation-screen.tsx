import moreVertIcon from "@expo/material-symbols/more_vert.xml";
import type { Path } from "@minip2p/react-native";
import type { ListRenderItem } from "@shopify/flash-list";
import { Effect, Fiber, Schedule } from "effect";
import * as Clipboard from "expo-clipboard";
import { Stack, useFocusEffect } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import * as React from "react";
import { Platform, View } from "react-native";
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
import { useFocusLoad } from "@/hooks/use-focus-load";
import { listMessages, markConversationRead } from "@/lib/db";
import type { Contact, StoredMessage } from "@/lib/db";
import { selectionHaptic } from "@/lib/haptics";
import { useP2pStore } from "@/lib/p2p-store";
import type { P2pConnection } from "@/lib/p2p-store-core";

const REDIAL_INTERVAL_MS = 15_000;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const noMessages: readonly StoredMessage[] = [];

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
    <Text variant="headline">@{handle}</Text>
    {online ? (
      <Text tone="secondary" variant="footnote">
        online
      </Text>
    ) : null}
  </View>
);

const pathLabel = (path: Path | undefined) => {
  switch (path?.kind) {
    case "direct": {
      return "Direct";
    }

    case "punched": {
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

/** Header menu status for one peer. */
const connectionLabel = (
  status: P2pConnection["status"],
  reachable: boolean
) => {
  switch (status) {
    case "failed":
    case "stopped": {
      return "P2P unavailable";
    }

    case "starting": {
      return "Starting P2P";
    }

    default: {
      return reachable ? "Connected" : "Not connected";
    }
  }
};

// Menu row text. Android ignores MenuAction subtitles, so fold the value into
// the title there.
const menuRow = (label: string, value: string) =>
  Platform.OS === "ios"
    ? { children: label, subtitle: value }
    : { children: `${label}: ${value}` };

const ConversationScreen = ({ contact }: { contact: Contact }) => {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const [draft, setDraft] = React.useState("");

  const load = React.useCallback(
    () => listMessages(contact.qid),
    [contact.qid]
  );

  const [messages, retryLoad] = useFocusLoad(load);

  // A dial may resolve a newer peerId than the persisted contact after device-key rotation.
  const [dialTarget, setDialTarget] = React.useState(() => ({
    contactPeerId: contact.peerId,
    peerId: contact.peerId,
  }));

  const connection = useP2pStore((state) => state.connection);
  const connectTo = useP2pStore((state) => state.connectTo);
  const retryMessage = useP2pStore((state) => state.retryMessage);
  const sendMessage = useP2pStore((state) => state.sendMessage);
  const { status } = connection;

  const dialPeerId =
    dialTarget.contactPeerId === contact.peerId
      ? dialTarget.peerId
      : contact.peerId;

  const latestReceivedAt =
    messages.kind === "ready" ? messages.value.at(-1)?.receivedAt : undefined;

  // Messages reload on every chat change while focused. Advance the read cursor
  // only through messages that a load returned, so a concurrent arrival stays
  // unread until the next load. A failed cursor write only delays read marks.
  React.useEffect(() => {
    if (latestReceivedAt === undefined) {
      return;
    }

    const markRead = async () => {
      try {
        await markConversationRead(contact.qid, latestReceivedAt);
      } catch {
        // Messages still show if the read cursor write fails.
      }
    };

    void markRead();
  }, [contact.qid, latestReceivedAt]);

  const running = connection.status === "running" ? connection : undefined;
  const reachable = running?.connectedPeerIds.includes(dialPeerId) === true;

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

  const copyPeerId = React.useCallback(async () => {
    await Clipboard.setStringAsync(dialPeerId);
  }, [dialPeerId]);

  const loadFailed =
    messages.kind === "failed" ||
    (messages.kind === "ready" && messages.refreshFailed);

  // Render nothing until the first load lands, so an existing chat never
  // flashes "No messages yet".
  const showEmpty = messages.kind === "ready" && !messages.refreshFailed;

  const canSend = status === "running" && draft.trim().length > 0;

  const animatedStyle = useAnimatedStyle(
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
        <Stack.Toolbar.Menu
          icon={Platform.OS === "ios" ? "ellipsis" : moreVertIcon}
          title="Connection"
        >
          {/* Every row has an icon so iOS keeps titles aligned. Info rows stay
              enabled (tapping just closes the menu) so iOS doesn't grey them. */}
          <Stack.Toolbar.MenuAction
            icon="antenna.radiowaves.left.and.right"
            {...menuRow("Status", connectionLabel(status, reachable))}
          />
          <Stack.Toolbar.MenuAction
            icon="arrow.triangle.branch"
            {...menuRow("Path", pathLabel(running?.peerPaths[dialPeerId]))}
          />
          <Stack.Toolbar.MenuAction
            icon="server.rack"
            {...menuRow(
              "Relay",
              running?.relayReserved === true ? "Reserved" : "Not reserved"
            )}
          />
          {connection.status === "failed" ? (
            <Stack.Toolbar.MenuAction
              icon="exclamationmark.triangle"
              {...menuRow("Error", connection.reason)}
            />
          ) : null}
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction
              icon="doc.on.doc"
              onPress={copyPeerId}
              {...menuRow("Copy peer ID", `…${dialPeerId.slice(-8)}`)}
            />
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {loadFailed ? (
        <View className="gap-3 p-4">
          <Text>Could not load messages.</Text>
          <Button onPress={retryLoad} variant="outline">
            <Text>Retry</Text>
          </Button>
        </View>
      ) : null}
      <MessageScroller
        data={messages.kind === "ready" ? messages.value : noMessages}
        followOutput
        getMessageId={getMessageId}
        ItemSeparatorComponent={ConversationSeparator}
        ListEmptyComponent={showEmpty ? EmptyConversation : null}
        renderItem={renderItem}
        variant="grouped"
      />
      <Animated.View
        className="border-border bg-background border-t px-3 pt-2"
        style={animatedStyle}
      >
        <ChatComposer variant="bare">
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
