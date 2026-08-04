import { Stack, useLocalSearchParams } from "expo-router";

import { ConversationScreen } from "@/components/chat/conversation-screen";

const ChatRoute = () => {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const title = name ?? (id === "aisha" ? "Aisha K." : "Conversation");

  return (
    <>
      <Stack.Screen options={{ title }} />
      <ConversationScreen peerName={title} />
    </>
  );
};

export default ChatRoute;
