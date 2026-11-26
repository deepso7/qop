import { MAILBOX_WAKE_DATA } from "@qop/protocol";
import { BackgroundNotificationTaskResult } from "expo-notifications";
import type { NotificationTaskPayload } from "expo-notifications";
import { defineTask } from "expo-task-manager";

import { MAILBOX_TASK, mailboxPushEnabled } from "./mailbox-notification";

if (mailboxPushEnabled) {
  defineTask<NotificationTaskPayload>(MAILBOX_TASK, async ({ data, error }) => {
    if (error) {
      return BackgroundNotificationTaskResult.Failed;
    }

    if (
      !data ||
      !("data" in data) ||
      data.data?.qopMailboxWake !== MAILBOX_WAKE_DATA.qopMailboxWake
    ) {
      return BackgroundNotificationTaskResult.NoData;
    }

    try {
      const { useP2pStore } = await import("./p2p-store");
      const delivered = await useP2pStore.getState().wakeMailbox();

      return delivered
        ? BackgroundNotificationTaskResult.NewData
        : BackgroundNotificationTaskResult.NoData;
    } catch {
      return BackgroundNotificationTaskResult.Failed;
    }
  });
}
