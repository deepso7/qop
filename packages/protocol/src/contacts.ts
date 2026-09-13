/** Structural contact used by live authorization. Persistence adapters supply these. */
export interface SessionContactInput {
  readonly createdAt: number;
  readonly deviceKey: string;
  readonly handle: string;
  readonly owner: string;
  readonly peerId: string;
  readonly qid: string;
}

export interface SessionContact extends SessionContactInput {
  readonly keyChanged: boolean;
  readonly lastReadAt: number;
}
