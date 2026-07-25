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
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
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

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Exported so consumers that need to bypass `queryEvents`'s hard-capped
 * limit/equality-severity filter (e.g. the app-shell durable log source,
 * which needs a `severity IN (...)` scan up to 2000 rows) can still reuse
 * this row->event mapping instead of duplicating it. */
export function mapDiagnosticEventRow(row: DiagnosticEventRow): DiagnosticEvent {
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
      params.push(
        event.id,
        new Date(event.occurredAt).toISOString(),
        event.severity,
        event.source,
        event.scope,
        event.code,
        event.message,
        event.stack,
        event.causeChain ? JSON.stringify(event.causeChain) : null,
        event.context ? JSON.stringify(event.context) : null,
        event.fingerprint,
        event.sessionId,
        event.runId,
        event.threadId,
        event.resourceId,
        event.rootId,
        event.appVersion,
        event.platform
      );
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
      const result = await this.db.query<DiagnosticEventRow>(
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
      const result = await this.db.query<{
        count: number | string;
        first_seen: string | Date | null;
        last_seen: string | Date | null;
      }>(
        `SELECT COUNT(*)::int AS count, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen
         FROM ${TABLE} WHERE fingerprint = $1 AND occurred_at >= $2`,
        [fingerprint, new Date(sinceMs).toISOString()]
      );
      const row = result.rows[0];
      return {
        count: Number(row?.count ?? 0),
        firstSeenMs: row?.first_seen ? toMs(row.first_seen) : null,
        lastSeenMs: row?.last_seen ? toMs(row.last_seen) : null,
      };
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
      const aged = await this.db.query<{ id: string }>(
        `DELETE FROM ${TABLE} WHERE id IN (
           SELECT id FROM ${TABLE} WHERE occurred_at < $1 ORDER BY occurred_at ASC LIMIT ${limit}
         ) RETURNING id`,
        [cutoff]
      );
      const overCap = await this.db.query<{ id: string }>(
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
