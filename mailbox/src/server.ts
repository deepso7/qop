import { Minip2p } from "@minip2p/node";
import { deviceKeyBytesFromPeerId } from "@qop/identity";
import {
  decodeBase64,
  inspectChatEnvelope,
  MAILBOX_PROTOCOL,
  MAX_MAILBOX_PAYLOAD_BYTES,
  readMailboxRequestFrom,
  writeMailboxResponseTo,
} from "@qop/protocol";
import type {
  MailboxError,
  MailboxPushTarget,
  MailboxRequest,
  MailboxResponse,
  MailboxStream,
} from "@qop/protocol";
import { Effect } from "effect";
import { bytesToHex } from "viem";

import type { DepositRecord, MailboxStore } from "./store.ts";

/** Minimal on-chain membership lookup: returns active qid or `null` if inactive. */
export interface MailboxRegistry {
  readonly lookupDeviceQid: (
    deviceKey: string
  ) => Effect.Effect<bigint | null, unknown>;
}

const AUTH_CACHE_TTL_MS = 60_000;
const DEFAULT_AUTH_LOOKUP_TIMEOUT_MS = 5000;
const MAX_AUTH_CACHE_ENTRIES = 4096;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INBOUND_MAILBOX_STREAMS = 32;
const STREAM_TIMEOUT_MS = 15_000;
const DEFAULT_RATE_LIMIT_PER_MIN = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_PEERS = 4096;
const MAX_PENDING_WAKEUPS = 32;

type MailboxWakeProviders = Partial<
  Record<
    MailboxPushTarget["platform"],
    ((token: string) => Promise<"unregistered" | undefined>) | undefined
  >
>;

export interface MailboxHandlerDeps {
  readonly now?: (() => number) | undefined;
  readonly registry: MailboxRegistry;
  readonly store: MailboxStore;
  readonly wake?: MailboxWakeProviders | undefined;
}

export type DeviceAuthResult =
  | { readonly qid: string; readonly status: "active" }
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable" };

export interface DeviceAuthorizer {
  readonly authorize: (deviceKey: string) => Effect.Effect<DeviceAuthResult>;
}

interface CachedAuth {
  readonly checkedAt: number;
  readonly result: Exclude<
    DeviceAuthResult,
    { readonly status: "unavailable" }
  >;
}

/**
 * Verify whether a device key is active in the registry with a bounded 60s
 * cache and in-flight coalescing. Transient RPC errors are never cached.
 */
export const createDeviceAuthorizer = (
  registry: MailboxRegistry,
  now: () => number = Date.now,
  lookupTimeoutMs = DEFAULT_AUTH_LOOKUP_TIMEOUT_MS
): DeviceAuthorizer => {
  const cache = new Map<string, CachedAuth>();
  const inflight = new Map<string, Promise<DeviceAuthResult>>();

  const pruneCache = (currentMs: number) => {
    for (const [key, entry] of cache) {
      if (currentMs - entry.checkedAt >= AUTH_CACHE_TTL_MS) {
        cache.delete(key);
      }
    }

    while (cache.size >= MAX_AUTH_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      cache.delete(oldestKey);
    }
  };

  const authorize = (deviceKey: string): Effect.Effect<DeviceAuthResult> =>
    Effect.promise(() => {
      const normalized = deviceKey.toLowerCase();
      const currentMs = now();
      const cached = cache.get(normalized);

      if (cached) {
        if (currentMs - cached.checkedAt < AUTH_CACHE_TTL_MS) {
          return Promise.resolve(cached.result);
        }

        cache.delete(normalized);
      }

      const pending = inflight.get(normalized);

      if (pending) {
        return pending;
      }

      const promise = (async (): Promise<DeviceAuthResult> => {
        const lookup = await Effect.runPromise(
          registry.lookupDeviceQid(normalized).pipe(
            Effect.timeoutOrElse({
              duration: `${lookupTimeoutMs} millis`,
              orElse: () => Effect.fail("timeout"),
            }),
            Effect.result
          )
        );

        if (lookup._tag === "Failure") {
          return { status: "unavailable" };
        }

        const result: CachedAuth["result"] =
          lookup.success !== null && lookup.success > 0n
            ? { qid: lookup.success.toString(), status: "active" }
            : { status: "unauthorized" };

        const checkedAt = now();

        if (cache.size >= MAX_AUTH_CACHE_ENTRIES) {
          pruneCache(checkedAt);
        }

        cache.set(normalized, { checkedAt, result });

        return result;
      })().finally(() => {
        if (inflight.get(normalized) === promise) {
          inflight.delete(normalized);
        }
      });

      inflight.set(normalized, promise);

      return promise;
    });

  return { authorize };
};

