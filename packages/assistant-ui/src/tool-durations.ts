import {
  type AssistantRunEvent,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';

function runEventTimestamp(data: AssistantRunEvent): number | undefined {
  const timestamp = Date.parse(data.timestamp);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function runEventToolCallId(data: AssistantRunEvent): string | undefined {
  const toolCallId = data.metadata?.['toolCallId'];
  return typeof toolCallId === 'string' ? toolCallId : undefined;
}

/**
 * Map each tool call's id to its execution time (ms), computed from the gap
 * between its `tool.started` and `tool.completed`/`tool.failed` run-event
 * TIMESTAMPS (matched by `metadata.toolCallId`). The producer
 * (`makeRunEventChunk` in the agent runtime) stamps every event but does NOT
 * attach a `durationMs` field, so the timestamp delta is the real source — not
 * a `durationMs` that never exists in production. Pure + unit-tested against
 * realistic event shapes.
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
