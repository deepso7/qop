import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:http2";
import type { ClientHttp2Session } from "node:http2";
import { finished } from "node:stream/promises";

import { MAILBOX_WAKE_DATA } from "@qop/protocol";
import { GoogleAuth } from "google-auth-library";

const WAKE_COLLAPSE_ID = "qop-mailbox";
const WAKE_TTL_SECONDS = 300;
const PUSH_TIMEOUT_MS = 5000;
const APNS_JWT_TTL_MS = 45 * 60 * 1000;

export const apnsWakePayload = {
  ...MAILBOX_WAKE_DATA,
  aps: { "content-available": 1 },
} as const;

export const fcmWakeMessage = (token: string) => ({
  message: {
    android: {
      collapse_key: WAKE_COLLAPSE_ID,
      priority: "HIGH",
      ttl: `${WAKE_TTL_SECONDS}s`,
    },
    data: MAILBOX_WAKE_DATA,
    token,
  },
});

const makeApns = async (options: {
  readonly keyFile: string;
  readonly keyId: string;
  readonly sandbox: boolean;
  readonly teamId: string;
  readonly topic: string;
}) => {
  const signingKey = createPrivateKey(await readFile(options.keyFile));

  if (signingKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APNs signing key must be a P-256 private key");
  }

  const origin = options.sandbox
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";

  let authorization:
    | { readonly expiresAt: number; readonly value: string }
    | undefined;

  let client: ClientHttp2Session | undefined;

  const apnsAuthorization = (now: number) => {
    if (authorization && now < authorization.expiresAt) {
      return authorization.value;
    }

    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", kid: options.keyId })
    ).toString("base64url");

    const claims = Buffer.from(
      JSON.stringify({ iat: Math.floor(now / 1000), iss: options.teamId })
    ).toString("base64url");

    const input = `${header}.${claims}`;

    const signature = sign("sha256", Buffer.from(input), {
      dsaEncoding: "ieee-p1363",
      key: signingKey,
    }).toString("base64url");

    authorization = {
      expiresAt: now + APNS_JWT_TTL_MS,
      value: `bearer ${input}.${signature}`,
    };

    return authorization.value;
  };

  const getSession = () => {
    if (client && !client.closed && !client.destroyed) {
      return client;
    }

    const session = connect(origin);
    session.on("error", () => session.destroy());
    session.on("goaway", () => session.close());
    session.setTimeout(60_000, () => session.close());
    client = session;

    return session;
  };

  return async (token: string) => {
    const now = Date.now();

    const request = getSession().request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      "apns-collapse-id": WAKE_COLLAPSE_ID,
      "apns-expiration": String(Math.floor(now / 1000) + WAKE_TTL_SECONDS),
      "apns-priority": "5",
      "apns-push-type": "background",
      "apns-topic": options.topic,
      authorization: apnsAuthorization(now),
      "content-type": "application/json",
    });

    let status: number | undefined;

    const timeout = setTimeout(() => {
      request.destroy(new Error("APNs request timed out"));
    }, PUSH_TIMEOUT_MS);

    request.once("response", (headers) => {
      status = headers[":status"];
    });

    try {
      const completion = finished(request);
      request.resume();
      request.end(JSON.stringify(apnsWakePayload));
      await completion;
    } finally {
      clearTimeout(timeout);
    }

    if (status === 410) {
      return "unregistered" as const;
    }

    if (status !== 200) {
      throw new Error("APNs wake rejected");
    }
  };
};

interface FcmError {
  readonly error?: {
    readonly details?: readonly {
      readonly "@type"?: string;
      readonly errorCode?: string;
    }[];
  };
}

const makeFcm = (projectId: string) => {
  const auth = new GoogleAuth({
    clientOptions: { transporterOptions: { timeout: PUSH_TIMEOUT_MS } },
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });

  return async (token: string) => {
    const response = await auth.request<FcmError>({
      data: fcmWakeMessage(token),
      method: "POST",
      retry: false,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      validateStatus: (status) => status === 200 || status === 404,
    });

    if (response.status === 404) {
      if (
        response.data.error?.details?.some(
          (detail) =>
            detail["@type"] ===
              "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
            detail.errorCode === "UNREGISTERED"
        )
      ) {
        return "unregistered" as const;
      }

      throw new Error("FCM wake rejected");
    }
  };
};

/** Read optional server-only push credentials. Neither provider is required for polling. */
export const createPushWake = async (env: NodeJS.ProcessEnv) => {
  const {
    QOP_APNS_ENVIRONMENT: environment = "production",
    QOP_APNS_KEY_FILE: keyFile,
    QOP_APNS_KEY_ID: keyId,
    QOP_APNS_TEAM_ID: teamId,
    QOP_APNS_TOPIC: topic,
    QOP_FCM_PROJECT_ID: projectId,
  } = env;

  let apns: Awaited<ReturnType<typeof makeApns>> | undefined;

  if (keyFile || keyId || teamId || topic) {
    if (!(keyFile && keyId && teamId && topic)) {
      throw new Error(
        "QOP_APNS_KEY_FILE, QOP_APNS_KEY_ID, QOP_APNS_TEAM_ID and QOP_APNS_TOPIC are all required for APNs"
      );
    }

    if (environment !== "production" && environment !== "development") {
      throw new Error("QOP_APNS_ENVIRONMENT must be production or development");
    }

    apns = await makeApns({
      keyFile,
      keyId,
      sandbox: environment === "development",
      teamId,
      topic,
    });
  }

  const fcm = projectId ? makeFcm(projectId) : undefined;

  return { apns, fcm };
};
