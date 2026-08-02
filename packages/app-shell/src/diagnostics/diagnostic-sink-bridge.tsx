import { useDiagnosticsRetentionStore } from '@brainstrike/app-state/stores/diagnostics-retention-store';
import { DiagnosticEventsRepository } from '@brainstrike/db';
import { useOptionalPGliteDatabase } from '@brainstrike/db/react';
import { addLogListener, createLogger, type LogRecord } from '@brainstrike/logging';
import {
  boundWithMarker,
  DIAGNOSTIC_MESSAGE_MAX_CHARS,
  type DiagnosticEvent,
  DiagnosticEventWriter,
  deriveDiagnosticRecordSource,
  logRecordToDiagnosticEvent,
} from '@brainstrike/utils/diagnostics';
import { useEffect, useRef } from 'react';
import { useDiagnosticSinkHealthStore } from './diagnostic-sink-health-store';
import { DIAGNOSTIC_SINK_SCOPE, getDiagnosticSessionId } from './diagnostic-sink-session';

const bridgeLogger = createLogger(DIAGNOSTIC_SINK_SCOPE);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeDroppedEvent(source: string) {
  return (droppedCount: number): DiagnosticEvent => ({
    appVersion: readAppVersion(),
    causeChain: null,
    code: 'diagnostics_events_dropped',
    context: { droppedCount },
    fingerprint: 'diagnostics_events_dropped',
    id: crypto.randomUUID(),
    message: `Diagnostic sink overflow: dropped ${droppedCount} events before this flush.`,
    occurredAt: Date.now(),
    platform: readPlatform(),
    resourceId: null,
    rootId: null,
    runId: null,
    scope: DIAGNOSTIC_SINK_SCOPE,
    sessionId: getDiagnosticSessionId(),
    severity: 'warn',
    source,
    stack: null,
    threadId: null,
  });
}

function readAppVersion(): string {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  return typeof env?.['VITE_APP_VERSION'] === 'string'
    ? (env['VITE_APP_VERSION'] as string)
    : 'dev';
}

function readPlatform(): string {
  return typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'unknown';
}

export interface ForwardedRecordsSubscription {
  subscribe(listener: (record: LogRecord) => void): () => void;
}

export interface DiagnosticSinkBridgeProps {
  readonly flushBatchSize?: number;
  /** Desktop main → renderer durable-record push (Task 6): when present, the
   * bridge also subscribes to main/hidden-host warn+ records pushed over
   * `logging:durable-record` and enqueues them into the SAME writer. Omitted
   * entirely by callers whose preload predates this bridge — capability by
   * composition, no silent no-op prop. */
  readonly forwardedRecords?: ForwardedRecordsSubscription;
  readonly source: string;
}

/** Render-nothing bridge: logger fan-out → batched writer → PGlite (design §4.3).
 * Mounted ONLY in the visible web + desktop renderers (capability by composition —
 * hidden hosts never mount it). */
export function DiagnosticSinkBridge({
  flushBatchSize,
  forwardedRecords,
  source,
}: DiagnosticSinkBridgeProps): null {
  const db = useOptionalPGliteDatabase();
  const activeDatabaseRef = useRef<unknown>(null);

  useEffect(() => {
    if (!db) {
      activeDatabaseRef.current = null;
      return;
    }
    const databaseChanged = activeDatabaseRef.current !== db;
    activeDatabaseRef.current = db;
    if (databaseChanged) {
      // Clear only for a new database identity. Other dependencies can rebuild
      // the writer but must not erase a genuine failure for the same database.
      useDiagnosticSinkHealthStore.getState().clear();
    }
    let active = true;
    const repository = new DiagnosticEventsRepository(db);
    const writer = new DiagnosticEventWriter({
      ...(flushBatchSize === undefined ? {} : { flushBatchSize }),
      makeDroppedEvent: makeDroppedEvent(source),
      onDisabled: (cause) => {
        if (!active) {
          return;
        }
        const reason = boundWithMarker(
          cause instanceof Error ? cause.message : String(cause),
          DIAGNOSTIC_MESSAGE_MAX_CHARS
        );
        // Loop guard: this scope is excluded from capture below, so the sink
        // failure is loud (console/file) without recursing into the sink.
        bridgeLogger.error('Diagnostic event sink disabled after repeated flush failures', {
          cause: reason,
        });
        // The health store is the ONLY channel this signal can reach the
        // settings UI through — see diagnostic-sink-health-store.ts for why.
        useDiagnosticSinkHealthStore.getState().markDisabled(reason);
      },
      sink: repository,
    });
    const env = {
      appVersion: readAppVersion(),
      makeId: () => crypto.randomUUID(),
      platform: readPlatform(),
      sessionId: getDiagnosticSessionId(),
      source,
    };
    const unsubscribe = addLogListener((record) => {
      if (record.scope === DIAGNOSTIC_SINK_SCOPE) {
        return;
      }
      const event = logRecordToDiagnosticEvent(record, env);
      if (event) {
        writer.enqueue(event);
        // Browsers don't guarantee async work started in visibilitychange:hidden
        // completes, so high-severity events must not wait for the batch window.
        if (event.severity !== 'warn') {
          void writer.flush();
        }
      }
    });
    const unsubscribeForwarded = forwardedRecords?.subscribe((record) => {
      // Same loop guard as the local logger fan-out above.
      if (record.scope === DIAGNOSTIC_SINK_SCOPE) {
        return;
      }
      const event = logRecordToDiagnosticEvent(record, {
        ...env,
        source: deriveDiagnosticRecordSource(record),
      });
      if (event) {
        writer.enqueue(event);
        // Same eager-flush rationale as the local logger fan-out above.
        if (event.severity !== 'warn') {
          void writer.flush();
        }
      }
    });
    // Read (not subscribe): a one-off value at mount time is correct here —
    // the startup purge runs once per mount, so it should use whatever the
    // user's retention preference was AT that moment, not re-run if the
    // preference changes later in the same session (Task 4's "Purge now"
    // button is the explicit re-run affordance for that).
    const { maxAgeDays, maxRows } = useDiagnosticsRetentionStore.getState();
    repository.purge({ maxAgeMs: maxAgeDays * MS_PER_DAY, maxRows }).catch((cause: unknown) => {
      bridgeLogger.error('Diagnostic retention purge failed', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void writer.flush();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // Disposal can finish an in-flight flush asynchronously. Retire this
      // generation first so its late failure cannot describe the next writer.
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      unsubscribeForwarded?.();
      void writer.dispose();
    };
  }, [db, flushBatchSize, forwardedRecords, source]);

  return null;
}
