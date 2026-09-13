import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CLI_VERSION, createQopCommand } from "../src/cli.ts";

const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
    })
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused"))
  )
);

describe("qop Effect CLI", () => {
  it.effect("parses link --account and start --to/--message", () =>
    Effect.gen(function* () {
      const seen: {
        handle?: string;
        message?: string | undefined;
        start?: boolean;
        status?: boolean;
        to?: string | undefined;
      } = {};
      const command = createQopCommand({
        runLink: (handle) =>
          Effect.sync(() => {
            seen.handle = handle;
          }),
        runStart: (options) =>
          Effect.sync(() => {
            seen.start = true;
            seen.message = options.message;
            seen.to = options.to;
          }),
        runStatus: () =>
          Effect.sync(() => {
            seen.status = true;
          }),
      });
      const run = Command.runWith(command, { version: CLI_VERSION });

      yield* run(["link", "--account", "alice"]).pipe(
        Effect.provide(CliTestLayer)
      );
      expect(seen.handle).toBe("alice");

      yield* run(["status"]).pipe(Effect.provide(CliTestLayer));
      expect(seen.status).toBe(true);

      yield* run(["start", "--to", "bob", "--message", "hi"]).pipe(
        Effect.provide(CliTestLayer)
      );
      expect(seen.start).toBe(true);
      expect(seen.to).toBe("bob");
      expect(seen.message).toBe("hi");
    })
  );

  it.effect("rejects an invalid account handle", () =>
    Effect.gen(function* () {
      const command = createQopCommand({
        runLink: () => Effect.void,
        runStart: () => Effect.void,
        runStatus: () => Effect.void,
      });
      const result = yield* Command.runWith(command, { version: CLI_VERSION })([
        "link",
        "--account",
        "Alice",
      ]).pipe(Effect.provide(CliTestLayer), Effect.result);
      expect(result._tag).toBe("Failure");
    })
  );
});
