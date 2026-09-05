/* oxlint-disable anti-slop/no-module-mocking -- Substitute the native FFI boundary to exercise the installed SDK adapter in Node. */
import { ClosedError, Minip2p } from "@minip2p/react-native";
import { afterEach, expect, test, vi } from "vitest";

const native = vi.hoisted(() => {
  interface NativeEvent {
    tag: string;
    inner: {
      connId: bigint;
      peerId: string;
      streamId?: bigint;
      protocolId?: string;
      initiatedLocally?: boolean;
      data?: ArrayBuffer;
    };
  }
  class Endpoint {
    static latest: Endpoint;
    events: NativeEvent[] = [];
    doorbell?: { onEventsReady: () => void };
    connId = 2n ** 63n + 1n;
    constructor() {
      Endpoint.latest = this;
    }
    start(doorbell: { onEventsReady: () => void }) {
      this.doorbell = doorbell;
    }
    drainEvents() {
      return this.events.splice(0);
    }
    openStream() {
      return { connId: this.connId, streamId: 7n };
    }
    stop() {
      this.doorbell = undefined;
    }
    uniffiDestroy() {
      this.events.length = 0;
    }
  }
  return { Endpoint };
});

vi.mock("../node_modules/@minip2p/react-native/lib/module/native.js", () => ({
  FfiError_Tags: {},
  P2pEndpoint: native.Endpoint,
  circuitAddress: vi.fn(),
  generateSecretKey: vi.fn(),
  peerIdFromSecretKey: vi.fn(),
}));
vi.mock(
  "../node_modules/@minip2p/react-native/lib/module/NativeMinip2p.js",
  () => ({
    default: { setMdnsEnabled: vi.fn() },
  })
);
vi.mock(
  "../node_modules/@minip2p/react-native/lib/module/hooks.js",
  () => ({})
);

afterEach(() => vi.useRealTimers());

test("native 64-bit connection IDs stay distinct and consistent across events and streams", async () => {
  vi.useFakeTimers();
  const endpoint = Minip2p.create({ secretKey: new Uint8Array(32) });
  const fake = native.Endpoint.latest;
  const connections: number[] = [];
  endpoint.on("connectionEstablished", ({ connId }) =>
    connections.push(connId)
  );
  const ids = [1n, 2n ** 56n + 1n, 2n ** 63n + 1n, 2n ** 63n + 2n];
  fake.events.push(
    ...ids.map((connId) => ({
      inner: { connId, peerId: "peer" },
      tag: "ConnectionEstablished",
    }))
  );
  fake.doorbell?.onEventsReady();
  await vi.runAllTimersAsync();
  expect(connections).toHaveLength(ids.length);
  expect(new Set(connections).size).toBe(ids.length);
  expect(connections.every(Number.isSafeInteger)).toBe(true);

  const opened = endpoint.openStream("peer", "/qop/chat/1", { timeoutMs: 0 });
  fake.events.push({
    inner: {
      connId: fake.connId,
      initiatedLocally: true,
      peerId: "peer",
      protocolId: "/qop/chat/1",
      streamId: 7n,
    },
    tag: "StreamReady",
  });
  fake.doorbell?.onEventsReady();
  await vi.runAllTimersAsync();
  const stream = await opened;
  expect(stream.connId).toBe(connections[2]);
  expect(stream.streamId).toBe(7);
  endpoint.close();
});

const openNativeStream = async () => {
  const endpoint = Minip2p.create({ secretKey: new Uint8Array(32) });
  const fake = native.Endpoint.latest;
  const opened = endpoint.openStream("peer", "/qop/chat/1", { timeoutMs: 0 });
  const identity = { connId: fake.connId, peerId: "peer", streamId: 7n };
  fake.events.push({
    inner: { ...identity, initiatedLocally: true, protocolId: "/qop/chat/1" },
    tag: "StreamReady",
  });
  fake.doorbell?.onEventsReady();
  await vi.runAllTimersAsync();
  return { endpoint, fake, identity, stream: await opened };
};

test("a FIN followed by full close in one native batch preserves unread data and EOF", async () => {
  vi.useFakeTimers();
  const { endpoint, fake, identity, stream } = await openNativeStream();
  fake.events.push(
    {
      inner: { ...identity, data: Uint8Array.of(1).buffer },
      tag: "StreamData",
    },
    {
      inner: { ...identity, data: Uint8Array.of(2).buffer },
      tag: "StreamData",
    },
    { inner: identity, tag: "StreamRemoteWriteClosed" },
    { inner: identity, tag: "StreamClosed" }
  );
  fake.doorbell?.onEventsReady();
  await vi.runAllTimersAsync();
  await expect(stream.read()).resolves.toEqual(Uint8Array.of(1));
  await expect(stream.read()).resolves.toEqual(Uint8Array.of(2));
  await expect(stream.read()).resolves.toBeUndefined();
  endpoint.close();
});

test("closing without a FIN still rejects reads and discards buffered data", async () => {
  vi.useFakeTimers();
  const { endpoint, fake, identity, stream } = await openNativeStream();
  fake.events.push(
    {
      inner: { ...identity, data: Uint8Array.of(1).buffer },
      tag: "StreamData",
    },
    { inner: identity, tag: "StreamClosed" }
  );
  fake.doorbell?.onEventsReady();
  await vi.runAllTimersAsync();
  await expect(stream.read()).rejects.toThrow("The stream closed");
  endpoint.close();
});

test("endpoint shutdown still rejects reads after a remote FIN", async () => {
  vi.useFakeTimers();
  const { endpoint, fake, identity, stream } = await openNativeStream();
  fake.events.push(
    {
      inner: { ...identity, data: Uint8Array.of(1).buffer },
      tag: "StreamData",
    },
    { inner: identity, tag: "StreamRemoteWriteClosed" }
  );
  fake.doorbell?.onEventsReady();
  await vi.runAllTimersAsync();
  endpoint.close();
  await expect(stream.read()).rejects.toBeInstanceOf(ClosedError);
});
