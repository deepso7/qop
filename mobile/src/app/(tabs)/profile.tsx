import { Handle, RegistrationAdmissionCode } from "@qop/identity";
import { Effect, Result, Schema } from "effect";
import * as React from "react";
import { ActivityIndicator, Platform, Share, View } from "react-native";

import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeAlert } from "@/components/ui/native-alert";
import { SectionLabel } from "@/components/ui/section-label";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { useIdentityStore } from "@/lib/identity-store";
import {
  loadLocalRegistration,
  reconcileLocalRegistration,
  startLocalRegistration,
} from "@/lib/local-registration";
import type { LocalRegistration } from "@/lib/local-registration";

const decodeHandle = Schema.decodeUnknownResult(Handle);
const decodeAdmissionCode = Schema.decodeUnknownResult(
  RegistrationAdmissionCode
);

const registrationStatusLabel = (
  registration: LocalRegistration | null | undefined
) => {
  switch (registration?.status) {
    case "confirmed": {
      return registration.qid
        ? `Registered · qid ${registration.qid}`
        : "Registered";
    }
    case "submitted": {
      return "Registration submitted";
    }
    case "ready": {
      return "Registration authorized";
    }
    case "pending_owner_signature": {
      return "Registration awaiting authorization";
    }
    case "failed": {
      return "Registration failed";
    }
    case "expired": {
      return "Registration expired";
    }
    case "draft": {
      return "Registration started";
    }
    default: {
      return "Not registered";
    }
  }
};

const canStartRegistration = (
  registration: LocalRegistration | null | undefined
) =>
  registration === null ||
  registration?.status === "draft" ||
  registration?.status === "failed" ||
  registration?.status === "expired";

const recoveryPresentation = (needsBackup: boolean) => {
  if (needsBackup) {
    return {
      activityColor: "accent-primary-foreground",
      buttonLabel: "Back up recovery key",
      buttonVariant: "default",
      status: "Recovery key not backed up",
    } as const;
  }
  return {
    activityColor: "accent-foreground-secondary",
    buttonLabel: "Export again",
    buttonVariant: "outline",
    status: "Recovery key exported",
  } as const;
};

const logoutPresentation = (needsBackup: boolean) => {
  if (needsBackup) {
    return {
      description:
        "This recovery key has not been exported. Logging out now permanently deletes the only known way to recover this identity.",
      title: "Delete an identity without a backup?",
    };
  }
  return {
    description:
      "For now, logging out deletes the local identity and keys from this device. You will need the recovery key to restore it.",
    title: "Log out on this device?",
  };
};

