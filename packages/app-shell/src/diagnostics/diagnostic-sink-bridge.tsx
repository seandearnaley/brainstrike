import { DiagnosticEventsRepository, useOptionalPGliteDatabase } from '@brainstrike/db';
import {
  type DiagnosticEvent,
  DiagnosticEventWriter,
  logRecordToDiagnosticEvent,
} from '@brainstrike/utils/diagnostics';
import { addLogListener, createLogger, type LogRecord } from '@brainstrike/utils/logger';
import { useEffect } from 'react';

export const DIAGNOSTIC_SINK_SCOPE = 'DiagnosticSink';

let sessionId: string | null = null;
export function getDiagnosticSessionId(): string {
  sessionId ??= crypto.randomUUID();
  return sessionId;
}

const bridgeLogger = createLogger(DIAGNOSTIC_SINK_SCOPE);

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

function deriveForwardedRecordSource(record: LogRecord): string {
  if (record.bindings['runtime'] === 'electron-main') {
    return 'electron-main';
  }
  return String(record.bindings['sourceWindowRole'] ?? 'hidden-host');
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

  useEffect(() => {
    if (!db) {
      return;
    }
    const repository = new DiagnosticEventsRepository(db);
    const writer = new DiagnosticEventWriter({
      ...(flushBatchSize === undefined ? {} : { flushBatchSize }),
      makeDroppedEvent: makeDroppedEvent(source),
      onDisabled: (cause) => {
        // Loop guard: this scope is excluded from capture below, so the sink
        // failure is loud (console/file) without recursing into the sink.
        bridgeLogger.error('Diagnostic event sink disabled after repeated flush failures', {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
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
      }
    });
    const unsubscribeForwarded = forwardedRecords?.subscribe((record) => {
      // Same loop guard as the local logger fan-out above.
      if (record.scope === DIAGNOSTIC_SINK_SCOPE) {
        return;
      }
      const event = logRecordToDiagnosticEvent(record, {
        ...env,
        source: deriveForwardedRecordSource(record),
      });
      if (event) {
        writer.enqueue(event);
      }
    });
    repository.purge().catch((cause: unknown) => {
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
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      unsubscribeForwarded?.();
      void writer.dispose();
    };
  }, [db, flushBatchSize, forwardedRecords, source]);

  return null;
}
