import { randomUUID } from 'node:crypto';
import type { LogRecord } from '@brainstrike/logging';
import {
  deriveDiagnosticRecordSource,
  logRecordToDiagnosticEvent,
  serializeDiagnosticEventLine,
} from '@brainstrike/utils/diagnostics';
import { DEFAULT_MAX_FILES, RotatingFileSink } from './rotating-file-sink';

/** Base filename for the durable NDJSON backstop, shared with factory reset
 * (`desktop-factory-reset.ts`, via `listErrorLogFilePaths` below) so the
 * writer and the purge logic can never drift onto different filenames. */
export const ERROR_LOG_FILE_NAME = 'brainstrike-errors.ndjson';

/**
 * Every on-disk path `createErrorLogSink({filePath})` can occupy: the live
 * file plus every rotated-sibling slot (`.1`…`.{maxFiles - 1}`), mirroring
 * `RotatingFileSink`'s rotation slot math (`rotatedPath`) exactly. Factory
 * reset uses this to purge the durable backstop without depending on the
 * sink's rotation internals directly.
 */
export function listErrorLogFilePaths(
  filePath: string,
  maxFiles: number = DEFAULT_MAX_FILES
): string[] {
  const paths = [filePath];
  for (let index = 1; index < maxFiles; index += 1) {
    paths.push(`${filePath}.${index}`);
  }
  return paths;
}

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

/** The ONE deliberate exception to "never call the logger from this module"
 * (see module doc): a single raw `console.error`, reused by both the
 * underlying sink's `onFailure` (write/rotate/open failures) and the
 * try/catch in `recordLogRecord` below (conversion/serialization failures).
 * A `logger.*` call here would re-enter the very listener that feeds this
 * sink and recurse without bound. */
function reportSinkFailure(context: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: the durable backstop sink must never call the logger it is fed by (see module doc) — this is the one deliberate exception.
  console.error(`[error-log-sink] ${context}`, error);
}

/**
 * Wraps a `RotatingFileSink` with the LogRecord → DiagnosticEvent → NDJSON
 * line pipeline, for the Electron main process durable backstop (Flight
 * Recorder P2a Task 3).
 *
 * This is fed by a log listener (see `logging-ipc.ts` and `main.ts`), so —
 * same rule as `RotatingFileSink` — NEVER import or call
 * `@brainstrike/logging` from this module. See `reportSinkFailure`.
 */
export function createErrorLogSink(options: CreateErrorLogSinkOptions): ErrorLogSinkHandle {
  const sink = new RotatingFileSink({
    filePath: options.filePath,
    onFailure: (error) => {
      reportSinkFailure('durable NDJSON error log disabled after a write failure', error);
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
      // `sink.writeLine` is contractually never-throwing (see
      // rotating-file-sink.ts), but `logRecordToDiagnosticEvent` and
      // `serializeDiagnosticEventLine` are NOT — e.g. a BigInt anywhere in
      // `record.args`/context throws out of `JSON.stringify`. This tap is
      // called synchronously from inside `addLogListener` (see
      // logging-ipc.ts), so an uncaught throw here would escape into
      // whatever code emitted the original log call. Never let a
      // malformed/unusual record silently kill the caller — report once via
      // the same raw console.error path as a sink write failure instead.
      try {
        const event = logRecordToDiagnosticEvent(record, {
          appVersion: options.appVersion,
          makeId: () => randomUUID(),
          platform: options.platform,
          sessionId: options.sessionId,
          source: deriveDiagnosticRecordSource(record),
        });
        if (!event) {
          return;
        }
        sink.writeLine(serializeDiagnosticEventLine(event));
      } catch (error) {
        reportSinkFailure('failed to convert/serialize a log record — record dropped', error);
      }
    },
  };
}
