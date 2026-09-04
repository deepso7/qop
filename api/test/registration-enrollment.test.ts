import { assert, layer } from "@effect/vitest";
import {
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  encodeRegisterIntentV1,
  hashRegisterIntentV1,
  makeRegisterIntentTypedDataV1,
} from "@qop/identity";
import type { RegisterIntentV1Encoded } from "@qop/identity";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Option } from "effect";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Database } from "../src/db/database.ts";
import { registrationAdmissionCodes } from "../src/db/schema.ts";
import { Env } from "../src/env.ts";
import {
  decodeRegistrationAdmissionCode,
  RegistrationAdmission,
} from "../src/registration/admission.ts";
import {
  RegistrationDeadlineInvalid,
  RegistrationEnrollment,
  RegistrationProtocolError,
  registrationReconciliationFailureCodes,
  RegistrationSignatureMismatch,
} from "../src/registration/enrollment.ts";
import {
  RegistrationRelayer,
  RegistrationRelayerError,
} from "../src/registration/relayer.ts";
import { registrationSignerLayer } from "../src/registration/signer.ts";
import { RegistrationStore } from "../src/registration/store.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type {
  RegistryInvalidations,
  RegistryRead,
  RegistryReads,
} from "../src/registry/reader.ts";
import { testAddress, testHash } from "./support/ethereum.ts";
import { TestDatabaseLive } from "./support/registration-database.ts";

const OWNER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const REGISTRATION_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
const WRONG_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000003";
const REGISTRY_ADDRESS = testAddress(
  "0x1111111111111111111111111111111111111111"
);
const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);
const wrongAccount = privateKeyToAccount(WRONG_PRIVATE_KEY);
const owner = testAddress(ownerAccount.address.toLowerCase());
const transactionHash = testHash("transaction");
const accountFor = (id: number) =>
  privateKeyToAccount(`0x${id.toString(16).padStart(64, "0")}`);

const domain = Effect.runSync(
  decodeIdentityEip712DomainV1({
    chainId: "31337",
    verifyingContract: REGISTRY_ADDRESS,
  })
);

const read = <Value>(value: Value): RegistryRead<Value> => ({
  blockNumber: 100n,
  cachedAt: 0,
  freshness: "fresh",
  value,
});

const confirmedHandles = new Set<string>();
const conflictingHandles = new Set<string>();
const mismatchedConfirmationHandles = new Set<string>();

const handleQid = (handle: string): bigint | null => {
  if (handle === "takenhandle" || conflictingHandles.has(handle)) {
    return 7n;
  }
  if (mismatchedConfirmationHandles.has(handle)) {
    return 7n;
  }
  return confirmedHandles.has(handle) ? 42n : null;
};

const ownerQid = (handle: string): bigint | null => {
  if (handle === "takenowner" || mismatchedConfirmationHandles.has(handle)) {
    return 8n;
  }
  return confirmedHandles.has(handle) ? 42n : null;
};

const registryReads: RegistryReads = {
  account: (qid) =>
    Effect.succeed(
      read({
        deviceKey: testHash("device"),
        handle: "alice",
        nonce: 0n,
        owner,
        ownerVersion: 0,
        qid,
        registeredAt: 0n,
      })
    ),
  qidByHandle: () => Effect.succeed(read(null)),
  qidByOwner: () => Effect.succeed(read(null)),
};

const registryInvalidations: RegistryInvalidations = {
  account: () => Effect.void,
  all: Effect.void,
  ownerRotation: () => Effect.void,
  qidByHandle: () => Effect.void,
  qidByOwner: () => Effect.void,
};

const RegistryReaderTestLive = Layer.succeed(
  RegistryReader,
  RegistryReader.of({
    cached: registryReads,
    fresh: {
      ...registryReads,
      registrationProbe: (handle) =>
        Effect.succeed({
          blockNumber: 100n,
          value: {
            blockTimestamp: handle === "expiredchain" ? 10_000_000_000n : 0n,
            handleQid: handleQid(handle),
            ownerQid: ownerQid(handle),
            registrationNonceUsed:
              handle === "usednonce" ||
              confirmedHandles.has(handle) ||
              mismatchedConfirmationHandles.has(handle),
          },
        }),
    },
    invalidate: registryInvalidations,
  })
);

const EnvTestLive = Layer.succeed(
  Env,
  Env.of({
    CHAIN_ID: 31_337n,
    DATABASE_URL: "postgresql://test",
    PORT: 3000,
    REGISTRATION_PRIVATE_KEY,
    REGISTRY_ADDRESS,
    REGISTRY_CONFIRMATIONS: 0,
    RELAYER_PRIVATE_KEY: WRONG_PRIVATE_KEY,
    RPC_URL: new URL("http://127.0.0.1:8545"),
  })
);

