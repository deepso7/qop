import { assert, layer } from "@effect/vitest";
import {
  Base64Url32,
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  EcdsaSignature,
  hashRegisterIntentV1,
  hashRegistrationDeviceCommitmentV1,
  makeRegisterIntentTypedDataV1,
  recoverRegisterIntentSignerV1,
  PeerId,
} from "@qop/identity";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { hexToBytes, keccak256, stringToBytes, toHex } from "viem";
import type { Address, Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Database } from "../src/db/database.ts";
import { registrationAdmissionCodes } from "../src/db/schema.ts";
import { Entropy } from "../src/entropy.ts";
import { Env } from "../src/env.ts";
import { RegistrationAdmission } from "../src/registration/admission.ts";
import {
  RegistrationEnrollment,
  RegistrationHandleUnavailable,
  RegistrationOwnerUnavailable,
  RegistrationProtocolError,
  registrationReconciliationFailureCodes,
  RegistrationSignatureMismatch,
} from "../src/registration/enrollment.ts";
import type { PreparedRegistration } from "../src/registration/enrollment.ts";
import { RegistrationInputError } from "../src/registration/inputs.ts";
import { RegistrationRelayer } from "../src/registration/relayer.ts";
import { registrationSignerLayer } from "../src/registration/signer.ts";
import {
  HandleLeaseConflict,
  RegistrationIntentConflict,
  RegistrationIntentExpired,
  RegistrationStore,
} from "../src/registration/store.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type {
  RegistryInvalidations,
  RegistryRead,
  RegistryReads,
} from "../src/registry/reader.ts";
import {
  RegistrationStoreTestLive,
  TestDatabaseLive,
} from "./support/registration-database.ts";

const OWNER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const ADMISSION_CODE = "ABC-123";
const REGISTRATION_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
const WRONG_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000003";
const REGISTRY_ADDRESS =
  "0x1111111111111111111111111111111111111111" as Address;
const PEER_ID = "12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X";

const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY);
const registrationAccount = privateKeyToAccount(REGISTRATION_PRIVATE_KEY);
const wrongAccount = privateKeyToAccount(WRONG_PRIVATE_KEY);
const takenOwner = wrongAccount.address.toLowerCase() as Address;

const read = <Value>(value: Value): RegistryRead<Value> => ({
  blockNumber: 100n,
  cachedAt: 0,
  freshness: "fresh",
  value,
});

const idempotencyKey = (label: string): string =>
  Effect.runSync(
    Schema.encodeEffect(Base64Url32)(
      hexToBytes(keccak256(stringToBytes(label)))
    )
  );
const clientCapability = (label: string) => {
  const observeToken = Effect.runSync(
    Schema.decodeUnknownEffect(Base64Url32)(idempotencyKey(`observe-${label}`))
  );
  const peerId = Effect.runSync(Schema.decodeUnknownEffect(PeerId)(PEER_ID));
  return {
    deviceCommitment: Effect.runSync(
      hashRegistrationDeviceCommitmentV1(peerId, observeToken)
    ),
    observeTokenHash: keccak256(observeToken),
  } as const;
};
const SECOND_ADMISSION_CODE = "XYZ-789";

const registryReads: RegistryReads = {
  account: () => Effect.die("account is not used by enrollment tests"),
  deviceRevocation: () =>
    Effect.die("device revocation is not used by enrollment tests"),
  qidByHandle: (handle) => Effect.succeed(read(handle === "taken" ? 7n : null)),
  qidByOwner: (owner) => Effect.succeed(read(owner === takenOwner ? 8n : null)),
};

