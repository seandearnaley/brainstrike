import {
  type AssistantRunEvent,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';

function runEventTimestamp(data: AssistantRunEvent): number | undefined {
  const timestamp = Date.parse(data.timestamp);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * The producer's measured execution time, when it stamped one.
 *
 * The `typeof`/finite checks are TYPE NARROWING, not validation: a non-numeric
 * or non-finite `durationMs` never reaches here, because it is not valid JSON
 * and `readAssistantRunEventDataPart` drops the whole event first (verified —
 * a string and a NaN both make the event vanish, not the field). Only the
 * NEGATIVE case is reachable, from a clock adjustment mid-execution, and it
 * falls back to the timestamp delta rather than rendering a negative duration.
 */
function runEventDurationMs(data: AssistantRunEvent): number | undefined {
  const durationMs = data.durationMs;
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : undefined;
}

function runEventToolCallId(data: AssistantRunEvent): string | undefined {
  const toolCallId = data.metadata?.['toolCallId'];
  return typeof toolCallId === 'string' ? toolCallId : undefined;
}

/**
 * Map each tool call's id to its execution time (ms).
 *
 * PREFERS the producer's own `durationMs` on the terminal event. The agent's
 * guard wrapper measures around the real `execute` and stamps it (see
 * `tool-execution-durations.ts` in @brainstrike/agent), which is the only
 * honest number for an APPROVAL-GATED call: `tool.started` comes from Mastra's
 * `tool-call` part — when the MODEL emits the call — and the gate then suspends
 * the run before `execute` is ever invoked. The terminal event arrives on the
 * resume leg, so the timestamp gap spans however long a human took to click
 * Approve; a two-second script behind a five-minute approval read as five
 * minutes.
 *
 * Nothing downstream can repair that. Measured against the real approval path,
 * the resume leg emits `tool.completed` FIRST, with no second `tool.started`,
 * no `run.resumed` (both approval paths run `maxAttempts: 1`, so the stall loop
 * never reaches the attempt that emits it) and no `run.started` (Mastra's
 * `resumeStream` emits no `start` part). The information only exists at the
 * producer, which is why it now travels on the event.
 *
 * FALLS BACK to the `tool.started` → terminal timestamp delta when there is no
 * `durationMs` — an older persisted thread, or a runtime that did not record.
 * That is the pre-existing behaviour, never a fabricated value.
 * Pure + unit-tested against realistic event shapes.
 */
export function collectToolDurations(parts: readonly unknown[]): Record<string, number> {
  const startedAt = new Map<string, number>();
  const durations: Record<string, number> = {};

  for (const part of parts) {
    const data = readAssistantRunEventDataPart(part);
    if (!data) {
      continue;
    }
    const kind = data.kind;
    if (kind !== 'tool.started' && kind !== 'tool.completed' && kind !== 'tool.failed') {
      continue;
    }
    const toolCallId = runEventToolCallId(data);
    const timestamp = runEventTimestamp(data);
    if (toolCallId === undefined || timestamp === undefined) {
      continue;
    }
    if (kind === 'tool.started') {
      startedAt.set(toolCallId, timestamp);
      continue;
    }
    // The producer's measurement wins outright: it is the real execution
    // window, and it does not need a start event to have survived.
    const measured = runEventDurationMs(data);
    if (measured !== undefined) {
      durations[toolCallId] = measured;
      continue;
    }
    const start = startedAt.get(toolCallId);
    if (start !== undefined && timestamp >= start) {
      durations[toolCallId] = timestamp - start;
    }
  }

  return durations;
}

/** Human duration: `420ms`, `3.4s`, `1m 12s`. */
export function formatActivityDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}
