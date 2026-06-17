import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { collectToolDurations } from '../tool-durations';

// Mirrors the REAL event shape `makeRunEventChunk` emits: a stamped event whose
// metadata carries `toolCallId` (and `toolName`), with NO `durationMs` field.
const toolEvent = (kind: string, toolCallId: string, timestamp: string) => ({
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
  data: {
    id: `${kind}-${toolCallId}`,
    kind,
    label: 'Tool',
    status: kind === 'tool.failed' ? 'failed' : 'completed',
    timestamp,
    metadata: { toolCallId, toolName: 'brainstrike.grepSearch' },
  },
});

describe('collectToolDurations', () => {
  it('computes duration from the tool.started→terminal timestamp gap, by toolCallId', () => {
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      toolEvent('tool.completed', 'a', '2026-06-16T10:00:01.200Z'),
      toolEvent('tool.started', 'b', '2026-06-16T10:00:02.000Z'),
      toolEvent('tool.failed', 'b', '2026-06-16T10:00:02.300Z'),
      { type: 'tool-call', toolCallId: 'a' },
    ]);
    expect(result).toEqual({ a: 1200, b: 300 });
  });

  it('ignores a terminal event with no matching start, or missing toolCallId/timestamp', () => {
    expect(
      collectToolDurations([
        toolEvent('tool.completed', 'orphan', '2026-06-16T10:00:00.000Z'),
        {
          name: ASSISTANT_RUN_EVENT_DATA_NAME,
          data: { kind: 'tool.completed', timestamp: '2026-06-16T10:00:00.000Z', metadata: {} },
        },
        {
          name: ASSISTANT_RUN_EVENT_DATA_NAME,
          data: { kind: 'tool.completed', metadata: { toolCallId: 'x' } },
        },
      ])
    ).toEqual({});
  });

  it('returns an empty map when there are no run events', () => {
    expect(collectToolDurations([{ type: 'tool-call', toolCallId: 'x' }])).toEqual({});
  });
});