const registrationProbe = (handle: string, owner: Address, _nonce: Hash) => {
  if (handle === "expiredauth") {
    return Effect.die(
      "expired authorization must fail before a registry probe"
    );
  }
  let handleQid: bigint | null = null;
  if (handle === "taken" || handle === "takenafterprepare") {
    handleQid = 7n;
  } else if (handle === "confirmme" || handle === "confirmduringauth") {
    handleQid = 42n;
  } else if (handle === "conflictme") {
    handleQid = 77n;
  }
  let ownerQid: bigint | null = null;
  if (handle === "confirmme" || handle === "confirmduringauth") {
    ownerQid = 42n;
  } else if (owner === takenOwner || handle === "ownerafterprepare") {
    ownerQid = 8n;
  }
  return Effect.succeed({
    blockNumber: 100n,
    value: {
      blockTimestamp: handle === "expireme" ? 18_446_744_073_709_551_615n : 0n,
      handleQid,
      ownerQid,
      registrationNonceUsed:
        handle === "confirmme" || handle === "confirmduringauth",
    },
  });
};

const registryFreshReads = { ...registryReads, registrationProbe };

const registryInvalidations: RegistryInvalidations = {
  account: () => Effect.void,
  all: Effect.void,
  deviceRevocation: () => Effect.void,
  ownerRotation: () => Effect.void,
  qidByHandle: () => Effect.void,
  qidByOwner: () => Effect.void,
};

const RegistryReaderTestLive = Layer.succeed(
  RegistryReader,
  RegistryReader.of({
    cached: registryReads,
    fresh: registryFreshReads,
    invalidate: registryInvalidations,
  })
);

const EntropyTestLive = Layer.sync(Entropy, () => {
  let next = 1;
  return Entropy.of({
    bytes32: Effect.sync(() => {
      const bytes = new Uint8Array(32);
      bytes[31] = next;
      next += 1;
      return bytes;
    }),
  });
});

