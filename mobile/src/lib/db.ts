import * as SQLite from "expo-sqlite";

export interface Contact {
  readonly createdAt: number;
  readonly deviceKey: string;
  readonly handle: string;
  readonly keyChanged: boolean;
  readonly lastReadAt: number;
  readonly owner: string;
  readonly peerId: string;
  readonly qid: string;
}

export interface ContactInput {
  readonly createdAt: number;
  readonly deviceKey: string;
  readonly handle: string;
  readonly owner: string;
  readonly peerId: string;
  readonly qid: string;
}

export type MessageDirection = "in" | "out";
export type MessageStatus = "failed" | "held" | "received" | "sending" | "sent";

export interface StoredMessage {
  readonly contactQid: string;
  readonly direction: MessageDirection;
  readonly holderPeerId: string | null;
  readonly id: string;
  readonly receivedAt: number;
  readonly sentAt: number;
  readonly status: MessageStatus;
  readonly text: string;
}

export type MessageInput = Omit<
  StoredMessage,
  "holderPeerId" | "receivedAt"
> & {
  readonly holderPeerId?: string | null;
};

export interface Conversation extends Contact {
  readonly latestMessageText: string | null;
  readonly latestMessageTime: number | null;
  readonly unreadCount: number;
}

interface ContactRow {
  createdAt: number;
  deviceKey: string;
  handle: string;
  keyChanged: number;
  lastReadAt: number;
  owner: string;
  peerId: string;
  qid: string;
}

interface MessageRow {
  contactQid: string;
  direction: MessageDirection;
  holderPeerId: string | null;
  id: string;
  receivedAt: number;
  sentAt: number;
  status: MessageStatus;
  text: string;
}

interface ConversationRow extends ContactRow {
  latestMessageText: string | null;
  latestMessageTime: number | null;
  unreadCount: number;
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

const failInterruptedMessagesSql = `UPDATE messages SET status = 'failed'
  WHERE direction = 'out' AND status = 'sending'`;

const MESSAGES_SCHEMA_VERSION = 5;
const messagesStatusCheck =
  "status IN ('sending','sent','failed','received','held')";

const migrateMessagesSchema = async (database: SQLite.SQLiteDatabase) => {
  const rows = await database.getAllAsync<{ user_version: number }>(
    "PRAGMA user_version"
  );
  const version = rows[0]?.user_version ?? 0;
  if (version >= MESSAGES_SCHEMA_VERSION) {
    return;
  }
  if (version < 2) {
    await database.execAsync(`
      CREATE TABLE messages_v2 (
        id TEXT PRIMARY KEY,
        contact_qid TEXT NOT NULL REFERENCES contacts(qid) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        text TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (${messagesStatusCheck})
      );
      INSERT INTO messages_v2
        SELECT id, contact_qid, direction, text, sent_at, received_at, status
        FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      CREATE INDEX IF NOT EXISTS messages_contact_received_idx
        ON messages(contact_qid, received_at);
      PRAGMA user_version = 2;
    `);
  }
  if (version < 3) {
    await database.execAsync(`
      ALTER TABLE messages ADD COLUMN holder_peer_id TEXT;
      PRAGMA user_version = 3;
    `);
  }
  if (version < 4) {
    await database.execAsync(`
      CREATE TABLE messages_v4 (
        contact_qid TEXT NOT NULL REFERENCES contacts(qid) ON DELETE CASCADE,
        id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        text TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (${messagesStatusCheck}),
        holder_peer_id TEXT,
        PRIMARY KEY (contact_qid, id)
      );
      INSERT INTO messages_v4
        SELECT contact_qid, id, direction, text, sent_at, received_at, status, holder_peer_id
        FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v4 RENAME TO messages;
      CREATE INDEX IF NOT EXISTS messages_contact_received_idx
        ON messages(contact_qid, received_at);
      PRAGMA user_version = 4;
    `);
  }
  if (version < 5) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS holder_cursors(
        holder_peer_id TEXT PRIMARY KEY,
        inbox_seq INTEGER NOT NULL
      );
      PRAGMA user_version = 5;
    `);
  }
};

const openDatabase = async () => {
  const database = await SQLite.openDatabaseAsync("qop.db");
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS contacts(
      qid TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      device_key TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      key_changed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,
      contact_qid TEXT NOT NULL REFERENCES contacts(qid) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (${messagesStatusCheck})
    );
    DROP INDEX IF EXISTS messages_contact_sent_idx;
    CREATE INDEX IF NOT EXISTS messages_contact_received_idx
      ON messages(contact_qid, received_at);
  `);
  await migrateMessagesSchema(database);
  await database.execAsync(failInterruptedMessagesSql);
  return database;
};

const getDatabase = async () => {
  databasePromise ??= openDatabase();
  try {
    return await databasePromise;
  } catch (error) {
    databasePromise = undefined;
    throw error;
  }
};

