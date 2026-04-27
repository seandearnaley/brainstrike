export type BrainstrikeDbClientCapability =
  | 'close'
  | 'diagnostics'
  | 'exec'
  | 'live-query'
  | 'query'
  | 'reset'
  | 'transaction';

export const BRAINSTRIKE_DB_CLIENT_CAPABILITIES = [
  'query',
  'exec',
  'transaction',
  'live-query',
  'diagnostics',
  'reset',
  'close',
] as const satisfies readonly BrainstrikeDbClientCapability[];

export interface BrainstrikeDbQueryResult<TRecord = unknown> {
  readonly rows: readonly TRecord[];
}

export interface BrainstrikeDbWorkOptions {
  readonly label?: string;
  readonly priority?: 'background' | 'foreground' | 'normal';
}

export interface BrainstrikeLiveQueryOptions {
  readonly key?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly params?: readonly unknown[] | null;
  readonly query: string;
}

export interface BrainstrikeLiveQueryHandle<TRecord = unknown> {
  readonly initialResults: BrainstrikeDbQueryResult<TRecord>;
  readonly refresh: (options?: {
    readonly limit?: number;
    readonly offset?: number;
  }) => Promise<void>;
  readonly subscribe: (listener: (results: BrainstrikeDbQueryResult<TRecord>) => void) => void;
  readonly unsubscribe: (
    listener?: (results: BrainstrikeDbQueryResult<TRecord>) => void
  ) => Promise<void>;
}

export interface BrainstrikeDbTransactionClient {
  readonly exec: (
    sql: string,
    params?: readonly unknown[],
    options?: BrainstrikeDbWorkOptions
  ) => Promise<unknown>;
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[],
    options?: BrainstrikeDbWorkOptions
  ) => Promise<BrainstrikeDbQueryResult<TRecord>>;
}

export interface BrainstrikeDbClient extends BrainstrikeDbTransactionClient {
  readonly close: () => Promise<void>;
  readonly diagnostics: () => Promise<unknown>;
  readonly live: {
    readonly incrementalQuery?: <TRecord = unknown>(
      options: BrainstrikeLiveQueryOptions & { readonly key: string }
    ) => Promise<BrainstrikeLiveQueryHandle<TRecord>>;
    readonly query: <TRecord = unknown>(
      options: BrainstrikeLiveQueryOptions
    ) => Promise<BrainstrikeLiveQueryHandle<TRecord>>;
  };
  readonly reset: () => Promise<unknown>;
  readonly transaction: <TResult>(
    callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
  ) => Promise<TResult>;
}

export function getMissingBrainstrikeDbClientCapabilities(
  candidate: unknown
): readonly BrainstrikeDbClientCapability[] {
  if (!isObjectRecord(candidate)) {
    return BRAINSTRIKE_DB_CLIENT_CAPABILITIES;
  }

  return BRAINSTRIKE_DB_CLIENT_CAPABILITIES.filter((capability) =>
    isBrainstrikeDbClientCapabilityMissing(candidate, capability)
  );
}

function isBrainstrikeDbClientCapabilityMissing(
  candidate: Record<PropertyKey, unknown>,
  capability: BrainstrikeDbClientCapability
): boolean {
  switch (capability) {
    case 'live-query':
      return !hasLiveQueryCapability(candidate);
    case 'close':
    case 'diagnostics':
    case 'exec':
    case 'query':
    case 'reset':
    case 'transaction':
      return !hasFunctionProperty(candidate, capability);
    default:
      return assertUnreachableDbClientCapability(capability);
  }
}

function hasLiveQueryCapability(candidate: Record<PropertyKey, unknown>): boolean {
  const live = candidate['live'];

  if (!isObjectRecord(live)) {
    return false;
  }

  return hasFunctionProperty(live, 'query');
}

function hasFunctionProperty(
  candidate: Record<PropertyKey, unknown>,
  property: PropertyKey
): boolean {
  return typeof candidate[property] === 'function';
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUnreachableDbClientCapability(value: never): never {
  throw new Error(`Unhandled Brainstrike DB client capability: ${String(value)}`);
}
