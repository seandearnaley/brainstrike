import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Map each tool call's id to its execution time (ms), read from the turn's
 * persisted `tool.completed` / `tool.failed` run events (which carry
 * `durationMs` + `metadata.toolCallId`). Tool-call message parts themselves
 * carry no timing, so this is the only source. Pure + unit-tested.
 */
export function collectToolDurations(parts: readonly unknown[]): Record<string, number> {
  const durations: Record<string, number> = {};

  for (const part of parts) {
    if (!(isRecord(part) && part['name'] === ASSISTANT_RUN_EVENT_DATA_NAME)) {
      continue;
    }
    const data = part['data'];
    if (!isRecord(data)) {
      continue;
    }
    if (data['kind'] !== 'tool.completed' && data['kind'] !== 'tool.failed') {
      continue;
    }
    const durationMs = data['durationMs'];
    const metadata = data['metadata'];
    const toolCallId = isRecord(metadata) ? metadata['toolCallId'] : undefined;
    if (typeof toolCallId === 'string' && typeof durationMs === 'number') {
      durations[toolCallId] = durationMs;
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
