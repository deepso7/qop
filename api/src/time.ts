import { DateTime } from "effect";

export const epochSeconds = (value: DateTime.DateTime): bigint =>
  BigInt(Math.floor(DateTime.toEpochMillis(value) / 1000));