/** Bounded per-peer fixed-window rate limiter to stop stream/RPC floods early. */
export const createPeerRateLimiter = (
  maxPerWindow = DEFAULT_RATE_LIMIT_PER_MIN,
  windowMs = RATE_LIMIT_WINDOW_MS,
  now: () => number = Date.now
) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const allow = (peerKey: string): boolean => {
    const currentMs = now();
    const existing = buckets.get(peerKey);

    if (existing && currentMs < existing.resetAt) {
      if (existing.count >= maxPerWindow) {
        return false;
      }

      existing.count += 1;

      return true;
    }

    if (buckets.size >= MAX_RATE_LIMIT_PEERS) {
      for (const [key, bucket] of buckets) {
        if (currentMs >= bucket.resetAt) {
          buckets.delete(key);
        }
      }

      if (buckets.size >= MAX_RATE_LIMIT_PEERS) {
        const oldest = buckets.keys().next().value;

        if (oldest !== undefined) {
          buckets.delete(oldest);
        }
      }
    }

    buckets.set(peerKey, { count: 1, resetAt: currentMs + windowMs });

    return true;
  };

  return { allow };
};

const errorResponse = (reason: MailboxError["reason"]): MailboxResponse => ({
  reason,
  type: "error",
  v: 1,
});

const storeErrorToReason = (
  operation: "quota" | "read" | "write"
): MailboxError["reason"] => (operation === "quota" ? "quota" : "unavailable");

const peerIdToDeviceKey = (peerId: string): string | null => {
  try {
    return bytesToHex(deviceKeyBytesFromPeerId(peerId)).toLowerCase();
  } catch {
    return null;
  }
};