const contactFromRow = (row: ContactRow): Contact => ({
  createdAt: row.createdAt,
  deviceKey: row.deviceKey,
  handle: row.handle,
  keyChanged: row.keyChanged !== 0,
  lastReadAt: row.lastReadAt,
  owner: row.owner,
  peerId: row.peerId,
  qid: row.qid,
});

export const upsertContact = async (contact: ContactInput): Promise<void> => {
  const database = await getDatabase();
  // Contact identity is qid. device_key/peer_id are last-seen dial hints only —
  // switching among authorized devices must not flip key_changed.
  await database.runAsync(
    `INSERT INTO contacts(qid, handle, owner, device_key, peer_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(qid) DO UPDATE SET
       handle = excluded.handle,
       owner = excluded.owner,
       device_key = excluded.device_key,
       peer_id = excluded.peer_id`,
    contact.qid,
    contact.handle,
    contact.owner,
    contact.deviceKey,
    contact.peerId,
    contact.createdAt
  );
};

const contactSelect = `SELECT
  qid,
  handle,
  owner,
  device_key AS deviceKey,
  peer_id AS peerId,
  key_changed AS keyChanged,
  created_at AS createdAt,
  last_read_at AS lastReadAt
FROM contacts`;

export const getContactByQid = async (qid: string): Promise<Contact | null> => {
  const database = await getDatabase();
  const row = await database.getFirstAsync<ContactRow>(
    `${contactSelect} WHERE qid = ?`,
    qid
  );
  return row ? contactFromRow(row) : null;
};

export const getContactByPeerId = async (
  peerId: string
): Promise<Contact | null> => {
  const database = await getDatabase();
  const row = await database.getFirstAsync<ContactRow>(
    `${contactSelect} WHERE peer_id = ?`,
    peerId
  );
  return row ? contactFromRow(row) : null;
};

export const getContactByHandle = async (
  handle: string
): Promise<Contact | null> => {
  const database = await getDatabase();
  const row = await database.getFirstAsync<ContactRow>(
    `${contactSelect} WHERE handle = ?`,
    handle
  );
  return row ? contactFromRow(row) : null;
};

export const listConversations = async (): Promise<Conversation[]> => {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ConversationRow>(`
    SELECT
      contacts.qid,
      contacts.handle,
      contacts.owner,
      contacts.device_key AS deviceKey,
      contacts.peer_id AS peerId,
      contacts.key_changed AS keyChanged,
      contacts.created_at AS createdAt,
      contacts.last_read_at AS lastReadAt,
      latest.text AS latestMessageText,
      latest.received_at AS latestMessageTime,
      (
        SELECT COUNT(*)
        FROM messages
        WHERE messages.contact_qid = contacts.qid
          AND messages.direction = 'in'
          AND messages.received_at > contacts.last_read_at
      ) AS unreadCount
    FROM contacts
    LEFT JOIN messages AS latest
      ON latest.contact_qid = contacts.qid
      AND latest.id = (
        SELECT id FROM messages
        WHERE contact_qid = contacts.qid
        ORDER BY received_at DESC, rowid DESC
        LIMIT 1
      )
    ORDER BY COALESCE(latest.received_at, contacts.created_at) DESC
  `);
  return rows.map((row) => ({
    ...contactFromRow(row),
    latestMessageText: row.latestMessageText,
    latestMessageTime: row.latestMessageTime,
    unreadCount: row.unreadCount,
  }));
};

export const markConversationRead = async (
  qid: string,
  throughReceivedAt?: number
): Promise<void> => {
  const database = await getDatabase();
  if (throughReceivedAt !== undefined) {
    await database.runAsync(
      `UPDATE contacts
       SET last_read_at = MAX(last_read_at, ?)
       WHERE qid = ?`,
      throughReceivedAt,
      qid
    );
    return;
  }
  await database.runAsync(
    `UPDATE contacts
     SET last_read_at = COALESCE(
       (SELECT MAX(received_at) FROM messages WHERE contact_qid = ?),
       last_read_at
     )
     WHERE qid = ?`,
    qid,
    qid
  );
};

export const insertMessage = async (
  message: MessageInput
): Promise<boolean> => {
  const database = await getDatabase();
  const receivedAt = Date.now();
  // Use local arrival order for display and unread tracking, even if the clock
  // moves backward or several messages arrive in the same millisecond.
  const result = await database.runAsync(
    `INSERT OR IGNORE INTO messages(
      id, contact_qid, direction, text, sent_at, received_at, status, holder_peer_id
    ) VALUES (?, ?, ?, ?, ?, MAX(?, COALESCE(
      (SELECT MAX(received_at) + 1 FROM messages WHERE contact_qid = ?), 0
    )), ?, ?)`,
    message.id,
    message.contactQid,
    message.direction,
    message.text,
    message.sentAt,
    receivedAt,
    message.contactQid,
    message.status,
    message.holderPeerId ?? null
  );
  return result.changes > 0;
};