const useProfileRegistration = () => {
  const [registration, setRegistration] =
    React.useState<LocalRegistration | null>();
  const [admissionCode, setAdmissionCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string>();
  const isValidAdmissionCode = React.useMemo(
    () => Result.isSuccess(decodeAdmissionCode(admissionCode)),
    [admissionCode]
  );

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const result = await Effect.runPromise(
        loadLocalRegistration().pipe(Effect.result)
      );
      if (!cancelled) {
        setRegistration(Result.isSuccess(result) ? result.success : null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const register = React.useCallback(async () => {
    if (!isValidAdmissionCode || busy) {
      return;
    }
    setBusy(true);
    setMessage(undefined);
    const result = await Effect.runPromise(
      startLocalRegistration(admissionCode).pipe(Effect.result)
    );
    if (Result.isSuccess(result)) {
      setRegistration(result.success);
      setAdmissionCode("");
      setMessage(
        result.success.status === "confirmed"
          ? "Identity registered."
          : "Registration submitted. Check again after it confirms."
      );
    } else {
      setMessage(
        "Could not register this identity. Check the invitation code and connection."
      );
    }
    setBusy(false);
  }, [admissionCode, busy, isValidAdmissionCode]);

  const check = React.useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setMessage(undefined);
    const result = await Effect.runPromise(
      reconcileLocalRegistration().pipe(Effect.result)
    );
    if (Result.isSuccess(result)) {
      setRegistration(result.success);
      setMessage(
        result.success.status === "confirmed"
          ? "Identity registered."
          : "The registration transaction is still confirming."
      );
    } else {
      setMessage("Could not check registration. Try again.");
    }
    setBusy(false);
  }, [busy]);

  const submit = React.useCallback(() => {
    void register();
  }, [register]);
  const submitCheck = React.useCallback(() => {
    void check();
  }, [check]);

  return {
    admissionCode,
    busy,
    isRegistered: registration?.status === "confirmed",
    isValidAdmissionCode,
    message,
    registration,
    setAdmissionCode,
    submit,
    submitCheck,
  };
};

const RegistrationSection = React.memo(
  ({
    admissionCode,
    busy,
    isRegistered,
    isValidAdmissionCode,
    message,
    registration,
    setAdmissionCode,
    submit,
    submitCheck,
  }: ReturnType<typeof useProfileRegistration>) => (
    <View className="gap-2">
      <SectionLabel>Registration</SectionLabel>
      <Surface
        className="gap-4 rounded-xl border border-background-selected p-4"
        tone="element"
      >
        <View className="gap-1">
          <Text variant="label">{registrationStatusLabel(registration)}</Text>
          <Text className="text-foreground-secondary" variant="caption">
            Registration anchors your handle and owner key to the qop identity
            registry.
          </Text>
        </View>
        {canStartRegistration(registration) ? (
          <View className="gap-3">
            <Input
              accessibilityLabel="Registration invitation code"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect={false}
              editable={!busy}
              maxLength={7}
              onChangeText={setAdmissionCode}
              onSubmitEditing={submit}
              placeholder="XXX-XXX"
              spellCheck={false}
              value={admissionCode}
            />
            <Button disabled={!isValidAdmissionCode || busy} onPress={submit}>
              {busy ? (
                <ActivityIndicator colorClassName="accent-primary-foreground" />
              ) : null}
              <Text>
                {registration === null ? "Register identity" : "Try again"}
              </Text>
            </Button>
          </View>
        ) : null}
        {registration &&
        !isRegistered &&
        !canStartRegistration(registration) ? (
          <Button disabled={busy} onPress={submitCheck} variant="outline">
            {busy ? (
              <ActivityIndicator colorClassName="accent-foreground-secondary" />
            ) : null}
            <Text>Check registration</Text>
          </Button>
        ) : null}
        {message ? (
          <Text
            className="text-center text-foreground-secondary"
            selectable
            variant="caption"
          >
            {message}
          </Text>
        ) : null}
      </Surface>
    </View>
  )
);
RegistrationSection.displayName = "RegistrationSection";

const ProfileScreen = React.memo(() => {
  const identity = useIdentityStore((state) => state.identity);
  const revealRecoveryKey = useIdentityStore(
    (state) => state.revealRecoveryKey
  );
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);
  const setBackupState = useIdentityStore((state) => state.setBackupState);
  const updateHandle = useIdentityStore((state) => state.updateHandle);
  const {
    admissionCode,
    busy: registrationBusy,
    isRegistered,
    isValidAdmissionCode,
    message: registrationMessage,
    registration,
    setAdmissionCode,
    submit: submitRegistration,
    submitCheck: submitRegistrationCheck,
  } = useProfileRegistration();
  const [editingHandle, setEditingHandle] = React.useState(false);
  const [handle, setHandle] = React.useState(identity?.handle ?? "");
  const [savingHandle, setSavingHandle] = React.useState(false);
  const [handleError, setHandleError] = React.useState<string>();
  const [exportingRecoveryKey, setExportingRecoveryKey] = React.useState(false);
  const [awaitingBackupConfirmation, setAwaitingBackupConfirmation] =
    React.useState(false);
  const [logoutAlertOpen, setLogoutAlertOpen] = React.useState(false);
  const [recoveryMessage, setRecoveryMessage] = React.useState<string>();
  const isValidHandle = React.useMemo(
    () => Result.isSuccess(decodeHandle(handle)),
    [handle]
  );
  const needsBackup = identity?.backupState !== "copied";
  const logout = React.useMemo(
    () => logoutPresentation(needsBackup),
    [needsBackup]
  );
  const recovery = React.useMemo(
    () => recoveryPresentation(needsBackup),
    [needsBackup]
  );

  const beginHandleEdit = React.useCallback(() => {
    setEditingHandle(true);
  }, []);

  const cancelHandleEdit = React.useCallback(() => {
    setHandle(identity?.handle ?? "");
    setHandleError(undefined);
    setEditingHandle(false);
  }, [identity?.handle]);

  const saveHandle = React.useCallback(async () => {
    if (!isValidHandle || savingHandle) {
      return;
    }
    setSavingHandle(true);
    setHandleError(undefined);
    const result = await updateHandle(handle);
    if (Result.isFailure(result)) {
      setHandleError("Could not save this handle. Try again.");
      setSavingHandle(false);
      return;
    }
    setSavingHandle(false);
    setEditingHandle(false);
  }, [handle, isValidHandle, savingHandle, updateHandle]);

  const exportRecoveryKey = React.useCallback(async () => {
    if (exportingRecoveryKey) {
      return;
    }
    setExportingRecoveryKey(true);
    setAwaitingBackupConfirmation(false);
    setRecoveryMessage(undefined);
    const revealed = await revealRecoveryKey();
    if (Result.isFailure(revealed)) {
      setRecoveryMessage("Could not open the recovery key. Try again.");
      setExportingRecoveryKey(false);
      return;
    }
    try {
      const shared = await Share.share({
        message: revealed.success,
        title: "Qop recovery key",
      });
      if (shared.action === Share.sharedAction) {
        if (Platform.OS === "android") {
          if (needsBackup) {
            setAwaitingBackupConfirmation(true);
            setRecoveryMessage("Confirm once you have saved the recovery key.");
          } else {
            setRecoveryMessage("Recovery key share sheet opened.");
          }
          return;
        }
        const saved = await setBackupState("copied");
        setRecoveryMessage(
          Result.isSuccess(saved)
            ? "Recovery key exported."
            : "Key exported, but Qop could not save the backup status."
        );
      }
    } catch {
      setRecoveryMessage("Could not export the recovery key. Try again.");
    } finally {
      setExportingRecoveryKey(false);
    }
  }, [exportingRecoveryKey, needsBackup, revealRecoveryKey, setBackupState]);

  const confirmRecoveryBackup = React.useCallback(async () => {
    if (exportingRecoveryKey) {
      return;
    }
    setExportingRecoveryKey(true);
    const saved = await setBackupState("copied");
    if (Result.isSuccess(saved)) {
      setAwaitingBackupConfirmation(false);
      setRecoveryMessage("Recovery key marked as backed up.");
    } else {
      setRecoveryMessage("Could not save the backup status. Try again.");
    }
    setExportingRecoveryKey(false);
  }, [exportingRecoveryKey, setBackupState]);

  const submitHandle = React.useCallback(() => {
    void saveHandle();
  }, [saveHandle]);

  const submitRecoveryExport = React.useCallback(() => {
    void exportRecoveryKey();
  }, [exportRecoveryKey]);

  const confirmReset = React.useCallback(() => {
    setLogoutAlertOpen(false);
    void resetIdentity();
  }, [resetIdentity]);

  const openLogoutAlert = React.useCallback(() => {
    setLogoutAlertOpen(true);
  }, []);

  return (
    <Screen bounces={false}>
      <View className="gap-1">
        <Text variant="title">Profile</Text>
        <Text className="text-foreground-secondary" variant="caption">
          Manage your identity on this device.
        </Text>
      </View>

      <View className="gap-2">
        <SectionLabel>Identity</SectionLabel>
        <Surface
          className="gap-4 rounded-xl border border-background-selected p-4"
          tone="element"
        >
          <View className="flex-row items-center justify-between gap-4">
            <View className="shrink gap-1">
              <Text variant="large">@{identity?.handle}</Text>
              <Text className="text-foreground-secondary" variant="caption">
                {isRegistered
                  ? "Permanent registered handle"
                  : "Registration handle · keys stay unchanged"}
              </Text>
            </View>
            {editingHandle || isRegistered ? null : (
              <Button
                accessibilityLabel="Change registration handle"
                onPress={beginHandleEdit}
                size="sm"
                variant="ghost"
              >
                <Text>Change</Text>
              </Button>
            )}
          </View>
          {editingHandle ? (
            <View className="gap-3">
              <Input
                accessibilityLabel="New qop handle"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!savingHandle}
                maxLength={32}
                onChangeText={setHandle}
                onSubmitEditing={submitHandle}
                spellCheck={false}
                value={handle}
              />
              {handleError ? (
                <Text className="text-destructive" selectable variant="caption">
                  {handleError}
                </Text>
              ) : null}
              <View className="flex-row justify-end gap-2">
                <Button
                  disabled={savingHandle}
                  onPress={cancelHandleEdit}
                  size="sm"
                  variant="ghost"
                >
                  <Text>Cancel</Text>
                </Button>
                <Button
                  disabled={
                    !isValidHandle ||
                    savingHandle ||
                    handle === identity?.handle
                  }
                  onPress={submitHandle}
                  size="sm"
                >
                  {savingHandle ? (
                    <ActivityIndicator colorClassName="accent-primary-foreground" />
                  ) : null}
                  <Text>Save handle</Text>
                </Button>
              </View>
            </View>
          ) : null}
        </Surface>
      </View>

      <RegistrationSection
        admissionCode={admissionCode}
        busy={registrationBusy}
        isRegistered={isRegistered}
        isValidAdmissionCode={isValidAdmissionCode}
        message={registrationMessage}
        registration={registration}
        setAdmissionCode={setAdmissionCode}
        submit={submitRegistration}
        submitCheck={submitRegistrationCheck}
      />

      <View className="gap-2">
        <SectionLabel>Recovery</SectionLabel>
        <Surface
          className="gap-4 rounded-xl border border-background-selected p-4"
          tone="element"
        >
          <View className="gap-1">
            <Text variant="label">{recovery.status}</Text>
            <Text className="text-foreground-secondary" variant="caption">
              Export it somewhere private. Anyone with this key controls your
              qop.
            </Text>
          </View>
          <Button
            disabled={exportingRecoveryKey}
            onPress={submitRecoveryExport}
            variant={recovery.buttonVariant}
          >
            {exportingRecoveryKey ? (
              <ActivityIndicator colorClassName={recovery.activityColor} />
            ) : null}
            <Text>{recovery.buttonLabel}</Text>
          </Button>
          {awaitingBackupConfirmation ? (
            <Button
              accessibilityHint="Confirms that the recovery key was saved outside qop"
              disabled={exportingRecoveryKey}
              onPress={confirmRecoveryBackup}
              variant="outline"
            >
              <Text>I saved the recovery key</Text>
            </Button>
          ) : null}
          {recoveryMessage ? (
            <Text
              className="text-center text-foreground-secondary"
              selectable
              variant="caption"
            >
              {recoveryMessage}
            </Text>
          ) : null}
        </Surface>
      </View>

      <View className="gap-2">
        <Button
          className="h-12 rounded-xl"
          onPress={openLogoutAlert}
          variant="destructive"
        >
          <Text>Log out</Text>
        </Button>
        <NativeAlert
          confirmLabel="Log out"
          description={logout.description}
          destructive
          onConfirm={confirmReset}
          onOpenChange={setLogoutAlertOpen}
          open={logoutAlertOpen}
          title={logout.title}
        />
        <Text
          className="text-center text-foreground-secondary"
          variant="caption"
        >
          You will need your recovery key to restore this identity.
        </Text>
      </View>
    </Screen>
  );
});
ProfileScreen.displayName = "ProfileScreen";

export default ProfileScreen;
