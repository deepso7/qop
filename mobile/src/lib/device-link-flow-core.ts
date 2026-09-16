import { asHex } from "@qop/protocol";
import type {
  DeviceActionApprovalV1Encoded,
  PairingOfferV1,
} from "@qop/protocol";
import { Effect } from "effect";

import { DeviceActionApprovalError } from "./device-action-approval-error";
import type { createLocalDeviceAction } from "./local-device-action-core";
import type {
  sendPairingApproval as SendPairingApproval,
  PairingTransport,
} from "./pairing-client-core";

type LocalDeviceActionApi = ReturnType<typeof createLocalDeviceAction>;

export interface DeviceLinkDependencies {
  readonly markAcknowledged: LocalDeviceActionApi["markAcknowledged"];
  readonly persistApproval: LocalDeviceActionApi["persistApproval"];
  readonly pollEnrollment: LocalDeviceActionApi["pollEnrollment"];
  readonly reconcileMembership: LocalDeviceActionApi["reconcileMembership"];
  readonly resumeInFlight: LocalDeviceActionApi["resumeInFlight"];
  readonly sendPairingApproval: typeof SendPairingApproval;
  readonly signDeviceActionRecord: (input: {
    readonly deviceKey: string;
    readonly expectedOwner: string;
    readonly operation: "add" | "remove";
    readonly qid: bigint;
  }) => Effect.Effect<
    { readonly record: DeviceActionApprovalV1Encoded },
    unknown
  >;
  readonly submitAcknowledged: LocalDeviceActionApi["submitAcknowledged"];
}

export const createDeviceLinkFlow = ({
  markAcknowledged: markAck,
  persistApproval: persist,
  pollEnrollment: poll,
  reconcileMembership: reconcile,
  resumeInFlight: resume,
  sendPairingApproval: sendApproval,
  signDeviceActionRecord: signRecord,
  submitAcknowledged: submit,
}: DeviceLinkDependencies) => {
  /** Persist → same-digest send → ack → submit → poll op status then roster. */
  const completeDeviceLink = Effect.fn("completeDeviceLink")(function* ({
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
    const current = yield* reconcile();
    if (
      current?.record.operation === "add" &&
      asHex(current.record.intent.deviceKey) === asHex(deviceKey) &&
      current.membership === "linked"
    ) {
      return yield* poll();
    }
    const resumed = yield* resume("add", deviceKey);
    const record =
      resumed ??
      (yield* signRecord({
        deviceKey,
        expectedOwner,
        operation: "add",
        qid,
      })).record;
    if (asHex(record.intent.deviceKey) !== asHex(deviceKey)) {
      return yield* new DeviceActionApprovalError({ operation: "sign" });
    }
    yield* persist(record);
    yield* sendApproval(transport, offer, peerId, record);
    yield* markAck(record.digest);
    yield* submit();
    return yield* poll();
  });

  const completeDeviceRemove = Effect.fn("completeDeviceRemove")(function* ({
    deviceKey,
    expectedOwner,
    qid,
  }: {
    readonly deviceKey: string;
    readonly expectedOwner: string;
    readonly qid: bigint;
  }) {
    const resumed = yield* resume("remove", deviceKey);
    const record =
      resumed ??
      (yield* signRecord({
        deviceKey,
        expectedOwner,
        operation: "remove",
        qid,
      })).record;
    if (asHex(record.intent.deviceKey) !== asHex(deviceKey)) {
      return yield* new DeviceActionApprovalError({ operation: "sign" });
    }
    yield* persist(record, { acknowledged: true });
    yield* submit();
    return yield* poll();
  });

  return { completeDeviceLink, completeDeviceRemove };
};
