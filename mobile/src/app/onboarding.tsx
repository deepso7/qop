import { Handle, RegistrationAdmissionCode } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import * as Haptics from "expo-haptics";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Plus,
  Share2,
} from "lucide-react-native";
import * as React from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
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
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { NativeAlert } from "@/components/ui/native-alert";
import { Text } from "@/components/ui/text";
import { useIdentityStore } from "@/lib/identity-store";
import type { IdentityVaultError } from "@/lib/identity-vault";
import {
  checkLocalRegistration,
  startLocalRegistration,
} from "@/lib/local-registration";
import type { LocalRegistration } from "@/lib/local-registration";
import { lookupHandle } from "@/lib/registry";

const decodeHandle = Schema.decodeUnknownResult(Handle);
const decodeAdmissionCode = Schema.decodeUnknownResult(
  RegistrationAdmissionCode
);

// Pre-identity steps; once keys exist the identity store drives the step.
type CreateStage = "code" | "handle" | "intro";

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
    case "sign": {
      return "Qop could not authorize the registration.";
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

const StepIndicatorView = ({ step }: { step: 1 | 2 | 3 }) => (
  <View
    accessibilityLabel={`Step ${step} of 3`}
    accessible
    className="items-end gap-2"
  >
    <Text className="text-foreground-secondary" variant="mono">
      {step} / 3
    </Text>
    <View className="flex-row gap-1.5">
      {[1, 2, 3].map((item) => (
        <View
          className={`h-1 w-8 rounded-full ${item <= step ? "bg-primary" : "bg-border"}`}
          key={item}
        />
      ))}
    </View>
  </View>
);
const StepIndicator = React.memo(StepIndicatorView);
StepIndicator.displayName = "StepIndicator";

// Top row of every step. Fixed height keeps headings aligned whether or not
// the step shows a back button.
const StepHeaderView = ({
  backDisabled,
  onBack,
  step,
}: {
  backDisabled?: boolean;
  onBack?: () => void;
  step: 1 | 2 | 3;
}) => (
  <View className="h-10 flex-row items-start justify-between">
    {onBack ? (
      <Button
        accessibilityLabel="Back"
        className="h-10 -translate-x-3 rounded-full px-3"
        disabled={backDisabled}
        onPress={onBack}
        variant="ghost"
      >
        <Icon as={ArrowLeft} className="size-5" />
        <Text>Back</Text>
      </Button>
    ) : (
      <View />
    )}
    <StepIndicator step={step} />
  </View>
);
const StepHeader = React.memo(StepHeaderView);
StepHeader.displayName = "StepHeader";

const BackupConfirmationButtonView = ({
  onConfirm,
  visible,
}: {
  onConfirm: () => void;
  visible: boolean;
}) => {
  if (!visible) {
    return null;
  }
  return (
    <Button
      accessibilityHint="Confirms that the recovery key was saved outside qop"
      onPress={onConfirm}
      variant="outline"
    >
      <Icon as={Check} className="size-5" />
      <Text>I saved the recovery key</Text>
    </Button>
  );
};
const BackupConfirmationButton = React.memo(BackupConfirmationButtonView);
BackupConfirmationButton.displayName = "BackupConfirmationButton";

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

// Loads the recovery key for the step-3 screen; state lives with that screen,
// so it starts fresh for every identity.
const useRecoveryKey = (
  revealRecoveryKey: () => Promise<Result.Result<string, IdentityVaultError>>
) => {
  const [retryNonce, setRetryNonce] = React.useState(0);
  const [error, setError] = React.useState<string>();
  const [recoveryKey, setRecoveryKey] = React.useState<string>();
  const retryNonceRef = React.useRef(retryNonce);

  React.useEffect(() => {
    retryNonceRef.current = retryNonce;
    let cancelled = false;
    const activeNonce = retryNonce;
    const reveal = async () => {
      const result = await revealRecoveryKey();
      // Drop superseded loads when a newer retry started (cleanup or newer nonce).
      if (cancelled || activeNonce !== retryNonceRef.current) {
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
  }, [revealRecoveryKey, retryNonce]);

  const retry = React.useCallback(() => {
    setError(undefined);
    setRecoveryKey(undefined);
    setRetryNonce((current) => current + 1);
  }, []);

  return {
    error,
    isOpening: !recoveryKey && !error,
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

const useRecoverySetup = (
  revealRecoveryKey: () => Promise<Result.Result<string, IdentityVaultError>>,
  setBackupState: (
    backupState: "copied" | "skipped"
  ) => Promise<Result.Result<void, IdentityVaultError>>
) => {
  const [backedUp, setBackedUp] = React.useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const [backupError, setBackupError] = React.useState<string>();
  const {
    error: recoveryKeyError,
    isOpening,
    recoveryKey,
    retry,
  } = useRecoveryKey(revealRecoveryKey);

  const exportRecoveryKey = React.useCallback(async () => {
    if (!recoveryKey) {
      return;
    }
    setAwaitingConfirmation(false);
    try {
      const result = await Share.share({
        message: recoveryKey,
        title: "Qop recovery key",
      });
      if (result.action === Share.sharedAction) {
        if (Platform.OS === "android") {
          setAwaitingConfirmation(true);
          setBackupError(undefined);
          return;
        }
        setBackedUp(true);
        setBackupError(undefined);
        playSuccessHaptic();
      }
    } catch {
      setBackupError("Could not export the recovery key. Try again.");
    }
  }, [recoveryKey]);

  const confirmBackup = React.useCallback(() => {
    setAwaitingConfirmation(false);
    setBackedUp(true);
    setBackupError(undefined);
    playSuccessHaptic();
  }, []);

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

  const submitExport = React.useCallback(() => {
    void exportRecoveryKey();
  }, [exportRecoveryKey]);
  const submitContinue = React.useCallback(() => {
    void continueToApp();
  }, [continueToApp]);
  const buttonLabel = React.useMemo(
    () =>
      getRecoveryButtonLabel({
        backedUp,
        isOpening,
        recoveryKey,
      }),
    [backedUp, isOpening, recoveryKey]
  );

  return {
    awaitingConfirmation,
    backedUp,
    buttonLabel,
    confirmBackup,
    error: getDisplayedBackupError(backupError, recoveryKeyError),
    finishing,
    isOpening,
    recoveryKey,
    retry,
    submitContinue,
    submitExport,
  };
};

const canStartRegistration = (
  registration: LocalRegistration | null | undefined
) =>
  registration === null ||
  registration?.status === "failed" ||
  registration?.status === "pending";

const getRegistrationFailureMessage = (
  failureCode: string | null,
  handle: string
) => {
  switch (failureCode) {
    case "HANDLE_TAKEN": {
      return `@${handle} is already taken. Go back to choose another handle.`;
    }
    case "RegistrationUnauthorized": {
      return "That invitation code isn't valid or has already been used.";
    }
    default: {
      return `Registration failed (${failureCode ?? "unknown"}). Try again.`;
    }
  }
};

// Drives step 2. Creates the identity keys on first submit (the handle is only
// a draft until then), then registers them with the invitation code.
const useOnboardingRegistration = (handle: string) => {
  const createIdentity = useIdentityStore((state) => state.createIdentity);
  const hydrate = useIdentityStore((state) => state.hydrate);
  const identity = useIdentityStore((state) => state.identity);
  const storedRegistration = useIdentityStore((state) => state.registration);
  const [registrationOverride, setRegistrationOverride] = React.useState<{
    ownerAddress: string;
    value: LocalRegistration;
  }>();
  const registration =
    registrationOverride &&
    registrationOverride.ownerAddress === identity?.ownerAddress
      ? registrationOverride.value
      : storedRegistration;
  const [admissionCode, setAdmissionCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const checking = React.useRef(false);
  const isValidAdmissionCode = React.useMemo(
    () => Result.isSuccess(decodeAdmissionCode(admissionCode)),
    [admissionCode]
  );

  const acceptRegistration = React.useCallback(
    (ownerAddress: string, nextRegistration: LocalRegistration) => {
      setRegistrationOverride({ ownerAddress, value: nextRegistration });
      if (nextRegistration.status === "failed") {
        setMessage(
          getRegistrationFailureMessage(
            nextRegistration.failureCode,
            nextRegistration.handle
          )
        );
        return;
      }
      setMessage(
        nextRegistration.status === "pending"
          ? "Submission not confirmed. Retry with your invitation code while we check the registry."
          : undefined
      );
      if (nextRegistration.status !== "confirmed") {
        return;
      }
      playSuccessHaptic();
      void hydrate();
    },
    [hydrate]
  );

  const register = React.useCallback(async () => {
    if (!isValidAdmissionCode || busy) {
      return;
    }
    Keyboard.dismiss();
    playPrimaryHaptic();
    setBusy(true);
    setMessage(undefined);
    let ownerAddress = identity?.ownerAddress;
    if (!ownerAddress) {
      const created = await createIdentity(handle);
      if (Result.isFailure(created)) {
        // The store switches onboarding to the vault error screen.
        setBusy(false);
        return;
      }
      ({ ownerAddress } = created.success);
    }
    const result = await Effect.runPromise(
      startLocalRegistration(admissionCode).pipe(Effect.result)
    );
    if (Result.isSuccess(result)) {
      if (result.success.status !== "pending") {
        setAdmissionCode("");
      }
      acceptRegistration(ownerAddress, result.success);
    } else {
      setMessage(
        "Could not register this identity. Check the invitation code and connection."
      );
    }
    setBusy(false);
  }, [
    acceptRegistration,
    admissionCode,
    busy,
    createIdentity,
    handle,
    identity?.ownerAddress,
    isValidAdmissionCode,
  ]);

  const ownerAddress = identity?.ownerAddress;
  React.useEffect(() => {
    if (
      !ownerAddress ||
      (registration?.status !== "submitted" &&
        registration?.status !== "pending")
    ) {
      return;
    }
    let mounted = true;
    const check = async () => {
      if (checking.current) {
        return;
      }
      checking.current = true;
      const result = await Effect.runPromise(
        checkLocalRegistration().pipe(Effect.result)
      );
      checking.current = false;
      if (!mounted) {
        return;
      }
      if (Result.isSuccess(result)) {
        acceptRegistration(ownerAddress, result.success);
      } else {
        setMessage("Could not check registration. Retrying…");
      }
    };
    void check();
    const interval = setInterval(() => {
      void check();
    }, 4000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [acceptRegistration, ownerAddress, registration?.status]);

  const submit = React.useCallback(() => {
    void register();
  }, [register]);

  return {
    admissionCode,
    busy,
    isValidAdmissionCode,
    message,
    registration,
    setAdmissionCode,
    submit,
  };
};

interface RegistrationStepProps {
  handle: string;
  // Returns to step 1, discarding any unregistered identity keys.
  onBack: () => void;
}

const RegistrationStepView = ({ handle, onBack }: RegistrationStepProps) => {
  const {
    admissionCode,
    busy,
    isValidAdmissionCode,
    message,
    registration,
    setAdmissionCode,
    submit,
  } = useOnboardingRegistration(handle);
  const canStart = canStartRegistration(registration);
  // A pending submission may still land on-chain, so keep the identity.
  const canGoBack = !busy && registration?.status !== "pending";

  const registrationStatus = canStart ? (
    <View className="gap-3">
      <Text variant="label">Invitation code</Text>
      <Input
        accessibilityLabel="Invitation code"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect={false}
        className="border-border bg-background-element dark:bg-background-element h-14 rounded-xl px-4 text-center font-mono text-[18px] tracking-widest"
        editable={!busy}
        enterKeyHint="done"
        maxLength={7}
        onChangeText={setAdmissionCode}
        onSubmitEditing={submit}
        placeholder="XXX-XXX"
        returnKeyType="done"
        spellCheck={false}
        value={admissionCode}
      />
      <Text className="text-foreground-secondary" selectable variant="caption">
        Invitation codes are six characters and can be used once.
      </Text>
    </View>
  ) : (
    <View className="border-border bg-background-element gap-2 rounded-xl border p-4">
      <ActivityIndicator colorClassName="accent-foreground-secondary" />
      <Text className="text-center" variant="label">
        Registering @{handle} on Sepolia…
      </Text>
      <Text className="text-foreground-secondary text-center" variant="caption">
        Sepolia confirmation can take a few seconds.
      </Text>
    </View>
  );

  let action: React.ReactNode;
  if (canStart) {
    action = (
      <Button
        accessibilityHint="Creates your qop keys and registers the handle"
        className="h-14 rounded-xl"
        disabled={!isValidAdmissionCode || busy}
        onPress={submit}
        size="lg"
      >
        {busy ? (
          <ActivityIndicator colorClassName="accent-primary-foreground" />
        ) : null}
        <Text>{busy ? "Registering…" : `Register @${handle}`}</Text>
      </Button>
    );
  }

  return (
    <Animated.View
      entering={stepTransition}
      exiting={stepExit}
      className="grow justify-between gap-10"
    >
      <View className="gap-8">
        <StepHeader
          backDisabled={!canGoBack}
          onBack={canStart ? onBack : undefined}
          step={2}
        />
        <View className="gap-3">
          <Text
            accessibilityRole="header"
            className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
          >
            Register @{handle}.
          </Text>
          <Text className="text-foreground-secondary max-w-md" variant="body">
            Enter your invitation code to make this handle permanent.
          </Text>
        </View>
        {registrationStatus}
      </View>

      <View className="gap-3">
        {message ? (
          <Text
            className="text-destructive text-center"
            selectable
            variant="caption"
          >
            {message}
          </Text>
        ) : null}
        {action}
        {canStart ? (
          <Text
            className="text-foreground-secondary text-center"
            selectable
            variant="caption"
          >
            Your recovery and device keys stay in secure storage on this device.
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
};
const RegistrationStep = React.memo(RegistrationStepView);
RegistrationStep.displayName = "RegistrationStep";

const RecoveryStepView = ({ handle }: { handle: string }) => {
  const revealRecoveryKey = useIdentityStore(
    (state) => state.revealRecoveryKey
  );
  const setBackupState = useIdentityStore((state) => state.setBackupState);
  const {
    awaitingConfirmation,
    backedUp,
    buttonLabel,
    confirmBackup,
    error,
    finishing,
    isOpening,
    recoveryKey,
    retry,
    submitContinue,
    submitExport,
  } = useRecoverySetup(revealRecoveryKey, setBackupState);

  return (
    <Animated.View
      entering={stepTransition}
      exiting={stepExit}
      className="grow justify-between gap-10"
    >
      <View className="gap-8">
        <StepHeader step={3} />
        <View className="gap-3">
          <Text
            accessibilityRole="header"
            className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
          >
            Save your recovery key.
          </Text>
          <Text className="text-foreground-secondary max-w-md" variant="body">
            @{handle} is yours. This key restores it, and Qop cannot reset or
            replace it for you.
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
        {error ? (
          <Text
            className="text-destructive text-center"
            selectable
            variant="caption"
          >
            {error}
          </Text>
        ) : null}
        <Button
          accessibilityHint="Opens the system share sheet to export the recovery key"
          className="h-14 rounded-xl"
          disabled={isOpening}
          onPress={recoveryKey ? submitExport : retry}
          size="lg"
        >
          {isOpening ? (
            <ActivityIndicator colorClassName="accent-primary-foreground" />
          ) : (
            <Icon as={backedUp ? Check : Share2} className="size-5" />
          )}
          <Text>{buttonLabel}</Text>
        </Button>
        <BackupConfirmationButton
          onConfirm={confirmBackup}
          visible={awaitingConfirmation}
        />
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
};
const RecoveryStep = React.memo(RecoveryStepView);
RecoveryStep.displayName = "RecoveryStep";

const VaultErrorScreenView = ({
  error,
}: {
  error: IdentityVaultError | null;
}) => {
  const isHydrating = useIdentityStore((state) => state.isHydrating);
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);
  const retryLoad = useIdentityStore((state) => state.retryLoad);
  const [resetting, setResetting] = React.useState(false);
  const [resetAlertOpen, setResetAlertOpen] = React.useState(false);
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
    setResetAlertOpen(false);
    void resetVault();
  }, [resetVault]);

  const openResetAlert = React.useCallback(() => {
    setResetAlertOpen(true);
  }, []);

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
            className="text-foreground-secondary text-center"
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
          <Button
            className="h-10 self-center rounded-full px-5"
            disabled={resetting}
            onPress={openResetAlert}
            variant="ghost"
          >
            <Text>Reset this device</Text>
          </Button>
        ) : null}
        <NativeAlert
          confirmLabel="Delete identity"
          description="This permanently removes the local recovery and device keys. Only continue if you have saved the recovery key or want to create a different identity."
          destructive
          onConfirm={confirmReset}
          onOpenChange={setResetAlertOpen}
          open={resetAlertOpen}
          title="Delete the stored identity?"
        />
      </View>
    </Animated.View>
  );
};
const VaultErrorScreen = React.memo(VaultErrorScreenView);
VaultErrorScreen.displayName = "VaultErrorScreen";

type HandleAvailability = "available" | "checking" | "taken" | "unknown";

// Debounced on-chain lookup so taken handles surface on step 1. Registration
// stays the source of truth (in-flight registrations aren't on-chain yet), so
// lookup failures resolve to "unknown" rather than blocking.
const useHandleAvailability = (
  handle: string,
  isValidHandle: boolean
): HandleAvailability | undefined => {
  const [checked, setChecked] = React.useState<{
    availability: Exclude<HandleAvailability, "checking">;
    handle: string;
  }>();

  React.useEffect(() => {
    if (!isValidHandle) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const lookup = await Effect.runPromise(
        lookupHandle(handle).pipe(Effect.result)
      );
      if (cancelled) {
        return;
      }
      let availability: Exclude<HandleAvailability, "checking"> = "unknown";
      if (Result.isSuccess(lookup)) {
        availability = lookup.success === null ? "available" : "taken";
      }
      setChecked({ availability, handle });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle, isValidHandle]);

  if (!isValidHandle) {
    return undefined;
  }
  return checked?.handle === handle ? checked.availability : "checking";
};

const getAvailabilityHint = (
  handle: string,
  availability: HandleAvailability
) =>
  ({
    available: `@${handle} is available.`,
    checking: `Checking @${handle}…`,
    taken: `@${handle} is already taken.`,
    unknown: `@${handle} is valid. Availability is checked during registration.`,
  })[availability];

const OnboardingRouteView = () => {
  const insets = useSafeAreaInsets();
  const error = useIdentityStore((state) => state.error);
  const identity = useIdentityStore((state) => state.identity);
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);
  const status = useIdentityStore((state) => state.status);
  const [stage, setStage] = React.useState<CreateStage>("intro");
  const [handle, setHandle] = React.useState("");

  const isValidHandle = React.useMemo(
    () => Result.isSuccess(decodeHandle(handle)),
    [handle]
  );
  const availability = useHandleAvailability(handle, isValidHandle);
  const canContinue = isValidHandle && availability !== "taken";

  const startCreate = React.useCallback(() => {
    playPrimaryHaptic();
    setStage("handle");
  }, []);

  const goBack = React.useCallback(() => {
    Keyboard.dismiss();
    playSelectionHaptic();
    setStage("intro");
  }, []);

  const continueToRegistration = React.useCallback(() => {
    if (!canContinue) {
      return;
    }
    Keyboard.dismiss();
    playPrimaryHaptic();
    setStage("code");
  }, [canContinue]);

  // The user never saw these keys (the recovery key is only shown after
  // registration), so an unregistered identity is discarded without asking.
  const backToHandle = React.useCallback(async () => {
    Keyboard.dismiss();
    playSelectionHaptic();
    if (identity) {
      const previousHandle = identity.handle;
      const result = await resetIdentity();
      if (Result.isFailure(result)) {
        return;
      }
      setHandle(previousHandle);
    }
    setStage("handle");
  }, [identity, resetIdentity]);

  const submitBackToHandle = React.useCallback(() => {
    void backToHandle();
  }, [backToHandle]);

  let content: React.ReactNode;
  if (status === "resetting" || status === "loading") {
    content = (
      <ActivityIndicator
        accessibilityLabel="Loading identity"
        colorClassName="accent-foreground-secondary"
      />
    );
  } else if (status === "error") {
    content = <VaultErrorScreen error={error} key="vault-error" />;
  } else if (status === "backup" && identity) {
    content = <RecoveryStep handle={identity.handle} key="backup" />;
  } else if (identity || stage === "code") {
    // Same key before and after the identity is created, so step state
    // survives the "creating" → "unregistered" transition.
    content = (
      <RegistrationStep
        handle={identity?.handle ?? handle}
        key="registration"
        onBack={submitBackToHandle}
      />
    );
  } else if (stage === "handle") {
    let hintClassName = "text-foreground-secondary";
    if ((handle.length > 0 && !isValidHandle) || availability === "taken") {
      hintClassName = "text-destructive";
    }
    content = (
      <Animated.View
        entering={stepTransition}
        exiting={stepExit}
        key="handle"
        className="grow justify-between gap-10"
      >
        <View className="gap-8">
          <StepHeader onBack={goBack} step={1} />

          <View className="gap-3">
            <Text
              accessibilityRole="header"
              className="max-w-lg text-4xl leading-11 font-semibold tracking-tight"
            >
              Create your qop.
            </Text>
            <Text className="text-foreground-secondary max-w-md" variant="body">
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
              className="border-border bg-background-element dark:bg-background-element h-14 rounded-xl px-4 text-[18px]"
              enterKeyHint="next"
              maxLength={32}
              onChangeText={setHandle}
              onSubmitEditing={continueToRegistration}
              placeholder="your_handle"
              returnKeyType="next"
              spellCheck={false}
              value={handle}
            />
            <Text className={hintClassName} selectable variant="caption">
              {availability
                ? getAvailabilityHint(handle, availability)
                : getHandleHint(handle)}
            </Text>
          </View>
        </View>

        <Button
          className="h-14 rounded-xl"
          disabled={!canContinue}
          onPress={continueToRegistration}
          size="lg"
        >
          <Text>Continue</Text>
          <Icon as={ArrowRight} className="size-5" />
        </Button>
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
              className="text-foreground-secondary max-w-sm text-center"
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
      className="bg-background flex-1"
      contentContainerClassName="grow"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 24),
        paddingTop: Math.max(insets.top, 24),
      }}
      contentInsetAdjustmentBehavior="never"
      keyboardDismissMode={
        process.env.EXPO_OS === "ios" ? "interactive" : "on-drag"
      }
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-xl grow gap-10 self-center px-6 py-3 sm:px-10 sm:py-8">
        {content}
      </View>
    </ScrollView>
  );
};
const OnboardingRoute = React.memo(OnboardingRouteView);
OnboardingRoute.displayName = "OnboardingRoute";

export default OnboardingRoute;
