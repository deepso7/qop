import { Base64Url32, Handle } from "@qop/identity/wire-codecs";
import { Result, Schema } from "effect";
import * as Haptics from "expo-haptics";
import { ArrowLeft, Plus } from "lucide-react-native";
import * as React from "react";
import { Keyboard, ScrollView, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { QopWordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useIdentityGate } from "@/lib/identity-gate";

const decodeHandle = Schema.decodeUnknownResult(Handle);
const decodeSecretKey = Schema.decodeUnknownResult(Base64Url32);

type KeyPath = "create" | "existing";

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

const StepIndicator = ({ step }: { step: 1 | 2 }) => (
  <View
    accessibilityLabel={`Step ${step} of 2`}
    accessible
    className="items-end gap-2"
  >
    <Text className="text-foreground-secondary" variant="mono">
      {step} / 2
    </Text>
    <View className="flex-row gap-1.5">
      <View className="bg-primary h-1 w-8 rounded-full" />
      <View
        className={`h-1 w-8 rounded-full ${step === 2 ? "bg-primary" : "bg-border"}`}
      />
    </View>
  </View>
);

const stepTransition = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const stepExit = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

const safelyPlayHaptic = async (feedback: Promise<void>) => {
  try {
    await feedback;
  } catch {
    // Haptics are optional feedback and are unavailable on some devices.
  }
};

const playSelectionHaptic = () => {
  if (process.env.EXPO_OS === "android") {
    void safelyPlayHaptic(
      Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick)
    );
  } else if (process.env.EXPO_OS === "ios") {
    void safelyPlayHaptic(Haptics.selectionAsync());
  }
};

const playPrimaryHaptic = () => {
  if (process.env.EXPO_OS === "android") {
    void safelyPlayHaptic(
      Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Virtual_Key)
    );
  } else if (process.env.EXPO_OS === "ios") {
    void safelyPlayHaptic(
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    );
  }
};

const playSuccessHaptic = () => {
  if (process.env.EXPO_OS === "android") {
    void safelyPlayHaptic(
      Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm)
    );
  } else if (process.env.EXPO_OS === "ios") {
    void safelyPlayHaptic(
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    );
  }
};

