import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

export const MAILBOX_CHANNEL = "mailbox";
export const MAILBOX_TASK = "qop-mailbox-wake";

export const mailboxPushEnabled =
  process.env.EXPO_PUBLIC_QOP_MAILBOX_PUSH === "1" &&
  Boolean(process.env.EXPO_PUBLIC_QOP_MAILBOX_ADDRS);

export const notifyMailboxDelivered = async () => {
  if (!mailboxPushEnabled || AppState.currentState === "active") {
    return;
  }

  try {
    const permission = await Notifications.getPermissionsAsync();

    if (
      !permission.granted &&
      permission.ios?.status !==
        Notifications.IosAuthorizationStatus.PROVISIONAL
    ) {
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: { body: "You have new messages.", title: "qop" },
      identifier: MAILBOX_TASK,
      trigger:
        Platform.OS === "android" ? { channelId: MAILBOX_CHANNEL } : null,
    });
  } catch {
    // The decrypted message is already in the inbox.
  }
};
