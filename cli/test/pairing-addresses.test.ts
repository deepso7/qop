import { describe, expect, it } from "vitest";

import { selectPairingAddrs } from "../src/pairing-link.ts";

describe("pairing addresses", () => {
  it("advertises a reserved relay before concrete LAN addresses, never wildcard listeners", () => {
    const circuit =
      "/dns/relay.example/udp/1234/quic-v1/p2p/relay/p2p-circuit/p2p/device";
    expect(
      selectPairingAddrs(
        [
          "/ip4/0.0.0.0/udp/1234/quic-v1/p2p/device",
          "/ip6/::/udp/1234/quic-v1/p2p/device",
        ],
        circuit,
        ["192.168.1.10"]
      )
    ).toEqual([circuit, "/ip4/192.168.1.10/udp/1234/quic-v1/p2p/device"]);
  });

  it("does not print an unusable offer when only wildcard listeners exist", () => {
    expect(
      selectPairingAddrs(["/ip4/0.0.0.0/udp/1234/quic-v1"], undefined, [])
    ).toEqual([]);
  });

  it("expands dual-stack wildcards and keeps dns listen addresses", () => {
    expect(
      selectPairingAddrs(
        [
          "/ip4/0.0.0.0/udp/1234/quic-v1/p2p/device",
          "/ip6/::/udp/1234/quic-v1/p2p/device",
        ],
        undefined,
        ["192.168.1.10", "2001:db8::1"]
      )
    ).toEqual([
      "/ip4/192.168.1.10/udp/1234/quic-v1/p2p/device",
      "/ip6/2001:db8::1/udp/1234/quic-v1/p2p/device",
    ]);
    expect(
      selectPairingAddrs(
        ["/dns/relay.example/udp/4001/quic-v1/p2p/relay"],
        undefined,
        ["192.168.1.10"]
      )
    ).toEqual(["/dns/relay.example/udp/4001/quic-v1/p2p/relay"]);
  });

  it("prefers LAN over docker when the address budget is two", () => {
    expect(
      selectPairingAddrs(
        ["/ip4/0.0.0.0/udp/1234/quic-v1/p2p/device"],
        "/dns/relay.example/udp/1234/quic-v1/p2p/relay/p2p-circuit/p2p/device",
        ["172.17.0.2", "192.168.1.10"]
      )
    ).toEqual([
      "/dns/relay.example/udp/1234/quic-v1/p2p/relay/p2p-circuit/p2p/device",
      "/ip4/192.168.1.10/udp/1234/quic-v1/p2p/device",
    ]);
  });
});
