import type { ProfileBootstrapCheck } from '../bootstrap/profile-bootstrap-report.js';

export type BrainstrikeDbClientCapability = 'exec' | 'live-query' | 'query' | 'transaction';
export type BrainstrikeDbExecutionClientCapability = Exclude<
  BrainstrikeDbClientCapability,
  'live-query'
>;
export type BrainstrikeDbSqlDialect = 'postgres' | 'sqlite';
export type BrainstrikeDbSqlFeature =
  | 'data-modifying-cte'
  | 'jsonb'
  | 'postgres-fts'
  | 'postgres-vector'
  | 'skip-locked'
  | 'sqlite-json'
  | 'sqlite-returning'
  | 'trigram'
  | 'turso-fts'
  | 'turso-vector';

export type BrainstrikeDbRuntimeHostCapability = 'close' | 'diagnostics' | 'reset';

export const BRAINSTRIKE_DB_SQL_DIALECTS = [
  'postgres',
  'sqlite',
] as const satisfies readonly BrainstrikeDbSqlDialect[];

export const BRAINSTRIKE_DB_EXECUTION_CLIENT_CAPABILITIES = [
  'query',
  'exec',
  'transaction',
] as const satisfies readonly BrainstrikeDbExecutionClientCapability[];

export const BRAINSTRIKE_DB_CLIENT_CAPABILITIES = [
  'query',
  'exec',
  'transaction',
  'live-query',
] as const satisfies readonly BrainstrikeDbClientCapability[];

export const BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES = [
  'diagnostics',
  'reset',
  'close',
] as const satisfies readonly BrainstrikeDbRuntimeHostCapability[];

export const BRAINSTRIKE_DB_POSTGRES_REPOSITORY_SQL_FEATURES = [
  'data-modifying-cte',
  'jsonb',
  'postgres-fts',
  'postgres-vector',
  'skip-locked',
  'trigram',
] as const satisfies readonly BrainstrikeDbSqlFeature[];

export const BRAINSTRIKE_DB_TURSO_BASELINE_SQL_CAPABILITIES = {
  dialect: 'sqlite',
  features: ['sqlite-json', 'sqlite-returning', 'turso-vector'],
} as const satisfies BrainstrikeDbSqlCapabilities;

export interface BrainstrikeDbQueryResult<TRecord = unknown> {
  readonly rows: readonly TRecord[];
}

export interface BrainstrikeDbDiagnosticsSnapshot {
  readonly details?: Record<string, unknown>;
  readonly message?: string;
  readonly ok: boolean;
}

export interface BrainstrikeDbWorkOptions {
  readonly label?: string;
  readonly priority?: 'background' | 'foreground' | 'normal';
}

export interface BrainstrikeDbSqlCapabilities {
  readonly dialect: BrainstrikeDbSqlDialect;
  readonly features: readonly BrainstrikeDbSqlFeature[];
}

export interface BrainstrikeLiveQueryOptions {
  readonly key?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly params?: readonly unknown[] | null;
  readonly query: string;
}

export interface BrainstrikeLiveQueryHandle<TRecord = unknown> {
  readonly dispose: () => Promise<void>;
  readonly initialResults: BrainstrikeDbQueryResult<TRecord>;
  readonly refresh: (options?: {
    readonly limit?: number;
    readonly offset?: number;
  }) => Promise<void>;
  readonly subscribe: (
    listener: (results: BrainstrikeDbQueryResult<TRecord>) => void
  ) => () => void;
}

export interface BrainstrikeDbTransactionClient {
  readonly exec: (
    sql: string,
    params?: readonly unknown[],
    options?: BrainstrikeDbWorkOptions
  ) => Promise<void>;
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[],
    options?: BrainstrikeDbWorkOptions
  ) => Promise<BrainstrikeDbQueryResult<TRecord>>;
}

export interface BrainstrikeDbExecutionClient extends BrainstrikeDbTransactionClient {
  readonly transaction: <TResult>(
    callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
  ) => Promise<TResult>;
}

export interface BrainstrikeDbClient extends BrainstrikeDbExecutionClient {
  readonly live: {
    readonly incrementalQuery?: <TRecord = unknown>(
      options: BrainstrikeLiveQueryOptions & { readonly key: string }
    ) => Promise<BrainstrikeLiveQueryHandle<TRecord>>;
    readonly query: <TRecord = unknown>(
      options: BrainstrikeLiveQueryOptions
    ) => Promise<BrainstrikeLiveQueryHandle<TRecord>>;
  };
}

