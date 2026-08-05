import { Context, Effect, Layer, Schema, SchemaIssue } from "effect";

const EnvSchema = Schema.Struct({
  DATABASE_URL: Schema.NonEmptyString,
});

type EnvType = Schema.Schema.Type<typeof EnvSchema>;

export class Env extends Context.Service<Env, EnvType>()("@qop/api/Env", {
  make: Schema.decodeUnknownEffect(EnvSchema)(process.env, {
    errors: "all",
  }).pipe(
    Effect.mapError((error) =>
      SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
    ),
    Effect.tapError((failure) =>
      Effect.sync(() => {
        console.error("Invalid environment variables:");
        console.dir(failure.issues, { depth: null });
      })
    )
  ),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
