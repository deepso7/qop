import { Handle } from "@qop/identity";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

export const CLI_VERSION = "0.0.0";

export interface QopCommandHandlers {
  readonly runLink: (handle: string) => Effect.Effect<void, unknown>;
  readonly runStart: (options: {
    readonly message?: string | undefined;
    readonly to?: string | undefined;
  }) => Effect.Effect<void, unknown>;
  readonly runStatus: () => Effect.Effect<void, unknown>;
}

/** Effect CLI command tree for `qop link|status|start`. */
export const createQopCommand = ({
  runLink,
  runStart,
  runStatus,
}: QopCommandHandlers) => {
  const link = Command.make(
    "link",
    {
      account: Flag.string("account").pipe(
        Flag.withDescription("Account handle to link"),
        Flag.withSchema(Handle)
      ),
    },
    Effect.fn("qop.link")(function* ({ account }) {
      return yield* runLink(account);
    })
  ).pipe(
    Command.withDescription("Link this CLI as a second device for an account")
  );

  const status = Command.make(
    "status",
    {},
    Effect.fn("qop.status")(function* () {
      return yield* runStatus();
    })
  ).pipe(Command.withDescription("Show this CLI identity and membership"));

  const start = Command.make(
    "start",
    {
      message: Flag.string("message").pipe(
        Flag.withDescription("Diagnostic message text"),
        Flag.optional
      ),
      to: Flag.string("to").pipe(
        Flag.withDescription("Handle to send a diagnostic message"),
        Flag.optional
      ),
    },
    Effect.fn("qop.start")(function* ({ message, to }) {
      return yield* runStart({
        message: Option.getOrUndefined(message),
        to: Option.getOrUndefined(to),
      });
    })
  ).pipe(
    Command.withDescription(
      "Start diagnostic chat after linking (macOS and Linux)"
    )
  );

  return Command.make("qop").pipe(
    Command.withDescription(
      "Link a CLI device to an existing account, then start diagnostic chat."
    ),
    Command.withSubcommands([link, status, start])
  );
};

export const runQopCli = (command: ReturnType<typeof createQopCommand>) =>
  Command.run(command, { version: CLI_VERSION });
