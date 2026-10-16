import { type DiagnosticEventsDatabase, mapDiagnosticEventRow } from '@brainstrike/db';
import { LogLevel, type LogRecord } from '@brainstrike/logging';
import type { LogSourceAdapter } from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import {
  type DiagnosticEvent,
  serializeDiagnosticEventsNdjson,
} from '@brainstrike/utils/diagnostics';

/**
 * Renderer-side `LogSourceAdapter` (Flight Recorder P2a) that lets the
 * Logs tab's viewer render durable `brainstrike_diagnostic_events`
 * rows out of PGlite alongside the in-memory renderer/main log sources.
 */

export const DURABLE_LOG_SOURCE_POLL_MS = 5000;
export const DURABLE_LOG_SOURCE_MAX_ROWS = 2000;

const TABLE = 'brainstrike_diagnostic_events';

const LOG_LEVEL_BY_SEVERITY: Record<DiagnosticEvent['severity'], LogLevel> = {
  error: LogLevel.ERROR,
  fatal: LogLevel.FATAL,
  warn: LogLevel.WARN,
};

interface DiagnosticCountRow {
  count: number | string;
}

function mapDiagnosticCountRow(value: unknown): DiagnosticCountRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Diagnostic count row must be an object.');
  }
  return value as DiagnosticCountRow;
}

function buildBindings(event: DiagnosticEvent): Record<string, unknown> {
  const bindings: Record<string, unknown> = {
    appVersion: event.appVersion,
    fingerprint: event.fingerprint,
    platform: event.platform,
    // `runtime` is what the viewer's internal `getRuntimeSource` reads for
    // its source-coverage footer, so the diagnostic event's origin (not a
    // literal "runtime") is deliberately placed there.
    runtime: event.source,
    sessionId: event.sessionId,
  };
  if (event.code !== null) {
    bindings['code'] = event.code;
  }
  if (event.runId !== null) {
    bindings['runId'] = event.runId;
  }
  if (event.threadId !== null) {
    bindings['threadId'] = event.threadId;
  }
  if (event.resourceId !== null) {
    bindings['resourceId'] = event.resourceId;
  }
  if (event.rootId !== null) {
    bindings['rootId'] = event.rootId;
  }
  return bindings;
}

function buildArgs(event: DiagnosticEvent): [Record<string, unknown>] {
  return [
    {
      logSource: event.source,
      ...(event.stack ? { stack: event.stack } : {}),
      ...(event.causeChain ? { causeChain: event.causeChain } : {}),
      ...(event.context ?? {}),
    },
  ];
}

export function diagnosticEventToLogRecord(event: DiagnosticEvent): LogRecord {
  return {
    args: buildArgs(event),
    bindings: buildBindings(event),
    level: LOG_LEVEL_BY_SEVERITY[event.severity],
    message: event.message,
    // `event.scope ?? undefined` is the mapping rule's intent, but
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
    // optional string property — omit the key instead, which is
    // observationally identical (`record.scope` reads as `undefined`).
    ...(event.scope === null ? {} : { scope: event.scope }),
    timestamp: event.occurredAt,
  };
}

function createFailureRecord(error: unknown): LogRecord {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    args: [{ reason }],
    bindings: { runtime: 'durable-log-source' },
    level: LogLevel.WARN,
    message: `Failed to load diagnostic events from the database: ${reason}`,
    scope: 'DurableLogSource',
    timestamp: Date.now(),
  };
}

/**
 * Result of `DurableLogSource.exportNdjson()`. The desktop NDJSON backstop
 * retains far more history (10 MB x 5 rotated files) than this bounded
 * `DURABLE_LOG_SOURCE_MAX_ROWS`-row query, so a web/renderer export CAN be a
 * strict subset of everything that ever happened — per "no silent caps"
 * (AGENTS.md), that must be visible, not just the honest-equivalent framing
 * in isolation. `truncated`/`totalCount` let the caller (the settings
 * section's export button handler) tell the user the export is the most
 * recent `exportedCount` of `totalCount` events, rather than presenting a
 * capped file as if it were complete.
 */
export interface DurableLogExportResult {
  /** Number of events actually included in `ndjson` — bounded by `limit`
   * (`DURABLE_LOG_SOURCE_MAX_ROWS` by default), the same cap
   * `loadEventsAscending` applies to the Log Viewer itself. */
  readonly exportedCount: number;
  readonly ndjson: string;
  /** Total warn+ events currently eligible (severity IN warn/error/fatal),
   * independent of the export cap. Equal to `exportedCount` when the export
   * was not truncated. */
  readonly totalCount: number;
  /** `true` when `totalCount > exportedCount` — older events beyond the cap
   * exist but are NOT included in `ndjson`. */
  readonly truncated: boolean;
}

/**
 * `LogSourceAdapter` widened with the NDJSON export affordance (Flight
 * Recorder P2a Task 6). Web has no filesystem, so this in-memory string is
 * the honest web equivalent of the desktop rotating
 * `brainstrike-errors.ndjson` file (design doc §7).
 */