const RegistrationPersistenceTestLive = Layer.merge(
  RegistrationAdmission.layer,
  RegistrationStore.layer
).pipe(Layer.provideMerge(TestDatabaseLive));

const RegistrationRelayerTestLive = Layer.succeed(
  RegistrationRelayer,
  RegistrationRelayer.of({
    broadcast: (prepared) => Effect.succeed(prepared.transactionHash),
    pendingNonce: Effect.succeed(0n),
    prepare: () =>
      Effect.succeed({ serializedTransaction: "0x02aa", transactionHash }),
  })
);

let retryBroadcastAttempts = 0;
const RetryRelayerTestLive = Layer.sync(RegistrationRelayer, () => {
  retryBroadcastAttempts = 0;
  return RegistrationRelayer.of({
    broadcast: (prepared) =>
      Effect.suspend(() => {
        retryBroadcastAttempts += 1;
        return retryBroadcastAttempts < 3
          ? Effect.fail(
              new RegistrationRelayerError({ operation: "broadcast" })
            )
          : Effect.succeed(prepared.transactionHash);
      }),
    pendingNonce: Effect.succeed(0n),
    prepare: () =>
      Effect.succeed({ serializedTransaction: "0x02aa", transactionHash }),
  });
});

const enrollmentLayer = (relayer: Layer.Layer<RegistrationRelayer>) =>
  RegistrationEnrollment.layer.pipe(
    Layer.provideMerge(RegistrationPersistenceTestLive),
    Layer.provide(RegistryReaderTestLive),
    Layer.provide(relayer),
    Layer.provide(registrationSignerLayer(REGISTRATION_PRIVATE_KEY)),
    Layer.provide(EnvTestLive)
  );

const RegistrationEnrollmentTestLive = enrollmentLayer(
  RegistrationRelayerTestLive
);
const RetryEnrollmentTestLive = enrollmentLayer(RetryRelayerTestLive);

let readyReplayPrepareAttempts = 0;
const ReadyReplayRelayerTestLive = Layer.sync(RegistrationRelayer, () => {
  readyReplayPrepareAttempts = 0;
  return RegistrationRelayer.of({
    broadcast: (prepared) => Effect.succeed(prepared.transactionHash),
    pendingNonce: Effect.succeed(0n),
    prepare: () => {
      readyReplayPrepareAttempts += 1;
      return Effect.fail(
        new RegistrationRelayerError({ operation: "prepare" })
      );
    },
  });
});
const ReadyReplayEnrollmentTestLive = enrollmentLayer(
  ReadyReplayRelayerTestLive
);

const makeIntent = Effect.fn("test.makeIntent")(function* (
  handle: string,
  deadlineOffset = 600n,
  inputOwner: Address = owner
) {
  const now = yield* DateTime.now;
  return yield* encodeRegisterIntentV1(
    yield* decodeRegisterIntentV1({
      deadline: (
        BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) + deadlineOffset
      ).toString(),
      deviceKey: testHash(`device-${handle}`),
      handle,
      nonce: testHash(`nonce-${handle}`),
      owner: inputOwner,
    })
  );
});

const signIntent = (
  intent: RegisterIntentV1Encoded,
  signer: Pick<typeof ownerAccount, "signTypedData"> = ownerAccount
) =>
  decodeRegisterIntentV1(intent).pipe(
    Effect.flatMap((decoded) =>
      Effect.promise(() =>
        signer.signTypedData(makeRegisterIntentTypedDataV1(domain, decoded))
      )
    )
  );

const registerInput = Effect.fn("test.registerInput")(function* (
  handle: string,
  deadlineOffset = 600n,
  account: typeof ownerAccount = ownerAccount,
  admissionCode = "ABC-123"
) {
  const inputOwner = testAddress(account.address.toLowerCase());
  const intent = yield* makeIntent(handle, deadlineOffset, inputOwner);
  return {
    admissionCode,
    intent,
    ownerSignature: yield* signIntent(intent, account),
  };
});

const createAdmission = Effect.fn("test.createAdmission")(function* (
  admissionCode: string,
  expiresAt?: bigint
) {
  const admissions = yield* RegistrationAdmission;
  const decoded = yield* decodeRegistrationAdmissionCode(admissionCode);
  yield* admissions.create(decoded.codeHash, expiresAt);
  return decoded.codeHash;
});