const OnboardingRoute = () => {
  const insets = useSafeAreaInsets();
  const { completeOnboardingForSession } = useIdentityGate();
  const [keyPath, setKeyPath] = React.useState<KeyPath>();
  const [handle, setHandle] = React.useState("");
  const [secretKey, setSecretKey] = React.useState("");

  const isValidHandle = Result.isSuccess(decodeHandle(handle));
  const isValidSecretKey = Result.isSuccess(decodeSecretKey(secretKey));
  const isValid = keyPath === "create" ? isValidHandle : isValidSecretKey;
  let previewLabel = "Choose a handle";
  if (keyPath === "existing") {
    previewLabel = isValidSecretKey
      ? "Preview with this key"
      : "Enter your key";
  } else if (isValidHandle) {
    previewLabel = `Preview @${handle}`;
  }

  const chooseKeyPath = React.useCallback((path: KeyPath) => {
    if (path === "create") {
      playPrimaryHaptic();
    } else {
      playSelectionHaptic();
    }
    setKeyPath(path);
  }, []);

  const goBack = React.useCallback(() => {
    Keyboard.dismiss();
    playSelectionHaptic();
    setKeyPath(undefined);
  }, []);

  const finishPreview = React.useCallback(() => {
    if (!isValid) {
      return;
    }
    Keyboard.dismiss();
    playSuccessHaptic();
    completeOnboardingForSession();
  }, [completeOnboardingForSession, isValid]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="grow"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 72),
        paddingTop:
          process.env.EXPO_OS === "ios" ? 24 : Math.max(insets.top, 24),
      }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode={
        process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
      }
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-xl grow self-center gap-10 px-6 py-3 sm:px-10 sm:py-8">
        <View className="flex-row items-start justify-between">
          {keyPath ? (
            <Button
              accessibilityLabel="Back to key options"
              className="h-10 -translate-x-3 rounded-full px-3"
              onPress={goBack}
              variant="ghost"
            >
              <Icon as={ArrowLeft} className="size-5" />
              <Text>Back</Text>
            </Button>
          ) : (
            <View />
          )}
          <StepIndicator step={keyPath ? 2 : 1} />
        </View>

        {keyPath ? (
          <Animated.View
            entering={stepTransition}
            exiting={stepExit}
            key={keyPath}
            className="grow justify-between gap-10"
          >
            {keyPath === "create" ? (
              <View className="gap-8">
                <View className="gap-3">
                  <Text
                    accessibilityRole="header"
                    className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
                  >
                    Create your qop.
                  </Text>
                  <Text
                    className="max-w-md text-foreground-secondary"
                    variant="body"
                  >
                    Choose a handle for a fresh identity on this device.
                  </Text>
                </View>

                <View className="gap-3">
                  <Text variant="label">Your handle</Text>
                  <View className="border-border bg-background-element flex-row items-center rounded-xl border px-4">
                    <Text className="text-foreground-secondary text-lg">@</Text>
                    <Input
                      accessibilityHint="Lowercase letters, numbers, and underscores"
                      accessibilityLabel="qop handle"
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect={false}
                      className="h-14 grow border-0 bg-transparent px-1.5 text-lg dark:bg-transparent"
                      enterKeyHint="done"
                      maxLength={33}
                      onChangeText={setHandle}
                      onSubmitEditing={finishPreview}
                      placeholder="your_handle"
                      returnKeyType="done"
                      spellCheck={false}
                      value={handle}
                    />
                  </View>
                  <Text
                    className={
                      handle.length > 0 && !isValidHandle
                        ? "text-destructive"
                        : "text-foreground-secondary"
                    }
                    selectable
                    variant="caption"
                  >
                    {isValidHandle
                      ? `@${handle} is available for the identity flow.`
                      : getHandleHint(handle)}
                  </Text>
                </View>
              </View>
            ) : (
              <View className="gap-8">
                <View className="gap-3">
                  <Text
                    accessibilityRole="header"
                    className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
                  >
                    Use your keys.
                  </Text>
                  <Text
                    className="max-w-md text-foreground-secondary"
                    variant="body"
                  >
                    Enter your existing 32-byte Ed25519 secret key.
                  </Text>
                </View>

                <View className="gap-3">
                  <View className="flex-row items-center justify-between">
                    <Text variant="label">Secret key</Text>
                    <Text
                      className="text-foreground-secondary tabular-nums"
                      variant="mono"
                    >
                      {Math.min(secretKey.length, 43)} / 43
                    </Text>
                  </View>
                  <Input
                    accessibilityHint="A 43-character unpadded base64url key"
                    accessibilityLabel="Existing secret key"
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect={false}
                    className="bg-background-element h-14 rounded-xl px-4 font-mono"
                    enterKeyHint="done"
                    maxLength={43}
                    onChangeText={(value) => setSecretKey(value.trim())}
                    onSubmitEditing={finishPreview}
                    placeholder="Paste your key"
                    returnKeyType="done"
                    secureTextEntry
                    spellCheck={false}
                    value={secretKey}
                  />
                  <Text
                    className={
                      secretKey.length > 0 && !isValidSecretKey
                        ? "text-destructive"
                        : "text-foreground-secondary"
                    }
                    selectable
                    variant="caption"
                  >
                    {isValidSecretKey
                      ? "This is a valid qop device key."
                      : "Use the 43-character base64url key from your existing device."}
                  </Text>
                </View>
              </View>
            )}

            <View className="gap-3">
              <Button
                accessibilityHint="Opens the app without creating or storing keys"
                className="h-14 rounded-xl"
                disabled={!isValid}
                onPress={finishPreview}
                size="lg"
              >
                <Text>{previewLabel}</Text>
              </Button>
              <Text
                className="text-center text-foreground-secondary"
                selectable
                variant="caption"
              >
                Prototype only—keys are validated locally but are not created or
                stored yet.
              </Text>
            </View>
          </Animated.View>
        ) : (
          <Animated.View
            entering={stepTransition}
            exiting={stepExit}
            key="choose-key-path"
            className="grow justify-between gap-10"
          >
            <View className="grow items-center justify-center gap-8 py-8">
              <QopWordmark width={184} />
              <View className="items-center gap-3">
                <Text
                  accessibilityRole="header"
                  className="max-w-lg text-center text-4xl leading-11 font-semibold tracking-tight"
                >
                  Message people, not platforms.
                </Text>
                <Text
                  className="max-w-sm text-center text-foreground-secondary"
                  variant="body"
                >
                  Your keys are your qop identity. Create a new set or bring the
                  ones you already use.
                </Text>
              </View>
            </View>

            <View className="gap-3">
              <Button
                accessibilityHint="Generate a fresh identity for this device"
                className="h-14 rounded-xl"
                onPress={() => chooseKeyPath("create")}
                size="lg"
              >
                <Icon as={Plus} className="size-5" color="#0D1012" />
                <Text>Create keys</Text>
              </Button>
              <Button
                accessibilityHint="Continue with an existing 32-byte secret key"
                className="h-9 self-center rounded-full px-4"
                onPress={() => chooseKeyPath("existing")}
                size="sm"
                variant="ghost"
              >
                <Text>I already have keys</Text>
              </Button>
            </View>
          </Animated.View>
        )}
      </View>
    </ScrollView>
  );
};

export default OnboardingRoute;
