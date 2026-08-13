import { Handle } from "@qop/identity";
import { Result, Schema } from "effect";
import * as React from "react";
import { ActivityIndicator, Share, View } from "react-native";

import { Screen } from "@/components/screen";
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
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/ui/section-label";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { useIdentityStore } from "@/lib/identity-store";

const decodeHandle = Schema.decodeUnknownResult(Handle);

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

const ProfileScreen = React.memo(() => {
  const identity = useIdentityStore((state) => state.identity);
  const revealRecoveryKey = useIdentityStore(
    (state) => state.revealRecoveryKey
  );
  const resetIdentity = useIdentityStore((state) => state.resetIdentity);
  const setBackupState = useIdentityStore((state) => state.setBackupState);
  const updateHandle = useIdentityStore((state) => state.updateHandle);
  const [editingHandle, setEditingHandle] = React.useState(false);
  const [handle, setHandle] = React.useState(identity?.handle ?? "");
  const [savingHandle, setSavingHandle] = React.useState(false);
  const [handleError, setHandleError] = React.useState<string>();
  const [exportingRecoveryKey, setExportingRecoveryKey] = React.useState(false);
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
  }, [exportingRecoveryKey, revealRecoveryKey, setBackupState]);

  const submitHandle = React.useCallback(() => {
    void saveHandle();
  }, [saveHandle]);

  const submitRecoveryExport = React.useCallback(() => {
    void exportRecoveryKey();
  }, [exportRecoveryKey]);

  const confirmReset = React.useCallback(() => {
    void resetIdentity();
  }, [resetIdentity]);

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
                Registration handle · keys stay unchanged
              </Text>
            </View>
            {editingHandle ? null : (
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
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="h-12 rounded-xl" variant="destructive">
              <Text>Log out</Text>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{logout.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {logout.description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel accessibilityLabel="Cancel logout">
                <Text>Cancel</Text>
              </AlertDialogCancel>
              <AlertDialogAction
                accessibilityLabel="Log out and delete local identity"
                onPress={confirmReset}
                variant="destructive"
              >
                <Text>Log out</Text>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
