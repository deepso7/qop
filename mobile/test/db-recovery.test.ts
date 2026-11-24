import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it("recovers crashed sends once when the database is reopened", async () => {
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
    status: "sending",
    text: "retry after restart",
  });
  const interrupted = await firstApp.getMessageById("interrupted");
  const database = await open.mock.results[0]?.value;

  if (!database) {
    throw new Error("Expected the first app to open its database");
  }

  // Restart the app's module while retaining its existing SQLite contents.
  vi.resetModules();
  const restartedSqlite = await import("expo-sqlite");
  vi.spyOn(restartedSqlite, "openDatabaseAsync").mockResolvedValue(database);
  const restartedApp = await import("@/lib/db");
  expect(await restartedApp.getMessageById("interrupted")).toEqual({
    ...interrupted,
    status: "queued",
  });
});

it("migrates a v5 database without losing messages, holders or arrival order", async () => {
  const sqlite = await import("expo-sqlite");
  const open = vi.spyOn(sqlite, "openDatabaseAsync");
  const app = await import("@/lib/db");
  await app.upsertContact({
    createdAt: 1,
    deviceKey: "device",
    handle: "alice",
    owner: "owner",
    peerId: "peer",
    qid: "1",
  });

  await Promise.all(
    (["sending", "held", "sent", "failed", "received"] as const).map((status) =>
      app.insertMessage({
        contactQid: "1",
        direction: status === "received" ? "in" : "out",
        holderPeerId: status === "held" ? "holder" : null,
        id: status,
        sentAt: 1,
        status,
        text: status,
      })
    )
  );

  const database = await open.mock.results[0]?.value;

  if (!database) {
    throw new Error("Missing database");
  }

  await database.execAsync(`
    CREATE TABLE messages_v5 (
      contact_qid TEXT NOT NULL, id TEXT NOT NULL, direction TEXT NOT NULL,
      text TEXT NOT NULL, sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sending','held','sent','failed','received')),
      holder_peer_id TEXT, PRIMARY KEY(contact_qid, id)
    );
    INSERT INTO messages_v5 SELECT contact_qid, id, direction, text, sent_at, received_at, status, holder_peer_id FROM messages ORDER BY rowid;
    DROP TABLE messages;
    ALTER TABLE messages_v5 RENAME TO messages;
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
});
