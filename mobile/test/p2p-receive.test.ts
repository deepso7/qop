import { describe, expect, it, vi } from "vitest";

import type { Contact } from "@/lib/db";
import { createResolveSender } from "@/lib/p2p-receive";
import type { RegistryAccount } from "@/lib/registry";

const oldDeviceKey = `0x${"11".repeat(32)}` as const;
const freshDeviceKey = `0x${"22".repeat(32)}` as const;

const account: RegistryAccount = {
  deviceKey: freshDeviceKey,
  handle: "alice",
  owner: "0x0000000000000000000000000000000000000001",
  ownerVersion: 2,
  peerId: "peer-new",
  qid: 1n,
  registeredAt: 1_700_000_000n,
};

const staleContact: Contact = {
  createdAt: 1_700_000_000_000,
  deviceKey: oldDeviceKey,
  handle: "alice",
  keyChanged: false,
  lastReadAt: 0,
  owner: account.owner,
  peerId: "peer-old",
  qid: "1",
};

describe("resolveSender", () => {
  it("rejects a cached contact when the chain has a different peer id", async () => {
    const upsertContact = vi.fn().mockImplementation(() => Promise.resolve());
    const resolveSender = createResolveSender({
      getContactByPeerId: vi.fn().mockResolvedValue(staleContact),
      lookupHandle: vi.fn().mockResolvedValue(account),
      upsertContact,
    });

    await expect(resolveSender("peer-old", "alice")).resolves.toBeNull();
    expect(upsertContact).not.toHaveBeenCalled();
  });

  it("upserts and accepts the peer id currently registered on chain", async () => {
    const upsertContact = vi.fn().mockImplementation(() => Promise.resolve());
    const resolveSender = createResolveSender({
      getContactByPeerId: vi.fn().mockResolvedValue(null),
      lookupHandle: vi.fn().mockResolvedValue(account),
      upsertContact,
    });

    await expect(resolveSender("peer-new", "alice")).resolves.toMatchObject({
      deviceKey: freshDeviceKey,
      peerId: "peer-new",
      qid: "1",
    });
    expect(upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceKey: freshDeviceKey,
        peerId: "peer-new",
        qid: "1",
      })
    );
  });

  it("rejects a handle that does not exist on chain", async () => {
    const upsertContact = vi.fn().mockImplementation(() => Promise.resolve());
    const resolveSender = createResolveSender({
      getContactByPeerId: vi.fn().mockResolvedValue(null),
      lookupHandle: vi.fn().mockResolvedValue(null),
      upsertContact,
    });

    await expect(resolveSender("peer-unknown", "nobody")).resolves.toBeNull();
    expect(upsertContact).not.toHaveBeenCalled();
  });
});
