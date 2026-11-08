//! Local state in SQLite: who this device is, where linking stands, and its messages (contacts,
//! `outbox`, `inbox`, as the CLI's `messages.db`). Non-secret only; the device secret key lives
//! in [`crate::keys`].
//!
//! One store per data directory, held exclusively: [`Store::open`] takes an advisory lock that
//! the kernel releases when the process exits, however it exits (the CLI's `lock.db`).
//! Schema changes append to [`MIGRATIONS`]; `PRAGMA user_version` records how many ran.

use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use alloy_primitives::{Address, B256, U256};
use rusqlite::{Connection, OptionalExtension, params};

use crate::wire::{
    ChatFrame, DeviceActionApproval, InboxRecord, OutboxRecord, OutboxStatus, identity,
    inbox_records_conflict, outbox_records_conflict,
};

/// Applied in order; never edit a shipped entry, append a new one.
const MIGRATIONS: &[&str] = &[
    // v1: the device's identity, its pending approval, and the revoked marker.
    "CREATE TABLE identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        handle TEXT NOT NULL,
        qid TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        registry TEXT NOT NULL,
        device_key TEXT NOT NULL,
        linked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pending_approval (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        record BLOB NOT NULL
    );
    CREATE TABLE revoked (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        handle TEXT NOT NULL
    );",
    // v2: messaging. `outbox` and `inbox` match the CLI's `messages.db` columns
    // (`OutboxRecordV1`, `InboxRecordV1`); `contacts` is one row per conversation, with the
    // inbox rowid read up to. The inbox rowid stays the catch-up cursor for `/qop/sync/1`.
    "CREATE TABLE contacts (
        qid TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        read_seq INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        from_handle TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        to_handle TEXT NOT NULL,
        to_qid TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
        attempts INTEGER NOT NULL,
        last_error TEXT,
        next_attempt_at INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX outbox_queued_idx ON outbox (next_attempt_at) WHERE status = 'queued';
    CREATE TABLE inbox (
        from_qid TEXT NOT NULL,
        id TEXT NOT NULL,
        from_handle TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (from_qid, id)
    ) STRICT;",
    // v3: one conversation's newest messages without scanning the others (`Store::thread`).
    "CREATE INDEX outbox_thread_idx ON outbox (to_qid, sent_at);
    CREATE INDEX inbox_thread_idx ON inbox (from_qid, received_at);",
];

/// Everything messaging stores; Unlink and revocation delete it with the identity.
const WIPE: &str = "DELETE FROM pending_approval; DELETE FROM identity;
    DELETE FROM contacts; DELETE FROM outbox; DELETE FROM inbox;";

const OUTBOX_COLUMNS: &str = "id, from_handle, sent_at, text, to_handle, to_qid, status, attempts,
    last_error, next_attempt_at, queued_at, updated_at";

/// `~/Library/Application Support/qop` on macOS (`$XDG_DATA_HOME/qop` elsewhere), or
/// `QOP_DATA_DIR` when set (tests and e2e runs use their own directories).
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("QOP_DATA_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/qop")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map_or_else(|| home.join(".local/share"), PathBuf::from)
            .join("qop")
    }
}

#[derive(Debug)]
pub enum StoreError {
    /// Another qop Desktop holds this data directory.
    Locked,
    Io(std::io::Error),
    Sql(rusqlite::Error),
    /// A row that this version cannot read.
    Corrupt(&'static str),
    /// A message id already stored with different content (`outboxRecordsConflict`,
    /// `inboxRecordsConflict`).
    Conflict,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Locked => f.write_str("another qop Desktop is using this data directory"),
            Self::Io(error) => write!(f, "store: {error}"),
            Self::Sql(error) => write!(f, "store: {error}"),
            Self::Corrupt(what) => write!(f, "store: unreadable {what}"),
            Self::Conflict => f.write_str("store: a different message already has this id"),
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

/// The account this device links to, and its own key. Written before any offer is shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub handle: String,
    pub qid: U256,
    pub chain_id: U256,
    pub registry: Address,
    pub device_key: B256,
    /// Set once this device's own chain read showed it as an active member.
    pub linked: bool,
}

impl Identity {
    pub fn peer_id(&self) -> String {
        identity::peer_id_from_device_key(&self.device_key).to_base58()
    }

