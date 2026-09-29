import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_MAX_FILES } from './rotating-file-sink';

export interface MainLogWindowRequest {
  readonly since: string;
  readonly until: string;
}

export interface MainLogWindowFile {
  readonly firstTime: string | null;
  readonly lastTime: string | null;
  readonly name: string;
}

export interface MainLogWindowCounts {
  readonly emptyChildResults: number;
  readonly toolTimeouts: number;
  readonly unhandledRejections: number;
  readonly wasmAllocationFailures: number;
}

export interface MainLogWindowResult {
  /** Failure markers counted over EVERY level inside the window, not only the kept lines. */
  readonly counts: MainLogWindowCounts;
  /** Warn+ lines inside the window that fell outside the line/byte caps (oldest dropped first). */
  readonly droppedLineCount: number;
  readonly files: readonly MainLogWindowFile[];
  /** Raw pino JSON lines, level >= warn, chronological. */
  readonly lines: readonly string[];
  readonly malformedLineCount: number;
  /** Every parseable line inside the window, any level. */
  readonly scannedLineCount: number;
  readonly since: string;
  readonly truncated: boolean;
  readonly until: string;
}

export const MAIN_LOG_WINDOW_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxLines: 2000,
  maxWindowMs: 24 * 60 * 60 * 1000,
  /** Rotated siblings the transport keeps beside the live file (`brainstrike.log.1`…). */
  rotatedSlots: DEFAULT_MAX_FILES - 1,
} as const;

const WARN_LEVEL = 40;
const FUTURE_TOLERANCE_MS = 60_000;
const MARKERS: Record<keyof MainLogWindowCounts, RegExp> = {
  emptyChildResults: /subagent_delegation_empty_result/,
  toolTimeouts: /Tool execution timed out/,
  unhandledRejections: /Unhandled promise rejection/,
  wasmAllocationFailures: /Cannot allocate Wasm memory/,
};
// Deliberately coupled to the sink's timestamp setting: the desktop main
// logger configures pino's `isoTime`, which writes `"time":"<ISO>"`. Pino's
// DEFAULT `timestamp: true` (epoch millis) and `includeTimestamp: false` (no
// field) both fail this match, and `readRecordTime` then throws on the first
// record rather than silently misplacing every line in the window.
const TIME_FIELD = /"time":"([^"]+)"/;

/**
 * Exactly `Date#toISOString()` output — the millisecond form pino's `isoTime`
 * stamps on every line — because `scanFile` orders instants as strings. A
 * whole-second or shorter-fraction bound would misorder (`…00.500Z` < `…00Z`).
 */
function isIsoInstant(value: unknown): value is string {
  // Expanded-year instants (`+275760-…`) round-trip too, but are 27 chars and
  // sort before every line the sink writes, so the length is part of the form.
  if (typeof value !== 'string' || value.length !== 24) {
    return false;
  }
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

/** Throws on anything but a bounded, past, well-ordered millisecond ISO-8601 UTC window. */
export function assertMainLogWindowRequest(value: unknown, now: number): MainLogWindowRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Main log window request must be an object.');
  }
  const { since, until } = value as { since?: unknown; until?: unknown };
  if (!isIsoInstant(since)) {
    throw new Error(
      'Main log window since must be a millisecond ISO-8601 UTC instant (Date#toISOString).'
    );
  }
  if (!isIsoInstant(until)) {
    throw new Error(
      'Main log window until must be a millisecond ISO-8601 UTC instant (Date#toISOString).'
    );
  }
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (untilMs < sinceMs) {
    throw new Error('Main log window until must not precede since.');
  }
  if (untilMs - sinceMs > MAIN_LOG_WINDOW_LIMITS.maxWindowMs) {
    throw new Error('Main log window may span at most 24 hours.');
  }
  if (untilMs > now + FUTURE_TOLERANCE_MS) {
    throw new Error('Main log window until must not be in the future.');
  }
  return { since, until };
}

/**
 * Oldest first, so `lines` comes out chronological: `.4`, `.3`, … `.1`, live.
 * A missing rotated slot is normal (fewer rotations than slots); a missing
 * LIVE file is not — file logging is on, so its absence is reported, never
 * read as an empty window.
 */
