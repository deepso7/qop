import { Handle } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import { router, Stack } from "expo-router";
import * as React from "react";
import { ActivityIndicator, Keyboard, ScrollView, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { upsertContact } from "@/lib/db";
import { selectionHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";
import { lookupHandle } from "@/lib/registry";
import type { RegistryAccount, RegistryReaderError } from "@/lib/registry";

const decodeHandle = Schema.decodeUnknownResult(Handle);

const getHandleHint = (handle: string) => {
  if (handle.length === 0) {
    return "Lowercase letters, numbers, and underscores.";
  }
  if (handle.length > 32) {
    return "Keep it to 32 characters or fewer.";
  }
  if (!/^[a-z0-9]/u.test(handle)) {
    return "Start with a lowercase letter or number.";
  }
  return "Use only lowercase letters, numbers, and underscores.";
};

const registryErrorMessage = (error: RegistryReaderError) => {
  if (error.operation === "configuration") {
    return "The registry RPC is not configured.";
  }
  if (error.operation === "rpc") {
    return "Could not reach the registry RPC.";
  }
  return "The registry returned an invalid account.";
};

const NewChatRoute = () => {
  const reduceMotion = useReducedMotion();
  const [opening, setOpening] = React.useState(false);
  const ownHandle = useIdentityStore((state) => state.identity?.handle);
  const [handle, setHandle] = React.useState("");
  const [lookingUp, setLookingUp] = React.useState(false);
  const [result, setResult] = React.useState<RegistryAccount | null>();
  const [message, setMessage] = React.useState<string>();
  const isValid = Result.isSuccess(decodeHandle(handle));

  const lookUp = React.useCallback(async () => {
    if (!isValid || lookingUp) {
      return;
    }
    Keyboard.dismiss();
    setLookingUp(true);
    setMessage(undefined);
    setResult(undefined);
    if (handle === ownHandle) {
      setMessage("That's you.");
      setLookingUp(false);
      return;
    }
    const lookup = await Effect.runPromise(
      lookupHandle(handle).pipe(Effect.result)
    );
    if (Result.isFailure(lookup)) {
      setMessage(registryErrorMessage(lookup.failure));
    } else if (lookup.success === null) {
      setMessage("No one has this handle.");
      setResult(null);
    } else {
      setResult(lookup.success);
    }
    setLookingUp(false);
  }, [handle, isValid, lookingUp, ownHandle]);

  const startChat = React.useCallback(async () => {
    if (!result || opening) {
      return;
    }
    setMessage(undefined);
    setOpening(true);
    try {
      await upsertContact({
        createdAt: Number(result.registeredAt) * 1000,
        deviceKey: result.deviceKey,
        handle: result.handle,
        owner: result.owner,
        peerId: result.peerId,
        qid: result.qid.toString(),
      });
      void selectionHaptic();
      router.replace({
        params: { id: result.qid.toString() },
        pathname: "/chat/[id]",
      });
    } catch {
      setOpening(false);
      setMessage("Could not save this contact. Tap Start chat to retry.");
    }
  }, [opening, result]);

  return (
    <>
      <Stack.Screen options={{ title: "New chat" }} />
      <ScrollView
        className="bg-background flex-1"
        contentContainerClassName="gap-6 p-5"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-3">
          <Text variant="label">Handle</Text>
          <Input
            accessibilityHint="Lowercase letters, numbers, and underscores"
            accessibilityLabel="qop handle"
            autoFocus
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            className="border-border bg-background-element dark:bg-background-element h-14 rounded-xl px-4 text-[18px]"
            editable={!lookingUp}
            enterKeyHint="search"
            maxLength={33}
            onChangeText={(value) => {
              setHandle(value.trim().replace(/^@/u, "").toLowerCase());
              setMessage(undefined);
              setResult(undefined);
            }}
            onSubmitEditing={lookUp}
            placeholder="their_handle"
            returnKeyType="search"
            spellCheck={false}
            value={handle}
          />
          <Text
            className={
              handle.length > 0 && !isValid
                ? "text-destructive"
                : "text-foreground-secondary"
            }
            selectable
            variant="caption"
          >
            {isValid ? `Look up @${handle}.` : getHandleHint(handle)}
          </Text>
          <Button disabled={!isValid || lookingUp} onPress={lookUp}>
            {lookingUp ? (
              <ActivityIndicator colorClassName="accent-primary-foreground" />
            ) : null}
            <Text>{lookingUp ? "Looking up…" : "Look up"}</Text>
          </Button>
        </View>

        {message ? (
          <Text className="text-destructive text-center" selectable>
            {message}
          </Text>
        ) : null}

        {result ? (
          <Animated.View entering={FadeIn.duration(reduceMotion ? 0 : 160)}>
            <Surface
              className="border-background-selected gap-4 rounded-xl border p-4"
              tone="element"
            >
              <View className="gap-1">
                <Text selectable variant="large">
                  @{result.handle}
                </Text>
                <Text
                  className="text-foreground-secondary"
                  selectable
                  variant="caption"
                >
                  QID {result.qid.toString()}
                </Text>
                <Text
                  className="text-foreground-secondary font-mono"
                  selectable
                  variant="caption"
                >
                  Peer {result.peerId.slice(0, 12)}…
                </Text>
              </View>
              <Button disabled={opening} onPress={startChat}>
                {opening ? (
                  <ActivityIndicator colorClassName="accent-primary-foreground" />
                ) : null}
                <Text>{opening ? "Opening…" : "Start chat"}</Text>
              </Button>
            </Surface>
          </Animated.View>
        ) : null}
      </ScrollView>
    </>
  );
};

export default NewChatRoute;