    pub fn fingerprint(&self) -> String {
        identity::pairing_fingerprint(&self.device_key)
    }
}

pub struct Store {
    conn: Connection,
    dir: PathBuf,
    /// Held for the store's lifetime; the kernel drops the lock with the process.
    _lock: File,
}

impl Store {
    /// Opens (creating, 0700) `dir`, takes the single-instance lock, and migrates.
    pub fn open(dir: &Path) -> StoreResult<Store> {
        fs::create_dir_all(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(dir.join("lock"))?;
        lock.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => StoreError::Locked,
            fs::TryLockError::Error(error) => StoreError::Io(error),
        })?;
        let path = dir.join("qop.db");
        let conn = Connection::open(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // Inbound messages are acknowledged once saved: make "saved" survive power loss.
        conn.pragma_update(None, "synchronous", "FULL")?;
        let store = Store {
            conn,
            dir: dir.to_owned(),
            _lock: lock,
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> StoreResult<()> {
        let applied: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        for (version, sql) in (1_i64..)
            .zip(MIGRATIONS)
            .skip(usize::try_from(applied).unwrap_or(0))
        {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn identity(&self) -> StoreResult<Option<Identity>> {
        let row = self
            .conn
            .query_row(
                "SELECT handle, qid, chain_id, registry, device_key, linked FROM identity",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, bool>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((handle, qid, chain_id, registry, device_key, linked)) = row else {
            return Ok(None);
        };
        let corrupt = |_| StoreError::Corrupt("identity");
        Ok(Some(Identity {
            handle,
            qid: qid.parse().map_err(corrupt)?,
            chain_id: chain_id.parse().map_err(corrupt)?,
            registry: registry
                .parse()
                .map_err(|_| StoreError::Corrupt("identity"))?,
            device_key: device_key
                .parse()
                .map_err(|_| StoreError::Corrupt("identity"))?,
            linked,
        }))
    }

    /// Inserts or replaces the identity.
    pub fn save_identity(&self, identity: &Identity) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO identity (id, handle, qid, chain_id, registry, device_key, linked)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                identity.handle,
                identity.qid.to_string(),
                identity.chain_id.to_string(),
                identity.registry.to_string().to_lowercase(),
                identity.device_key.to_string(),
                identity.linked,
            ],
        )?;
        Ok(())
    }

    /// Forgets the identity, any pending approval and all messages (Unlink).
    pub fn delete_identity(&self) -> StoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch(WIPE)?;
        tx.commit()?;
        Ok(())
    }

    pub fn approval(&self) -> StoreResult<Option<DeviceActionApproval>> {
        let record: Option<Vec<u8>> = self
            .conn
            .query_row("SELECT record FROM pending_approval", [], |row| row.get(0))
            .optional()?;
        record
            .map(|bytes| {
                DeviceActionApproval::decode(&bytes)
                    .map_err(|_| StoreError::Corrupt("pending approval"))
            })
            .transpose()
    }

    /// Persists the approval the phone sent; `approvalSaved` goes out only after this returns.
    pub fn save_approval(&self, approval: &DeviceActionApproval) -> StoreResult<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO pending_approval (id, record) VALUES (1, ?1)",
            params![approval.encode()],
        )?;
        Ok(())
    }

    pub fn clear_approval(&self) -> StoreResult<()> {
        self.conn.execute("DELETE FROM pending_approval", [])?;
        Ok(())
    }