export type DurableLogSource = LogSourceAdapter & {
  exportNdjson(): Promise<DurableLogExportResult>;
};

export interface CreateDurableLogSourceOptions {
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly db: DiagnosticEventsDatabase;
  readonly limit?: number;
  readonly pollMs?: number;
  readonly setInterval?: typeof globalThis.setInterval;
}

export function createDurableLogSource(options: CreateDurableLogSourceOptions): DurableLogSource {
  const { db } = options;
  const limit = options.limit ?? DURABLE_LOG_SOURCE_MAX_ROWS;
  const pollMs = options.pollMs ?? DURABLE_LOG_SOURCE_POLL_MS;
  const schedule = options.setInterval ?? globalThis.setInterval.bind(globalThis);
  const cancel = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);

  // Direct SQL rather than `DiagnosticEventsRepository.queryEvents`: that
  // method hard-caps `limit` at 200 and its `severity` filter is equality
  // (not a minimum), so it cannot serve a 2000-row warn-and-above view. The
  // row mapping is still reused from the repository (`mapDiagnosticEventRow`)
  // to avoid duplicating it here.
  //
  // Single source of truth for both the viewer and the NDJSON export
  // (Task 6): `loadEventsAscending` is the one bounded query, and both
  // `loadRecordsAscending` (viewer) and `exportNdjson` (download) derive
  // from it rather than issuing a second, potentially divergent query.
  async function loadEventsAscending(): Promise<DiagnosticEvent[]> {
    const result = await db.query(
      `SELECT * FROM ${TABLE} WHERE severity IN ('warn', 'error', 'fatal') ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapDiagnosticEventRow).toReversed();
  }

  async function loadRecordsAscending(): Promise<LogRecord[]> {
    const events = await loadEventsAscending();
    return events.map(diagnosticEventToLogRecord);
  }

  // A separate COUNT query (same severity filter, no LIMIT) rather than
  // querying `limit + 1` rows: this needs the exact total for the "most
  // recent N of M" toast message, not just a yes/no truncation flag, and a
  // COUNT scan is no more expensive than the row query it runs alongside.
  async function countEligibleEvents(): Promise<number> {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM ${TABLE} WHERE severity IN ('warn', 'error', 'fatal')`
    );
    const value = result.rows[0];
    return Number(value === undefined ? 0 : (mapDiagnosticCountRow(value).count ?? 0));
  }

  // Deliberately no try/catch here, unlike `loadRecordsAscending` (which
  // falls back to a synthetic WARN record so the viewer never throws): a
  // rejected export must propagate so the caller (the settings section's
  // export button handler) can surface it visibly via toast, per the "no
  // silent fallbacks" rule. Swallowing it into an NDJSON line would make a
  // failed export look like a successful-but-empty one. Same rule applies to
  // `countEligibleEvents` above — a rejection from either query in the
  // `Promise.all` below propagates unchanged.
  async function exportNdjson(): Promise<DurableLogExportResult> {
    const [events, totalCount] = await Promise.all([loadEventsAscending(), countEligibleEvents()]);
    const exportedCount = events.length;
    return {
      exportedCount,
      ndjson: serializeDiagnosticEventsNdjson(events),
      totalCount,
      truncated: totalCount > exportedCount,
    };
  }

  async function getInitialRecords(): Promise<readonly LogRecord[]> {
    try {
      return await loadRecordsAscending();
    } catch (error) {
      return [createFailureRecord(error)];
    }
  }

  // Polling, not a live query: `LogSourceAdapter` is an imperative contract
  // (getInitialRecords/subscribe), while `usePGliteLiveQuery` is a React
  // hook — the two shapes don't compose here. The viewer's Refresh button
  // already covers on-demand re-fetch via getInitialRecords; polling covers
  // the gap between refreshes for this v1.
  function subscribe(handler: (records: readonly LogRecord[]) => void): () => void {
    let disposed = false;
    // Monotonic request counter: polls can overlap (a slow tick N still
    // in-flight when tick N+1 fires). Without this, whichever query
    // resolves LAST wins the handler call regardless of which one was
    // issued last, so a stale snapshot can silently clobber a newer one.
    // Each emit() captures its own requestId; only the result whose
    // requestId still matches the latest-issued one is delivered.
    let latestRequestId = 0;

    const emit = () => {
      const requestId = ++latestRequestId;
      loadRecordsAscending()
        .then((records) => {
          if (!disposed && requestId === latestRequestId) {
            handler(records);
          }
        })
        .catch((error) => {
          if (!disposed && requestId === latestRequestId) {
            handler([createFailureRecord(error)]);
          }
        });
    };

    emit();
    const timer = schedule(emit, pollMs);

    return () => {
      disposed = true;
      cancel(timer);
    };
  }

  return { exportNdjson, getInitialRecords, subscribe };
}
