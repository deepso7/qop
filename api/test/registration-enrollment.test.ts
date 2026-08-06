import { assert, layer } from "@effect/vitest";
import {
  Base64Url32,
  decodeIdentityEip712DomainV1,
  decodeRegisterIntentV1,
  EcdsaSignature,
  hashRegisterIntentV1,
  makeRegisterIntentTypedDataV1,
  recoverRegisterIntentSignerV1,
} from "@qop/identity";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { keccak256, toHex } from "viem";
import type { Address, Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Env } from "../src/env.ts";
import {
  RegistrationEnrollment,
  RegistrationHandleUnavailable,
  RegistrationOwnerUnavailable,
  registrationReconciliationFailureCodes,
  RegistrationSignatureMismatch,
} from "../src/registration/enrollment.ts";
import type { PreparedRegistration } from "../src/registration/enrollment.ts";
import { RegistrationEntropy } from "../src/registration/entropy.ts";
import { RegistrationInputError } from "../src/registration/inputs.ts";
import { registrationSignerLayer } from "../src/registration/signer.ts";
import {
  RegistrationIntentExpired,
  RegistrationStore,
} from "../src/registration/store.ts";
import { RegistryReader } from "../src/registry/reader.ts";
import type {
  RegistryInvalidations,
  RegistryRead,
  RegistryReads,
} from "../src/registry/reader.ts";
import { RegistrationStoreTestLive } from "./support/registration-database.ts";

const OWNER_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
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
  } else if (handle === "confirmme") {
    handleQid = 42n;
  } else if (handle === "conflictme") {
    handleQid = 77n;
  }
  const ownerQid =
    owner === takenOwner || handle === "ownerafterprepare" ? 8n : null;
  return Effect.succeed({
    blockNumber: 100n,
    value: {
      blockTimestamp: handle === "expireme" ? 18_446_744_073_709_551_615n : 0n,
      handleQid,
      ownerQid,
      registrationNonceUsed: handle === "confirmme",
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

const RegistrationEntropyTestLive = Layer.sync(RegistrationEntropy, () => {
  let next = 1;
  return RegistrationEntropy.of({
    bytes32: Effect.sync(() => {
      const bytes = new Uint8Array(32);
      bytes[31] = next;
      next += 1;
      return bytes;
    }),
  });
});

const EnvTestLive = Layer.succeed(
  Env,
  Env.of({
    CHAIN_ID: 31_337n,
    DATABASE_URL: "postgresql://test",
    REGISTRY_ADDRESS,
    REGISTRY_CONFIRMATIONS: 0,
    RPC_URL: new URL("http://127.0.0.1:8545"),
  })
);

const RegistrationEnrollmentTestLive = RegistrationEnrollment.layer.pipe(
  Layer.provide(RegistrationEntropyTestLive),
  Layer.provideMerge(RegistrationStoreTestLive),
  Layer.provide(RegistryReaderTestLive),
  Layer.provide(registrationSignerLayer(REGISTRATION_PRIVATE_KEY)),
  Layer.provide(EnvTestLive)
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
        handle: "foxtrot",
        owner: ownerAccount.address,
        peerId: PEER_ID,
      });
      const intent = yield* decodeRegisterIntentV1(prepared.intent);
      const token = yield* Schema.decodeUnknownEffect(Base64Url32)(
        prepared.observeToken
      );
      const stored = Option.getOrThrow(yield* store.get(prepared.digest));
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
      assert.strictEqual(
        yield* Schema.encodeEffect(Base64Url32)(token),
        prepared.observeToken
      );
      assert.strictEqual(stored.registrationNonce, prepared.intent.nonce);
      assert.strictEqual(stored.peerId, PEER_ID);
      assert.strictEqual(stored.observeTokenHash, keccak256(toHex(token)));
    })
  );

  it.effect("verifies the owner and advances the stored intent to ready", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const prepared = yield* enrollment.prepare({
        handle: "golf",
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

      assert.strictEqual(authorized.status, "ready");
      assert.strictEqual(authorized.digest, prepared.digest);
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

  it.effect(
    "rejects the wrong owner without consuming the pending intent",
    () =>
      Effect.gen(function* () {
        const enrollment = yield* RegistrationEnrollment;
        const prepared = yield* enrollment.prepare({
          handle: "hotel",
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
          "ready"
        );
      })
  );

  it.effect("fails before signing when the handle or owner is onchain", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const handleError = yield* enrollment
        .prepare({
          handle: "taken",
          owner: ownerAccount.address,
          peerId: PEER_ID,
        })
        .pipe(Effect.flip);
      assert.instanceOf(handleError, RegistrationHandleUnavailable);
      assert.strictEqual(handleError.qid, 7n);

      const ownerError = yield* enrollment
        .prepare({
          handle: "india",
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
          handle: "takenafterprepare",
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
          handle: "ownerafterprepare",
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
        handle: "expiredauth",
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

  it.effect("rejects a persisted signature from the wrong registrar", () =>
    Effect.gen(function* () {
      const enrollment = yield* RegistrationEnrollment;
      const prepared = yield* enrollment.prepare({
        handle: "juliet",
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
          handle: "kilo",
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
          handle: "confirmme",
          owner: ownerAccount.address,
          peerId: PEER_ID,
        });
        yield* persistPreparedAuthorization(confirmedPrepared);
        const confirmed = yield* enrollment.reconcile(confirmedPrepared.digest);
        assert.strictEqual(confirmed.status, "confirmed");
        assert.strictEqual(confirmed.qid, 42n);

        const conflictingPrepared = yield* enrollment.prepare({
          handle: "conflictme",
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
          handle: "expireme",
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