    /// The handle of an account that removed this device, until the user acknowledges it.
    pub fn revoked(&self) -> StoreResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT handle FROM revoked", [], |row| row.get(0))
            .optional()?)
    }

    /// Wipes the identity and messages and records the revocation, atomically.
    pub fn revoke(&self, handle: &str) -> StoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch(WIPE)?;
        tx.execute(
            "INSERT OR REPLACE INTO revoked (id, handle) VALUES (1, ?1)",
            params![handle],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear_revoked(&self) -> StoreResult<()> {
        self.conn.execute("DELETE FROM revoked", [])?;
        Ok(())
    }

    /// Adds a conversation with `qid`, or updates its handle.
    pub fn upsert_contact(&self, qid: &str, handle: &str) -> StoreResult<()> {
        self.conn.execute(
            "INSERT INTO contacts (qid, handle) VALUES (?1, ?2)
             ON CONFLICT (qid) DO UPDATE SET handle = excluded.handle",
            params![qid, handle],
        )?;
        Ok(())
    }

    /// Every conversation, oldest first.
    pub fn contacts(&self) -> StoreResult<Vec<Contact>> {
        self.contacts_where("1", [])
    }

    /// The conversation with `qid`, if there is one.
    pub fn contact_summary(&self, qid: &str) -> StoreResult<Option<Contact>> {
        Ok(self.contacts_where("c.qid = ?1", [qid])?.pop())
    }

    fn contacts_where(&self, filter: &str, params: impl rusqlite::Params) -> StoreResult<Vec<Contact>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT c.qid, c.handle,
                (SELECT COUNT(*) FROM inbox i WHERE i.from_qid = c.qid AND i.rowid > c.read_seq)
             FROM contacts c WHERE {filter} ORDER BY c.rowid"
        ))?;
        let rows = statement.query_map(params, |row| {
            Ok(Contact {
                qid: row.get(0)?,
                handle: row.get(1)?,
                unread: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn contact(&self, qid: &str) -> StoreResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT handle FROM contacts WHERE qid = ?1", [qid], |row| {
                row.get(0)
            })
            .optional()?)
    }

    /// Marks everything received from `qid` so far as read.
    pub fn mark_read(&self, qid: &str) -> StoreResult<()> {
        self.conn.execute(
            "UPDATE contacts SET read_seq =
                (SELECT COALESCE(MAX(rowid), 0) FROM inbox WHERE from_qid = ?1)
             WHERE qid = ?1",
            [qid],
        )?;
        Ok(())
    }

    /// Saves a new outbox record; an identical one already stored is returned instead, a
    /// conflicting one is [`StoreError::Conflict`] (`CliOutboxStore.enqueue`). Its recipient
    /// becomes a conversation if it was not one (a phone handoff can name anyone); an existing
    /// contact keeps its handle.
    pub fn enqueue(&self, record: &OutboxRecord) -> StoreResult<OutboxRecord> {
        let tx = self.conn.unchecked_transaction()?;
        if let Some(existing) = outbox_by_id(&tx, &record.frame.id)? {
            if outbox_records_conflict(&existing, record) {
                return Err(StoreError::Conflict);
            }
            return Ok(existing);
        }
        insert_outbox(&tx, record)?;
        tx.execute(
            "INSERT INTO contacts (qid, handle) VALUES (?1, ?2) ON CONFLICT (qid) DO NOTHING",
            params![record.to_qid, record.to_handle],
        )?;
        tx.commit()?;
        Ok(record.clone())
    }

    /// Updates an outbox record's status and retry bookkeeping; conflicting content is
    /// [`StoreError::Conflict`] (`CliOutboxStore.put`). Unlike the CLI's, a record that is not
    /// stored is left out rather than inserted: a delivery that finishes after Unlink or
    /// revocation wiped the outbox must not bring its record back. New records use `enqueue`.
    pub fn put(&self, record: &OutboxRecord) -> StoreResult<()> {
        let tx = self.conn.unchecked_transaction()?;
        match outbox_by_id(&tx, &record.frame.id)? {
            Some(existing) if outbox_records_conflict(&existing, record) => {
                return Err(StoreError::Conflict);
            }
            Some(_) => {
                tx.execute(
                    "UPDATE outbox SET status = ?2, attempts = ?3, last_error = ?4,
                        next_attempt_at = ?5, queued_at = ?6, updated_at = ?7
                     WHERE id = ?1",
                    params![
                        record.frame.id,
                        record.status.as_str(),
                        record.attempts,
                        record.last_error,
                        record.next_attempt_at,
                        record.queued_at,
                        record.updated_at,
                    ],
                )?;
            }
            None => {}
        }
        tx.commit()?;
        Ok(())
    }

    pub fn outbox(&self, id: &str) -> StoreResult<Option<OutboxRecord>> {
        outbox_by_id(&self.conn, id)
    }

    /// Every outbox record, in the order they were queued.
    pub fn outbox_all(&self) -> StoreResult<Vec<OutboxRecord>> {
        self.outbox_where("1")
    }

    /// The stored records among `ids`, in the order they were queued (`CliOutboxStore.getByIds`).
    pub fn outbox_by_ids(&self, ids: &[String]) -> StoreResult<Vec<OutboxRecord>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.conn.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE id IN ({}) ORDER BY rowid",
            vec!["?"; ids.len()].join(", ")
        ))?;
        let rows = statement.query_map(rusqlite::params_from_iter(ids), outbox_row)?;
        rows.map(|row| row?.ok_or(StoreError::Corrupt("outbox")))
            .collect()
    }

    /// The records still waiting for an ACK, oldest first.
    pub fn queued(&self) -> StoreResult<Vec<OutboxRecord>> {
        self.outbox_where("status = 'queued'")
    }

    fn outbox_where(&self, filter: &str) -> StoreResult<Vec<OutboxRecord>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE {filter} ORDER BY rowid"
        ))?;
        let rows = statement.query_map([], outbox_row)?;
        rows.map(|row| row?.ok_or(StoreError::Corrupt("outbox")))
            .collect()
    }

    /// Saves an inbound message and its sender as a contact, atomically; `true` if it was new.
    /// The same message again is not an error (the sender retries until it sees our ACK); the
    /// same id with different content is [`StoreError::Conflict`] (`CliOutboxStore.putInbox`).
    pub fn put_inbox(&self, record: &InboxRecord) -> StoreResult<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let existing = tx
            .query_row(
                "SELECT from_handle, sent_at, text, received_at FROM inbox
                 WHERE from_qid = ?1 AND id = ?2",
                params![record.from_qid, record.frame.id],
                |row| {
                    Ok(InboxRecord {
                        frame: ChatFrame {
                            from_handle: row.get(0)?,
                            id: record.frame.id.clone(),
                            sent_at: row.get(1)?,
                            text: row.get(2)?,
                        },
                        from_qid: record.from_qid.clone(),
                        received_at: row.get(3)?,
                    })
                },
            )
            .optional()?;
        if let Some(existing) = existing {
            if inbox_records_conflict(&existing, record) {
                return Err(StoreError::Conflict);
            }
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO inbox (from_qid, id, from_handle, sent_at, text, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.from_qid,
                record.frame.id,
                record.frame.from_handle,
                record.frame.sent_at,
                record.frame.text,
                record.received_at,
            ],
        )?;
        tx.execute(
            "INSERT INTO contacts (qid, handle) VALUES (?1, ?2)
             ON CONFLICT (qid) DO UPDATE SET handle = excluded.handle",
            params![record.from_qid, record.frame.from_handle],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Up to `limit` inbox records with a seq (rowid) past `seq`, oldest first, and the highest
    /// seq stored (`CliOutboxStore.inboxAfter`): the phone's catch-up page. The inbox is
    /// append-only while linked, so a seq never moves to another record.
    pub fn inbox_after(&self, seq: u64, limit: usize) -> StoreResult<InboxPage> {
        let last_seq = self
            .conn
            .query_row("SELECT COALESCE(MAX(rowid), 0) FROM inbox", [], |row| row.get(0))?;
        let mut statement = self.conn.prepare(
            "SELECT rowid, from_qid, id, from_handle, sent_at, text, received_at FROM inbox
             WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
        )?;
        let rows = statement.query_map(params![seq, limit], |row| {
            Ok((row.get(0)?, inbox_record(row, 1)?))
        })?;
        Ok(InboxPage {
            last_seq,
            records: rows.collect::<Result<_, _>>()?,
        })
    }

    /// The newest `limit` messages with `qid`, oldest first, and whether older ones exist.
    /// Sent messages are timed by when they were written, received ones by when they arrived.
    pub fn thread(&self, qid: &str, limit: usize) -> StoreResult<(Vec<ThreadMessage>, bool)> {
        let mut statement = self.conn.prepare(
            "SELECT id, text, at, status FROM (
                SELECT id, text, sent_at AS at, status, 0 AS kind, rowid AS seq
                    FROM outbox WHERE to_qid = ?1
                UNION ALL
                SELECT id, text, received_at AS at, NULL AS status, 1 AS kind, rowid AS seq
                    FROM inbox WHERE from_qid = ?1
             ) ORDER BY at DESC, kind DESC, seq DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![qid, limit + 1], |row| {
            let status: Option<String> = row.get(3)?;
            // The schema's CHECK admits only the statuses this version knows.
            let unknown = || rusqlite::Error::InvalidColumnType(3, "status".into(), rusqlite::types::Type::Text);
            Ok(ThreadMessage {
                id: row.get(0)?,
                text: row.get(1)?,
                at_ms: row.get(2)?,
                sent: status.map(|status| OutboxStatus::parse(&status).ok_or_else(unknown)).transpose()?,
            })
        })?;
        let mut messages = rows.collect::<Result<Vec<_>, _>>()?;
        let more = messages.len() > limit;
        messages.truncate(limit);
        messages.reverse();
        Ok((messages, more))
    }

    /// Every inbound message, in arrival order.
    pub fn inbox_all(&self) -> StoreResult<Vec<InboxRecord>> {
        let mut statement = self.conn.prepare(
            "SELECT from_qid, id, from_handle, sent_at, text, received_at FROM inbox ORDER BY rowid",
        )?;
        let rows = statement.query_map([], |row| inbox_record(row, 0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// An inbox row's columns from `at`: from_qid, id, from_handle, sent_at, text, received_at.
fn inbox_record(row: &rusqlite::Row, at: usize) -> rusqlite::Result<InboxRecord> {
    Ok(InboxRecord {
        from_qid: row.get(at)?,
        frame: ChatFrame {
            id: row.get(at + 1)?,
            from_handle: row.get(at + 2)?,
            sent_at: row.get(at + 3)?,
            text: row.get(at + 4)?,
        },
        received_at: row.get(at + 5)?,
    })
}

/// A catch-up page: inbox records with their seq, and the highest seq stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboxPage {
    pub last_seq: u64,
    pub records: Vec<(u64, InboxRecord)>,
}

/// One message of a conversation, as the thread view needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadMessage {
    pub id: String,
    pub text: String,
    pub at_ms: u64,
    /// The outbox status of a message this account sent; `None` for one received.
    pub sent: Option<OutboxStatus>,
}

/// A conversation as stored: the contact and how many of its messages are unread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contact {
    pub qid: String,
    pub handle: String,
    pub unread: u32,
}