layer(RegistrationEnrollmentTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("submits registration and confirms it through reconciliation", () =>
    Effect.gen(function* () {
      const admissionCode = "HAP-001";
      yield* createAdmission(admissionCode);
      const enrollment = yield* RegistrationEnrollment;
      const input = yield* registerInput(
        "happy",
        600n,
        accountFor(10),
        admissionCode
      );
      const submitted = yield* enrollment.register(input);
      confirmedHandles.add("happy");
      const confirmed = yield* enrollment.reconcile(submitted.digest);

      assert.deepStrictEqual(submitted, {
        digest: submitted.digest,
        registrationSignature: submitted.registrationSignature,
        status: "submitted",
        transactionHash,
      });
      assert.strictEqual(confirmed.status, "confirmed");
      assert.strictEqual(confirmed.qid, 42n);
      const admissions = yield* RegistrationAdmission;
      const { codeHash } =
        yield* decodeRegistrationAdmissionCode(admissionCode);
      const denied = yield* admissions.validate(codeHash).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "RegistrationAdmissionUnauthorized");
    }).pipe(
      Effect.ensuring(Effect.sync(() => confirmedHandles.delete("happy")))
    )
  );

  it.effect("replays a digest without rechecking its admission code", () =>
    Effect.gen(function* () {
      const admissionCode = "REP-002";
      yield* createAdmission(admissionCode);
      const enrollment = yield* RegistrationEnrollment;
      const input = yield* registerInput(
        "replay",
        600n,
        accountFor(11),
        admissionCode
      );
      const first = yield* enrollment.register(input);
      confirmedHandles.add("replay");
      yield* enrollment.reconcile(first.digest);

      const replay = yield* enrollment.register(input);
      assert.strictEqual(replay.status, "confirmed");
      assert.strictEqual(replay.digest, first.digest);
    }).pipe(
      Effect.ensuring(Effect.sync(() => confirmedHandles.delete("replay")))
    )
  );

  it.effect("rejects a signature from the wrong owner and stores nothing", () =>
    Effect.gen(function* () {
      const admissionCode = "OWN-003";
      yield* createAdmission(admissionCode);
      const enrollment = yield* RegistrationEnrollment;
      const intent = yield* makeIntent("wrongowner");
      const decoded = yield* decodeRegisterIntentV1(intent);
      const ownerSignature = yield* Effect.promise(() =>
        wrongAccount.signTypedData(
          makeRegisterIntentTypedDataV1(domain, decoded)
        )
      );
      const error = yield* enrollment
        .register({ admissionCode, intent, ownerSignature })
        .pipe(Effect.flip);

      assert.instanceOf(error, RegistrationSignatureMismatch);
      const digest = yield* hashRegisterIntentV1(domain, decoded);
      assert.isTrue(
        Option.isNone(yield* (yield* RegistrationStore).get(digest))
      );
    })
  );

  it.effect("rejects deadlines outside the one-hour window", () =>
    Effect.gen(function* () {
      const admissionCode = "DDL-004";
      yield* createAdmission(admissionCode);
      const enrollment = yield* RegistrationEnrollment;
      for (const offset of [0n, 3601n]) {
        const error = yield* enrollment
          .register(
            yield* registerInput(
              `deadline${offset}`,
              offset,
              accountFor(12),
              admissionCode
            )
          )
          .pipe(Effect.flip);
        assert.instanceOf(error, RegistrationDeadlineInvalid);
      }
    })
  );

  it.effect(
    "rejects used nonces, taken handles, and taken owners before storage",
    () =>
      Effect.gen(function* () {
        const enrollment = yield* RegistrationEnrollment;
        const store = yield* RegistrationStore;
        for (const [handle, expectedTag, admissionCode] of [
          ["usednonce", "RegistrationNonceUsed", "NON-005"],
          ["takenhandle", "RegistrationHandleUnavailable", "HND-006"],
          ["takenowner", "RegistrationOwnerUnavailable", "OWN-007"],
        ] as const) {
          yield* createAdmission(admissionCode);
          const input = yield* registerInput(
            handle,
            600n,
            accountFor(13),
            admissionCode
          );
          const error = yield* enrollment.register(input).pipe(Effect.flip);
          assert.strictEqual(error._tag, expectedTag);
          const digest = yield* hashRegisterIntentV1(
            domain,
            yield* decodeRegisterIntentV1(input.intent)
          );
          assert.isTrue(Option.isNone(yield* store.get(digest)));
        }
      })
  );

  it.effect(
    "marks chain conflicts failed and releases the admission code",
    () =>
      Effect.gen(function* () {
        const admissionCode = "FLR-008";
        yield* createAdmission(admissionCode);
        const enrollment = yield* RegistrationEnrollment;
        const submitted = yield* enrollment.register(
          yield* registerInput(
            "chainconflict",
            600n,
            accountFor(14),
            admissionCode
          )
        );
        conflictingHandles.add("chainconflict");
        const failed = yield* enrollment.reconcile(submitted.digest);

        assert.strictEqual(failed.status, "failed");
        assert.strictEqual(
          failed.failureCode,
          registrationReconciliationFailureCodes.chainConflict
        );
        const retry = yield* enrollment.register(
          yield* registerInput(
            "afterfailure",
            600n,
            accountFor(14),
            admissionCode
          )
        );
        assert.strictEqual(retry.status, "submitted");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => conflictingHandles.delete("chainconflict"))
        )
      )
  );

  it.effect("does not confirm a used nonce owned by a different qid", () =>
    Effect.gen(function* () {
      const admissionCode = "QID-010";
      yield* createAdmission(admissionCode);
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const submitted = yield* enrollment.register(
        yield* registerInput("qidmismatch", 600n, accountFor(16), admissionCode)
      );
      mismatchedConfirmationHandles.add("qidmismatch");

      const error = yield* enrollment
        .reconcile(submitted.digest)
        .pipe(Effect.flip);
      assert.instanceOf(error, RegistrationProtocolError);
      assert.strictEqual(error.operation, "reconcile-chain");
      assert.strictEqual(
        Option.getOrThrow(yield* store.get(submitted.digest)).status,
        "submitted"
      );

      const { codeHash } =
        yield* decodeRegistrationAdmissionCode(admissionCode);
      const { client: db } = yield* Database;
      const [admission] = yield* db
        .select({
          claimedByDigest: registrationAdmissionCodes.claimedByDigest,
          consumedAt: registrationAdmissionCodes.consumedAt,
        })
        .from(registrationAdmissionCodes)
        .where(eq(registrationAdmissionCodes.codeHash, codeHash));
      assert.strictEqual(admission?.claimedByDigest, submitted.digest);
      assert.isNull(admission?.consumedAt);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => mismatchedConfirmationHandles.delete("qidmismatch"))
      )
    )
  );
});

