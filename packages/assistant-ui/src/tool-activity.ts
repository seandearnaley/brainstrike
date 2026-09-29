import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A message part is a tool call when its discriminant `type` is `'tool-call'`. */
export function isToolCallPart(part: unknown): part is Record<string, unknown> {
  return isRecord(part) && part['type'] === 'tool-call';
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
    const data = readAssistantRunEventDataPart(part);
    if (!data) {
      continue;
    }
    const timestamp = Date.parse(data.timestamp);
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
