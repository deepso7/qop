import {
  CHAT_PROTOCOL,
  decodeFrame,
  MAX_CHAT_PAYLOAD_BYTES,
} from "./chat-wire";
import type { ChatFrame } from "./chat-wire";
import type { Contact, ContactInput } from "./db";
import { withTimeout } from "./p2p-send";
import type { RegistryAccount } from "./registry";

interface ReceiveStream {
  readonly peerId: string;
  readonly protocolId: string;
  readonly read: () => Promise<Uint8Array | undefined>;
}

export interface ResolveSenderDependencies {
  readonly getContactByPeerId: (peerId: string) => Promise<Contact | null>;
  readonly lookupHandle: (handle: string) => Promise<RegistryAccount | null>;
  readonly upsertContact: (contact: ContactInput) => Promise<void>;
}

const contactFromAccount = (account: RegistryAccount): ContactInput => ({
  createdAt: Number(account.registeredAt) * 1000,
  deviceKey: account.deviceKey,
  handle: account.handle,
  owner: account.owner,
  peerId: account.peerId,
  qid: account.qid.toString(),
});

export const createResolveSender = (dependencies: ResolveSenderDependencies) =>
  async function resolveSender(
    peerId: string,
    fromHandle: string,
    shouldWrite: () => boolean = () => true
  ): Promise<Contact | null> {
    const [known, account] = await Promise.all([
      dependencies.getContactByPeerId(peerId),
      dependencies.lookupHandle(fromHandle),
    ]);
    if (!account || account.peerId !== peerId) {
      return null;
    }

    const fresh = contactFromAccount(account);
    if (!shouldWrite()) {
      return null;
    }
    await dependencies.upsertContact(fresh);
    return {
      ...fresh,
      keyChanged:
        known?.qid === fresh.qid
          ? known.keyChanged || known.deviceKey !== fresh.deviceKey
          : false,
      lastReadAt: known?.qid === fresh.qid ? known.lastReadAt : 0,
    };
  };

const readStream = async (stream: Pick<ReceiveStream, "read">) => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    // Stream chunks are ordered, so reads cannot run concurrently.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const chunk = await stream.read();
    if (!chunk) {
      break;
    }
    byteLength += chunk.byteLength;
    if (byteLength > MAX_CHAT_PAYLOAD_BYTES) {
      throw new Error("Chat frame exceeds 16 KB");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const readVerifiedChat = (
  stream: ReceiveStream,
  resolveSender: (
    peerId: string,
    fromHandle: string
  ) => Promise<Contact | null>,
  timeoutMs: number
): Promise<{ readonly contact: Contact; readonly frame: ChatFrame } | null> =>
  withTimeout(
    (async () => {
      if (stream.protocolId !== CHAT_PROTOCOL) {
        return null;
      }
      const frame = decodeFrame(await readStream(stream));
      const contact = await resolveSender(stream.peerId, frame.fromHandle);
      return contact ? { contact, frame } : null;
    })(),
    timeoutMs,
    "Timed out receiving chat frame"
  );
