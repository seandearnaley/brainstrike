/**
 * Host-owned graph over native Mastra conversations. Write inputs come from
 * the host's observed delegation scope, never model arguments or renderer ids.
 * Read authorization joins the live root owner and exact native child scope.
 */
export interface DelegatedConversationDatabase {
  /** Only scalar SQL parameters and explicitly serialized configuration JSON. */
  query(sql: string, params?: (string | number | null)[]): Promise<{ rows: unknown[] }>;
  transaction?<T>(callback: (tx: DelegatedConversationDatabase) => Promise<T>): Promise<T>;
}

export interface DelegatedConversationScope {
  readonly ownerResourceId: string;
  readonly rootThreadId: string;
}

export class DelegatedConversationIdentityError extends Error {
  readonly reason: string;
  constructor(reason = 'identity-conflict') {
    super(
      'Delegated conversation identity is missing, unauthorized or conflicts with its persisted binding.'
    );
    this.name = 'DelegatedConversationIdentityError';
    this.reason = reason;
  }
}
