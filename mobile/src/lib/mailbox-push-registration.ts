import { parseMailboxAddrs } from "@qop/protocol";
import { Schema } from "effect";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { MAILBOX_CHANNEL, mailboxPushEnabled } from "./mailbox-notification";
import { createMailboxPushRegistration } from "./mailbox-push-registration-core";
import { useP2pStore } from "./p2p-store";

const isNativeToken = Schema.is(Schema.String);

/** Register device tokens while the account and its endpoint are ready. */
export const startMailboxPushRegistration = () => {
  if (
    !mailboxPushEnabled ||
    (Platform.OS !== "ios" && Platform.OS !== "android")
  ) {
    return;
  }

  const mailboxes = parseMailboxAddrs(
    process.env.EXPO_PUBLIC_QOP_MAILBOX_ADDRS
  );

  if (mailboxes.length === 0) {
    return;
  }

  let latestToken: Notifications.DevicePushToken | undefined;

  const register = async (canRegister: () => boolean) => {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(MAILBOX_CHANNEL, {
        importance: Notifications.AndroidImportance.DEFAULT,
        name: "Messages",
      });
    }

    const permission = await Notifications.getPermissionsAsync();

    if (permission.status === "undetermined" && canRegister()) {
      await Notifications.requestPermissionsAsync();
    }

    if (!canRegister()) {
      return false;
    }

    const token =
      latestToken ?? (await Notifications.getDevicePushTokenAsync());

    if (
      !canRegister() ||
      !isNativeToken(token.data) ||
      (token.type !== "ios" && token.type !== "android")
    ) {
      return false;
    }

    const registered = await useP2pStore.getState().registerMailboxPush({
      platform: token.type === "ios" ? "apns" : "fcm",
      token: token.data,
    });

    return registered.length === mailboxes.length;
  };

  const registration = createMailboxPushRegistration({
    isActive: () => AppState.currentState === "active",
    register,
  });

  const appState = AppState.addEventListener("change", registration.refresh);

  const tokens = Notifications.addPushTokenListener((token) => {
    if (latestToken?.data === token.data) {
      return;
    }

    latestToken = token;
    registration.reset();
  });

  registration.refresh();

  return () => {
    registration.stop();
    tokens.remove();
    appState.remove();
  };
};
