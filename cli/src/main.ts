#!/usr/bin/env node

import { Handle } from "@qop/identity";
import { pairingFingerprint } from "@qop/protocol";
import { Cause, Effect, Exit, Schema } from "effect";

import { runStart } from "./chat.ts";
import { configuredRegistry } from "./config.ts";
import {
  createCliIdentityStore,
  defaultDataDirectory,
} from "./identity-store.ts";
import { runLink } from "./pairing-link.ts";

const usage = `qop <link|status|start> [--account HANDLE] [--to HANDLE] [--message TEXT]

Link a CLI device to an existing account, then start diagnostic chat.`;

const flagValue = (argv: string[], name: string) => {
  const index = argv.indexOf(name);
  if (index === -1) {
    return;
  }
  return argv[index + 1];
};

const argv = process.argv.slice(2);
const [command] = argv;
const account = flagValue(argv, "--account");
const to = flagValue(argv, "--to");
const message = flagValue(argv, "--message");
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

const program = Effect.fn("qop")(function* () {
  if (command === "status") {
    return yield* withLock(runStatus());
  }
  if (command === "link") {
    if (!account) {
      console.error(usage);
      return;
    }
    const handle = yield* Schema.decodeUnknownEffect(Handle)(account);
    return yield* withLock(runLink(store, handle));
  }
  if (command === "start") {
    return yield* withLock(runStart(store, { message, to }));
  }
  console.error(usage);
});

const exit = await Effect.runPromiseExit(program());
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause));
  process.exitCode = 1;
}
