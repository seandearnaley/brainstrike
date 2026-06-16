import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { collectToolDurations } from '../tool-durations';

const runEvent = (data: Record<string, unknown>) => ({
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
  data: { id: 'e', label: 'x', status: 'completed', timestamp: '2026-06-16T10:00:00Z', ...data },
});

describe('collectToolDurations', () => {
  it('maps toolCallId to durationMs from tool.completed and tool.failed events', () => {
    const result = collectToolDurations([
      runEvent({ kind: 'tool.started', metadata: { toolCallId: 'a' } }),
      runEvent({ durationMs: 1200, kind: 'tool.completed', metadata: { toolCallId: 'a' } }),
      runEvent({ durationMs: 300, kind: 'tool.failed', metadata: { toolCallId: 'b' } }),
      { type: 'tool-call', toolCallId: 'a' },
    ]);
    expect(result).toEqual({ a: 1200, b: 300 });
  });

  it('ignores terminal events lacking a toolCallId or a numeric duration', () => {
    expect(
      collectToolDurations([
        runEvent({ durationMs: 100, kind: 'tool.completed', metadata: {} }),
        runEvent({ kind: 'tool.completed', metadata: { toolCallId: 'c' } }),
        runEvent({ durationMs: 'nope', kind: 'tool.completed', metadata: { toolCallId: 'd' } }),
      ])
    ).toEqual({});
  });

  it('returns an empty map when there are no run events', () => {
    expect(collectToolDurations([{ type: 'tool-call', toolCallId: 'x' }])).toEqual({});
  });
});
