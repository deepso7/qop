import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it("keeps queued messages across database reopen", async () => {
  const sqlite = await import("expo-sqlite");
  const open = vi.spyOn(sqlite, "openDatabaseAsync");
  const firstApp = await import("@/lib/db");
  await firstApp.upsertContact({
    createdAt: 1,
    deviceKey: "device",
    handle: "alice",
    owner: "owner",
    peerId: "peer",
    qid: "1",
  });
  await firstApp.insertMessage({
    contactQid: "1",
    direction: "out",
    id: "interrupted",
    sentAt: 100,
    status: "queued",
    text: "retry after restart",
  });
  const interrupted = await firstApp.getMessageById("interrupted");
  const database = await open.mock.results[0]?.value;

  if (!database) {
    throw new Error("Expected the first app to open its database");
  }

  vi.resetModules();
  const restartedSqlite = await import("expo-sqlite");
  vi.spyOn(restartedSqlite, "openDatabaseAsync").mockResolvedValue(database);
  const restartedApp = await import("@/lib/db");
  expect(await restartedApp.getMessageById("interrupted")).toEqual(interrupted);
});

it("migrates a v5 database without losing messages, holders, or arrival order", async () => {
  const sqlite = await import("expo-sqlite");
  const database = await sqlite.openDatabaseAsync("v5-migration");
  await database.execAsync(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE contacts(
      qid TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      device_key TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      key_changed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      contact_qid TEXT NOT NULL REFERENCES contacts(qid) ON DELETE CASCADE,
      id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending','held','sent','failed','received')),
      holder_peer_id TEXT,
      PRIMARY KEY (contact_qid, id)
    );
    CREATE TABLE holder_cursors(
      holder_peer_id TEXT PRIMARY KEY,
      inbox_seq INTEGER NOT NULL
    );
    INSERT INTO contacts(qid, handle, owner, device_key, peer_id, created_at)
      VALUES ('1', 'alice', 'owner', 'device', 'peer', 1);
    INSERT INTO messages(contact_qid, id, direction, text, sent_at, received_at, status, holder_peer_id) VALUES
      ('1', 'sending', 'out', 'sending', 1, 10, 'sending', NULL),
      ('1', 'held', 'out', 'held', 1, 11, 'held', 'holder'),
      ('1', 'sent', 'out', 'sent', 1, 12, 'sent', NULL),
      ('1', 'failed', 'out', 'failed', 1, 13, 'failed', NULL),
      ('1', 'received', 'in', 'received', 1, 14, 'received', NULL);
    PRAGMA user_version = 5;
  `);

  vi.resetModules();
  const reopenedSqlite = await import("expo-sqlite");
  vi.spyOn(reopenedSqlite, "openDatabaseAsync").mockResolvedValue(database);
  const reopened = await import("@/lib/db");
  const messages = await reopened.listMessages("1");

  expect(messages.map(({ id }) => id)).toEqual([
    "sending",
    "held",
    "sent",
    "failed",
    "received",
  ]);
  expect(messages.map(({ status }) => status)).toEqual([
    "queued",
    "held",
    "sent",
    "failed",
    "received",
  ]);
  expect(
    messages.every(
      ({ attempts, nextAttemptAt }) => attempts === 0 && nextAttemptAt === 0
    )
  ).toBe(true);
  expect(messages[1]?.holderPeerId).toBe("holder");

  const indexes = await database.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'`
  );

  expect(indexes.map(({ name }) => name)).toContain(
    "messages_outgoing_pending_idx"
  );
});
