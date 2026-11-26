import { Effect } from "effect";
import { hexToBytes } from "viem";
import type { Hex } from "viem";

import type { ChatCipher } from "./chat-envelope.ts";
import type { ChatFrame } from "./chat-wire.ts";
import { exchangeMailbox } from "./mailbox-io.ts";
import type { MailboxStream } from "./mailbox-io.ts";
import {
  decodeBase64,
  encodeBase64,
  MAILBOX_MAX_DEPOSIT_ITEMS,
  MAILBOX_MAX_FETCH_LIMIT,
  MailboxCodecError,
} from "./mailbox.ts";
import type {
  MailboxMessageV1,
  MailboxRequestV1,
  MailboxResponseV1,
} from "./mailbox.ts";

export interface MailboxPeer {
  readonly addr: string;
  readonly peerId: string;
}

const PEER_ID_SEGMENT = /\/p2p\/(?<peerId>[^/]+)$/u;
const HEX32_PATTERN = /^0x[0-9a-f]{64}$/iu;

/** Maximum fetch→ack pages drained per poll to prevent hostile infinite loops. */
export const MAILBOX_MAX_DRAIN_PAGES = 16;

/** Parse comma-separated mailbox multiaddrs (`.../p2p/<peerId>`), deduplicated by peer ID. */
export const parseMailboxAddrs = (raw: string | undefined): MailboxPeer[] => {
  if (!raw) {
    return [];
  }

  const seen = new Set<string>();
  const peers: MailboxPeer[] = [];

  for (const part of raw.split(",")) {
    const addr = part.trim();

    if (!addr) {
      continue;
    }

    const peerId = PEER_ID_SEGMENT.exec(addr)?.groups?.peerId;

    if (peerId && !seen.has(peerId)) {
      seen.add(peerId);
      peers.push({ addr, peerId });
    }
  }

  return peers;
};

const deviceKeyToBytes = (hex: string): Uint8Array => {
  if (!HEX32_PATTERN.test(hex)) {
    throw new Error("Invalid device key hex");
  }

  // SAFETY: HEX32_PATTERN guarantees a `0x`-prefixed 32-byte hex string.
  return hexToBytes(hex as Hex);
};

const openStreamCancellable = (
  openStream: () => Promise<MailboxStream>
): Effect.Effect<MailboxStream, MailboxCodecError> =>
  Effect.callback<MailboxStream, MailboxCodecError>((resume) => {
    let cancelled = false;

    const run = async () => {
      try {
        const stream = await openStream();

        if (cancelled) {
          stream.reset?.();

          return;
        }

        resume(Effect.succeed(stream));
      } catch {
        if (!cancelled) {
          resume(Effect.fail(new MailboxCodecError({ operation: "frame" })));
        }
      }
    };

    void run();

    return Effect.sync(() => {
      cancelled = true;
    });
  });

const openAndExchange = (
  openStream: () => Promise<MailboxStream>,
  request: MailboxRequestV1,
  beforeWrite?: () => boolean
): Effect.Effect<MailboxResponseV1, MailboxCodecError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const stream = yield* restore(openStreamCancellable(openStream));

      if (beforeWrite && !beforeWrite()) {
        stream.reset?.();

        return yield* new MailboxCodecError({ operation: "frame" });
      }

      return yield* restore(exchangeMailbox(stream, request)).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Success"
            ? Effect.void
            : Effect.sync(() => {
                stream.reset?.();
              })
        )
      );
    })
  );

export interface MailboxDepositOptions {
  readonly beforeWrite?: (() => boolean) | undefined;
  readonly cipher: ChatCipher;
  readonly frame: ChatFrame;
  readonly openStream: () => Promise<MailboxStream>;
  readonly recipientDeviceKeys: readonly string[];
}

/**
 * Seal one HPKE envelope per unique recipient device key and deposit onto a
 * mailbox node in chunks of `MAILBOX_MAX_DEPOSIT_ITEMS`.
 * Returns the lowercase recipient device keys accepted by the mailbox so
 * callers can retry only still-pending devices on another mailbox.
 */