export interface BrainstrikeDbRuntimeHost {
  readonly close: () => Promise<void>;
  readonly diagnostics: () => Promise<BrainstrikeDbDiagnosticsSnapshot>;
  readonly reset: () => Promise<void>;
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

export function getMissingBrainstrikeDbExecutionClientCapabilities(
  candidate: unknown
): readonly BrainstrikeDbExecutionClientCapability[] {
  if (!isObjectRecord(candidate)) {
    return BRAINSTRIKE_DB_EXECUTION_CLIENT_CAPABILITIES;
  }

  return BRAINSTRIKE_DB_EXECUTION_CLIENT_CAPABILITIES.filter((capability) =>
    isBrainstrikeDbExecutionClientCapabilityMissing(candidate, capability)
  );
}

export function buildBrainstrikeDbClientCapabilityBootstrapChecks(
  candidate: unknown
): readonly ProfileBootstrapCheck[] {
  const missingCapabilities = new Set(getMissingBrainstrikeDbClientCapabilities(candidate));

  return BRAINSTRIKE_DB_CLIENT_CAPABILITIES.map((capability) => ({
    id: `db.client.${capability}`,
    label: `DB client ${capability} capability`,
    required: true,
    status: missingCapabilities.has(capability) ? 'failed' : 'passed',
  }));
}

export function buildBrainstrikeDbExecutionClientCapabilityBootstrapChecks(
  candidate: unknown
): readonly ProfileBootstrapCheck[] {
  const missingCapabilities = new Set(
    getMissingBrainstrikeDbExecutionClientCapabilities(candidate)
  );

  return BRAINSTRIKE_DB_EXECUTION_CLIENT_CAPABILITIES.map((capability) => ({
    id: `db.execution-client.${capability}`,
    label: `DB execution client ${capability} capability`,
    required: true,
    status: missingCapabilities.has(capability) ? 'failed' : 'passed',
  }));
}

export function hasBrainstrikeDbSqlDialect(
  candidate: unknown,
  dialect: BrainstrikeDbSqlDialect
): boolean {
  if (!isBrainstrikeDbSqlCapabilities(candidate)) {
    return false;
  }

  return candidate.dialect === dialect;
}

export function getMissingBrainstrikeDbSqlFeatures(
  candidate: unknown,
  requiredFeatures: readonly BrainstrikeDbSqlFeature[]
): readonly BrainstrikeDbSqlFeature[] {
  if (!isBrainstrikeDbSqlCapabilities(candidate)) {
    return requiredFeatures;
  }

  const availableFeatures = new Set(candidate.features);
  return requiredFeatures.filter((feature) => !availableFeatures.has(feature));
}

export function buildBrainstrikeDbSqlFeatureBootstrapChecks(
  candidate: unknown,
  requiredFeatures: readonly BrainstrikeDbSqlFeature[]
): readonly ProfileBootstrapCheck[] {
  const missingFeatures = new Set(getMissingBrainstrikeDbSqlFeatures(candidate, requiredFeatures));

  return requiredFeatures.map((feature) => ({
    id: `db.sql-feature.${feature}`,
    label: `DB SQL feature ${feature}`,
    required: true,
    status: missingFeatures.has(feature) ? 'failed' : 'passed',
  }));
}

function isBrainstrikeDbClientCapabilityMissing(
  candidate: Record<PropertyKey, unknown>,
  capability: BrainstrikeDbClientCapability
): boolean {
  switch (capability) {
    case 'live-query':
      return !hasLiveQueryCapability(candidate);
    case 'exec':
    case 'query':
    case 'transaction':
      return !hasFunctionProperty(candidate, capability);
    default:
      return assertUnreachableDbClientCapability(capability);
  }
}

function isBrainstrikeDbExecutionClientCapabilityMissing(
  candidate: Record<PropertyKey, unknown>,
  capability: BrainstrikeDbExecutionClientCapability
): boolean {
  switch (capability) {
    case 'exec':
    case 'query':
    case 'transaction':
      return !hasFunctionProperty(candidate, capability);
    default:
      return assertUnreachableDbExecutionClientCapability(capability);
  }
}

export function getMissingBrainstrikeDbRuntimeHostCapabilities(
  candidate: unknown
): readonly BrainstrikeDbRuntimeHostCapability[] {
  if (!isObjectRecord(candidate)) {
    return BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES;
  }

  return BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES.filter((capability) =>
    isBrainstrikeDbRuntimeHostCapabilityMissing(candidate, capability)
  );
}

export function buildBrainstrikeDbRuntimeHostCapabilityBootstrapChecks(
  candidate: unknown
): readonly ProfileBootstrapCheck[] {
  const missingCapabilities = new Set(getMissingBrainstrikeDbRuntimeHostCapabilities(candidate));

  return BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES.map((capability) => ({
    id: `db.runtime-host.${capability}`,
    label: `DB runtime host ${capability} capability`,
    required: true,
    status: missingCapabilities.has(capability) ? 'failed' : 'passed',
  }));
}

function isBrainstrikeDbRuntimeHostCapabilityMissing(
  candidate: Record<PropertyKey, unknown>,
  capability: BrainstrikeDbRuntimeHostCapability
): boolean {
  switch (capability) {
    case 'close':
    case 'diagnostics':
    case 'reset':
      return !hasFunctionProperty(candidate, capability);
    default:
      return assertUnreachableDbRuntimeHostCapability(capability);
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

function isBrainstrikeDbSqlCapabilities(value: unknown): value is BrainstrikeDbSqlCapabilities {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    BRAINSTRIKE_DB_SQL_DIALECTS.includes(value['dialect'] as BrainstrikeDbSqlDialect) &&
    Array.isArray(value['features']) &&
    value['features'].every((feature) => typeof feature === 'string')
  );
}

function assertUnreachableDbClientCapability(value: never): never {
  throw new Error(`Unhandled Brainstrike DB client capability: ${String(value)}`);
}

function assertUnreachableDbExecutionClientCapability(value: never): never {
  throw new Error(`Unhandled Brainstrike DB execution client capability: ${String(value)}`);
}

function assertUnreachableDbRuntimeHostCapability(value: never): never {
  throw new Error(`Unhandled Brainstrike DB runtime host capability: ${String(value)}`);
}
