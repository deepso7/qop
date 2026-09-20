import { chmod, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

import {
  InboxRecordV1,
  OutboxRecordV1,
  inboxRecordsConflict,
  outboxRecordsConflict,
} from "@qop/protocol";
import { Data, Effect, Schema } from "effect";
import type { Scope } from "effect";

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;
const SCHEMA_VERSION = 1;
const DB_FILE = "messages.db";
const SQLITE_BUSY_TIMEOUT_MS = 5000;

const NodeErrno = Schema.Struct({
  code: Schema.String,
});
const errnoCode = Schema.decodeUnknownOption(NodeErrno);

export class CliOutboxStoreError extends Data.TaggedError(
  "CliOutboxStoreError"
)<{
  readonly operation:
    | "absent"
    | "conflict"
    | "decode"
    | "permissions"
    | "read"
    | "write";
}> {}

export interface PutInboxResult {
  readonly inserted: boolean;
  readonly record: InboxRecordV1;
}

export interface CliOutboxStore {
  readonly enqueue: (
    record: OutboxRecordV1
  ) => Effect.Effect<OutboxRecordV1, CliOutboxStoreError>;
  readonly getByIds: (
    ids: readonly string[]
  ) => Effect.Effect<readonly OutboxRecordV1[], CliOutboxStoreError>;
  readonly loadInbox: () => Effect.Effect<
    readonly InboxRecordV1[],
    CliOutboxStoreError
  >;
  readonly loadRecords: () => Effect.Effect<
    readonly OutboxRecordV1[],
    CliOutboxStoreError
  >;
  readonly put: (
    record: OutboxRecordV1
  ) => Effect.Effect<OutboxRecordV1, CliOutboxStoreError>;
  readonly putInbox: (
    record: InboxRecordV1
  ) => Effect.Effect<PutInboxResult, CliOutboxStoreError>;
  readonly queued: () => Effect.Effect<
    readonly OutboxRecordV1[],
    CliOutboxStoreError
  >;
  readonly queuedCount: () => Effect.Effect<number, CliOutboxStoreError>;
}

/** Operator-facing copy for a durable outbox/inbox store failure. */
export const describeCliOutboxStoreError = (error: CliOutboxStoreError) => {
  switch (error.operation) {
    case "absent": {
      return "CLI messages.db is not present.";
    }
    case "conflict": {
      return "CLI outbox or inbox has a conflicting record for the same message id.";
    }
    case "decode": {
      return "CLI outbox or inbox is unreadable. Move the data directory aside to recover.";
    }
    case "permissions": {
      return "CLI messages.db must be mode 600 (directory 700). Fix permissions or move the data directory aside.";
    }
    case "read": {
      return "Could not read the CLI outbox or inbox.";
    }
    case "write": {
      return "Could not write the CLI outbox or inbox.";
    }
    default: {
      const exhaustive: never = error.operation;
      return exhaustive;
    }
  }
};

const storeError = (operation: CliOutboxStoreError["operation"]) =>
  new CliOutboxStoreError({ operation });

const ErrorMessage = Schema.Struct({
  message: Schema.String,
});
const errorMessage = Schema.decodeUnknownOption(ErrorMessage);
const SqliteErrcode = Schema.Struct({
  errcode: Schema.Number,
});
const sqliteErrcode = Schema.decodeUnknownOption(SqliteErrcode);
const UserVersionRow = Schema.Struct({
  user_version: Schema.Number,
});
const decodeUserVersion = Schema.decodeUnknownOption(UserVersionRow);
const CountRow = Schema.Struct({
  n: Schema.Number,
});
const decodeCount = Schema.decodeUnknownOption(CountRow);

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_UNREADABLE_MESSAGE =
  /SQLITE_NOTADB|SQLITE_CORRUPT|not a database|malformed/iu;

const isUnreadableSqliteErrcode = (errcode: number) => {
  // Primary SQLite result code; extended codes are 256 * extra + primary.
  const primary = errcode % 256;
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
};

const sqliteOpenError = (
  coded: ReturnType<typeof sqliteErrcode>,
  parsed: ReturnType<typeof errorMessage>
) => {
  if (coded._tag === "Some" && isUnreadableSqliteErrcode(coded.value.errcode)) {
    return storeError("decode");
  }
  if (
    parsed._tag === "Some" &&
    SQLITE_UNREADABLE_MESSAGE.test(parsed.value.message)
  ) {
    return storeError("decode");
  }
  return storeError("read");
};

const CREATE_SCHEMA_SQL = `
CREATE TABLE outbox (
  id              TEXT    PRIMARY KEY,
  from_handle     TEXT    NOT NULL,
  sent_at         INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  to_handle       TEXT    NOT NULL,
  to_qid          TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('queued','sent','failed')),
  attempts        INTEGER NOT NULL,
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL,
  queued_at       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX outbox_queued_idx ON outbox (next_attempt_at) WHERE status = 'queued';
CREATE TABLE inbox (
  from_qid    TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  from_handle TEXT    NOT NULL,
  sent_at     INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (from_qid, id)
) STRICT;
PRAGMA user_version = ${SCHEMA_VERSION};
`;

const OUTBOX_SELECT = `SELECT
  id,
  from_handle AS fromHandle,
  sent_at AS sentAt,
  text,
  to_handle AS toHandle,
  to_qid AS toQid,
  status,
  attempts,
  last_error AS lastError,
  next_attempt_at AS nextAttemptAt,
  queued_at AS queuedAt,
  updated_at AS updatedAt
FROM outbox`;

const INBOX_SELECT = `SELECT
  from_qid AS fromQid,
  id,
  from_handle AS fromHandle,
  sent_at AS sentAt,
  text,
  received_at AS receivedAt
FROM inbox`;

const decodeOutboxRow = (row: Record<string, SQLOutputValue>) => {
  const decoded = Schema.decodeUnknownOption(OutboxRecordV1)({
    attempts: row.attempts,
    frame: {
      fromHandle: row.fromHandle,
      id: row.id,
      sentAt: row.sentAt,
      text: row.text,
      v: 1,
    },
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    queuedAt: row.queuedAt,
    status: row.status,
    toHandle: row.toHandle,
    toQid: row.toQid,
    updatedAt: row.updatedAt,
    v: 1,
  });
  if (decoded._tag === "None") {
    throw storeError("decode");
  }
  return decoded.value;
};

const decodeInboxRow = (row: Record<string, SQLOutputValue>) => {
  const decoded = Schema.decodeUnknownOption(InboxRecordV1)({
    frame: {
      fromHandle: row.fromHandle,
      id: row.id,
      sentAt: row.sentAt,
      text: row.text,
      v: 1,
    },
    fromQid: row.fromQid,
    receivedAt: row.receivedAt,
    v: 1,
  });
  if (decoded._tag === "None") {
    throw storeError("decode");
  }
  return decoded.value;
};

const outboxInsertParams = (record: OutboxRecordV1): SQLInputValue[] => {
  const {
    attempts,
    frame,
    lastError,
    nextAttemptAt,
    queuedAt,
    status,
    toHandle,
    toQid,
    updatedAt,
  } = record;
  return [
    frame.id,
    frame.fromHandle,
    frame.sentAt,
    frame.text,
    toHandle,
    toQid,
    status,
    attempts,
    lastError,
    nextAttemptAt,
    queuedAt,
    updatedAt,
  ];
};

const outboxUpdateParams = (record: OutboxRecordV1): SQLInputValue[] => {
  const {
    attempts,
    frame,
    lastError,
    nextAttemptAt,
    queuedAt,
    status,
    toHandle,
    toQid,
    updatedAt,
  } = record;
  return [
    frame.fromHandle,
    frame.sentAt,
    frame.text,
    toHandle,
    toQid,
    status,
    attempts,
    lastError,
    nextAttemptAt,
    queuedAt,
    updatedAt,
    frame.id,
  ];
};

const inboxInsertParams = (record: InboxRecordV1): SQLInputValue[] => {
  const { frame, fromQid, receivedAt } = record;
  return [
    fromQid,
    frame.id,
    frame.fromHandle,
    frame.sentAt,
    frame.text,
    receivedAt,
  ];
};

const readUserVersion = (db: DatabaseSync) => {
  const versionParsed = decodeUserVersion(
    db.prepare("PRAGMA user_version").get()
  );
  if (versionParsed._tag === "None") {
    throw storeError("decode");
  }
  return versionParsed.value.user_version;
};

const applySchema = (db: DatabaseSync, readOnly = false) => {
  if (readOnly) {
    // Status opens while the holder may write; never bootstrap here.
    if (readUserVersion(db) !== SCHEMA_VERSION) {
      throw storeError("decode");
    }
    return;
  }
  db.exec("PRAGMA synchronous = FULL");
  // Healthy v1 is a shared read so status can open while the holder writes.
  if (readUserVersion(db) === SCHEMA_VERSION) {
    return;
  }
  // Serialize first bootstrap: loser waits, re-reads v1, and returns.
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = readUserVersion(db);
    if (version === SCHEMA_VERSION) {
      db.exec("ROLLBACK");
      return;
    }
    const existingOutbox = db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'outbox'"
      )
      .get();
    if (version === 0 && existingOutbox === undefined) {
      db.exec(CREATE_SCHEMA_SQL);
      db.exec("COMMIT");
      return;
    }
    throw storeError("decode");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Open is already failing; rollback is best-effort.
    }
    throw error;
  }
};