export const depositToMailbox = Effect.fn("@qop/protocol/depositToMailbox")(
  function* (options: MailboxDepositOptions) {
    const uniqueKeys = [
      ...new Set(options.recipientDeviceKeys.map((key) => key.toLowerCase())),
    ];

    if (uniqueKeys.length === 0) {
      return [];
    }

    const items = yield* Effect.tryPromise({
      catch: () => new MailboxCodecError({ operation: "frame" }),
      try: () =>
        Promise.all(
          uniqueKeys.map(async (recipientDeviceKey) => {
            const envelope = await options.cipher.seal(
              options.frame,
              deviceKeyToBytes(recipientDeviceKey)
            );

            return {
              envelope: encodeBase64(envelope),
              id: options.frame.id,
              recipientDeviceKey,
            };
          })
        ),
    });

    const accepted = new Set<string>();

    for (
      let offset = 0;
      offset < items.length;
      offset += MAILBOX_MAX_DEPOSIT_ITEMS
    ) {
      const batch = items.slice(offset, offset + MAILBOX_MAX_DEPOSIT_ITEMS);
      const batchKeys = new Set(batch.map((item) => item.recipientDeviceKey));

      const response = yield* openAndExchange(
        options.openStream,
        {
          items: batch,
          type: "deposit",
          v: 1,
        },
        options.beforeWrite
      );

      if (response.type === "deposited") {
        for (const item of response.items) {
          const key = item.recipientDeviceKey.toLowerCase();

          if (item.id === options.frame.id && batchKeys.has(key)) {
            accepted.add(key);
          }
        }
      }
    }

    return [...accepted];
  }
);

/**
 * Caller decision after inspecting a decrypted mailbox item:
 * - `"ack"`: durably saved, duplicate, conflicting, or rejected sender — delete from mailbox.
 * - `"retry"`: transient RPC/storage error — leave unacked for the next poll.
 * - `"abort"`: owning session changed/wiped — stop draining immediately without ACKing.
 */
export type MailboxItemDisposition = "abort" | "ack" | "retry";

export interface MailboxDrainOptions {
  readonly cipher: ChatCipher;
  readonly maxPages?: number;
  readonly onMessage: (
    frame: ChatFrame,
    meta: MailboxMessageV1
  ) => Promise<MailboxItemDisposition> | MailboxItemDisposition;
  readonly openStream: () => Promise<MailboxStream>;
}

/**
 * Drain up to `maxPages` pages of pending envelopes for this device,
 * decrypting and persisting before sending `ack`.
 */
export const drainMailbox = Effect.fn("@qop/protocol/drainMailbox")(function* (
  options: MailboxDrainOptions
) {
  const maxPages = Math.max(1, options.maxPages ?? MAILBOX_MAX_DRAIN_PAGES);
  const ackedSeqsSeen = new Set<number>();
  let delivered = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const response = yield* openAndExchange(options.openStream, {
      limit: MAILBOX_MAX_FETCH_LIMIT,
      type: "fetch",
      v: 1,
    });

    if (response.type !== "messages" || response.items.length === 0) {
      return delivered;
    }

    const ackSeqs: number[] = [];
    let aborted = false;
    let repeatedAckedSeq = false;

    for (const item of response.items) {
      if (ackedSeqsSeen.has(item.seq)) {
        repeatedAckedSeq = true;
        break;
      }

      const opened = yield* Effect.tryPromise({
        catch: () => null,
        try: () =>
          options.cipher.open(
            decodeBase64(item.envelope),
            deviceKeyToBytes(item.senderDeviceKey)
          ),
      }).pipe(Effect.result);

      if (opened._tag === "Failure") {
        // Unreadable or tampered envelope: ACK so it cannot head-of-line block.
        ackSeqs.push(item.seq);
        continue;
      }

      const disposition = yield* Effect.tryPromise({
        catch: () => "retry" as const,
        try: () => Promise.resolve(options.onMessage(opened.success, item)),
      }).pipe(Effect.catch(() => Effect.succeed("retry" as const)));

      if (disposition === "abort") {
        aborted = true;
        break;
      }

      if (disposition === "ack") {
        ackSeqs.push(item.seq);
        delivered += 1;
      }
    }

    if (aborted || repeatedAckedSeq || ackSeqs.length === 0) {
      return delivered;
    }

    const ackRes = yield* openAndExchange(options.openStream, {
      seqs: ackSeqs,
      type: "ack",
      v: 1,
    });

    if (ackRes.type !== "acked") {
      return delivered;
    }

    for (const seq of ackSeqs) {
      ackedSeqsSeen.add(seq);
    }

    if (!response.hasMore) {
      return delivered;
    }
  }

  return delivered;
});
