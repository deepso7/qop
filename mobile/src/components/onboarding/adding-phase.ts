import type { LocalEnrollment } from "@/lib/local-enrollment";

// What restore's "adding this phone" step shows:
// - waiting: submitting, or polling a submitted record
// - retrying: a failed record is being submitted again
// - stalled: a restored identity with no record to poll, e.g. offline or after
//   a restart between restoring and submitting
// - failed: the record failed; `final` ones can't be retried, since starting
//   over makes a fresh device key (and takes the current recovery key)
export type AddingPhase =
  | { kind: "waiting"; message?: string }
  | { kind: "retrying"; message: string }
  | { kind: "stalled"; message: string }
  | { kind: "failed"; final: boolean; message: string };

const getFailureMessage = (failureCode: string | null, handle: string) => {
  switch (failureCode) {
    case "MAX_DEVICES": {
      return `@${handle} has no room for another device. Remove one from another device, then try again.`;
    }

    case "OWNER_CHANGED": {
      return `@${handle}’s recovery key changed. Use the new one.`;
    }

    case "REMOVED": {
      return `This phone was removed from @${handle}. Start over to add it again.`;
    }

    case "EXPIRED": {
      return "The request expired before it went through. Try again.";
    }

    case "REVERTED":
    case "REJECTED": {
      return "The registry turned this phone down. Try again.";
    }

    default: {
      return `Adding this phone failed (${failureCode ?? "unknown"}). Try again.`;
    }
  }
};

// Derives the phase from the enrollment record, whether an action is in
// flight, and the latest action's error. That error outranks a failed
// record's reason: a retry that fails before writing a new record (e.g.
// offline) leaves the old record in place.
export const getAddingPhase = ({
  busy,
  enrollment,
  message,
}: {
  busy: boolean;
  enrollment: LocalEnrollment | null;
  message: string | undefined;
}): AddingPhase => {
  if (enrollment?.status === "failed") {
    const shown =
      message ?? getFailureMessage(enrollment.failureCode, enrollment.handle);

    if (busy) {
      return { kind: "retrying", message: shown };
    }

    return {
      final:
        enrollment.failureCode === "OWNER_CHANGED" ||
        enrollment.failureCode === "REMOVED",
      kind: "failed",
      message: shown,
    };
  }

  if (enrollment === null && !busy) {
    return {
      kind: "stalled",
      message: message ?? "This phone isn’t added yet. Try again.",
    };
  }

  return { kind: "waiting", message };
};