const RegistrationRelayerTestLive = Layer.succeed(
  RegistrationRelayer,
  RegistrationRelayer.of({
    broadcast: (prepared) => Effect.succeed(prepared.transactionHash),
    pendingNonce: Effect.succeed(0n),
    prepare: () =>
      Effect.succeed({
        serializedTransaction: "0x02aa",
        transactionHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
  })
);

const EnvTestLive = Layer.succeed(
  Env,
  Env.of({
    CHAIN_ID: 31_337n,
    DATABASE_URL: "postgresql://test",
    GATEWAY_ID: new Uint8Array(32),
    PORT: 3000,
    REGISTRATION_PRIVATE_KEY,
    REGISTRY_ADDRESS,
    REGISTRY_CONFIRMATIONS: 0,
    RELAYER_PRIVATE_KEY: WRONG_PRIVATE_KEY,
    RPC_URL: new URL("http://127.0.0.1:8545"),
  })
);

const RegistrationAdmissionTestLive = Layer.effect(
  RegistrationAdmission,
  Effect.gen(function* () {
    const admission = yield* RegistrationAdmission;
    const { client } = yield* Database;
    return RegistrationAdmission.of({
      ...admission,
      validate: (codeHash) =>
        client
          .update(registrationAdmissionCodes)
          .set({
            claimedAt: null,
            claimedByDigest: null,
            consumedAt: null,
            expiresAt: null,
          })
          .where(eq(registrationAdmissionCodes.codeHash, codeHash))
          .pipe(
            Effect.andThen(admission.create(codeHash)),
            Effect.andThen(admission.validate(codeHash))
          ),
    });
  })
).pipe(
  Layer.provide(RegistrationAdmission.layer),
  Layer.provide(TestDatabaseLive)
);

const RegistrationEnrollmentTestLive = RegistrationEnrollment.layer.pipe(
  Layer.provide(EntropyTestLive),
  Layer.provideMerge(RegistrationStoreTestLive),
  Layer.provide(RegistryReaderTestLive),
  Layer.provide(RegistrationRelayerTestLive),
  Layer.provide(registrationSignerLayer(REGISTRATION_PRIVATE_KEY)),
  Layer.provide(RegistrationAdmissionTestLive),
  Layer.provide(EnvTestLive)
);

const UnexpectedCreateStoreTestLive = Layer.effect(
  RegistrationStore,
  Effect.gen(function* () {
    const store = yield* RegistrationStore;
    return RegistrationStore.of({
      ...store,
      create: (input) =>
        store.create(input).pipe(
          Effect.map((registration) => ({
            ...registration,
            status: "failed" as const,
          }))
        ),
    });
  })
).pipe(Layer.provide(RegistrationStoreTestLive));

const UnexpectedAuthorizeStoreTestLive = Layer.effect(
  RegistrationStore,
  Effect.gen(function* () {
    const store = yield* RegistrationStore;
    return RegistrationStore.of({
      ...store,
      authorize: (digest, authorization) =>
        store.authorize(digest, authorization).pipe(
          Effect.map((registration) => ({
            ...registration,
            status: "failed" as const,
          }))
        ),
    });
  })
).pipe(Layer.provide(RegistrationStoreTestLive));

const enrollmentLayerWithStore = <Error, Requirements>(
  storeLayer: Layer.Layer<RegistrationStore, Error, Requirements>
) =>
  RegistrationEnrollment.layer.pipe(
    Layer.provide(EntropyTestLive),
    Layer.provide(storeLayer),
    Layer.provide(RegistryReaderTestLive),
    Layer.provide(RegistrationRelayerTestLive),
    Layer.provide(registrationSignerLayer(REGISTRATION_PRIVATE_KEY)),
    Layer.provide(RegistrationAdmissionTestLive),
    Layer.provide(EnvTestLive)
  );

const UnexpectedCreateEnrollmentTestLive = enrollmentLayerWithStore(
  UnexpectedCreateStoreTestLive
);
const UnexpectedAuthorizeEnrollmentTestLive = enrollmentLayerWithStore(
  UnexpectedAuthorizeStoreTestLive
);

const domain = Effect.runSync(
  decodeIdentityEip712DomainV1({
    chainId: "31337",
    verifyingContract: REGISTRY_ADDRESS,
  })
);

const signPreparedIntent = Effect.fn("test.signPreparedIntent")(function* (
  encodedIntent: Parameters<typeof decodeRegisterIntentV1>[0],
  account: typeof ownerAccount
) {
  const intent = yield* decodeRegisterIntentV1(encodedIntent);
  return yield* Effect.promise(() =>
    account.signTypedData(makeRegisterIntentTypedDataV1(domain, intent))
  );
});

const persistPreparedAuthorization = Effect.fn(
  "test.persistPreparedAuthorization"
)(function* (
  prepared: PreparedRegistration,
  registrationSigner: typeof ownerAccount = registrationAccount as typeof ownerAccount
) {
  const store = yield* RegistrationStore;
  const ownerSignature = yield* signPreparedIntent(
    prepared.intent,
    ownerAccount
  );
  const registrationSignature = yield* signPreparedIntent(
    prepared.intent,
    registrationSigner
  );
  yield* store.authorize(prepared.digest, {
    ownerSignature,
    registrationSignature,
  });
  return { ownerSignature, registrationSignature };
});

layer(RegistrationEnrollmentTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("prepares the exact owner-signable EIP-712 intent", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const now = yield* DateTime.now;
      const prepared = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "foxtrot",
        idempotencyKey: idempotencyKey("foxtrot"),
        ...clientCapability("foxtrot"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const intent = yield* decodeRegisterIntentV1(prepared.intent);
      const stored = Option.getOrThrow(yield* store.get(prepared.digest));
      const capability = clientCapability("foxtrot");
      const expectedDeadline =
        BigInt(Math.floor(DateTime.toEpochMillis(now) / 1000)) + 600n;

      assert.strictEqual(prepared.status, "pending_owner_signature");
      assert.strictEqual(intent.handle, "foxtrot");
      assert.strictEqual(intent.owner, ownerAccount.address.toLowerCase());
      assert.strictEqual(intent.deadline, expectedDeadline);
      assert.strictEqual(
        toHex(intent.nonce),
        "0x0000000000000000000000000000000000000000000000000000000000000001"
      );
      assert.strictEqual(
        prepared.digest,
        yield* hashRegisterIntentV1(domain, intent)
      );
      assert.strictEqual(stored.registrationNonce, prepared.intent.nonce);
      assert.strictEqual(stored.peerId, PEER_ID);
      assert.strictEqual(stored.observeTokenHash, capability.observeTokenHash);
      assert.strictEqual(
        prepared.intent.deviceCommitment,
        capability.deviceCommitment
      );
      assert.strictEqual(stored.deviceCommitment, capability.deviceCommitment);
    })
  );

  it.effect(
    "replays prepare with the same client-held idempotency secret",
    () =>
      Effect.gen(function* () {
        const enrollment = yield* RegistrationEnrollment;
        const input = {
          admissionCode: ADMISSION_CODE,
          handle: "retryable",
          idempotencyKey: idempotencyKey("retryable"),
          ...clientCapability("retryable"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        } as const;

        const first = yield* enrollment.prepare(input);
        const retry = yield* enrollment.prepare(input);
        assert.deepStrictEqual(retry, first);

        const mismatch = yield* enrollment
          .prepare({ ...input, handle: "different" })
          .pipe(Effect.flip);
        assert.instanceOf(mismatch, RegistrationIntentConflict);

        const admissionMismatch = yield* enrollment
          .prepare({ ...input, admissionCode: SECOND_ADMISSION_CODE })
          .pipe(Effect.flip);
        assert.instanceOf(admissionMismatch, RegistrationIntentConflict);

        const capabilityMismatch = yield* enrollment
          .prepare({ ...input, ...clientCapability("different-capability") })
          .pipe(Effect.flip);
        assert.instanceOf(capabilityMismatch, RegistrationIntentConflict);
      })
  );

  it.effect("classifies malformed admission codes as registration input", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const error = yield* enrollment
        .prepare({
          admissionCode: "not-a-code",
          handle: "badadmission",
          idempotencyKey: idempotencyKey("badadmission"),
          ...clientCapability("badadmission"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, RegistrationInputError);
      assert.strictEqual(error.field, "admission-code");
    })
  );

  it.effect("contends the handle before registrar authorization", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const first = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "leasegate",
        idempotencyKey: idempotencyKey("leasegate-first"),
        ...clientCapability("leasegate-first"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const second = yield* enrollment.prepare({
        admissionCode: SECOND_ADMISSION_CODE,
        handle: "leasegate",
        idempotencyKey: idempotencyKey("leasegate-second"),
        ...clientCapability("leasegate-second"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      yield* enrollment.authorize({
        digest: first.digest,
        ownerSignature: yield* signPreparedIntent(first.intent, ownerAccount),
      });
      const conflict = yield* enrollment
        .authorize({
          digest: second.digest,
          ownerSignature: yield* signPreparedIntent(
            second.intent,
            ownerAccount
          ),
        })
        .pipe(Effect.flip);
      assert.instanceOf(conflict, HandleLeaseConflict);
      assert.isNull(
        Option.getOrThrow(yield* store.get(second.digest)).registrationSignature
      );
      yield* store.markFailed(first.digest, "TEST_CLEANUP");
      yield* store.markFailed(second.digest, "TEST_CLEANUP");
    })
  );

  it.effect("verifies the owner and submits the stored intent", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const prepared = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "golf",
        idempotencyKey: idempotencyKey("golf"),
        ...clientCapability("golf"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const ownerSignature = yield* signPreparedIntent(
        prepared.intent,
        ownerAccount
      );
      const authorized = yield* enrollment.authorize({
        digest: prepared.digest,
        ownerSignature,
      });
      const intent = yield* decodeRegisterIntentV1(authorized.intent);
      const registrationSignature = yield* Schema.decodeUnknownEffect(
        EcdsaSignature
      )(authorized.registrationSignature);
      const canonicalOwnerSignature = yield* Schema.decodeUnknownEffect(
        EcdsaSignature
      )(authorized.ownerSignature);

      assert.strictEqual(authorized.status, "submitted");
      assert.strictEqual(authorized.digest, prepared.digest);
      const submitted = Option.getOrThrow(yield* store.get(prepared.digest));
      assert.strictEqual(submitted.status, "submitted");
      assert.strictEqual(
        submitted.transactionHash,
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      );
      assert.strictEqual(submitted.serializedTransaction, "0x02aa");
      assert.strictEqual(
        yield* recoverRegisterIntentSignerV1(
          domain,
          intent,
          registrationSignature
        ),
        registrationAccount.address.toLowerCase()
      );
      assert.strictEqual(
        yield* recoverRegisterIntentSignerV1(
          domain,
          intent,
          canonicalOwnerSignature
        ),
        ownerAccount.address.toLowerCase()
      );
      const replay = yield* enrollment.authorize({
        digest: prepared.digest,
        ownerSignature,
      });
      assert.strictEqual(replay.ownerSignature, authorized.ownerSignature);
      assert.strictEqual(
        replay.registrationSignature,
        authorized.registrationSignature
      );
    })
  );

  it.effect("heals authorization when the same intent is already onchain", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const prepared = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "confirmduringauth",
        idempotencyKey: idempotencyKey("confirmduringauth"),
        ...clientCapability("confirmduringauth"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const authorized = yield* enrollment.authorize({
        digest: prepared.digest,
        ownerSignature: yield* signPreparedIntent(
          prepared.intent,
          ownerAccount
        ),
      });

      assert.strictEqual(authorized.status, "confirmed");
      const stored = Option.getOrThrow(yield* store.get(prepared.digest));
      assert.strictEqual(stored.status, "confirmed");
      assert.strictEqual(stored.qid, 42n);
      assert.isNull(stored.failureCode);
    })
  );

  it.effect(
    "rejects the wrong owner without consuming the pending intent",
    () =>
      Effect.gen(function* () {
        const enrollment = yield* RegistrationEnrollment;
        const prepared = yield* enrollment.prepare({
          admissionCode: ADMISSION_CODE,
          handle: "hotel",
          idempotencyKey: idempotencyKey("hotel"),
          ...clientCapability("hotel"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        const wrongSignature = yield* signPreparedIntent(
          prepared.intent,
          wrongAccount as typeof ownerAccount
        );
        const mismatch = yield* enrollment
          .authorize({
            digest: prepared.digest,
            ownerSignature: wrongSignature,
          })
          .pipe(Effect.flip);

        assert.instanceOf(mismatch, RegistrationSignatureMismatch);
        assert.strictEqual(mismatch.kind, "owner");

        const ownerSignature = yield* signPreparedIntent(
          prepared.intent,
          ownerAccount
        );
        assert.strictEqual(
          (yield* enrollment.authorize({
            digest: prepared.digest,
            ownerSignature,
          })).status,
          "submitted"
        );
      })
  );

  it.effect("fails before signing when the handle or owner is onchain", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const handleError = yield* enrollment
        .prepare({
          admissionCode: ADMISSION_CODE,
          handle: "taken",
          idempotencyKey: idempotencyKey("taken"),
          ...clientCapability("taken"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        })
        .pipe(Effect.flip);
      assert.instanceOf(handleError, RegistrationHandleUnavailable);
      assert.strictEqual(handleError.qid, 7n);

      const ownerError = yield* enrollment
        .prepare({
          admissionCode: ADMISSION_CODE,
          handle: "india",
          idempotencyKey: idempotencyKey("india"),
          ...clientCapability("india"),
          owner: takenOwner,
          peerId: PEER_ID,
        })
        .pipe(Effect.flip);
      assert.instanceOf(ownerError, RegistrationOwnerUnavailable);
      assert.strictEqual(ownerError.qid, 8n);
    })
  );

  it.effect(
    "rechecks handle and owner availability before registrar signing",
    () =>
      Effect.gen(function* () {
        const enrollment = yield* RegistrationEnrollment;
        const handlePrepared = yield* enrollment.prepare({
          admissionCode: ADMISSION_CODE,
          handle: "takenafterprepare",
          idempotencyKey: idempotencyKey("takenafterprepare"),
          ...clientCapability("takenafterprepare"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        const handleError = yield* enrollment
          .authorize({
            digest: handlePrepared.digest,
            ownerSignature: yield* signPreparedIntent(
              handlePrepared.intent,
              ownerAccount
            ),
          })
          .pipe(Effect.flip);
        assert.instanceOf(handleError, RegistrationHandleUnavailable);
        assert.strictEqual(handleError.qid, 7n);

        const ownerPrepared = yield* enrollment.prepare({
          admissionCode: ADMISSION_CODE,
          handle: "ownerafterprepare",
          idempotencyKey: idempotencyKey("ownerafterprepare"),
          ...clientCapability("ownerafterprepare"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        const ownerError = yield* enrollment
          .authorize({
            digest: ownerPrepared.digest,
            ownerSignature: yield* signPreparedIntent(
              ownerPrepared.intent,
              ownerAccount
            ),
          })
          .pipe(Effect.flip);
        assert.instanceOf(ownerError, RegistrationOwnerUnavailable);
        assert.strictEqual(ownerError.qid, 8n);
      })
  );

  it.effect("rejects expired pending intents before the registry probe", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const prepared = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "expiredauth",
        idempotencyKey: idempotencyKey("expiredauth"),
        ...clientCapability("expiredauth"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const ownerSignature = yield* signPreparedIntent(
        prepared.intent,
        ownerAccount
      );
      yield* TestClock.adjust("601 seconds");

      const error = yield* enrollment
        .authorize({ digest: prepared.digest, ownerSignature })
        .pipe(Effect.flip);
      assert.instanceOf(error, RegistrationIntentExpired);
      const stored = Option.getOrThrow(yield* store.get(prepared.digest));
      assert.strictEqual(stored.status, "pending_owner_signature");
      assert.isNull(stored.registrationSignature);
    })
  );

  it.effect("sweeps abandoned pending intents during the next prepare", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const store = yield* RegistrationStore;
      const abandoned = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "abandoned",
        idempotencyKey: idempotencyKey("abandoned"),
        ...clientCapability("abandoned"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });

      yield* TestClock.adjust("601 seconds");
      yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "aftercleanup",
        idempotencyKey: idempotencyKey("aftercleanup"),
        ...clientCapability("aftercleanup"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });

      const stored = Option.getOrThrow(yield* store.get(abandoned.digest));
      assert.strictEqual(stored.status, "expired");
    })
  );

  it.effect("rejects a persisted signature from the wrong registrar", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const prepared = yield* enrollment.prepare({
        admissionCode: ADMISSION_CODE,
        handle: "juliet",
        idempotencyKey: idempotencyKey("juliet"),
        ...clientCapability("juliet"),
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const { ownerSignature } = yield* persistPreparedAuthorization(
        prepared,
        wrongAccount as typeof ownerAccount
      );

      const mismatch = yield* enrollment
        .authorize({ digest: prepared.digest, ownerSignature })
        .pipe(Effect.flip);
      assert.instanceOf(mismatch, RegistrationSignatureMismatch);
      assert.strictEqual(mismatch.kind, "registration");
      assert.strictEqual(
        mismatch.expected,
        registrationAccount.address.toLowerCase()
      );
      assert.strictEqual(
        mismatch.recovered,
        wrongAccount.address.toLowerCase()
      );
    })
  );

  it.effect("rejects the zero owner at the prepare boundary", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const error = yield* enrollment
        .prepare({
          admissionCode: ADMISSION_CODE,
          handle: "kilo",
          idempotencyKey: idempotencyKey("kilo"),
          ...clientCapability("kilo"),
          owner: `0x${"00".repeat(20)}`,
          peerId: PEER_ID,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, RegistrationInputError);
      assert.strictEqual(error.field, "owner");
    })
  );

  it.effect(
    "reconciles confirmed, conflicting, and proven-expired intents",
    () =>
      Effect.gen(function* () {
        const enrollment = yield* RegistrationEnrollment;
        const confirmedPrepared = yield* enrollment.prepare({
          admissionCode: ADMISSION_CODE,
          handle: "confirmme",
          idempotencyKey: idempotencyKey("confirmme"),
          ...clientCapability("confirmme"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        yield* persistPreparedAuthorization(confirmedPrepared);
        const confirmed = yield* enrollment.reconcile(confirmedPrepared.digest);
        assert.strictEqual(confirmed.status, "confirmed");
        assert.strictEqual(confirmed.qid, 42n);

        const conflictingPrepared = yield* enrollment.prepare({
          admissionCode: ADMISSION_CODE,
          handle: "conflictme",
          idempotencyKey: idempotencyKey("conflictme"),
          ...clientCapability("conflictme"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        yield* persistPreparedAuthorization(conflictingPrepared);
        const conflicting = yield* enrollment.reconcile(
          conflictingPrepared.digest
        );
        assert.strictEqual(conflicting.status, "failed");
        assert.strictEqual(
          conflicting.failureCode,
          registrationReconciliationFailureCodes.chainConflict
        );

        const expiredPrepared = yield* enrollment.prepare({
          admissionCode: ADMISSION_CODE,
          handle: "expireme",
          idempotencyKey: idempotencyKey("expireme"),
          ...clientCapability("expireme"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        yield* persistPreparedAuthorization(expiredPrepared);
        const expired = yield* enrollment.reconcile(expiredPrepared.digest);
        assert.strictEqual(expired.status, "failed");
        assert.strictEqual(
          expired.failureCode,
          registrationReconciliationFailureCodes.deadlineExpired
        );
      })
  );
});

layer(UnexpectedCreateEnrollmentTestLive, { timeout: "30 seconds" })((it) => {
  it.effect("rejects an unexpected status returned from store create", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const error = yield* enrollment
        .prepare({
          admissionCode: ADMISSION_CODE,
          handle: "badcreate",
          idempotencyKey: idempotencyKey("badcreate"),
          ...clientCapability("badcreate"),
          owner: ownerAccount.address,
          peerId: PEER_ID,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, RegistrationProtocolError);
      assert.strictEqual(error.operation, "verify-state");
      assert.strictEqual(
        error.cause,
        "Unexpected prepared registration status: failed"
      );
    })
  );
});

layer(UnexpectedAuthorizeEnrollmentTestLive, { timeout: "30 seconds" })(
  (it) => {
    it.effect(
      "rejects an unexpected status returned from store authorize",
      () =>
        Effect.gen(function* () {
          const enrollment = yield* RegistrationEnrollment;
          const prepared = yield* enrollment.prepare({
            admissionCode: ADMISSION_CODE,
            handle: "badauthorize",
            idempotencyKey: idempotencyKey("badauthorize"),
            ...clientCapability("badauthorize"),
            owner: ownerAccount.address,
            peerId: PEER_ID,
          });
          const ownerSignature = yield* signPreparedIntent(
            prepared.intent,
            ownerAccount
          );
          const error = yield* enrollment
            .authorize({ digest: prepared.digest, ownerSignature })
            .pipe(Effect.flip);

          assert.instanceOf(error, RegistrationProtocolError);
          assert.strictEqual(error.operation, "verify-state");
          assert.strictEqual(
            error.cause,
            "Unexpected authorized registration status: failed"
          );
        })
    );
  }
);
