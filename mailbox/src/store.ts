import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import { encodeBase64 } from "@qop/protocol";
import type { MailboxMessage, MailboxPushTarget } from "@qop/protocol";
import { Data, Effect } from "effect";

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;
const DB_FILE = "mailbox.db";
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const PUSH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const DEFAULT_MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ENVELOPES_PER_RECIPIENT = 256;
export const DEFAULT_MAX_BYTES_PER_RECIPIENT = 4 * 1024 * 1024;

/** 1/8th of the per-recipient cap so a pair of accounts cannot starve others. */
export const DEFAULT_MAX_ENVELOPES_PER_SENDER = 32;

export interface MailboxLimits {
  readonly maxBytesPerRecipient: number;
  readonly maxEnvelopesPerRecipient: number;
  readonly maxEnvelopesPerSender: number;
  readonly ttlMs: number;
}

export const defaultMailboxLimits: MailboxLimits = {
  maxBytesPerRecipient: DEFAULT_MAX_BYTES_PER_RECIPIENT,
  maxEnvelopesPerRecipient: DEFAULT_MAX_ENVELOPES_PER_RECIPIENT,
  maxEnvelopesPerSender: DEFAULT_MAX_ENVELOPES_PER_SENDER,
  ttlMs: DEFAULT_MAILBOX_TTL_MS,
};

export interface DepositRecord {
  readonly envelope: Uint8Array;
  readonly id: string;
  readonly recipientDeviceKey: string;
  readonly senderDeviceKey: string;
  readonly senderQid: string;
}

export class MailboxStoreError extends Data.TaggedError("MailboxStoreError")<{
  readonly operation: "quota" | "read" | "write";
}> {}

export interface DepositedItem {
  readonly id: string;
  readonly recipientDeviceKey: string;
}

export interface MailboxStore {
  readonly ack: (
    recipientDeviceKey: string,
    seqs: readonly number[]
  ) => Effect.Effect<number, MailboxStoreError>;
  readonly close: () => void;
  readonly deposit: (
    records: readonly DepositRecord[],
    nowMs: number
  ) => Effect.Effect<
    {
      readonly items: readonly DepositedItem[];
      readonly insertedRecipients: ReadonlySet<string>;
    },
    MailboxStoreError
  >;
  readonly fetch: (
    recipientDeviceKey: string,
    limit: number,
    maxPayloadBytes: number,
    nowMs: number
  ) => Effect.Effect<
    { readonly hasMore: boolean; readonly items: readonly MailboxMessage[] },
    MailboxStoreError
  >;
  readonly pruneExpired: (
    nowMs: number
  ) => Effect.Effect<number, MailboxStoreError>;
  readonly registerPush: (
    deviceKey: string,
    target: MailboxPushTarget,
    nowMs: number
  ) => Effect.Effect<void, MailboxStoreError>;
  readonly pushTarget: (
    deviceKey: string,
    nowMs: number
  ) => Effect.Effect<MailboxPushTarget | undefined, MailboxStoreError>;
  readonly removePush: (
    deviceKey: string,
    target: MailboxPushTarget
  ) => Effect.Effect<void, MailboxStoreError>;
}

const asUint8Array = (value: SQLOutputValue): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }

  throw new Error("Expected BLOB column");
};

const asNumber = (value: SQLOutputValue): number => {
  const num = Number(value);

  if (Number.isFinite(num)) {
    return num;
  }

  throw new Error("Expected INTEGER column");
};

const asString = (value: SQLOutputValue): string => {
  if (value === null || value instanceof Uint8Array) {
    throw new Error("Expected TEXT column");
  }

  return String(value);
};

const textEncoder = new TextEncoder();

// Byte length of an empty `messages` frame using the longer `"hasMore":false` literal.
const EMPTY_MESSAGES_FRAME_BYTES = textEncoder.encode(
  JSON.stringify({
    hasMore: false,
    items: [],
    type: "messages",
    v: 1,
  })
).byteLength;

