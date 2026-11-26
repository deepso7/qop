import { parseMailboxAddrs } from "@qop/protocol";
import { Schema } from "effect";
import * as Notifications from "expo-notifications";
import { isTaskRegisteredAsync } from "expo-task-manager";
import { AppState, Platform } from "react-native";

import {
  MAILBOX_CHANNEL,
  MAILBOX_TASK,
  mailboxPushEnabled,
} from "./mailbox-notification";
import { useP2pStore } from "./p2p-store";

const REFRESH_MS = 24 * 60 * 60 * 1000;
const isNativeToken = Schema.is(Schema.String);

/** Register device tokens while the account and its endpoint are ready. */
export const startMailboxPushRegistration = () => {
  if (!mailboxPushEnabled) {
    return;
  }

  const peers = new Set(
    parseMailboxAddrs(process.env.EXPO_PUBLIC_QOP_MAILBOX_ADDRS).map(
      (peer) => peer.peerId
    )
  );

  if (peers.size === 0) {
    return;
  }

  let stopped = false;
  let latestToken: Notifications.DevicePushToken | undefined;
  let nextRefresh = 0;
  let registration: Promise<void> | undefined;

  const refresh = () => {
    if (
      stopped ||
      registration ||
      AppState.currentState !== "active" ||
      Date.now() < nextRefresh
    ) {
      return;
    }

    const register = async () => {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync(MAILBOX_CHANNEL, {
          importance: Notifications.AndroidImportance.DEFAULT,
          name: "Messages",
        });
      }

      const permission = await Notifications.getPermissionsAsync();

      if (permission.status === "undetermined") {
        await Notifications.requestPermissionsAsync();
      }

      const token =
        latestToken ?? (await Notifications.getDevicePushTokenAsync());

      if (
        stopped ||
        !isNativeToken(token.data) ||
        (token.type !== "ios" && token.type !== "android")
      ) {
        return;
      }

      if (!(await isTaskRegisteredAsync(MAILBOX_TASK))) {
        await Notifications.registerTaskAsync(MAILBOX_TASK);
      }

      if (!stopped) {
        const registered = await useP2pStore.getState().registerMailboxPush({
          platform: token.type === "ios" ? "apns" : "fcm",
          token: token.data,
        });

        if (
          registered.length === peers.size &&
          (!latestToken || latestToken.data === token.data)
        ) {
          nextRefresh = Date.now() + REFRESH_MS;
        }
      }
    };

    const startedWith = latestToken?.data;
    registration = register()
      .catch(() => {
        // Push is optional; the normal mailbox poll still works.
      })
      .finally(() => {
        registration = undefined;

        if (latestToken?.data !== startedWith) {
          refresh();
        }
      });
  };

  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      refresh();
    }
  });

  const tokens = Notifications.addPushTokenListener((token) => {
    latestToken = token;
    nextRefresh = 0;
    refresh();
  });

  refresh();

  return () => {
    stopped = true;
    tokens.remove();
    appState.remove();
  };
};
