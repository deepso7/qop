import { Handle } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import { router, Stack } from "expo-router";
import * as React from "react";
import { Keyboard, ScrollView, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { upsertContact } from "@/lib/db";
import type { ContactInput } from "@/lib/db";
import { selectionHaptic } from "@/lib/haptics";
import { selectIdentity, useIdentityStore } from "@/lib/identity-store";
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

// The account's last-seen device as a contact, or null if it has none to dial.
const toContact = (account: RegistryAccount): ContactInput | null =>
  account.deviceKey && account.peerId
    ? {
        createdAt: Number(account.registeredAt) * 1000,
        deviceKey: account.deviceKey,
        handle: account.handle,
        owner: account.owner,
        peerId: account.peerId,
        qid: account.qid.toString(),
      }
    : null;

// Where the screen is between typing a handle and opening its chat. A found
// account carries its contact (null when unreachable) and any save error.
type Lookup =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "failed"; message: string }
  | {
      kind: "found";
      account: RegistryAccount;
      contact: ContactInput | null;
      error?: string;
    }
  | { kind: "opening"; account: RegistryAccount };

const getLookupMessage = (lookup: Lookup) => {
  if (lookup.kind === "found") {
    return lookup.contact
      ? lookup.error
      : "This account has no active device yet.";
  }

  return lookup.kind === "failed" ? lookup.message : undefined;
};

const NewChatRoute = () => {
  const reduceMotion = useReducedMotion();
  const ownHandle = useIdentityStore((state) => selectIdentity(state)?.handle);
  const [handle, setHandle] = React.useState("");
  const [lookup, setLookup] = React.useState<Lookup>({ kind: "idle" });
  const isValid = Result.isSuccess(decodeHandle(handle));
  const looking = lookup.kind === "looking";
  const opening = lookup.kind === "opening";
  const message = getLookupMessage(lookup);

  const account =
    lookup.kind === "found" || lookup.kind === "opening"
      ? lookup.account
      : undefined;

  const lookUp = React.useCallback(async () => {
    if (!isValid || looking || opening) {
      return;
    }

    Keyboard.dismiss();

    if (handle === ownHandle) {
      setLookup({ kind: "failed", message: "That's you." });

      return;
    }

    setLookup({ kind: "looking" });

    const result = await Effect.runPromise(
      lookupHandle(handle).pipe(Effect.result)
    );

    if (Result.isFailure(result)) {
      setLookup({
        kind: "failed",
        message: registryErrorMessage(result.failure),
      });
    } else if (result.success === null) {
      setLookup({ kind: "failed", message: "No one has this handle." });
    } else {
      setLookup({
        account: result.success,
        contact: toContact(result.success),
        kind: "found",
      });
    }
  }, [handle, isValid, looking, opening, ownHandle]);

  const startChat = React.useCallback(async () => {
    if (lookup.kind !== "found" || !lookup.contact) {
      return;
    }

    const { contact } = lookup;

    setLookup({ account: lookup.account, kind: "opening" });

    try {
      await upsertContact(contact);
      void selectionHaptic();
      router.replace({
        params: { id: contact.qid },
        pathname: "/chat/[id]",
      });
    } catch {
      setLookup({
        ...lookup,
        error: "Could not save this contact. Tap Start chat to retry.",
      });
    }
  }, [lookup]);

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
            className="h-14"
            size="lg"
            variant="filled"
            // Locked while opening too: editing would drop the card mid-save.
            editable={!(looking || opening)}
            enterKeyHint="search"
            maxLength={33}
            onChangeText={(value) => {
              setHandle(value.trim().replace(/^@/u, "").toLowerCase());
              setLookup({ kind: "idle" });
            }}
            onSubmitEditing={lookUp}
            placeholder="their_handle"
            returnKeyType="search"
            spellCheck={false}
            value={handle}
          />
          <Text
            selectable
            tone={handle.length > 0 && !isValid ? "destructive" : "secondary"}
            variant="caption"
          >
            {isValid ? `Look up @${handle}.` : getHandleHint(handle)}
          </Text>
          <Button disabled={!isValid || looking || opening} onPress={lookUp}>
            {looking ? <Spinner tone="onPrimary" /> : null}
            <Text>{looking ? "Looking up…" : "Look up"}</Text>
          </Button>
        </View>

        {message ? (
          <Text className="text-center" selectable tone="destructive">
            {message}
          </Text>
        ) : null}

        {account ? (
          <Animated.View entering={FadeIn.duration(reduceMotion ? 0 : 160)}>
            <Surface tone="element" variant="outline">
              <View className="gap-1">
                <Text selectable variant="large">
                  @{account.handle}
                </Text>
                <Text selectable tone="secondary" variant="caption">
                  QID {account.qid.toString()}
                </Text>
                <Text selectable tone="secondary" variant="mono">
                  Peer {(account.peerId ?? "none").slice(0, 12)}…
                </Text>
              </View>
              <Button
                disabled={lookup.kind !== "found" || !lookup.contact}
                onPress={startChat}
              >
                {opening ? <Spinner tone="onPrimary" /> : null}
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
