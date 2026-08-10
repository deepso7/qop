import { Effect } from "effect";
import { concatBytes, keccak256, stringToBytes } from "viem";
import type { Hash } from "viem";

import type { Base64Url32, PeerId } from "./wire-codecs.ts";

const REGISTRATION_DEVICE_COMMITMENT_DOMAIN = stringToBytes(
  "qop/registration-device-commitment/v1"
);

export const hashRegistrationDeviceCommitmentV1 = Effect.fn(
  "@qop/identity/hashRegistrationDeviceCommitmentV1"
)((peerId: typeof PeerId.Type, observeToken: typeof Base64Url32.Type) =>
  Effect.sync(
    () =>
      keccak256(
        concatBytes([
          REGISTRATION_DEVICE_COMMITMENT_DOMAIN,
          peerId,
          observeToken,
        ])
      ) as Hash
  )
);
