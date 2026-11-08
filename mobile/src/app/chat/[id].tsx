import { router, Stack, useLocalSearchParams } from "expo-router";
import * as React from "react";
import { ScrollView, View } from "react-native";

import { ConversationScreen } from "@/components/chat/conversation-screen";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useFocusLoad } from "@/hooks/use-focus-load";
import { getContactByQid } from "@/lib/db";

const ChatRoute = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = React.useCallback(() => getContactByQid(id), [id]);
  // Reloads on every chat change; a failed refresh keeps the open conversation
  // (and its draft) instead of swapping in the error page.
  const [contact, retryLoad] = useFocusLoad(load);

  if (contact.kind === "failed") {
    return (
      <View className="bg-background flex-1 items-center justify-center gap-4 p-6">
        <Text>Could not load this conversation.</Text>
        <Button onPress={retryLoad}>
          <Text>Retry</Text>
        </Button>
        <Button onPress={() => router.back()} variant="outline">
          <Text>Back</Text>
        </Button>
      </View>
    );
  }

  if (contact.kind === "loading") {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <Spinner />
      </View>
    );
  }

  if (contact.value === null) {
    return (
      <>
        <Stack.Screen options={{ title: "Chat" }} />
        <ScrollView
          className="bg-background flex-1"
          contentContainerClassName="grow items-center justify-center gap-4 p-6"
          contentInsetAdjustmentBehavior="automatic"
        >
          <Text selectable>This conversation is not on this device.</Text>
          <Button onPress={() => router.back()} variant="outline">
            <Text>Back</Text>
          </Button>
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: `@${contact.value.handle}` }} />
      <ConversationScreen contact={contact.value} key={contact.value.qid} />
    </>
  );
};

export default ChatRoute;