/** Handle authenticated `/qop/mailbox/1` requests, separating caller auth from body handling. */
export const createMailboxHandler = (deps: MailboxHandlerDeps) => {
  const now = deps.now ?? Date.now;
  const authorizer = createDeviceAuthorizer(deps.registry, now);
  const { wake } = deps;
  let pendingWakeups = 0;

  const wakeRecipient = (deviceKey: string) => {
    if ((!wake?.apns && !wake?.fcm) || pendingWakeups >= MAX_PENDING_WAKEUPS) {
      return;
    }

    pendingWakeups += 1;

    const send = async () => {
      try {
        const target = await Effect.runPromise(
          deps.store.pushTarget(deviceKey, now())
        );

        if (
          target &&
          (await wake[target.platform]?.(target.token)) === "unregistered"
        ) {
          await Effect.runPromise(deps.store.removePush(deviceKey, target));
        }
      } catch {
        // Provider failures must not undo a deposit or log the device token.
      } finally {
        pendingWakeups -= 1;
      }
    };

    void send();
  };

  const registerPush = (deviceKey: string, target: MailboxPushTarget) =>
    wake?.[target.platform]
      ? deps.store.registerPush(deviceKey, target, now()).pipe(
          Effect.as({
            type: "push-registered",
            v: 1,
          } satisfies MailboxResponse),
          Effect.orElseSucceed(() => errorResponse("unavailable"))
        )
      : Effect.succeed(errorResponse("unavailable"));

  const handleAuthorized = (
    callerDeviceKey: string,
    callerQid: string,
    request: MailboxRequest
  ): Effect.Effect<MailboxResponse> =>
    Effect.gen(function* () {
      if (request.type === "register-push") {
        const { platform, token } = request;

        return yield* registerPush(callerDeviceKey, { platform, token });
      }

      if (request.type === "fetch") {
        const result = yield* deps.store
          .fetch(
            callerDeviceKey,
            request.limit,
            MAX_MAILBOX_PAYLOAD_BYTES,
            now()
          )
          .pipe(Effect.result);

        if (result._tag === "Failure") {
          return errorResponse(storeErrorToReason(result.failure.operation));
        }

        return {
          hasMore: result.success.hasMore,
          items: result.success.items,
          type: "messages",
          v: 1,
        } satisfies MailboxResponse;
      }

      if (request.type === "ack") {
        const result = yield* deps.store
          .ack(callerDeviceKey, request.seqs)
          .pipe(Effect.result);

        if (result._tag === "Failure") {
          return errorResponse(storeErrorToReason(result.failure.operation));
        }

        return {
          count: result.success,
          type: "acked",
          v: 1,
        } satisfies MailboxResponse;
      }

      const validated: {
        readonly envelope: Uint8Array;
        readonly id: string;
        readonly recipientDeviceKey: string;
      }[] = [];

      for (const item of request.items) {
        const recipientDeviceKey = item.recipientDeviceKey.toLowerCase();
        let envelopeBytes: Uint8Array;

        let inspected: {
          readonly recipient: Uint8Array;
          readonly sender: Uint8Array;
        };

        try {
          envelopeBytes = decodeBase64(item.envelope);
          inspected = inspectChatEnvelope(envelopeBytes);
        } catch {
          return errorResponse("invalid");
        }

        const headerSender = bytesToHex(inspected.sender).toLowerCase();
        const headerRecipient = bytesToHex(inspected.recipient).toLowerCase();

        if (
          headerSender !== callerDeviceKey ||
          headerRecipient !== recipientDeviceKey
        ) {
          return errorResponse("invalid");
        }

        validated.push({
          envelope: envelopeBytes,
          id: item.id,
          recipientDeviceKey,
        });
      }

      const uniqueRecipients = [
        ...new Set(validated.map((item) => item.recipientDeviceKey)),
      ];

      const authEntries = yield* Effect.forEach(
        uniqueRecipients,
        (recipientDeviceKey) =>
          authorizer
            .authorize(recipientDeviceKey)
            .pipe(
              Effect.map((auth) => [recipientDeviceKey, auth.status] as const)
            ),
        { concurrency: "unbounded" }
      );

      const recipientAuthStatus = new Map(authEntries);
      const records: DepositRecord[] = [];
      let lastAuthFailure: "unauthorized" | "unavailable" | undefined;

      for (const item of validated) {
        const recipientStatus =
          recipientAuthStatus.get(item.recipientDeviceKey) ?? "unauthorized";

        if (recipientStatus !== "active") {
          if (lastAuthFailure !== "unavailable") {
            lastAuthFailure = recipientStatus;
          }

          continue;
        }

        records.push({
          envelope: item.envelope,
          id: item.id,
          recipientDeviceKey: item.recipientDeviceKey,
          senderDeviceKey: callerDeviceKey,
          senderQid: callerQid,
        });
      }

      if (records.length === 0) {
        return errorResponse(lastAuthFailure ?? "unauthorized");
      }

      const deposited = yield* deps.store
        .deposit(records, now())
        .pipe(Effect.result);

      if (deposited._tag === "Failure") {
        return errorResponse(storeErrorToReason(deposited.failure.operation));
      }

      for (const deviceKey of deposited.success.insertedRecipients) {
        wakeRecipient(deviceKey);
      }

      return {
        items: deposited.success.items,
        type: "deposited",
        v: 1,
      } satisfies MailboxResponse;
    });

  const handle = (
    callerPeerId: string,
    request: MailboxRequest
  ): Effect.Effect<MailboxResponse> =>
    Effect.gen(function* () {
      const callerDeviceKey = peerIdToDeviceKey(callerPeerId);

      if (!callerDeviceKey) {
        return errorResponse("unauthorized");
      }

      const callerAuth = yield* authorizer.authorize(callerDeviceKey);

      if (callerAuth.status !== "active") {
        return errorResponse(callerAuth.status);
      }

      return yield* handleAuthorized(callerDeviceKey, callerAuth.qid, request);
    });

  return {
    authorizeCaller: authorizer.authorize,
    handle,
    handleAuthorized,
  };
};

