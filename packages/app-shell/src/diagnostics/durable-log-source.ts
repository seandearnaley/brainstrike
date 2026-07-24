import {
  type DiagnosticEventRow,
  type DiagnosticEventsDatabase,
  mapDiagnosticEventRow,
} from '@brainstrike/db';
import type { LogSourceAdapter } from '@brainstrike/preferences';
import {
  type DiagnosticEvent,
  serializeDiagnosticEventsNdjson,
} from '@brainstrike/utils/diagnostics';
import { LogLevel, type LogRecord } from '@brainstrike/utils/logger';

/**
 * Renderer-side `LogSourceAdapter` (Flight Recorder P2a) that lets the
 * existing settings Log Viewer render durable `brainstrike_diagnostic_events`
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
 * `LogSourceAdapter` widened with the NDJSON export affordance (Flight
 * Recorder P2a Task 6). Web has no filesystem, so this in-memory string is
 * the honest web equivalent of the desktop rotating
 * `brainstrike-errors.ndjson` file (design doc §7).
 */
export type DurableLogSource = LogSourceAdapter & {
  exportNdjson(): Promise<string>;
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
    const result = await db.query<DiagnosticEventRow>(
      `SELECT * FROM ${TABLE} WHERE severity IN ('warn', 'error', 'fatal') ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapDiagnosticEventRow).toReversed();
  }

  async function loadRecordsAscending(): Promise<LogRecord[]> {
    const events = await loadEventsAscending();
    return events.map(diagnosticEventToLogRecord);
  }

  // Deliberately no try/catch here, unlike `loadRecordsAscending` (which
  // falls back to a synthetic WARN record so the viewer never throws): a
  // rejected export must propagate so the caller (the settings section's
  // export button handler) can surface it visibly via toast, per the "no
  // silent fallbacks" rule. Swallowing it into an NDJSON line would make a
  // failed export look like a successful-but-empty one.
  async function exportNdjson(): Promise<string> {
    const events = await loadEventsAscending();
    return serializeDiagnosticEventsNdjson(events);
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
