import { assert, layer } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import type { Address, Hash, Hex } from "viem";

import { RegistrationInputError } from "../src/registration/inputs.ts";
import {
  HandleLeaseConflict,
  registrationDraftLimitPerHandle,
  registrationExpirationBatchSize,
  RegistrationDraftLimitReached,
  RegistrationIntentConflict,
  RegistrationIntentExpired,
  RegistrationStore,
  RegistrationTransitionConflict,
} from "../src/registration/store.ts";
import type { CreateRegistrationIntent } from "../src/registration/types.ts";
import { RegistrationStoreTestLive } from "./support/registration-database.ts";

const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";
const CHECKSUMMED_OWNER =
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address;
const CANONICAL_OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" as Address;

const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, "0")}` as Hash;

const uppercaseHash = (value: number): Hash =>
  hash(value).toUpperCase() as Hash;

const walletSignature = (recovery: "1B" | "1C"): Hex => {
  const r = "A".padStart(64, "0");
  const s = "1".padStart(64, "0");
  return `0x${r}${s}${recovery}` as Hex;
};

const canonicalSignature = (yParity: "00" | "01"): Hex => {
  const r = "a".padStart(64, "0");
  const s = "1".padStart(64, "0");
  return `0x${r}${s}${yParity}` as Hex;
};

const deadlineAfter = Effect.fn("test.deadlineAfter")(function* (
  seconds: number
) {
  const now = yield* DateTime.now;
  return BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000) + seconds);
});

const input = (
  id: number,
  handle: string,
  deadline: bigint,
  options?: { readonly uppercase?: boolean }
): CreateRegistrationIntent => {
  const encodeHash = options?.uppercase ? uppercaseHash : hash;
  return {
    admissionCodeHash: encodeHash(50_000 + id),
    deadline,
    deviceCommitment: encodeHash(40_000 + id),
    digest: encodeHash(10_000 + id),
    handle,
    observeTokenHash: encodeHash(20_000 + id),
    owner: CHECKSUMMED_OWNER,
    peerId: PEER_ID,
    registrationNonce: encodeHash(30_000 + id),
  };
};

const authorization = {
  ownerSignature: walletSignature("1B"),
  registrationSignature: walletSignature("1C"),
};

layer(RegistrationStoreTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("normalizes drafts and leases a handle only on authorization", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const deadline = yield* deadlineAfter(60);
      const firstInput = input(1, "alice", deadline, { uppercase: true });
      const created = yield* store.create(firstInput);

      assert.strictEqual(created.digest, firstInput.digest.toLowerCase());
      assert.strictEqual(
        created.deviceCommitment,
        firstInput.deviceCommitment.toLowerCase()
      );
      assert.strictEqual(
        created.observeTokenHash,
        firstInput.observeTokenHash.toLowerCase()
      );
      assert.strictEqual(created.owner, CANONICAL_OWNER);
      assert.strictEqual(
        created.registrationNonce,
        firstInput.registrationNonce.toLowerCase()
      );
      assert.strictEqual(
        (yield* store.create(firstInput)).digest,
        created.digest
      );

      const competing = input(2, "alice", deadline);
      assert.strictEqual(
        (yield* store.create(competing)).status,
        "pending_owner_signature"
      );
      yield* store.authorize(firstInput.digest, authorization);
      const conflict = yield* store
        .authorize(competing.digest, authorization)
        .pipe(Effect.flip);
      assert.instanceOf(conflict, HandleLeaseConflict);

      yield* store.markFailed(firstInput.digest, "TEST_CLEANUP");
      yield* store.markFailed(competing.digest, "TEST_CLEANUP");
      assert.instanceOf(
        yield* store.create(firstInput).pipe(Effect.flip),
        RegistrationIntentConflict
      );
      const replacement = input(11, "alice", deadline);
      yield* store.create(replacement);
      yield* store.markFailed(replacement.digest, "TEST_CLEANUP");
    })
  );

  it.effect("normalizes wallet signatures to wire yParity", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const registration = input(3, "bravo", yield* deadlineAfter(60));
      yield* store.create(registration);
      const ready = yield* store.authorize(registration.digest, authorization);

      assert.strictEqual(ready.ownerSignature, canonicalSignature("00"));
      assert.strictEqual(ready.registrationSignature, canonicalSignature("01"));
      assert.strictEqual(
        (yield* store.authorize(registration.digest, authorization)).status,
        "ready"
      );
      yield* store.markFailed(registration.digest, "TEST_CLEANUP");
    })
  );

  it.effect("atomically replays prepare by observe capability hash", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const deadline = yield* deadlineAfter(60);
      const firstInput = input(13, "atomicretry", deadline);
      const retryInput = {
        ...input(14, "atomicretry", deadline),
        admissionCodeHash: firstInput.admissionCodeHash,
        deviceCommitment: firstInput.deviceCommitment,
        observeTokenHash: firstInput.observeTokenHash,
      };

      const [first, retry] = yield* Effect.all(
        [store.create(firstInput), store.create(retryInput)],
        { concurrency: "unbounded" }
      );
      assert.strictEqual(retry.digest, first.digest);
      assert.strictEqual(retry.registrationNonce, first.registrationNonce);

      const mismatch = yield* store
        .create({ ...retryInput, handle: "differentrequest" })
        .pipe(Effect.flip);
      assert.instanceOf(mismatch, RegistrationIntentConflict);
      const commitmentMismatch = yield* store
        .create({
          ...retryInput,
          deviceCommitment: hash(99_999),
        })
        .pipe(Effect.flip);
      assert.instanceOf(commitmentMismatch, RegistrationIntentConflict);
      yield* store.markFailed(first.digest, "TEST_CLEANUP");
    })
  );

  it.effect("rejects authorization after a pending intent deadline", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const registration = input(12, "beforedeadline", yield* deadlineAfter(5));
      yield* store.create(registration);
      yield* TestClock.adjust("6 seconds");

      const error = yield* store
        .authorize(registration.digest, authorization)
        .pipe(Effect.flip);
      assert.instanceOf(error, RegistrationIntentExpired);
      const stored = Option.getOrThrow(yield* store.get(registration.digest));
      assert.strictEqual(stored.status, "pending_owner_signature");
      assert.isNull(stored.ownerSignature);
      assert.isNull(stored.registrationSignature);
      assert.strictEqual(yield* store.expire, 1);
    })
  );

  it.effect("replays concurrent and pre-reserved identical authorization", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const reserved = input(15, "reserved", yield* deadlineAfter(60));
      yield* store.create(reserved);
      yield* store.reserveAuthorization(
        reserved.digest,
        authorization.ownerSignature
      );
      assert.strictEqual(
        (yield* store.authorize(reserved.digest, authorization)).status,
        "ready"
      );

      const concurrent = input(16, "concurrent", yield* deadlineAfter(60));
      yield* store.create(concurrent);
      const results = yield* Effect.all(
        [
          store.authorize(concurrent.digest, authorization),
          store.authorize(concurrent.digest, authorization),
        ],
        { concurrency: "unbounded" }
      );
      assert.deepStrictEqual(
        results.map((result) => result.status),
        ["ready", "ready"]
      );
      yield* store.markFailed(reserved.digest, "TEST_CLEANUP");
      yield* store.markFailed(concurrent.digest, "TEST_CLEANUP");
    })
  );

  it.effect(
    "does not relabel terminal authorization conflicts as expired",
    () =>
      Effect.gen(function* () {
        const store = yield* RegistrationStore;
        const registration = input(17, "terminal", yield* deadlineAfter(5));
        yield* store.create(registration);
        yield* store.authorize(registration.digest, authorization);
        yield* TestClock.adjust("6 seconds");
        const error = yield* store
          .authorize(registration.digest, {
            ownerSignature: walletSignature("1C"),
            registrationSignature: walletSignature("1B"),
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, RegistrationTransitionConflict);
        assert.strictEqual(error.actual, "ready");
        yield* store.markFailed(registration.digest, "TEST_CLEANUP");
      })
  );

  it.effect("bounds concurrent drafts per handle", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const deadline = yield* deadlineAfter(60);
      const drafts = Array.from(
        { length: registrationDraftLimitPerHandle },
        (_, index) => input(2000 + index, "bounded", deadline)
      );
      yield* Effect.forEach(drafts, store.create, {
        concurrency: "unbounded",
        discard: true,
      });
      const overflow = yield* store
        .create(input(3000, "bounded", deadline))
        .pipe(Effect.flip);
      assert.instanceOf(overflow, RegistrationDraftLimitReached);
      assert.strictEqual(overflow.limit, registrationDraftLimitPerHandle);
      yield* Effect.forEach(
        drafts,
        (draft) => store.markFailed(draft.digest, "TEST_CLEANUP"),
        { concurrency: "unbounded", discard: true }
      );
    })
  );

  it.effect("retains ready and submitted leases after their deadline", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const deadline = yield* deadlineAfter(10);
      const registration = input(4, "charlie", deadline);
      yield* store.create(registration);
      yield* store.authorize(registration.digest, authorization);
      yield* TestClock.adjust("11 seconds");

      assert.strictEqual(yield* store.expire, 0);
      assert.strictEqual(
        (yield* store.authorize(registration.digest, authorization)).status,
        "ready"
      );
      const readyCompetitor = input(5, "charlie", yield* deadlineAfter(60));
      yield* store.create(readyCompetitor);
      assert.instanceOf(
        yield* store
          .authorize(readyCompetitor.digest, authorization)
          .pipe(Effect.flip),
        HandleLeaseConflict
      );

      const submitted = yield* store.markSubmitted(
        registration.digest,
        uppercaseHash(40_004)
      );
      assert.strictEqual(submitted.status, "submitted");
      assert.strictEqual(submitted.transactionHash, hash(40_004));
      assert.strictEqual(yield* store.expire, 0);
      const submittedCompetitor = input(6, "charlie", yield* deadlineAfter(60));
      yield* store.create(submittedCompetitor);
      assert.instanceOf(
        yield* store
          .authorize(submittedCompetitor.digest, authorization)
          .pipe(Effect.flip),
        HandleLeaseConflict
      );

      const confirmed = yield* store.markConfirmed(registration.digest, 1n);
      assert.strictEqual(confirmed.status, "confirmed");
      assert.strictEqual(
        (yield* store.create(registration)).status,
        "confirmed"
      );
      const replacement = input(7, "charlie", yield* deadlineAfter(60));
      yield* store.create(replacement);
      yield* store.markFailed(readyCompetitor.digest, "TEST_CLEANUP");
      yield* store.markFailed(submittedCompetitor.digest, "TEST_CLEANUP");
      yield* store.markFailed(replacement.digest, "TEST_CLEANUP");
    })
  );

  it.effect("allows competing drafts and expires them independently", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const incumbent = input(8, "delta", yield* deadlineAfter(5));
      yield* store.create(incumbent);
      yield* TestClock.adjust("6 seconds");

      const replacement = input(9, "delta", yield* deadlineAfter(60));
      assert.strictEqual(
        (yield* store.create(replacement)).digest,
        replacement.digest
      );
      assert.strictEqual(
        Option.getOrThrow(yield* store.get(incumbent.digest)).status,
        "pending_owner_signature"
      );
      assert.strictEqual(yield* store.expire, 1);
      assert.strictEqual(
        Option.getOrThrow(yield* store.get(incumbent.digest)).status,
        "expired"
      );
      yield* store.markFailed(replacement.digest, "TEST_CLEANUP");
    })
  );

  it.effect("rejects invalid codecs before writing", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const invalid = {
        ...input(10, "echo", yield* deadlineAfter(60)),
        peerId: `${PEER_ID}x`,
      };
      const error = yield* store.create(invalid).pipe(Effect.flip);

      assert.instanceOf(error, RegistrationInputError);
      assert.strictEqual(error.field, "peer-id");
      assert.isTrue(Option.isNone(yield* store.get(invalid.digest)));
    })
  );

  it.effect("expires unsigned intents in bounded batches", () =>
    Effect.gen(function* () {
      const store = yield* RegistrationStore;
      const deadline = yield* deadlineAfter(5);

      yield* Effect.forEach(
        Array.from(
          { length: registrationExpirationBatchSize + 1 },
          (_, index) => {
            const first = String.fromCodePoint(97 + Math.floor(index / 26));
            const second = String.fromCodePoint(97 + (index % 26));
            return input(100 + index, `batch${first}${second}`, deadline);
          }
        ),
        store.create,
        { concurrency: 1, discard: true }
      );
      yield* TestClock.adjust("6 seconds");

      assert.strictEqual(yield* store.expire, registrationExpirationBatchSize);
      assert.strictEqual(yield* store.expire, 1);
      assert.strictEqual(yield* store.expire, 0);
    })
  );
});
