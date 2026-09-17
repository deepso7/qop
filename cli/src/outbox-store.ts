import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  InboxRecordV1,
  OutboxRecordV1,
  inboxRecordsConflict,
  outboxRecordsConflict,
} from "@qop/protocol";
import { Data, Effect, Schema } from "effect";

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;
const OUTBOX_VERSION = 1 as const;
const INBOX_VERSION = 1 as const;

const NodeErrno = Schema.Struct({
  code: Schema.String,
});
const errnoCode = Schema.decodeUnknownOption(NodeErrno);

export class CliOutboxStoreError extends Data.TaggedError(
  "CliOutboxStoreError"
)<{
  readonly operation: "conflict" | "decode" | "permissions" | "read" | "write";
}> {}

const storeError = (operation: CliOutboxStoreError["operation"]) =>
  new CliOutboxStoreError({ operation });

const StoredOutboxFile = Schema.Struct({
  records: Schema.Array(OutboxRecordV1),
  version: Schema.Literal(OUTBOX_VERSION),
}).annotate({
  messageUnexpectedKey: "Unexpected CLI outbox file field",
  parseOptions: { errors: "all", onExcessProperty: "error" },
});

const StoredInboxFile = Schema.Struct({
  messages: Schema.Array(InboxRecordV1),
  version: Schema.Literal(INBOX_VERSION),
}).annotate({
  messageUnexpectedKey: "Unexpected CLI inbox file field",
  parseOptions: { errors: "all", onExcessProperty: "error" },
});

const writeAtomic = Effect.fn("CliOutbox.writeAtomic")(function* (
  filePath: string,
  contents: string
) {
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () =>
      mkdir(path.dirname(filePath), { mode: MODE_DIR, recursive: true }),
  });
  const temporary = `${filePath}.tmp`;
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => writeFile(temporary, contents, { mode: MODE_FILE }),
  });
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => chmod(temporary, MODE_FILE),
  });
  yield* Effect.tryPromise({
    catch: () => storeError("write"),
    try: () => rename(temporary, filePath),
  });
});

const readTextOptional = (filePath: string) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: () => readFile(filePath, "utf-8"),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const parsed = errnoCode(error);
        return parsed._tag === "Some" && parsed.value.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(storeError("read"));
      },
      onSuccess: (value) => Effect.succeed(value),
    })
  );

const assertPrivateFile = Effect.fn("CliOutbox.assertPrivateFile")(function* (
  filePath: string
) {
  const info = yield* Effect.tryPromise({
    catch: () => storeError("permissions"),
    try: () => stat(filePath),
  });
  if (info.mode.toString(8).slice(-3) !== "600") {
    return yield* storeError("permissions");
  }
});

const parseJson = (encoded: string) =>
  Effect.try({
    catch: () => storeError("decode"),
    // SAFETY: JSON.parse is untyped; the file schema is decoded next.
    try: () => JSON.parse(encoded) as unknown,
  });

const emptyOutbox: OutboxRecordV1[] = [];
const emptyInbox: InboxRecordV1[] = [];

/** Durable CLI outbox + inbox under the identity data directory. */
export const createCliOutboxStore = (root: string) => {
  const outboxPath = path.join(root, "outbox.json");
  const inboxPath = path.join(root, "inbox.json");

  const loadRecords = Effect.fn("CliOutbox.loadRecords")(function* () {
    const encoded = yield* readTextOptional(outboxPath);
    if (!encoded) {
      return emptyOutbox;
    }
    yield* assertPrivateFile(outboxPath);
    const parsed = yield* parseJson(encoded);
    const file = yield* Schema.decodeUnknownEffect(StoredOutboxFile)(
      parsed
    ).pipe(Effect.mapError(() => storeError("decode")));
    return file.records;
  });

  const saveRecords = Effect.fn("CliOutbox.saveRecords")(function* (
    records: readonly OutboxRecordV1[]
  ) {
    const encoded = yield* Schema.encodeEffect(StoredOutboxFile)({
      records,
      version: OUTBOX_VERSION,
    }).pipe(Effect.mapError(() => storeError("write")));
    yield* writeAtomic(outboxPath, JSON.stringify(encoded));
    yield* assertPrivateFile(outboxPath);
  });

  const loadInbox = Effect.fn("CliOutbox.loadInbox")(function* () {
    const encoded = yield* readTextOptional(inboxPath);
    if (!encoded) {
      return emptyInbox;
    }
    yield* assertPrivateFile(inboxPath);
    const parsed = yield* parseJson(encoded);
    const file = yield* Schema.decodeUnknownEffect(StoredInboxFile)(
      parsed
    ).pipe(Effect.mapError(() => storeError("decode")));
    return file.messages;
  });

  const saveInbox = Effect.fn("CliOutbox.saveInbox")(function* (
    messages: readonly InboxRecordV1[]
  ) {
    const encoded = yield* Schema.encodeEffect(StoredInboxFile)({
      messages,
      version: INBOX_VERSION,
    }).pipe(Effect.mapError(() => storeError("write")));
    yield* writeAtomic(inboxPath, JSON.stringify(encoded));
    yield* assertPrivateFile(inboxPath);
  });

  const enqueue = Effect.fn("CliOutbox.enqueue")(function* (
    record: OutboxRecordV1
  ) {
    const records = yield* loadRecords();
    const existing = records.find((item) => item.frame.id === record.frame.id);
    if (existing) {
      if (outboxRecordsConflict(existing, record)) {
        return yield* storeError("conflict");
      }
      return existing;
    }
    const next = [...records, record];
    yield* saveRecords(next);
    return record;
  });

  const put = Effect.fn("CliOutbox.put")(function* (record: OutboxRecordV1) {
    const records = yield* loadRecords();
    const index = records.findIndex(
      (item) => item.frame.id === record.frame.id
    );
    if (index === -1) {
      yield* saveRecords([...records, record]);
      return record;
    }
    const current = records[index];
    if (current && outboxRecordsConflict(current, record)) {
      return yield* storeError("conflict");
    }
    const next = [...records];
    next[index] = record;
    yield* saveRecords(next);
    return record;
  });

  const queued = Effect.fn("CliOutbox.queued")(function* () {
    const records = yield* loadRecords();
    return records.filter((record) => record.status === "queued");
  });

  const queuedCount = Effect.fn("CliOutbox.queuedCount")(function* () {
    return (yield* queued()).length;
  });

  const putInbox = Effect.fn("CliOutbox.putInbox")(function* (
    record: InboxRecordV1
  ) {
    const messages = yield* loadInbox();
    const existing = messages.find((item) => item.frame.id === record.frame.id);
    if (existing) {
      if (inboxRecordsConflict(existing, record)) {
        return yield* storeError("conflict");
      }
      return existing;
    }
    const next = [...messages, record];
    yield* saveInbox(next);
    return record;
  });

  return {
    enqueue,
    loadInbox,
    loadRecords,
    put,
    putInbox,
    queued,
    queuedCount,
  };
};