fn outbox_by_id(conn: &Connection, id: &str) -> StoreResult<Option<OutboxRecord>> {
    conn.query_row(
        &format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE id = ?1"),
        [id],
        outbox_row,
    )
    .optional()?
    .map(|row| row.ok_or(StoreError::Corrupt("outbox")))
    .transpose()
}

/// One outbox row; `None` for a status this version does not know.
fn outbox_row(row: &rusqlite::Row) -> rusqlite::Result<Option<OutboxRecord>> {
    let status: String = row.get(6)?;
    let Some(status) = OutboxStatus::parse(&status) else {
        return Ok(None);
    };
    Ok(Some(OutboxRecord {
        frame: ChatFrame {
            id: row.get(0)?,
            from_handle: row.get(1)?,
            sent_at: row.get(2)?,
            text: row.get(3)?,
        },
        to_handle: row.get(4)?,
        to_qid: row.get(5)?,
        status,
        attempts: row.get(7)?,
        last_error: row.get(8)?,
        next_attempt_at: row.get(9)?,
        queued_at: row.get(10)?,
        updated_at: row.get(11)?,
    }))
}

fn insert_outbox(conn: &Connection, record: &OutboxRecord) -> StoreResult<()> {
    conn.execute(
        &format!(
            "INSERT INTO outbox ({OUTBOX_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
        ),
        params![
            record.frame.id,
            record.frame.from_handle,
            record.frame.sent_at,
            record.frame.text,
            record.to_handle,
            record.to_qid,
            record.status.as_str(),
            record.attempts,
            record.last_error,
            record.next_attempt_at,
            record.queued_at,
            record.updated_at,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qop-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn identity() -> Identity {
        Identity {
            handle: "alice".into(),
            qid: U256::from(42),
            chain_id: U256::from(31337),
            registry: "0x1111111111111111111111111111111111111111"
                .parse()
                .unwrap(),
            device_key: B256::repeat_byte(9),
            linked: false,
        }
    }

    #[test]
    fn persists_identity_across_reopen_and_holds_the_lock() {
        let dir = temp_dir("reopen");
        {
            let store = Store::open(&dir).expect("open");
            assert!(matches!(Store::open(&dir), Err(StoreError::Locked)));
            store.save_identity(&identity()).expect("save");
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let store = Store::open(&dir).expect("reopen after release");
        assert_eq!(store.identity().unwrap(), Some(identity()));
        fs::remove_dir_all(dir).unwrap();
    }

    fn frame(id: &str, text: &str) -> ChatFrame {
        ChatFrame {
            from_handle: "alice".into(),
            id: id.into(),
            sent_at: 1_700_000_000_000,
            text: text.into(),
        }
    }

    const ID: &str = "6f1c3c4e-8a2b-4c1d-9e0f-1a2b3c4d5e6f";

    fn queued(text: &str) -> OutboxRecord {
        OutboxRecord {
            attempts: 0,
            frame: frame(ID, text),
            last_error: None,
            next_attempt_at: 5,
            queued_at: 5,
            status: OutboxStatus::Queued,
            to_handle: "bob".into(),
            to_qid: "7".into(),
            updated_at: 5,
        }
    }

    /// `outboxRecordsConflict`: same id, different content conflicts; bookkeeping may change.
    #[test]
    fn outbox_ids_keep_their_content() {
        let dir = temp_dir("outbox");
        let store = Store::open(&dir).expect("open");
        let record = queued("hi");
        assert_eq!(store.enqueue(&record).unwrap(), record);
        // Enqueueing the same record again returns what is stored (the attempt count included).
        let sent = OutboxRecord {
            status: OutboxStatus::Sent,
            attempts: 2,
            ..record.clone()
        };
        store.put(&sent).unwrap();
        assert_eq!(store.enqueue(&record).unwrap(), sent);
        assert_eq!(store.queued().unwrap(), vec![]);
        for conflicting in [
            queued("edited"),
            OutboxRecord {
                to_handle: "carol".into(),
                ..record.clone()
            },
            OutboxRecord {
                to_qid: "8".into(),
                ..record.clone()
            },
            OutboxRecord {
                frame: ChatFrame {
                    sent_at: 6,
                    ..record.frame.clone()
                },
                ..record.clone()
            },
            OutboxRecord {
                frame: ChatFrame {
                    from_handle: "mallory".into(),
                    ..record.frame.clone()
                },
                ..record.clone()
            },
        ] {
            assert!(outbox_records_conflict(&record, &conflicting));
            assert!(matches!(
                store.enqueue(&conflicting),
                Err(StoreError::Conflict)
            ));
            assert!(matches!(store.put(&conflicting), Err(StoreError::Conflict)));
        }
        assert_eq!(store.outbox(ID).unwrap(), Some(sent));
        // `put` never inserts: a delivery finishing after a wipe leaves nothing behind.
        store.delete_identity().unwrap();
        store.put(&record).unwrap();
        assert_eq!(store.outbox_all().unwrap(), vec![]);
        fs::remove_dir_all(dir).unwrap();
    }

    /// `inboxRecordsConflict`: keyed by sender and id; a repeat is not new, edited content
    /// conflicts, and the same id from someone else is a different message.
    #[test]
    fn inbox_records_are_keyed_by_sender_and_id() {
        let dir = temp_dir("inbox");
        let store = Store::open(&dir).expect("open");
        let record = InboxRecord {
            frame: frame(ID, "hello"),
            from_qid: "7".into(),
            received_at: 10,
        };
        assert!(store.put_inbox(&record).unwrap());
        // The sender retries until it sees the ACK: the repeat is accepted, not stored twice.
        let repeat = InboxRecord {
            received_at: 99,
            ..record.clone()
        };
        assert!(!inbox_records_conflict(&record, &repeat));
        assert!(!store.put_inbox(&repeat).unwrap());
        let edited = InboxRecord {
            frame: frame(ID, "edited"),
            ..record.clone()
        };
        assert!(inbox_records_conflict(&record, &edited));
        assert!(matches!(
            store.put_inbox(&edited),
            Err(StoreError::Conflict)
        ));
        let other_sender = InboxRecord {
            from_qid: "8".into(),
            ..edited.clone()
        };
        assert!(!inbox_records_conflict(&record, &other_sender));
        assert!(store.put_inbox(&other_sender).unwrap());
        assert_eq!(
            store.inbox_all().unwrap(),
            vec![record.clone(), other_sender]
        );

        // Each sender became a conversation with one unread message, until read.
        let unread: Vec<_> = store
            .contacts()
            .unwrap()
            .iter()
            .map(|c| (c.qid.clone(), c.unread))
            .collect();
        assert_eq!(unread, vec![("7".into(), 1), ("8".into(), 1)]);
        store.mark_read("7").unwrap();
        assert_eq!(store.contacts().unwrap()[0].unread, 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn revoking_wipes_the_identity_and_remembers_the_handle() {
        let dir = temp_dir("revoke");
        let store = Store::open(&dir).expect("open");
        store
            .save_identity(&Identity {
                linked: true,
                ..identity()
            })
            .unwrap();
        store.upsert_contact("7", "bob").unwrap();
        store.revoke("alice").unwrap();
        assert_eq!(store.identity().unwrap(), None);
        assert_eq!(store.contacts().unwrap(), vec![]);
        assert_eq!(store.revoked().unwrap().as_deref(), Some("alice"));
        store.clear_revoked().unwrap();
        assert_eq!(store.revoked().unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
