import { Handle } from "@qop/identity";
import { Result, Schema } from "effect";
import * as Haptics from "expo-haptics";
import { ArrowLeft, Check, Plus, Share2 } from "lucide-react-native";
import * as React from "react";
import {
  ActivityIndicator,
  Keyboard,
  ScrollView,
  Share,
  View,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { QopWordmark } from "@/components/brand-mark";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useIdentityStore } from "@/lib/identity-store";
import type { IdentityVaultError } from "@/lib/identity-vault";

const decodeHandle = Schema.decodeUnknownResult(Handle);

type CreateStage = "handle" | "intro";

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

const getVaultErrorMessage = (error: IdentityVaultError | null) => {
  switch (error?.operation) {
    case "availability": {
      return "Secure key storage is unavailable on this device.";
    }
    case "already-exists": {
      return "An identity already exists on this device.";
    }
    case "decode": {
      return "The stored identity could not be verified.";
    }
    case "delete": {
      return "Qop could not remove the stored identity.";
    }
    case "install-state": {
      return "Qop could not verify this app installation.";
    }
    case "invalid-handle": {
      return "That handle is not valid.";
    }
    case "missing-identity": {
      return "There is no identity to finish setting up.";
    }
    case "read": {
      return "Qop could not read the identity from secure storage.";
    }
    case "stale-install": {
      return "An identity from a previous installation is locked on this device.";
    }
    case "create": {
      return "Qop could not generate the identity keys.";
    }
    case "write": {
      return "Qop could not save the identity securely.";
    }
    default: {
      return "Qop could not open the identity vault.";
    }
  }
};

const StepIndicator = React.memo(({ step }: { step: 1 | 2 }) => (
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
));
StepIndicator.displayName = "StepIndicator";

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

const useRecoveryKey = (
  enabled: boolean,
  revealRecoveryKey: () => Promise<Result.Result<string, IdentityVaultError>>
) => {
  const [attempt, setAttempt] = React.useState(0);
  const [error, setError] = React.useState<string>();
  const [recoveryKey, setRecoveryKey] = React.useState<string>();

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    const reveal = async () => {
      const result = await revealRecoveryKey();
      if (cancelled) {
        return;
      }
      if (Result.isSuccess(result)) {
        setRecoveryKey(result.success);
        setError(undefined);
      } else {
        setError("Could not open the recovery key. Try again.");
      }
    };
    void reveal();
    return () => {
      cancelled = true;
    };
  }, [attempt, enabled, revealRecoveryKey]);

  const retry = React.useCallback(() => {
    setError(undefined);
    setAttempt((current) => current + 1);
  }, []);

  return {
    error,
    isOpening: enabled && !recoveryKey && !error,
    recoveryKey,
    retry,
  };
};

const getRecoveryButtonLabel = ({
  backedUp,
  isOpening,
  recoveryKey,
}: {
  backedUp: boolean;
  isOpening: boolean;
  recoveryKey: string | undefined;
}) => {
  if (backedUp) {
    return "Recovery key exported";
  }
  if (recoveryKey) {
    return "Export recovery key";
  }
  return isOpening ? "Opening recovery key…" : "Try opening recovery key";
};

const getDisplayedBackupError = (
  backupError: string | undefined,
  recoveryKeyError: string | undefined
) => backupError ?? recoveryKeyError;

