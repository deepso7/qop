import { Base64Url32, ChainId, EthereumAddress } from "@qop/identity";
import {
  Context,
  Effect,
  Layer,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

const Confirmations = Schema.NumberFromString.check(
  Schema.isInt({ expected: "an integer confirmation count" }),
  Schema.isBetween({
    maximum: 100_000,
    minimum: 0,
  })
);

const RegistryAddressInput = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/iu, {
    expected: "a 20-byte 0x-prefixed Ethereum address",
  })
);

const RegistryAddress = RegistryAddressInput.pipe(
  Schema.decodeTo(EthereumAddress, SchemaTransformation.toLowerCase())
);

const PrivateKey = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{64}$/iu, {
    expected: "a 32-byte 0x-prefixed private key",
  })
);

const Port = Schema.NumberFromString.check(
  Schema.isInt({ expected: "an integer port" }),
  Schema.isBetween({ maximum: 65_535, minimum: 1 })
);

const EnvSchema = Schema.Struct({
  CHAIN_ID: ChainId,
  DATABASE_URL: Schema.Trim.check(Schema.isNonEmpty()),
  GATEWAY_ID: Base64Url32,
  PORT: Port,
  REGISTRATION_PRIVATE_KEY: PrivateKey,
  REGISTRY_ADDRESS: RegistryAddress,
  REGISTRY_CONFIRMATIONS: Confirmations,
  RELAYER_PRIVATE_KEY: PrivateKey,
  RPC_URL: Schema.URLFromString,
});

type EnvType = Schema.Schema.Type<typeof EnvSchema>;

export const decodeEnv = (input: unknown) =>
  Schema.decodeUnknownEffect(EnvSchema)(input, { errors: "all" });

export class Env extends Context.Service<Env, EnvType>()("@qop/api/Env", {
  make: decodeEnv(process.env).pipe(
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
