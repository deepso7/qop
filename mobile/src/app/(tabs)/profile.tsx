import { Result } from "effect";
import * as React from "react";
import { ActivityIndicator, Platform, Share, View } from "react-native";

import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { NativeAlert } from "@/components/ui/native-alert";
import { SectionLabel } from "@/components/ui/section-label";
import { Surface } from "@/components/ui/surface";
import { Text } from "@/components/ui/text";
import { useIdentityStore } from "@/lib/identity-store";

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
  const [exportingRecoveryKey, setExportingRecoveryKey] = React.useState(false);
  const [awaitingBackupConfirmation, setAwaitingBackupConfirmation] =
    React.useState(false);
  const [logoutAlertOpen, setLogoutAlertOpen] = React.useState(false);
  const [recoveryMessage, setRecoveryMessage] = React.useState<string>();
  const needsBackup = identity?.backupState !== "copied";
  const logout = React.useMemo(
    () => logoutPresentation(needsBackup),
    [needsBackup]
  );
  const recovery = React.useMemo(
    () => recoveryPresentation(needsBackup),
    [needsBackup]
  );

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
          className="rounded-xl border border-background-selected p-4"
          tone="element"
        >
          <View className="gap-1">
            <Text selectable variant="large">
              @{identity?.handle}
            </Text>
            <Text className="text-foreground-secondary" variant="caption">
              Permanent registered handle
            </Text>
          </View>
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
