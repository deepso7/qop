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
    status: "failed",
  });

  await restartedApp.updateMessageStatus("interrupted", "sending");
  expect(await restartedApp.getMessageById("interrupted")).toEqual({
    ...interrupted,
    status: "sending",
  });
});
