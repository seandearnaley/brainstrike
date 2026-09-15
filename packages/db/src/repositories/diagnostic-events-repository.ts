import type { DiagnosticEvent, DiagnosticSeverity } from '@brainstrike/utils/diagnostics';

const TABLE = 'brainstrike_diagnostic_events';

export const DIAGNOSTIC_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_RETENTION_MAX_ROWS = 20_000;
/**
 * Default per-query row cap for BOTH deletes inside `purge()` (the aged-rows
 * delete and the over-cap delete each independently respect this limit, so a
 * single `purge()` call can return up to 2x this value). Exported (Flight
 * Recorder P2b Task 4) so the settings UI's "Purge now" toast can tell a
 * user "more may remain" instead of silently implying the purge fully
 * drained a large backlog — see `logging-settings-section.tsx`'s
 * `DIAGNOSTIC_PURGE_MAY_REMAIN_THRESHOLD`, which mirrors this value (test-side
 * drift guard: that section's test imports this constant directly).
 */
export const DIAGNOSTIC_EVENTS_PURGE_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 200;

export type DiagnosticEventsOperation = 'insert' | 'purge' | 'query';

export class DiagnosticEventsStorageError extends Error {
  readonly operation: DiagnosticEventsOperation;

  constructor(operation: DiagnosticEventsOperation, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to ${operation} diagnostic events${detail ? `: ${detail}` : ''}`, { cause });
    this.name = 'DiagnosticEventsStorageError';
    this.operation = operation;
  }
}

export interface DiagnosticEventsDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface DiagnosticEventsQueryFilter {
  readonly fingerprint?: string;
  readonly limit?: number;
  readonly runId?: string;
  readonly severity?: DiagnosticSeverity;
  readonly sinceMs?: number;
  readonly threadId?: string;
  readonly untilMs?: number;
}

export interface DiagnosticEventRow {
  app_version: string;
  cause_chain: unknown;
  code: string | null;
  context: unknown;
  fingerprint: string;
  id: string;
  message: string;
  occurred_at: string | Date;
  platform: string;
  resource_id: string | null;
  root_id: string | null;
  run_id: string | null;
  scope: string | null;
  session_id: string;
  severity: DiagnosticSeverity;
  source: string;
  stack: string | null;
  thread_id: string | null;
}

export interface DiagnosticFingerprintGroup {
  code: string | null;
  count: number;
  fingerprint: string;
  firstSeenMs: number;
  lastSeenMs: number;
  latestMessage: string;
  severity: DiagnosticSeverity;
  source: string;
}

interface DiagnosticFingerprintGroupRow {
  code: string | null;
  count: number | string;
  fingerprint: string;
  first_seen: string | Date;
  last_seen: string | Date;
  latest_message: string;
  severity: DiagnosticSeverity;
  source: string;
}

interface DiagnosticFingerprintCountRow {
  count: number | string;
  first_seen: string | Date | null;
  last_seen: string | Date | null;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Exported so consumers that need to bypass `queryEvents`'s hard-capped
 * limit/equality-severity filter (e.g. the app-shell durable log source,
 * which needs a `severity IN (...)` scan up to 2000 rows) can still reuse
 * this row->event mapping instead of duplicating it. */
export function mapDiagnosticEventRow(value: unknown): DiagnosticEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Diagnostic event row must be an object.');
  }
  // Single assertion after the object guard: the row interface keeps the
  // column types as machine-readable documentation (BST-1027 review).
  const row = value as DiagnosticEventRow;
  return {
    appVersion: row.app_version,
    causeChain: Array.isArray(row.cause_chain)
      ? (row.cause_chain as DiagnosticEvent['causeChain'])
      : null,
    code: row.code,
    context:
      row.context && typeof row.context === 'object' && !Array.isArray(row.context)
        ? (row.context as Record<string, unknown>)
        : null,
    fingerprint: row.fingerprint,
    id: row.id,
    message: row.message,
    occurredAt: toMs(row.occurred_at),
    platform: row.platform,
    resourceId: row.resource_id,
    rootId: row.root_id,
    runId: row.run_id,
    scope: row.scope,
    sessionId: row.session_id,
    severity: row.severity,
    source: row.source,
    stack: row.stack,
    threadId: row.thread_id,
  };
}

function mapDiagnosticFingerprintCountRow(value: unknown): DiagnosticFingerprintCountRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Diagnostic fingerprint count row must be an object.');
  }
  return value as DiagnosticFingerprintCountRow;
}

function mapDiagnosticFingerprintGroupRow(value: unknown): DiagnosticFingerprintGroup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Diagnostic fingerprint group row must be an object.');
  }
  const row = value as DiagnosticFingerprintGroupRow;
  return {
    code: row.code,
    count: Number(row.count),
    fingerprint: row.fingerprint,
    firstSeenMs: toMs(row.first_seen),
    lastSeenMs: toMs(row.last_seen),
    latestMessage: row.latest_message,
    severity: row.severity,
    source: row.source,
  };
}

const NUL = String.fromCharCode(0);
/** U+2400 SYMBOL FOR NULL: the visible stand-in stored in place of a NUL. */
const NUL_MARKER = String.fromCharCode(0x24_00);
/** U+FFFD: the replacement `String.prototype.toWellFormed` makes for a lone surrogate. */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xff_fd);
/** In `u` mode a well-formed pair is one astral code point, so only lone surrogates match. */
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/gu;
/** Reserved `context` key: per event field, how many characters were rewritten for storage. */
const STORAGE_REPLACEMENTS_KEY = 'storageReplacements';

type StorableTextField =
  | 'appVersion'
  | 'code'
  | 'fingerprint'
  | 'id'
  | 'message'
  | 'platform'
  | 'resourceId'
  | 'rootId'
  | 'runId'
  | 'scope'
  | 'sessionId'
  | 'source'
  | 'stack'
  | 'threadId';

type StorageReplacements = Record<string, number>;

function toStorableText(value: string, field: string, replacements: StorageReplacements): string {
  let count = 0;
  const storable = value
    .replaceAll(NUL, () => {
      count += 1;
      return NUL_MARKER;
    })
    .replace(LONE_SURROGATE_RE, () => {
      count += 1;
      return REPLACEMENT_CHARACTER;
    });
  if (count > 0) {
    replacements[field] = (replacements[field] ?? 0) + count;
  }
  return storable;
}

function toStorableJsonValue(
  value: unknown,
  field: string,
  replacements: StorageReplacements
): unknown {
  if (typeof value === 'string') {
    return toStorableText(value, field, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toStorableJsonValue(entry, field, replacements));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        toStorableText(key, field, replacements),
        toStorableJsonValue(entry, field, replacements),
      ])
    );
  }
  return value;
}

/**
 * PostgreSQL text cannot hold NUL (22021) and jsonb rejects NUL and lone-surrogate
 * escapes (22P05/22P02). One such row fails the whole multi-row INSERT, and the
 * writer re-queues that batch whole, so every retry fails until the writer disables
 * itself. Every stored string is therefore rewritten visibly, and the row records the
 * rewrite under `context.storageReplacements`.
 */
function toStorableRowParams(event: DiagnosticEvent): unknown[] {
  const replacements: StorageReplacements = {};
  const text = (field: StorableTextField): string | null => {
    const value = event[field];
    return value === null ? null : toStorableText(value, field, replacements);
  };
  // Round-trip through JSON first so the walk rewrites exactly what would be
  // stored: `toJSON` values (a Date, say) have no own entries to walk.
  const json = (field: 'causeChain' | 'context'): unknown =>
    event[field]
      ? toStorableJsonValue(JSON.parse(JSON.stringify(event[field])), field, replacements)
      : null;

  const row = {
    appVersion: text('appVersion'),
    causeChain: json('causeChain'),
    code: text('code'),
    context: json('context') as Record<string, unknown> | null,
    fingerprint: text('fingerprint'),
    id: text('id'),
    message: text('message'),
    platform: text('platform'),
    resourceId: text('resourceId'),
    rootId: text('rootId'),
    runId: text('runId'),
    scope: text('scope'),
    sessionId: text('sessionId'),
    source: text('source'),
    stack: text('stack'),
    threadId: text('threadId'),
  };
  const context =
    Object.keys(replacements).length === 0
      ? row.context
      : { ...row.context, [STORAGE_REPLACEMENTS_KEY]: replacements };
  return [
    row.id,
    new Date(event.occurredAt).toISOString(),
    event.severity,
    row.source,
    row.scope,
    row.code,
    row.message,
    row.stack,
    row.causeChain === null ? null : JSON.stringify(row.causeChain),
    context === null ? null : JSON.stringify(context),
    row.fingerprint,
    row.sessionId,
    row.runId,
    row.threadId,
    row.resourceId,
    row.rootId,
    row.appVersion,
    row.platform,
  ];
}

export class DiagnosticEventsRepository {
  private readonly db: DiagnosticEventsDatabase;
  private readonly now: () => Date;

  constructor(db: DiagnosticEventsDatabase, options?: { now?: () => Date }) {
    this.db = db;
    this.now = options?.now ?? (() => new Date());
  }

  async insertBatch(events: readonly DiagnosticEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const columns =
      '(id, occurred_at, severity, source, scope, code, message, stack, cause_chain, context, fingerprint, session_id, run_id, thread_id, resource_id, root_id, app_version, platform)';
    const params: unknown[] = [];
    const tuples = events.map((event, index) => {
      const base = index * 18;
      params.push(...toStorableRowParams(event));
      const placeholders = Array.from({ length: 18 }, (_, offset) => `$${base + offset + 1}`);
      return `(${placeholders.join(', ')})`;
    });
    try {
      await this.db.query(
        `INSERT INTO ${TABLE} ${columns} VALUES ${tuples.join(', ')} ON CONFLICT (id) DO NOTHING`,
        params
      );
    } catch (error) {
      throw new DiagnosticEventsStorageError('insert', error);
    }
  }

  async queryEvents(filter: DiagnosticEventsQueryFilter): Promise<DiagnosticEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown) => {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    };
    if (filter.severity) {
      push('severity = ?', filter.severity);
    }
    if (filter.threadId) {
      push('thread_id = ?', filter.threadId);
    }
    if (filter.runId) {
      push('run_id = ?', filter.runId);
    }
    if (filter.fingerprint) {
      push('fingerprint = ?', filter.fingerprint);
    }
    if (typeof filter.sinceMs === 'number') {
      push('occurred_at >= ?', new Date(filter.sinceMs).toISOString());
    }
    if (typeof filter.untilMs === 'number') {
      push('occurred_at <= ?', new Date(filter.untilMs).toISOString());
    }
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_QUERY_LIMIT, 1), DEFAULT_QUERY_LIMIT);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    try {
      const result = await this.db.query(
        `SELECT * FROM ${TABLE} ${where} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`,
        params
      );
      return result.rows.map(mapDiagnosticEventRow);
    } catch (error) {
      throw new DiagnosticEventsStorageError('query', error);
    }
  }

  async countByFingerprint(
    fingerprint: string,
    sinceMs: number
  ): Promise<{ count: number; firstSeenMs: number | null; lastSeenMs: number | null }> {
    try {
      const result = await this.db.query(
        `SELECT COUNT(*)::int AS count, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen
         FROM ${TABLE} WHERE fingerprint = $1 AND occurred_at >= $2`,
        [fingerprint, new Date(sinceMs).toISOString()]
      );
      const value = result.rows[0];
      const row = value === undefined ? undefined : mapDiagnosticFingerprintCountRow(value);
      return {
        count: Number(row?.count ?? 0),
        firstSeenMs: row?.first_seen ? toMs(row.first_seen) : null,
        lastSeenMs: row?.last_seen ? toMs(row.last_seen) : null,
      };
    } catch (error) {
      throw new DiagnosticEventsStorageError('query', error);
    }
  }

  async queryFingerprintGroups(
    filter: DiagnosticEventsQueryFilter
  ): Promise<DiagnosticFingerprintGroup[]> {
    const clauses: string[] = [];
    const latestClauses: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, operator: string, value: unknown) => {
      params.push(value);
      const placeholder = `$${params.length}`;
      clauses.push(`${column} ${operator} ${placeholder}`);
      latestClauses.push(`latest.${column} ${operator} ${placeholder}`);
    };
    if (filter.severity) {
      push('severity', '=', filter.severity);
    }
    if (filter.threadId) {
      push('thread_id', '=', filter.threadId);
    }
    if (filter.runId) {
      push('run_id', '=', filter.runId);
    }
    if (filter.fingerprint) {
      push('fingerprint', '=', filter.fingerprint);
    }
    if (typeof filter.sinceMs === 'number') {
      push('occurred_at', '>=', new Date(filter.sinceMs).toISOString());
    }
    if (typeof filter.untilMs === 'number') {
      push('occurred_at', '<=', new Date(filter.untilMs).toISOString());
    }
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_QUERY_LIMIT, 1), DEFAULT_QUERY_LIMIT);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const latestWhere = latestClauses.length > 0 ? `AND ${latestClauses.join(' AND ')}` : '';
    try {
      const result = await this.db.query(
        `WITH grouped AS (
           SELECT
             fingerprint,
             COUNT(*)::int AS count,
             MIN(occurred_at) AS first_seen,
             MAX(occurred_at) AS last_seen
           FROM ${TABLE}
           ${where}
           GROUP BY fingerprint
           ORDER BY count DESC, last_seen DESC, fingerprint ASC
           LIMIT ${limit}
         )
         SELECT
           grouped.fingerprint,
           grouped.count,
           grouped.first_seen,
           grouped.last_seen,
           latest.severity,
           latest.source,
           latest.code,
           latest.message AS latest_message
         FROM grouped
         JOIN LATERAL (
           SELECT severity, source, code, message
           FROM ${TABLE} AS latest
           WHERE latest.fingerprint = grouped.fingerprint
             ${latestWhere}
           ORDER BY latest.occurred_at DESC, latest.id DESC
           LIMIT 1
         ) AS latest ON true
         ORDER BY grouped.count DESC, grouped.last_seen DESC, grouped.fingerprint ASC`,
        params
      );
      return result.rows.map(mapDiagnosticFingerprintGroupRow);
    } catch (error) {
      throw new DiagnosticEventsStorageError('query', error);
    }
  }

  /** Bounded oldest-first purge past the age OR row bound. Never an unbounded DELETE. */
  async purge(options?: { maxAgeMs?: number; maxRows?: number; limit?: number }): Promise<number> {
    const maxAgeMs = options?.maxAgeMs ?? DIAGNOSTIC_RETENTION_MAX_AGE_MS;
    const maxRows = options?.maxRows ?? DIAGNOSTIC_RETENTION_MAX_ROWS;
    const limit = options?.limit ?? DIAGNOSTIC_EVENTS_PURGE_LIMIT;
    const cutoffMs = Math.max(0, this.now().getTime() - maxAgeMs);
    const cutoff = new Date(cutoffMs).toISOString();
    try {
      const aged = await this.db.query(
        `DELETE FROM ${TABLE} WHERE id IN (
           SELECT id FROM ${TABLE} WHERE occurred_at < $1 ORDER BY occurred_at ASC LIMIT ${limit}
         ) RETURNING id`,
        [cutoff]
      );
      const overCap = await this.db.query(
        `DELETE FROM ${TABLE} WHERE id IN (
           SELECT id FROM ${TABLE} ORDER BY occurred_at DESC, id DESC OFFSET $1 LIMIT ${limit}
         ) RETURNING id`,
        [maxRows]
      );
      return aged.rows.length + overCap.rows.length;
    } catch (error) {
      throw new DiagnosticEventsStorageError('purge', error);
    }
  }
}