const ADVANCE_FROM: Record<MessageStatus, readonly MessageStatus[]> = {
  failed: ["sending"],
  held: ["failed", "sending"],
  received: [],
  sending: ["failed"],
  sent: ["failed", "held", "sending"],
};

/** Apply a delivery-status transition without clobbering a later terminal state. */
export const advanceMessageStatus = async (
  id: string,
  status: MessageStatus,
  contactQid: string
): Promise<boolean> => {
  const allowedFrom = ADVANCE_FROM[status];
  if (allowedFrom.length === 0) {
    return false;
  }
  const database = await getDatabase();
  const result = await database.runAsync(
    `UPDATE messages SET status = ?, holder_peer_id = NULL
     WHERE id = ? AND contact_qid = ? AND status IN (${allowedFrom
       .map(() => "?")
       .join(",")})`,
    status,
    id,
    contactQid,
    ...allowedFrom
  );
  return result.changes > 0;
};

/** Persist the CLI that accepted this id so later polls hit the same holder. */
export const markMessageHeld = async (
  id: string,
  holderPeerId: string,
  contactQid: string
): Promise<boolean> => {
  const database = await getDatabase();
  const result = await database.runAsync(
    `UPDATE messages
     SET status = 'held', holder_peer_id = ?
     WHERE id = ? AND contact_qid = ? AND status IN ('held', 'sending')`,
    holderPeerId,
    id,
    contactQid
  );
  return result.changes > 0;
};

/** Only an explicit CLI rejection can invalidate an accepted hold. */
export const failRejectedHandoff = async (
  id: string,
  contactQid: string
): Promise<void> => {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE messages SET status = 'failed', holder_peer_id = NULL
     WHERE id = ? AND contact_qid = ? AND status IN ('sending','held')`,
    id,
    contactQid
  );
};

// Endpoint shutdown and app startup make interrupted sends manually retryable.
export const failInterruptedMessages = async (): Promise<void> => {
  const database = await getDatabase();
  await database.runAsync(failInterruptedMessagesSql);
};

const messageSelect = `SELECT
  id,
  contact_qid AS contactQid,
  direction,
  holder_peer_id AS holderPeerId,
  text,
  sent_at AS sentAt,
  received_at AS receivedAt,
  status
FROM messages`;

const messageFromRow = (row: MessageRow): StoredMessage => ({
  ...row,
  holderPeerId: row.holderPeerId ?? null,
});

export const getMessageById = async (
  id: string,
  contactQid?: string
): Promise<StoredMessage | null> => {
  const database = await getDatabase();
  const row =
    contactQid === undefined
      ? await database.getFirstAsync<MessageRow>(
          `${messageSelect} WHERE id = ?`,
          id
        )
      : await database.getFirstAsync<MessageRow>(
          `${messageSelect} WHERE id = ? AND contact_qid = ?`,
          id,
          contactQid
        );
  return row ? messageFromRow(row) : null;
};

export const listMessages = async (
  contactQid: string
): Promise<StoredMessage[]> => {
  const database = await getDatabase();
  const rows = await database.getAllAsync<MessageRow>(
    `${messageSelect} WHERE contact_qid = ? ORDER BY received_at, rowid`,
    contactQid
  );
  return rows.map(messageFromRow);
};

export const listOutgoingPending = async (): Promise<StoredMessage[]> => {
  const database = await getDatabase();
  const rows = await database.getAllAsync<MessageRow>(
    `${messageSelect} WHERE direction = 'out' AND status IN ('failed','held','sending')
     ORDER BY received_at, rowid`
  );
  return rows.map(messageFromRow);
};

export const deleteAll = async (): Promise<void> => {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync("DELETE FROM messages");
    await transaction.runAsync("DELETE FROM contacts");
    await transaction.runAsync("DELETE FROM holder_cursors");
  });
};

export const getHolderInboxCursor = async (peerId: string): Promise<number> => {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ inboxSeq: number }>(
    `SELECT inbox_seq AS inboxSeq FROM holder_cursors WHERE holder_peer_id = ?`,
    peerId
  );
  return row?.inboxSeq ?? 0;
};

/** Monotonic: a late page must not move the cursor backward. */
export const setHolderInboxCursor = async (
  peerId: string,
  seq: number
): Promise<void> => {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO holder_cursors(holder_peer_id, inbox_seq) VALUES (?, ?)
     ON CONFLICT(holder_peer_id) DO UPDATE SET
       inbox_seq = MAX(holder_cursors.inbox_seq, excluded.inbox_seq)`,
    peerId,
    seq
  );
};