/**
 * All DB access goes through this sync helper; never yield between the read
 * and the write of one operation. DatabaseSync is synchronous and JS is
 * single-threaded, so one try body is atomic w.r.t. every other fiber.
 */
const runSync = <A>(operation: "read" | "write", body: () => A) =>
  Effect.try({
    catch: (cause) =>
      cause instanceof CliOutboxStoreError ? cause : storeError(operation),
    try: body,
  });

const makeStore = (db: DatabaseSync): CliOutboxStore => {
  const selectOutboxById = db.prepare(`${OUTBOX_SELECT} WHERE id = ?`);
  const insertOutbox = db.prepare(`INSERT INTO outbox (
    id, from_handle, sent_at, text, to_handle, to_qid, status, attempts,
    last_error, next_attempt_at, queued_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateOutbox = db.prepare(`UPDATE outbox SET
    from_handle = ?, sent_at = ?, text = ?, to_handle = ?, to_qid = ?,
    status = ?, attempts = ?, last_error = ?, next_attempt_at = ?,
    queued_at = ?, updated_at = ?
  WHERE id = ?`);
  const selectOutboxAll = db.prepare(`${OUTBOX_SELECT} ORDER BY rowid`);
  const selectOutboxQueued = db.prepare(
    `${OUTBOX_SELECT} WHERE status = 'queued' ORDER BY rowid`
  );
  const countOutboxQueued = db.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'"
  );
  const selectInboxByKey = db.prepare(
    `${INBOX_SELECT} WHERE from_qid = ? AND id = ?`
  );
  const insertInbox = db.prepare(`INSERT INTO inbox (
    from_qid, id, from_handle, sent_at, text, received_at
  ) VALUES (?, ?, ?, ?, ?, ?)`);
  const selectInboxAll = db.prepare(`${INBOX_SELECT} ORDER BY rowid`);

  const enqueue = Effect.fn("CliOutbox.enqueue")(function* (
    record: OutboxRecordV1
  ) {
    return yield* runSync("write", () => {
      const row = selectOutboxById.get(record.frame.id);
      if (row) {
        const existing = decodeOutboxRow(row);
        if (outboxRecordsConflict(existing, record)) {
          throw storeError("conflict");
        }
        return existing;
      }
      insertOutbox.run(...outboxInsertParams(record));
      return record;
    });
  });

  const put = Effect.fn("CliOutbox.put")(function* (record: OutboxRecordV1) {
    return yield* runSync("write", () => {
      const row = selectOutboxById.get(record.frame.id);
      if (row) {
        const current = decodeOutboxRow(row);
        if (outboxRecordsConflict(current, record)) {
          throw storeError("conflict");
        }
        updateOutbox.run(...outboxUpdateParams(record));
        return record;
      }
      insertOutbox.run(...outboxInsertParams(record));
      return record;
    });
  });

  const loadRecords = Effect.fn("CliOutbox.loadRecords")(function* () {
    return yield* runSync("read", () =>
      selectOutboxAll.all().map((row) => decodeOutboxRow(row))
    );
  });

  const queued = Effect.fn("CliOutbox.queued")(function* () {
    return yield* runSync("read", () =>
      selectOutboxQueued.all().map((row) => decodeOutboxRow(row))
    );
  });

  const queuedCount = Effect.fn("CliOutbox.queuedCount")(function* () {
    return yield* runSync("read", () => {
      const parsed = decodeCount(countOutboxQueued.get());
      if (parsed._tag === "None") {
        throw storeError("decode");
      }
      return parsed.value.n;
    });
  });

  const getByIds = Effect.fn("CliOutbox.getByIds")(function* (
    ids: readonly string[]
  ) {
    if (ids.length === 0) {
      return [];
    }
    return yield* runSync("read", () => {
      const placeholders = ids.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `${OUTBOX_SELECT} WHERE id IN (${placeholders}) ORDER BY rowid`
        )
        .all(...ids);
      return rows.map((row) => decodeOutboxRow(row));
    });
  });

  const loadInbox = Effect.fn("CliOutbox.loadInbox")(function* () {
    return yield* runSync("read", () =>
      selectInboxAll.all().map((row) => decodeInboxRow(row))
    );
  });

  const putInbox = Effect.fn("CliOutbox.putInbox")(function* (
    record: InboxRecordV1
  ) {
    return yield* runSync("write", () => {
      const row = selectInboxByKey.get(record.fromQid, record.frame.id);
      if (row) {
        const existing = decodeInboxRow(row);
        if (inboxRecordsConflict(existing, record)) {
          throw storeError("conflict");
        }
        return { inserted: false, record: existing };
      }
      insertInbox.run(...inboxInsertParams(record));
      return { inserted: true, record };
    });
  });

  return {
    enqueue,
    getByIds,
    loadInbox,
    loadRecords,
    put,
    putInbox,
    queued,
    queuedCount,
  };
};

const openDatabase = Effect.fn("CliOutbox.openDatabase")(function* (
  root: string,
  readOnly = false
) {
  const dbPath = path.join(root, DB_FILE);
  if (readOnly) {
    const info = yield* Effect.tryPromise({
      catch: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "ENOENT"
          ? storeError("absent")
          : storeError("permissions");
      },
      try: () => stat(dbPath),
    });
    if (info.mode.toString(8).slice(-3) !== "600") {
      return yield* storeError("permissions");
    }
    return yield* Effect.try({
      catch: (cause) =>
        sqliteOpenError(sqliteErrcode(cause), errorMessage(cause)),
      try: () =>
        new DatabaseSync(dbPath, {
          readOnly: true,
          timeout: SQLITE_BUSY_TIMEOUT_MS,
        }),
    });
  }
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => mkdir(root, { mode: MODE_DIR, recursive: true }),
  });
  // chmod only the file we just created (defeat umask). Existing files are
  // checked, not repaired — a 644 messages.db is a permissions failure.
  const created = yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: async () => {
      try {
        const handle = await open(dbPath, "wx", MODE_FILE);
        await handle.close();
        return true;
      } catch (error) {
        const parsed = errnoCode(error);
        if (parsed._tag === "Some" && parsed.value.code === "EEXIST") {
          return false;
        }
        throw error;
      }
    },
  });
  if (created) {
    yield* Effect.tryPromise({
      catch: () => storeError("write"),
      try: () => chmod(dbPath, MODE_FILE),
    });
  }
  const info = yield* Effect.tryPromise({
    catch: () => storeError("permissions"),
    try: () => stat(dbPath),
  });
  if (info.mode.toString(8).slice(-3) !== "600") {
    return yield* storeError("permissions");
  }
  return yield* Effect.try({
    catch: (cause) =>
      sqliteOpenError(sqliteErrcode(cause), errorMessage(cause)),
    try: () => new DatabaseSync(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS }),
  });
});

export interface OpenCliOutboxStoreOptions {
  readonly readOnly?: boolean;
}

/** Opens `<root>/messages.db`, verifies schema version, closes on scope exit. */
export const openCliOutboxStore = (
  root: string,
  options?: OpenCliOutboxStoreOptions
): Effect.Effect<CliOutboxStore, CliOutboxStoreError, Scope.Scope> => {
  const readOnly = options?.readOnly === true;
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const db = yield* openDatabase(root, readOnly);
      const store = yield* Effect.try({
        catch: (cause) => {
          try {
            db.close();
          } catch {
            // Open is already failing; close is best-effort.
          }
          if (cause instanceof CliOutboxStoreError) {
            return cause;
          }
          return sqliteOpenError(sqliteErrcode(cause), errorMessage(cause));
        },
        try: () => {
          applySchema(db, readOnly);
          return makeStore(db);
        },
      });
      return { db, store };
    }),
    ({ db }) =>
      Effect.sync(() => {
        db.close();
      })
  ).pipe(Effect.map(({ store }) => store));
};
