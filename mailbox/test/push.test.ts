import { describe, expect, it } from "vitest";

import { apnsWakePayload, fcmWakeMessage } from "../src/push.ts";

describe("mailbox wake payloads", () => {
  it("sends a silent APNs wake and a data-only FCM wake without mailbox metadata", () => {
    expect(apnsWakePayload).toEqual({
      aps: { "content-available": 1 },
      qopMailboxWake: "1",
    });
    expect(fcmWakeMessage("device-token")).toEqual({
      message: {
        android: { collapse_key: "qop-mailbox", priority: "HIGH", ttl: "300s" },
        data: { qopMailboxWake: "1" },
        token: "device-token",
      },
    });
  });
});