layer(RetryEnrollmentTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("succeeds on the third broadcast attempt", () =>
    Effect.gen(function* () {
      const admissionCode = "TRY-009";
      yield* createAdmission(admissionCode);
      const enrollment = yield* RegistrationEnrollment;
      const input = yield* registerInput(
        "broadcastretry",
        600n,
        accountFor(15),
        admissionCode
      );

      assert.instanceOf(
        yield* enrollment.register(input).pipe(Effect.flip),
        RegistrationRelayerError
      );
      assert.instanceOf(
        yield* enrollment
          .reconcile(
            yield* hashRegisterIntentV1(
              domain,
              yield* decodeRegisterIntentV1(input.intent)
            )
          )
          .pipe(Effect.flip),
        RegistrationRelayerError
      );
      const result = yield* enrollment.reconcile(
        yield* hashRegisterIntentV1(
          domain,
          yield* decodeRegisterIntentV1(input.intent)
        )
      );
      assert.strictEqual(result.status, "submitted");
      assert.strictEqual(retryBroadcastAttempts, 3);
    })
  );
});

layer(ReadyReplayEnrollmentTestLive, { timeout: "30 seconds" })((it) => {
  it.effect(
    "fails an expired ready replay before calling the relayer again",
    () =>
      Effect.gen(function* () {
        const admissionCode = "RDY-011";
        yield* createAdmission(admissionCode);
        const enrollment = yield* RegistrationEnrollment;
        const store = yield* RegistrationStore;
        const input = yield* registerInput(
          "expiredchain",
          600n,
          accountFor(17),
          admissionCode
        );

        assert.instanceOf(
          yield* enrollment.register(input).pipe(Effect.flip),
          RegistrationRelayerError
        );
        assert.strictEqual(readyReplayPrepareAttempts, 1);
        yield* enrollment.register(input).pipe(Effect.flip);
        assert.strictEqual(readyReplayPrepareAttempts, 1);

        const digest = yield* hashRegisterIntentV1(
          domain,
          yield* decodeRegisterIntentV1(input.intent)
        );
        const failed = Option.getOrThrow(yield* store.get(digest));
        assert.strictEqual(failed.status, "failed");
        assert.strictEqual(
          failed.failureCode,
          registrationReconciliationFailureCodes.deadlineExpired
        );
      })
  );
});
