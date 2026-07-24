import { randomUUID } from 'node:crypto';
import {
  logRecordToDiagnosticEvent,
  serializeDiagnosticEventLine,
} from '@brainstrike/utils/diagnostics';
import type { LogRecord } from '@brainstrike/utils/logger';
import { RotatingNdjsonSink } from './rotating-ndjson-sink';

export interface ErrorLogSinkHandle {
  close(): void;
  readonly filePath: string;
  /** Warn+ filtering is the CALLER's job (already done upstream by
   * `DURABLE_PUSH_LEVELS` in logging-ipc.ts); this converts and appends
   * unconditionally, relying on `logRecordToDiagnosticEvent` returning
   * `null` as a second, independent floor check. */
  recordLogRecord(record: LogRecord): void;
}

export interface CreateErrorLogSinkOptions {
  readonly appVersion: string;
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly platform: string;
  readonly sessionId: string;
}

/** Mirrors the renderer bridge's source derivation exactly
 * (`packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx`,
 * `deriveForwardedRecordSource`) so a desktop main-process record and the
 * same record forwarded to a renderer sink resolve to the same `source`. */
function deriveSource(record: LogRecord): string {
  if (record.bindings['runtime'] === 'electron-main') {
    return 'electron-main';
  }
  return String(record.bindings['sourceWindowRole'] ?? 'hidden-host');
}

/**
 * Wraps a `RotatingNdjsonSink` with the LogRecord → DiagnosticEvent → NDJSON
 * line pipeline, for the Electron main process durable backstop (Flight
 * Recorder P2a Task 3).
 *
 * This is fed by a log listener (see `logging-ipc.ts` and `main.ts`), so —
 * same rule as `RotatingNdjsonSink` — NEVER import or call
 * `@brainstrike/utils/logger` from this module or from the `onFailure`
 * callback below. A `logger.*` call here would re-enter the very listener
 * that calls `recordLogRecord`, recursing without bound. Failures are
 * reported exactly once via a single raw `console.error` instead.
 */
export function createErrorLogSink(options: CreateErrorLogSinkOptions): ErrorLogSinkHandle {
  const sink = new RotatingNdjsonSink({
    filePath: options.filePath,
    onFailure: (error) => {
      // biome-ignore lint/suspicious/noConsole: the durable backstop sink must never call the logger it is fed by (see module doc) — this is the one deliberate exception.
      console.error(
        '[error-log-sink] durable NDJSON error log disabled after a write failure',
        error
      );
    },
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });

  return {
    close(): void {
      sink.close();
    },
    filePath: options.filePath,
    recordLogRecord(record: LogRecord): void {
      const event = logRecordToDiagnosticEvent(record, {
        appVersion: options.appVersion,
        makeId: () => randomUUID(),
        platform: options.platform,
        sessionId: options.sessionId,
        source: deriveSource(record),
      });
      if (!event) {
        return;
      }
      sink.writeLine(serializeDiagnosticEventLine(event));
    },
  };
}