const VaultErrorScreen = React.memo(
  ({ error }: { error: IdentityVaultError | null }) => {
    const isHydrating = useIdentityStore((state) => state.isHydrating);
    const resetIdentity = useIdentityStore((state) => state.resetIdentity);
    const retryLoad = useIdentityStore((state) => state.retryLoad);
    const [resetting, setResetting] = React.useState(false);
    const canReset =
      error?.operation === "decode" ||
      error?.operation === "delete" ||
      error?.operation === "stale-install";

    const resetVault = React.useCallback(async () => {
      if (resetting) {
        return;
      }
      setResetting(true);
      const result = await resetIdentity();
      if (Result.isFailure(result)) {
        setResetting(false);
      }
    }, [resetIdentity, resetting]);

    const confirmReset = React.useCallback(() => {
      void resetVault();
    }, [resetVault]);

    return (
      <Animated.View
        entering={stepTransition}
        exiting={stepExit}
        className="grow justify-between gap-10"
      >
        <View className="grow items-center justify-center gap-5 py-8">
          <QopWordmark width={184} />
          <View className="max-w-md items-center gap-3">
            <Text
              accessibilityRole="header"
              className="text-center text-3xl leading-10 font-semibold tracking-tight"
            >
              Identity vault unavailable.
            </Text>
            <Text
              className="text-center text-foreground-secondary"
              selectable
              variant="body"
            >
              {getVaultErrorMessage(error)}
            </Text>
          </View>
        </View>
        <View className="gap-3">
          <Button
            className="h-14 rounded-xl"
            disabled={isHydrating}
            onPress={retryLoad}
            size="lg"
          >
            {isHydrating ? (
              <ActivityIndicator colorClassName="accent-primary-foreground" />
            ) : null}
            <Text>{isHydrating ? "Trying again…" : "Try again"}</Text>
          </Button>
          {canReset ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  className="h-10 self-center rounded-full px-5"
                  disabled={resetting}
                  variant="ghost"
                >
                  <Text>Reset this device</Text>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete the stored identity?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently removes the local recovery and device keys.
                    Only continue if you have saved the recovery key or want to
                    create a different identity.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel accessibilityLabel="Cancel identity reset">
                    <Text>Cancel</Text>
                  </AlertDialogCancel>
                  <AlertDialogAction
                    accessibilityLabel="Delete stored identity"
                    disabled={resetting}
                    onPress={confirmReset}
                    variant="destructive"
                  >
                    <Text>Delete identity</Text>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </View>
      </Animated.View>
    );
  }
);
VaultErrorScreen.displayName = "VaultErrorScreen";

const OnboardingRoute = React.memo(() => {
  const insets = useSafeAreaInsets();
  const createIdentity = useIdentityStore((state) => state.createIdentity);
  const error = useIdentityStore((state) => state.error);
  const identity = useIdentityStore((state) => state.identity);
  const revealRecoveryKey = useIdentityStore(
    (state) => state.revealRecoveryKey
  );
  const setBackupState = useIdentityStore((state) => state.setBackupState);
  const status = useIdentityStore((state) => state.status);
  const [stage, setStage] = React.useState<CreateStage>("intro");
  const [handle, setHandle] = React.useState("");
  const [backedUp, setBackedUp] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [backupError, setBackupError] = React.useState<string>();

  const isValidHandle = React.useMemo(
    () => Result.isSuccess(decodeHandle(handle)),
    [handle]
  );
  const isCreating = status === "creating";
  const isBackup = status === "backup";
  const {
    error: recoveryKeyError,
    isOpening: isOpeningRecoveryKey,
    recoveryKey,
    retry: retryRecoveryKey,
  } = useRecoveryKey(isBackup, revealRecoveryKey);

  const startCreate = React.useCallback(() => {
    playPrimaryHaptic();
    setStage("handle");
  }, []);

  const goBack = React.useCallback(() => {
    Keyboard.dismiss();
    playSelectionHaptic();
    setStage("intro");
  }, []);

  const create = React.useCallback(async () => {
    if (!isValidHandle || isCreating) {
      return;
    }
    Keyboard.dismiss();
    playPrimaryHaptic();
    const result = await createIdentity(handle);
    if (Result.isSuccess(result)) {
      playSuccessHaptic();
    }
  }, [createIdentity, handle, isCreating, isValidHandle]);

  const exportRecoveryKey = React.useCallback(async () => {
    if (!recoveryKey) {
      return;
    }
    try {
      const result = await Share.share({
        message: recoveryKey,
        title: "Qop recovery key",
      });
      if (result.action === Share.sharedAction) {
        setBackedUp(true);
        setBackupError(undefined);
        playSuccessHaptic();
      }
    } catch {
      setBackupError("Could not export the recovery key. Try again.");
    }
  }, [recoveryKey]);

  const continueToApp = React.useCallback(async () => {
    if (finishing) {
      return;
    }
    setFinishing(true);
    setBackupError(undefined);
    const result = await setBackupState(backedUp ? "copied" : "skipped");
    if (Result.isFailure(result)) {
      setBackupError("Could not save the backup choice. Try again.");
      setFinishing(false);
      return;
    }
    playSuccessHaptic();
  }, [backedUp, finishing, setBackupState]);

  const submitCreate = React.useCallback(() => {
    void create();
  }, [create]);

  const submitRecoveryExport = React.useCallback(() => {
    void exportRecoveryKey();
  }, [exportRecoveryKey]);

  const submitContinue = React.useCallback(() => {
    void continueToApp();
  }, [continueToApp]);

  const displayedBackupError = getDisplayedBackupError(
    backupError,
    recoveryKeyError
  );
  const recoveryButtonLabel = React.useMemo(
    () =>
      getRecoveryButtonLabel({
        backedUp,
        isOpening: isOpeningRecoveryKey,
        recoveryKey,
      }),
    [backedUp, isOpeningRecoveryKey, recoveryKey]
  );

  let content: React.ReactNode;
  if (status === "error") {
    content = <VaultErrorScreen error={error} key="vault-error" />;
  } else if (isBackup) {
    content = (
      <Animated.View
        entering={stepTransition}
        exiting={stepExit}
        key="backup"
        className="grow justify-between gap-10"
      >
        <View className="gap-8">
          <View className="items-end">
            <StepIndicator step={2} />
          </View>
          <View className="gap-3">
            <Text
              accessibilityRole="header"
              className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
            >
              Save your recovery key.
            </Text>
            <Text className="max-w-md text-foreground-secondary" variant="body">
              This key restores @{identity?.handle}. Qop cannot reset or replace
              it for you.
            </Text>
          </View>

          <View className="gap-3">
            <View
              className="border-border bg-code-background rounded-xl border p-4"
              style={{ borderCurve: "continuous" }}
            >
              {recoveryKey ? (
                <Text
                  accessibilityLabel="Recovery key"
                  className="font-mono text-sm leading-6"
                  selectable
                >
                  {recoveryKey}
                </Text>
              ) : (
                <View className="h-12 items-center justify-center">
                  <ActivityIndicator colorClassName="accent-foreground-secondary" />
                </View>
              )}
            </View>
            <Text
              className="text-foreground-secondary"
              selectable
              variant="caption"
            >
              Anyone with this key controls your qop. Keep it private.
            </Text>
          </View>
        </View>

        <View className="gap-3">
          {displayedBackupError ? (
            <Text
              className="text-center text-destructive"
              selectable
              variant="caption"
            >
              {displayedBackupError}
            </Text>
          ) : null}
          <Button
            accessibilityHint="Opens the system share sheet to export the recovery key"
            className="h-14 rounded-xl"
            disabled={isOpeningRecoveryKey}
            onPress={recoveryKey ? submitRecoveryExport : retryRecoveryKey}
            size="lg"
          >
            {isOpeningRecoveryKey ? (
              <ActivityIndicator colorClassName="accent-primary-foreground" />
            ) : (
              <Icon as={backedUp ? Check : Share2} className="size-5" />
            )}
            <Text>{recoveryButtonLabel}</Text>
          </Button>
          <Button
            accessibilityHint={
              backedUp
                ? "Finishes identity creation"
                : "Finishes identity creation without confirming a backup"
            }
            className="h-10 self-center rounded-full px-5"
            disabled={finishing}
            onPress={submitContinue}
            size="sm"
            variant="ghost"
          >
            {finishing ? (
              <ActivityIndicator colorClassName="accent-foreground-secondary" />
            ) : null}
            <Text>{backedUp ? "Continue" : "I'll save it later"}</Text>
          </Button>
        </View>
      </Animated.View>
    );
  } else if (stage === "handle") {
    content = (
      <Animated.View
        entering={stepTransition}
        exiting={stepExit}
        key="handle"
        className="grow justify-between gap-10"
      >
        <View className="gap-8">
          <View className="flex-row items-start justify-between">
            <Button
              accessibilityLabel="Back"
              className="h-10 -translate-x-3 rounded-full px-3"
              disabled={isCreating}
              onPress={goBack}
              variant="ghost"
            >
              <Icon as={ArrowLeft} className="size-5" />
              <Text>Back</Text>
            </Button>
            <StepIndicator step={1} />
          </View>

          <View className="gap-3">
            <Text
              accessibilityRole="header"
              className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
            >
              Create your qop.
            </Text>
            <Text className="max-w-md text-foreground-secondary" variant="body">
              Choose the handle people will know you by.
            </Text>
          </View>

          <View className="gap-3">
            <Text variant="label">Your handle</Text>
            <Input
              accessibilityHint="Lowercase letters, numbers, and underscores"
              accessibilityLabel="qop handle"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              className="border-border bg-background-element h-14 rounded-xl px-4 text-[18px] dark:bg-background-element"
              editable={!isCreating}
              enterKeyHint="done"
              maxLength={32}
              onChangeText={setHandle}
              onSubmitEditing={submitCreate}
              placeholder="your_handle"
              returnKeyType="done"
              spellCheck={false}
              value={handle}
            />
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
                ? `@${handle} is valid. Availability is checked during registration.`
                : getHandleHint(handle)}
            </Text>
          </View>
        </View>

        <View className="gap-3">
          <Button
            accessibilityHint="Generates and securely stores a new qop identity"
            className="h-14 rounded-xl"
            disabled={!isValidHandle || isCreating}
            onPress={submitCreate}
            size="lg"
          >
            {isCreating ? (
              <ActivityIndicator colorClassName="accent-primary-foreground" />
            ) : (
              <Icon as={Plus} className="size-5" />
            )}
            <Text>{isCreating ? "Creating…" : `Create @${handle}`}</Text>
          </Button>
          <Text
            className="text-center text-foreground-secondary"
            selectable
            variant="caption"
          >
            Your recovery and device keys stay in secure storage on this device.
          </Text>
        </View>
      </Animated.View>
    );
  } else {
    content = (
      <Animated.View
        entering={stepTransition}
        exiting={stepExit}
        key="intro"
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
              Create a qop that you control with one recovery key.
            </Text>
          </View>
        </View>

        <Button
          accessibilityHint="Starts creating a new qop identity"
          className="h-14 rounded-xl"
          onPress={startCreate}
          size="lg"
        >
          <Icon as={Plus} className="size-5" />
          <Text>Create your qop</Text>
        </Button>
      </Animated.View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="grow"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 72),
        paddingTop: Math.max(insets.top, 24),
      }}
      contentInsetAdjustmentBehavior="never"
      keyboardDismissMode={
        process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
      }
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-xl grow self-center gap-10 px-6 py-3 sm:px-10 sm:py-8">
        {content}
      </View>
    </ScrollView>
  );
});
OnboardingRoute.displayName = "OnboardingRoute";

export default OnboardingRoute;
