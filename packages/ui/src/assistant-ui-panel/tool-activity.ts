import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { extractPrimaryArg } from './tool-fallback';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A message part is a tool call when its discriminant `type` is `'tool-call'`. */
export function isToolCallPart(part: unknown): part is Record<string, unknown> {
  return isRecord(part) && part['type'] === 'tool-call';
}

function partStatusType(part: Record<string, unknown>): string | undefined {
  const status = part['status'];
  if (isRecord(status) && typeof status['type'] === 'string') {
    return status['type'];
  }
  return;
}

function partToolName(part: Record<string, unknown>): string {
  return typeof part['toolName'] === 'string' && part['toolName'].length > 0
    ? part['toolName']
    : 'tool';
}

export interface ToolActivitySummary {
  /** Primary argument of the currently-running tool (file/query/path/…). */
  activeArg: string | null;
  /** Display name of the currently-running tool, when one is running. */
  activeLabel: string | null;
  /** Tool calls that ended incomplete (timeout / abort / thrown). */
  failedCount: number;
  /** Tool calls still running. */
  runningCount: number;
  /** Total tool-call parts in this turn (each renders as one step row). */
  stepCount: number;
}

/**
 * Reduce a turn's chain-of-thought parts to a compact tool-activity summary.
 * Pure: only failure-by-status is counted here (a tool that "completes" with an
 * error result still surfaces its error in the expanded card, so it is not
 * double-counted as a header-level failure).
 */
export function summarizeToolActivity(parts: readonly unknown[]): ToolActivitySummary {
  let stepCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let activeLabel: string | null = null;
  let activeArg: string | null = null;

  for (const part of parts) {
    if (!isToolCallPart(part)) {
      continue;
    }
    stepCount++;
    const status = partStatusType(part);
    if (status === 'running') {
      runningCount++;
      // Last running tool wins — it is the most recent "current step".
      activeLabel = partToolName(part);
      const argsText = typeof part['argsText'] === 'string' ? part['argsText'] : undefined;
      activeArg = extractPrimaryArg(part['args'], argsText) ?? null;
    } else if (status === 'incomplete') {
      failedCount++;
    }
  }

  return { activeArg, activeLabel, failedCount, runningCount, stepCount };
}

/**
 * Wall-clock span (ms) of a turn, derived from the min→max timestamps of its
 * persisted run-event data parts. Used as the elapsed fallback for reloaded /
 * already-finished turns, where no live client timer ran. Returns undefined
 * when fewer than two timestamped events exist.
 */
export function runEventsSpanMs(parts: readonly unknown[]): number | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const part of parts) {
    if (!(isRecord(part) && part['name'] === ASSISTANT_RUN_EVENT_DATA_NAME)) {
      continue;
    }
    const data = part['data'];
    if (!isRecord(data)) {
      continue;
    }
    const timestamp =
      typeof data['timestamp'] === 'string' ? Date.parse(data['timestamp']) : Number.NaN;
    if (Number.isNaN(timestamp)) {
      continue;
    }
    min = Math.min(min, timestamp);
    max = Math.max(max, timestamp);
    count++;
  }

  if (count < 2 || max <= min) {
    return;
  }
  return max - min;
}