/** Open a durable SQLite mailbox store holding only opaque encrypted envelopes. */
export const openMailboxStore = (
  root: string,
  limits: Partial<MailboxLimits> = {}
): Effect.Effect<MailboxStore, MailboxStoreError> =>
  Effect.tryPromise({
    catch: () => new MailboxStoreError({ operation: "write" }),
    try: async () => {
      const resolvedLimits: MailboxLimits = {
        ...defaultMailboxLimits,
        ...limits,
      };

      await mkdir(root, { mode: MODE_DIR, recursive: true });
      await chmod(root, MODE_DIR);

      const dbPath = path.join(root, DB_FILE);
      const db = new DatabaseSync(dbPath);

      const prepareStatements = async () => {
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
        `);

        // SAFETY: PRAGMA user_version returns a single SQLite row object.
        const versionRow = db.prepare("PRAGMA user_version").get() as
          | Record<string, SQLOutputValue>
          | undefined;

        const version = Number(versionRow?.user_version ?? 0);

        if (version < 1) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS envelopes (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              recipient_device_key TEXT NOT NULL,
              sender_device_key TEXT NOT NULL,
              sender_qid TEXT NOT NULL,
              message_id TEXT NOT NULL,
              envelope BLOB NOT NULL,
              stored_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              UNIQUE (recipient_device_key, sender_device_key, message_id)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS envelopes_recipient_seq_idx
              ON envelopes (recipient_device_key, seq);
            CREATE INDEX IF NOT EXISTS envelopes_expires_idx
              ON envelopes (expires_at);
            CREATE INDEX IF NOT EXISTS envelopes_sender_recipient_idx
              ON envelopes (sender_qid, recipient_device_key);
            PRAGMA user_version = 1;
          `);
        }

        if (version < 2) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS push_targets (
              device_key TEXT PRIMARY KEY,
              platform TEXT NOT NULL CHECK (platform IN ('apns', 'fcm')),
              token TEXT NOT NULL,
              expires_at INTEGER NOT NULL
            ) STRICT;
            PRAGMA user_version = 2;
          `);
        }

        await chmod(dbPath, MODE_FILE).catch(() => null);

        return {
          countRecipient: db.prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(length(envelope)), 0) AS total_bytes
             FROM envelopes WHERE recipient_device_key = ?`
          ),
          countSenderForRecipient: db.prepare(
            `SELECT COUNT(*) AS count FROM envelopes
             WHERE sender_qid = ? AND recipient_device_key = ?`
          ),
          deleteExpired: db.prepare(
            `DELETE FROM envelopes WHERE expires_at <= ?`
          ),
          deleteExpiredPush: db.prepare(
            "DELETE FROM push_targets WHERE expires_at <= ?"
          ),
          deletePush: db.prepare(
            "DELETE FROM push_targets WHERE device_key = ? AND platform = ? AND token = ?"
          ),
          deleteOne: db.prepare(
            `DELETE FROM envelopes WHERE recipient_device_key = ? AND seq = ?`
          ),
          insertEnvelope: db.prepare(
            `INSERT INTO envelopes (
               recipient_device_key, sender_device_key, sender_qid,
               message_id, envelope, stored_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ),
          pruneRecipientExpired: db.prepare(
            `DELETE FROM envelopes WHERE recipient_device_key = ? AND expires_at <= ?`
          ),
          selectExisting: db.prepare(
            `SELECT 1 FROM envelopes
             WHERE recipient_device_key = ? AND sender_device_key = ? AND message_id = ?`
          ),
          selectPending: db.prepare(
            `SELECT seq, message_id, sender_device_key, envelope, stored_at
             FROM envelopes
             WHERE recipient_device_key = ? AND expires_at > ?
             ORDER BY seq ASC
             LIMIT ?`
          ),
          selectPush: db.prepare(
            "SELECT platform, token FROM push_targets WHERE device_key = ? AND expires_at > ?"
          ),
          upsertPush: db.prepare(
            `INSERT INTO push_targets (device_key, platform, token, expires_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(device_key) DO UPDATE SET
               platform = excluded.platform, token = excluded.token,
               expires_at = excluded.expires_at`
          ),
        };
      };

      let statements: Awaited<ReturnType<typeof prepareStatements>>;

      try {
        statements = await prepareStatements();
      } catch (error) {
        db.close();
        throw error;
      }

      const {
        countRecipient,
        countSenderForRecipient,
        deleteExpired,
        deleteOne,
        insertEnvelope,
        pruneRecipientExpired,
        selectExisting,
        selectPending,
      } = statements;

      const deposit = (records: readonly DepositRecord[], nowMs: number) =>
        Effect.try({
          catch: (error) =>
            error instanceof MailboxStoreError
              ? error
              : new MailboxStoreError({ operation: "write" }),
          try: () => {
            const expiresAt = nowMs + resolvedLimits.ttlMs;
            const accepted: DepositedItem[] = [];
            const insertedRecipients = new Set<string>();

            db.exec("BEGIN IMMEDIATE");

            try {
              const prunedRecipients = new Set<string>();

              for (const record of records) {
                if (!prunedRecipients.has(record.recipientDeviceKey)) {
                  pruneRecipientExpired.run(record.recipientDeviceKey, nowMs);
                  prunedRecipients.add(record.recipientDeviceKey);
                }

                const existing = selectExisting.get(
                  record.recipientDeviceKey,
                  record.senderDeviceKey,
                  record.id
                );

                if (existing) {
                  // HPKE uses a fresh ephemeral key per seal, so retries produce new
                  // ciphertext for the same (recipient, sender, id). Keep the first
                  // committed copy and acknowledge idempotently.
                  accepted.push({
                    id: record.id,
                    recipientDeviceKey: record.recipientDeviceKey,
                  });
                  continue;
                }

                // SAFETY: COUNT/COALESCE aggregate query always returns one row object.
                const recipientStats = countRecipient.get(
                  record.recipientDeviceKey
                ) as Record<string, SQLOutputValue>;

                const recipientCount = asNumber(recipientStats.count ?? 0);

                const recipientBytes = asNumber(
                  recipientStats.total_bytes ?? 0
                );

                if (
                  recipientCount >= resolvedLimits.maxEnvelopesPerRecipient ||
                  recipientBytes + record.envelope.byteLength >
                    resolvedLimits.maxBytesPerRecipient
                ) {
                  // Skip full device queues rather than rolling back other devices in the batch.
                  continue;
                }

                // SAFETY: COUNT aggregate query always returns one row object.
                const senderStats = countSenderForRecipient.get(
                  record.senderQid,
                  record.recipientDeviceKey
                ) as Record<string, SQLOutputValue>;

                const senderCount = asNumber(senderStats.count ?? 0);

                if (senderCount >= resolvedLimits.maxEnvelopesPerSender) {
                  continue;
                }

                insertEnvelope.run(
                  record.recipientDeviceKey,
                  record.senderDeviceKey,
                  record.senderQid,
                  record.id,
                  record.envelope,
                  nowMs,
                  expiresAt
                );
                insertedRecipients.add(record.recipientDeviceKey);

                accepted.push({
                  id: record.id,
                  recipientDeviceKey: record.recipientDeviceKey,
                });
              }

              if (accepted.length === 0) {
                throw new MailboxStoreError({ operation: "quota" });
              }

              db.exec("COMMIT");

              return { insertedRecipients, items: accepted };
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          },
        });

      const fetch = (
        recipientDeviceKey: string,
        limit: number,
        maxPayloadBytes: number,
        nowMs: number
      ) =>
        Effect.try({
          catch: () => new MailboxStoreError({ operation: "read" }),
          try: () => {
            if (EMPTY_MESSAGES_FRAME_BYTES > maxPayloadBytes) {
              throw new Error("Empty messages frame exceeds maxPayloadBytes");
            }

            // SAFETY: SELECT returns SQLite row objects matching the envelopes schema.
            const rows = selectPending.all(
              recipientDeviceKey,
              nowMs,
              limit + 1
            ) as Record<string, SQLOutputValue>[];

            const items: MailboxMessage[] = [];
            let hasMore = rows.length > limit;
            let frameBytes = EMPTY_MESSAGES_FRAME_BYTES;

            for (const row of rows.slice(0, limit)) {
              const candidate: MailboxMessage = {
                envelope: encodeBase64(asUint8Array(row.envelope ?? null)),
                id: asString(row.message_id ?? ""),
                senderDeviceKey: asString(row.sender_device_key ?? ""),
                seq: asNumber(row.seq ?? 0),
                storedAt: asNumber(row.stored_at ?? 0),
              };

              const itemBytes = textEncoder.encode(
                JSON.stringify(candidate)
              ).byteLength;

              const nextBytes =
                frameBytes + (items.length > 0 ? 1 : 0) + itemBytes;

              if (nextBytes > maxPayloadBytes) {
                if (items.length === 0) {
                  throw new Error("First envelope exceeds maxPayloadBytes");
                }

                hasMore = true;
                break;
              }

              items.push(candidate);
              frameBytes = nextBytes;
            }

            return { hasMore, items };
          },
        });

      const ack = (recipientDeviceKey: string, seqs: readonly number[]) =>
        Effect.try({
          catch: () => new MailboxStoreError({ operation: "write" }),
          try: () => {
            let deleted = 0;

            db.exec("BEGIN IMMEDIATE");

            try {
              for (const seq of seqs) {
                const result = deleteOne.run(recipientDeviceKey, seq);
                deleted += Number(result.changes);
              }

              db.exec("COMMIT");

              return deleted;
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          },
        });

      const pruneExpired = (nowMs: number) =>
        Effect.try({
          catch: () => new MailboxStoreError({ operation: "write" }),
          try: () => {
            statements.deleteExpiredPush.run(nowMs);

            return Number(deleteExpired.run(nowMs).changes);
          },
        });

      return {
        ack,
        close: () => {
          db.close();
        },
        deposit,
        fetch,
        pruneExpired,
        pushTarget: (deviceKey, nowMs) =>
          Effect.try({
            catch: () => new MailboxStoreError({ operation: "read" }),
            try: (): MailboxPushTarget | undefined => {
              const row = statements.selectPush.get(deviceKey, nowMs);

              if (row?.platform === "apns" || row?.platform === "fcm") {
                return {
                  platform: row.platform,
                  token: asString(row.token ?? null),
                };
              }
            },
          }),
        registerPush: (deviceKey, target, nowMs) =>
          Effect.try({
            catch: () => new MailboxStoreError({ operation: "write" }),
            try: () => {
              statements.upsertPush.run(
                deviceKey,
                target.platform,
                target.token,
                nowMs + PUSH_TOKEN_TTL_MS
              );
            },
          }),
        removePush: (deviceKey, target) =>
          Effect.try({
            catch: () => new MailboxStoreError({ operation: "write" }),
            try: () => {
              statements.deletePush.run(
                deviceKey,
                target.platform,
                target.token
              );
            },
          }),
      } satisfies MailboxStore;
    },
  });
