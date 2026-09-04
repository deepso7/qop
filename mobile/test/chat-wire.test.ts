import { describe, expect, it } from "vitest";

import {
  assertAckMatches,
  decodeAck,
  decodeFrame,
  encodeAck,
  encodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "@/lib/chat-wire";

const id = "c56a4180-65aa-42ec-a945-5fd21dec0538";

describe("chat wire format", () => {
  it.each([-1, 8_640_000_000_000_001, 1.5, Number.MAX_VALUE])(
    "rejects invalid timestamp %s",
    (sentAt) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ fromHandle: "alice", id, sentAt, text: "hi", v: 1 })
      );
      expect(() => decodeFrame(bytes)).toThrow();
    }
  );

  it("rejects malformed UTF-8 inside an otherwise valid frame", () => {
    const bytes = encodeFrame({
      fromHandle: "alice",
      id,
      sentAt: 1,
      text: "~",
      v: 1,
    });
    bytes[bytes.indexOf(126)] = 255;
    expect(() => decodeFrame(bytes)).toThrow();
  });

  it("round trips frames and acknowledgements", () => {
    const frame = {
      fromHandle: "alice",
      id,
      sentAt: 1_700_000_000_000,
      text: "hello",
      v: 1 as const,
    };

    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    expect(decodeAck(encodeAck({ ack: id, v: 1 }))).toEqual({ ack: id, v: 1 });
  });

  it("rejects payloads over 16 KB before parsing", () => {
    const oversized = new Uint8Array(MAX_CHAT_PAYLOAD_BYTES + 1);
    expect(() => decodeFrame(oversized)).toThrow("exceeds 16 KB");
  });

  it("rejects an unknown frame version", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        fromHandle: "alice",
        id,
        sentAt: 1,
        text: "hello",
        v: 2,
      })
    );
    expect(() => decodeFrame(bytes)).toThrow();
  });

  it("detects an acknowledgement for a different message", () => {
    const ack = decodeAck(
      encodeAck({ ack: "9b2c40a8-705b-4f3b-a3cc-3d723711d851", v: 1 })
    );
    expect(() => assertAckMatches(ack, id)).toThrow("does not match");
  });
});