export interface MailboxServerConfig {
  readonly keypair: Uint8Array;
  readonly listenAddrs: readonly [string, ...string[]];
  readonly maxRequestsPerMinute?: number | undefined;
  readonly registry: MailboxRegistry;
  readonly relayAddrs?: readonly string[] | undefined;
  readonly store: MailboxStore;
  readonly streamTimeoutMs?: number | undefined;
  readonly wake?: MailboxWakeProviders | undefined;
}

export interface RunningMailboxServer {
  readonly close: () => void;
  readonly listenAddrs: () => readonly string[];
  readonly peerId: string;
}

type InboundMailboxStream = MailboxStream & {
  readonly peerId: string;
  readonly protocolId: string;
  readonly reset: () => void;
};

/** Start a minip2p node serving `/qop/mailbox/1` backed by `store` and `registry`. */
export const startMailboxServer = (
  config: MailboxServerConfig
): RunningMailboxServer => {
  const handler = createMailboxHandler({
    registry: config.registry,
    store: config.store,
    wake: config.wake,
  });

  const rateLimiter = createPeerRateLimiter(
    config.maxRequestsPerMinute ?? DEFAULT_RATE_LIMIT_PER_MIN
  );

  const timeoutMs = config.streamTimeoutMs ?? STREAM_TIMEOUT_MS;

  const serveStream = (stream: InboundMailboxStream, callerDeviceKey: string) =>
    Effect.gen(function* () {
      // Authenticate caller BEFORE reading up to 128 KiB from the stream.
      // Reset rejected streams so unread client bytes do not hold native stream slots.
      const callerAuth = yield* handler.authorizeCaller(callerDeviceKey);

      if (callerAuth.status !== "active") {
        return yield* Effect.fail("rejected" as const);
      }

      const decoded = yield* readMailboxRequestFrom(stream).pipe(Effect.result);

      if (decoded._tag === "Failure") {
        if (decoded.failure.operation === "oversized") {
          return yield* Effect.fail("oversized" as const);
        }

        yield* writeMailboxResponseTo(stream, errorResponse("invalid"));

        return;
      }

      const response = yield* handler.handleAuthorized(
        callerDeviceKey,
        callerAuth.qid,
        decoded.success
      );

      yield* writeMailboxResponseTo(stream, response);
    }).pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        orElse: () => Effect.fail("timeout" as const),
      }),
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.sync(() => {
              try {
                stream.reset();
              } catch {
                // Stream already closed.
              }
            })
      ),
      Effect.ignore
    );

  const baseConfig = {
    agentVersion: "qop-mailbox/0.1.0",
    inboundStreamLimits: { [MAILBOX_PROTOCOL]: MAX_INBOUND_MAILBOX_STREAMS },
    listen: config.listenAddrs,
    protocols: [MAILBOX_PROTOCOL],
    secretKey: config.keypair,
  };

  const endpoint = Minip2p.create(
    config.relayAddrs && config.relayAddrs.length > 0
      ? { ...baseConfig, relays: [...config.relayAddrs] }
      : baseConfig
  );

  endpoint.on("stream", (stream: InboundMailboxStream) => {
    if (stream.protocolId !== MAILBOX_PROTOCOL) {
      stream.reset();

      return;
    }

    const callerDeviceKey = peerIdToDeviceKey(stream.peerId);

    if (!callerDeviceKey || !rateLimiter.allow(callerDeviceKey)) {
      stream.reset();

      return;
    }

    void Effect.runPromise(serveStream(stream, callerDeviceKey));
  });

  const pruneTimer = setInterval(() => {
    void Effect.runPromise(
      config.store.pruneExpired(Date.now()).pipe(Effect.ignore)
    );
  }, PRUNE_INTERVAL_MS);

  pruneTimer.unref();

  return {
    close: () => {
      clearInterval(pruneTimer);
      endpoint.close();
    },
    listenAddrs: () => endpoint.listenAddrs(),
    peerId: endpoint.peerId(),
  };
};
