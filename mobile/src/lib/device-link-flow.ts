import { asHex } from "@qop/protocol";
import type { PairingOfferV1 } from "@qop/protocol";
import { Effect } from "effect";

import {
  DeviceActionApprovalError,
  signDeviceActionRecord,
} from "./device-action-approval";
import {
  markAcknowledged,
  persistApproval,
  pollEnrollment,
  resumeInFlightAdd,
  submitAcknowledged,
} from "./local-device-action";
import { sendPairingApproval } from "./pairing-client-core";
import type { PairingTransport } from "./pairing-client-core";

/** Persist → same-digest send → ack → submit → poll op status then roster. */
export const completeDeviceLink = Effect.fn("completeDeviceLink")(function* ({
  deviceKey,
  expectedOwner,
  offer,
  peerId,
  qid,
  transport,
}: {
  readonly deviceKey: string;
  readonly expectedOwner: string;
  readonly offer: PairingOfferV1;
  readonly peerId: string;
  readonly qid: bigint;
  readonly transport: PairingTransport;
}) {
  const resumed = yield* resumeInFlightAdd(deviceKey);
  const record =
    resumed ??
    (yield* signDeviceActionRecord({
      deviceKey,
      expectedOwner,
      operation: "add",
      qid,
    })).record;
  if (asHex(record.intent.deviceKey) !== asHex(deviceKey)) {
    return yield* new DeviceActionApprovalError({ operation: "sign" });
  }
  yield* persistApproval(record);
  yield* sendPairingApproval(transport, offer, peerId, record);
  yield* markAcknowledged(record.digest);
  yield* submitAcknowledged();
  return yield* pollEnrollment();
});

export const completeDeviceRemove = Effect.fn("completeDeviceRemove")(
  function* ({
    deviceKey,
    expectedOwner,
    qid,
  }: {
    readonly deviceKey: string;
    readonly expectedOwner: string;
    readonly qid: bigint;
  }) {
    const signed = yield* signDeviceActionRecord({
      deviceKey,
      expectedOwner,
      operation: "remove",
      qid,
    });
    yield* persistApproval(signed.record, { acknowledged: true });
    yield* submitAcknowledged();
    return yield* pollEnrollment();
  }
);
