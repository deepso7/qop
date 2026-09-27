import qrCodeIcon from "@expo/material-symbols/qr_code.xml";
import {
  Column,
  FieldGroup,
  Host,
  Icon,
  ListItem,
  Row,
  Spacer,
  Text as UIText,
} from "@expo/ui";
import { pairingFingerprint } from "@qop/protocol";
import { Result } from "effect";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import * as React from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Share,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NativeAlert } from "@/components/ui/native-alert";
import {
  accessibleButtonModifiers,
  settingsFormModifiers,
} from "@/components/ui/native-modifiers";
import { SettingsPalette } from "@/components/ui/settings-palette";
import { Text } from "@/components/ui/text";
import { useTheme } from "@/constants/theme";
import { useDeviceRoster } from "@/hooks/use-device-roster";
import { selectionHaptic } from "@/lib/haptics";
import { useIdentityStore } from "@/lib/identity-store";

interface ProfileCardProps {
  readonly handle: string;
  readonly qid: string;
}

// Soft avatar tints (background, initials), picked per handle so a person
// keeps the same color everywhere.
const avatarTints = [
  ["#E4E1FA", "#4B3F9E"],
  ["#DDF1E6", "#246B45"],
  ["#FBE3D6", "#9A4A22"],
  ["#DCEBFA", "#2A5C8F"],
  ["#F7DDE9", "#8F2E5A"],
] as const;

const avatarTint = (handle: string) => {
  let hash = 0;
  for (const char of handle) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  }
  return avatarTints[hash % avatarTints.length] ?? avatarTints[0];
};

// Placeholder until the QR code for adding contacts exists.
const showQrCode = () => {
  Alert.alert("QR code", "Coming soon.");
};

/** Contact-card header: tinted initials avatar, handle, QID and a QR button. */
const ProfileCard = ({ handle, qid }: ProfileCardProps) => {
  const colors = useTheme();
  const [tint, ink] = avatarTint(handle);
  return (
    // No row-wide spacing: it would also pad around the flexible spacer and
    // squeeze the QR circle when the handle is long.
    <Row alignment="center" style={{ paddingVertical: 14 }}>
      <Column
        alignment="center"
        style={{
          backgroundColor: tint,
          borderRadius: 36,
          height: 72,
          width: 72,
        }}
      >
        <Spacer flexible />
        <UIText textStyle={{ color: ink, fontSize: 28, fontWeight: "600" }}>
          {handle.slice(0, 2).toUpperCase()}
        </UIText>
        <Spacer flexible />
      </Column>
      <Spacer size={16} />
      <Column spacing={4}>
        <UIText
          numberOfLines={1}
          textStyle={{ fontSize: 24, fontWeight: "600" }}
        >
          {`@${handle}`}
        </UIText>
        <UIText textStyle={{ color: colors.textSecondary, fontSize: 17 }}>
          {`QID ${qid}`}
        </UIText>
      </Column>
      <Spacer size={12} />
      <Spacer flexible />
      <Column
        alignment="center"
        modifiers={accessibleButtonModifiers("Show QR code")}
        onPress={showQrCode}
        style={{
          backgroundColor: colors.text,
          borderRadius: 26,
          height: 52,
          width: 52,
        }}
      >
        <Spacer flexible />
        <Icon
          accessibilityLabel="Show QR code"
          color={colors.background}
          name={Icon.select({ android: qrCodeIcon, ios: "qrcode" })}
          size={26}
        />
        <Spacer flexible />
      </Column>
    </Row>
  );
};

interface SettingsRowProps {
  /** Row label as a text element (`UIText` / `Secondary`). */
  readonly children: React.ReactElement;
  readonly onPress?: () => void;
  readonly supportingText?: React.ReactNode;
  readonly trailing?: React.ReactNode;
}

/**
 * A settings row. iOS uses a native ListItem. On Android each
 * FieldGroup.Section row is already a Compose ListItem (card, padding), so
 * render bare content instead of a second list item inside it.
 */
const SettingsRow = ({
  children,
  onPress,
  supportingText,
  trailing,
}: SettingsRowProps) => {
  if (Platform.OS === "ios") {
    return (
      <ListItem
        onPress={onPress}
        supportingText={supportingText}
        trailing={trailing}
      >
        {children}
      </ListItem>
    );
  }
  return (
    <Row alignment="center" onPress={onPress}>
      <Column spacing={2}>
        {children}
        {supportingText}
      </Column>
      <Spacer flexible />
      {trailing}
    </Row>
  );
};

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
        <SettingsPalette>
          <FieldGroup
            modifiers={settingsFormModifiers}
            style={{ backgroundColor: colors.background }}
          >
            <FieldGroup.Section>
              <ProfileCard
                handle={identity?.handle ?? ""}
                qid={registration?.qid ?? "—"}
              />
            </FieldGroup.Section>

            <FieldGroup.Section title="Recovery key">
              <SettingsRow trailing={<Secondary>{recovery.status}</Secondary>}>
                <UIText>Status</UIText>
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
                  <UIText>Could not load devices</UIText>
                </SettingsRow>
              ) : null}
              {roster.status === "ready"
                ? roster.devices.map((device) =>
                    device.deviceKey === roster.thisDeviceKey ? (
                      <SettingsRow
                        key={device.deviceKey}
                        onPress={copyPeerId}
                        supportingText={
                          <Secondary>
                            {peerIdCopied
                              ? "Peer ID copied"
                              : `…${device.peerId.slice(-8)}`}
                          </Secondary>
                        }
                      >
                        <UIText>This device</UIText>
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
                        <UIText>{pairingFingerprint(device.deviceKey)}</UIText>
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
                <UIText textStyle={{ color: colors.destructive }}>
                  Log out
                </UIText>
              </SettingsRow>
              <FieldGroup.SectionFooter>
                <Secondary>
                  You will need your recovery key to restore this identity.
                </Secondary>
              </FieldGroup.SectionFooter>
            </FieldGroup.Section>
          </FieldGroup>
        </SettingsPalette>
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
