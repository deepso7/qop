import {
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import * as React from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";

import { ConversationScreen } from "@/components/chat/conversation-screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { getContactByQid } from "@/lib/db";
import type { Contact } from "@/lib/db";
import { useP2pStore } from "@/lib/p2p-store";

const ChatRoute = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [contact, setContact] = React.useState<Contact | null>();
  const [loadError, setLoadError] = React.useState(false);
  const [retryCount, retryLoad] = React.useReducer(
    (count: number) => count + 1,
    0
  );
  const revision = useP2pStore((state) => state.revision);

  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      const load = async (_revision: number, _retryCount: number) => {
        try {
          const loaded = await getContactByQid(id);
          if (active) {
            setContact(loaded);
            setLoadError(false);
          }
        } catch {
          if (active) {
            setLoadError(true);
          }
        }
      };
      void load(revision, retryCount);
      return () => {
        active = false;
      };
    }, [id, revision, retryCount])
  );

  if (loadError) {
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
  if (contact === undefined) {
    return (
      <View className="bg-background flex-1 items-center justify-center">
        <ActivityIndicator colorClassName="accent-foreground-secondary" />
      </View>
    );
  }
  if (contact === null) {
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
      <Stack.Screen options={{ title: `@${contact.handle}` }} />
      <ConversationScreen contact={contact} key={contact.qid} />
    </>
  );
};

export default ChatRoute;
