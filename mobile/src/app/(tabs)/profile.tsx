import { FieldGroup, Host, ListItem, Text as UIText } from "@expo/ui";
import { pairingFingerprint } from "@qop/protocol";
import { Result } from "effect";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import * as React from "react";
import {
  ActivityIndicator,
  Platform,
  Share,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NativeAlert } from "@/components/ui/native-alert";
import { settingsFormModifiers } from "@/components/ui/settings-form-modifiers";
import { Text } from "@/components/ui/text";
import { useTheme } from "@/constants/theme";
import { useDeviceRoster } from "@/hooks/use-device-roster";
import { selectionHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";

// On Android each FieldGroup.Section row is already a Compose ListItem, so
// make ours transparent instead of drawing a second card inside it.
const transparentRow = { containerColor: "transparent" };

/** A settings row; see `transparentRow` for the Android nesting. */
const SettingsRow = (props: React.ComponentProps<typeof ListItem>) => (
  <ListItem colors={transparentRow} {...props} />
);

/** Secondary text for a settings row's value or subtitle. */
const Secondary = ({ children }: { children: string }) => {
  const colors = useTheme();
  return (
    <UIText textStyle={{ color: colors.textSecondary }}>{children}</UIText>
  );
};

const recoveryPresentation = (needsBackup: boolean) =>
  needsBackup
    ? { buttonLabel: "Back up recovery key", status: "Not backed up" }
    : { buttonLabel: "Export again", status: "Backed up" };

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

const ProfileScreen = () => {
  const { push } = useRouter();
  const roster = useDeviceRoster();
  const [removeKey, setRemoveKey] = React.useState<string>();
  const insets = useSafeAreaInsets();
  const colors = useTheme();
  const colorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const [peerIdCopied, setPeerIdCopied] = React.useState(false);
  const identity = useIdentityStore((state) => state.identity);
  const registration = useIdentityStore((state) => state.registration);
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
        } else {
          const saved = await setBackupState("copied");
          setRecoveryMessage(
            Result.isSuccess(saved)
              ? "Recovery key exported."
              : "Key exported, but Qop could not save the backup status."
          );
        }
      }
    } catch {
      setRecoveryMessage("Could not export the recovery key. Try again.");
    }
    setExportingRecoveryKey(false);
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

  const { remove, retry: retryRoster } = roster;
  const confirmRemove = React.useCallback(() => {
    const deviceKey = removeKey;
    setRemoveKey(undefined);
    if (deviceKey) {
      void remove(deviceKey);
    }
  }, [remove, removeKey]);

  const openLogoutAlert = React.useCallback(() => {
    setLogoutAlertOpen(true);
  }, []);

  const copyPeerId = React.useCallback(async () => {
    if (!identity) {
      return;
    }
    await Clipboard.setStringAsync(identity.peerId);
    void selectionHaptic();
    setPeerIdCopied(true);
  }, [identity]);

  // Revert the "Copied" confirmation after a moment.
  React.useEffect(() => {
    if (!peerIdCopied) {
      return;
    }
    const timer = setTimeout(() => setPeerIdCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [peerIdCopied]);

  return (
    <View className="bg-background flex-1" style={{ paddingTop: insets.top }}>
      <Text className="px-5 pt-10 pb-2" variant="title">
        Profile
      </Text>
      <Host
        colorScheme={colorScheme}
        seedColor={colors.primary}
        style={{ backgroundColor: colors.background, flex: 1 }}
      >
        <FieldGroup
          modifiers={settingsFormModifiers}
          style={{ backgroundColor: colors.background }}
        >
          <FieldGroup.Section title="Account">
            <SettingsRow
              supportingText={<Secondary>Permanent handle</Secondary>}
            >
              <UIText textStyle={{ fontSize: 20, fontWeight: "600" }}>
                {`@${identity?.handle ?? ""}`}
              </UIText>
            </SettingsRow>
            <SettingsRow
              trailing={<Secondary>{registration?.qid ?? "—"}</Secondary>}
            >
              QID
            </SettingsRow>
            <SettingsRow
              onPress={copyPeerId}
              trailing={
                <Secondary>
                  {peerIdCopied
                    ? "Copied"
                    : `…${identity?.peerId.slice(-8) ?? ""}`}
                </Secondary>
              }
            >
              Peer ID
            </SettingsRow>
          </FieldGroup.Section>

          <FieldGroup.Section title="Recovery key">
            <SettingsRow trailing={<Secondary>{recovery.status}</Secondary>}>
              Status
            </SettingsRow>
            <SettingsRow
              onPress={submitRecoveryExport}
              trailing={
                exportingRecoveryKey ? (
                  <ActivityIndicator color={colors.textSecondary} />
                ) : undefined
              }
            >
              <UIText textStyle={{ color: colors.primary }}>
                {recovery.buttonLabel}
              </UIText>
            </SettingsRow>
            {awaitingBackupConfirmation ? (
              <SettingsRow onPress={confirmRecoveryBackup}>
                <UIText textStyle={{ color: colors.primary }}>
                  I saved the recovery key
                </UIText>
              </SettingsRow>
            ) : null}
            <FieldGroup.SectionFooter>
              <Secondary>
                {recoveryMessage ??
                  "Anyone with this key controls your qop. Keep it somewhere private."}
              </Secondary>
            </FieldGroup.SectionFooter>
          </FieldGroup.Section>

          <FieldGroup.Section title="Devices">
            {roster.status === "loading" ? (
              <SettingsRow>
                <Secondary>Loading devices…</Secondary>
              </SettingsRow>
            ) : null}
            {roster.status === "error" ? (
              <SettingsRow
                onPress={retryRoster}
                trailing={
                  <UIText textStyle={{ color: colors.primary }}>Retry</UIText>
                }
              >
                Could not load devices
              </SettingsRow>
            ) : null}
            {roster.status === "ready"
              ? roster.devices.map((device) =>
                  device.deviceKey === roster.thisDeviceKey ? (
                    <SettingsRow
                      key={device.deviceKey}
                      supportingText={
                        <Secondary>{`…${device.peerId.slice(-8)}`}</Secondary>
                      }
                    >
                      This device
                    </SettingsRow>
                  ) : (
                    <SettingsRow
                      key={device.deviceKey}
                      onPress={() => {
                        if (!roster.removing) {
                          setRemoveKey(device.deviceKey);
                        }
                      }}
                      supportingText={
                        <Secondary>{`…${device.peerId.slice(-8)}`}</Secondary>
                      }
                      trailing={
                        <UIText textStyle={{ color: colors.destructive }}>
                          Remove
                        </UIText>
                      }
                    >
                      {pairingFingerprint(device.deviceKey)}
                    </SettingsRow>
                  )
                )
              : null}
            <SettingsRow onPress={() => push("/link-device")}>
              <UIText textStyle={{ color: colors.primary }}>
                Link a device
              </UIText>
            </SettingsRow>
            <FieldGroup.SectionFooter>
              <Secondary>
                {roster.message ??
                  "Linked devices can send and receive messages as you."}
              </Secondary>
            </FieldGroup.SectionFooter>
          </FieldGroup.Section>

          <FieldGroup.Section>
            <SettingsRow onPress={openLogoutAlert}>
              <UIText textStyle={{ color: colors.destructive }}>Log out</UIText>
            </SettingsRow>
            <FieldGroup.SectionFooter>
              <Secondary>
                You will need your recovery key to restore this identity.
              </Secondary>
            </FieldGroup.SectionFooter>
          </FieldGroup.Section>
        </FieldGroup>
      </Host>
      <NativeAlert
        confirmLabel="Remove"
        description="It will no longer be able to send or receive as you. Conversation history stays."
        destructive
        onConfirm={confirmRemove}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveKey(undefined);
          }
        }}
        open={removeKey !== undefined}
        title={`Remove ${removeKey ? pairingFingerprint(removeKey) : "device"}?`}
      />
      <NativeAlert
        confirmLabel="Log out"
        description={logout.description}
        destructive
        onConfirm={confirmReset}
        onOpenChange={setLogoutAlertOpen}
        open={logoutAlertOpen}
        title={logout.title}
      />
    </View>
  );
};

export default React.memo(ProfileScreen);