async function candidateFiles(logFilePath: string): Promise<string[]> {
  const present: string[] = [];
  for (let slot = MAIN_LOG_WINDOW_LIMITS.rotatedSlots; slot >= 1; slot -= 1) {
    const candidate = `${logFilePath}.${slot}`;
    try {
      await access(candidate);
      present.push(candidate);
    } catch {
      // Fewer rotations than slots.
    }
  }
  try {
    await access(logFilePath);
  } catch (error) {
    throw new Error(
      `Main log file ${path.basename(logFilePath)} is not readable at ${logFilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  present.push(logFilePath);
  return present;
}

function isJsonRecord(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * The line's ISO time, or null for a crash-truncated line (counted, never
 * thrown). A whole record without a time — the log written with timestamps
 * disabled — cannot be placed in any window, and reading it as empty would
 * hide every failure marker, so it throws.
 *
 * `lineNumber` is the PHYSICAL 1-based line — `scanFile` counts blank lines
 * before it skips them — so the operator-facing message points at the line an
 * editor or `sed -n '<n>p'` lands on, not at an Nth non-blank record.
 */
function readRecordTime(raw: string, lineNumber: number, filePath: string): string | null {
  const time = TIME_FIELD.exec(raw)?.[1] ?? null;
  if (time !== null || !isJsonRecord(raw)) {
    return time;
  }
  throw new Error(
    `Main log line ${lineNumber} of ${path.basename(filePath)} has no ISO "time" field, so the window cannot place it.`
  );
}

class KeptLines {
  readonly lines: string[] = [];
  droppedLineCount = 0;
  private bytes = 0;

  push(raw: string): void {
    this.lines.push(raw);
    this.bytes += Buffer.byteLength(raw, 'utf8');
    while (
      this.lines.length > MAIN_LOG_WINDOW_LIMITS.maxLines ||
      this.bytes > MAIN_LOG_WINDOW_LIMITS.maxBytes
    ) {
      const dropped = this.lines.shift() as string;
      this.bytes -= Buffer.byteLength(dropped, 'utf8');
      this.droppedLineCount += 1;
    }
  }
}

interface ScanState {
  readonly counts: Record<keyof MainLogWindowCounts, number>;
  readonly kept: KeptLines;
  malformedLineCount: number;
  scannedLineCount: number;
}

async function scanFile(
  filePath: string,
  request: MainLogWindowRequest,
  state: ScanState
): Promise<MainLogWindowFile> {
  let firstTime: string | null = null;
  let lastTime: string | null = null;
  const input = createReadStream(filePath, 'utf8');
  const reader = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input });
  let lineNumber = 0;
  try {
    for await (const raw of reader) {
      lineNumber += 1;
      if (raw.trim().length === 0) {
        continue;
      }
      const time = readRecordTime(raw, lineNumber, filePath);
      if (time === null) {
        // A crash can truncate the last written line mid-record; count, never throw.
        state.malformedLineCount += 1;
        continue;
      }
      firstTime ??= time;
      lastTime = time;
      if (time < request.since || time > request.until) {
        continue;
      }
      let parsed: { level?: unknown };
      try {
        parsed = JSON.parse(raw) as { level?: unknown };
      } catch {
        // A crash can truncate the last written line mid-record; count, never throw.
        state.malformedLineCount += 1;
        continue;
      }
      state.scannedLineCount += 1;
      for (const name of Object.keys(MARKERS) as (keyof MainLogWindowCounts)[]) {
        if (MARKERS[name].test(raw)) {
          state.counts[name] += 1;
        }
      }
      if (typeof parsed.level === 'number' && parsed.level >= WARN_LEVEL) {
        state.kept.push(raw);
      }
    }
  } finally {
    // Leaving the loop early closes `reader`, which never destroys its input.
    input.destroy();
  }
  return { firstTime, lastTime, name: path.basename(filePath) };
}

export async function readMainLogWindow(input: {
  readonly logFilePath: string;
  readonly request: MainLogWindowRequest;
}): Promise<MainLogWindowResult> {
  const state: ScanState = {
    counts: {
      emptyChildResults: 0,
      toolTimeouts: 0,
      unhandledRejections: 0,
      wasmAllocationFailures: 0,
    },
    kept: new KeptLines(),
    malformedLineCount: 0,
    scannedLineCount: 0,
  };
  const files: MainLogWindowFile[] = [];
  for (const filePath of await candidateFiles(input.logFilePath)) {
    files.push(await scanFile(filePath, input.request, state));
  }
  return {
    counts: state.counts,
    droppedLineCount: state.kept.droppedLineCount,
    files,
    lines: state.kept.lines,
    malformedLineCount: state.malformedLineCount,
    scannedLineCount: state.scannedLineCount,
    since: input.request.since,
    truncated: state.kept.droppedLineCount > 0,
    until: input.request.until,
  };
}
