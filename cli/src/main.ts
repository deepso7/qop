#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { pairingFingerprint } from "@qop/protocol";
import { Cause, Effect, Exit } from "effect";

import { runStart } from "./chat.ts";
import { createQopCommand, runQopCli } from "./cli.ts";
import { configuredRegistry } from "./config.ts";
import {
  CliIdentityStoreError,
  createCliIdentityStore,
  defaultDataDirectory,
} from "./identity-store.ts";
import { runLink } from "./pairing-link.ts";

const store = createCliIdentityStore(
  process.env.QOP_DATA_DIR ?? defaultDataDirectory()
);

const withLock = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = yield* store.acquireLock();
    return yield* program.pipe(
      Effect.ensuring(lock.release.pipe(Effect.ignore))
    );
  });

const runStatus = Effect.fn("qop.status")(function* () {
  const identity = yield* store.loadIdentity();
  if (!identity) {
    console.log("No CLI identity. Run qop link --account <handle>.");
    return;
  }
  const { reader } = yield* configuredRegistry();
  const membership = yield* reader.lookupDeviceKey(identity.deviceKey);
  console.log(`account  @${identity.handle}`);
  console.log(`qid      ${identity.qid}`);
  console.log(`peer     ${identity.peerId}`);
  console.log(
    `device   ${pairingFingerprint(identity.deviceKey)} (${identity.deviceKey})`
  );
  console.log(
    `state    ${membership?.qid.toString() === identity.qid ? "linked" : "not linked"}`
  );
});

const command = createQopCommand({
  runLink: (handle) => withLock(runLink(store, handle)),
  runStart: (options) => withLock(runStart(store, options)),
  runStatus: () => withLock(runStatus()),
});

const operatorMessage = (error: CliIdentityStoreError) => {
  if (error.operation === "permissions") {
    return "CLI identity files must be mode 600 (directory 700). Fix permissions or move the data directory aside — do not overwrite device.key.";
  }
  if (error.operation === "decode") {
    return "CLI identity is unreadable. Move the data directory aside to recover — do not overwrite device.key.";
  }
  if (error.operation === "conflict") {
    return "Could not lock the CLI data directory or reuse this identity. If no other qop process is running, delete the lock file. A secret without identity.json must not be overwritten.";
  }
};

const exit = await Effect.runPromiseExit(
  runQopCli(command).pipe(Effect.provide(NodeServices.layer))
);
if (Exit.isFailure(exit)) {
  const squashed = Cause.squash(exit.cause);
  console.error(
    squashed instanceof CliIdentityStoreError
      ? (operatorMessage(squashed) ?? Cause.pretty(exit.cause))
      : Cause.pretty(exit.cause)
  );
  process.exitCode = 1;
}
