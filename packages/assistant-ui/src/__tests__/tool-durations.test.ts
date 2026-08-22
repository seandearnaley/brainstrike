import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND } from '@brainstrike/assistant-contract/tool-suspend';
import { describe, expect, it } from 'vitest';
import { collectToolDurations } from '../tool-durations';

// Mirrors the REAL event shape `makeRunEventChunk` emits: a stamped event whose
// metadata carries `toolCallId` (and `toolName`), with NO `durationMs` field.
const toolEvent = (kind: string, toolCallId: string, timestamp: string) => ({
  data: {
    id: `${kind}-${toolCallId}`,
    kind,
    label: 'Tool',
    metadata: { toolCallId, toolName: 'brainstrike.grepSearch' },
    status: kind === 'tool.failed' ? 'failed' : 'completed',
    timestamp,
  },
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
});

describe('collectToolDurations', () => {
  it('computes duration from the tool.started→terminal timestamp gap, by toolCallId', () => {
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      toolEvent('tool.completed', 'a', '2026-06-16T10:00:01.200Z'),
      toolEvent('tool.started', 'b', '2026-06-16T10:00:02.000Z'),
      toolEvent('tool.failed', 'b', '2026-06-16T10:00:02.300Z'),
      { toolCallId: 'a', type: 'tool-call' },
    ]);
    expect(result).toEqual({ a: 1200, b: 300 });
  });

  it('ignores a terminal event with no matching start, or missing toolCallId/timestamp', () => {
    expect(
      collectToolDurations([
        toolEvent('tool.completed', 'orphan', '2026-06-16T10:00:00.000Z'),
        {
          data: { kind: 'tool.completed', metadata: {}, timestamp: '2026-06-16T10:00:00.000Z' },
          name: ASSISTANT_RUN_EVENT_DATA_NAME,
        },
        {
          data: { kind: 'tool.completed', metadata: { toolCallId: 'x' } },
          name: ASSISTANT_RUN_EVENT_DATA_NAME,
        },
      ])
    ).toEqual({});
  });

  it('returns an empty map when there are no run events', () => {
    expect(collectToolDurations([{ toolCallId: 'x', type: 'tool-call' }])).toEqual({});
  });

  it("never times the USER's deliberation on an approval pause (BST-1402)", () => {
    // `tool.approval.requested` shares the paused call's `toolCallId` but is NOT
    // a lifecycle start: no tool ran. It must neither open a duration window
    // (which would clock the user's thinking as tool execution once the resumed
    // call completes) nor close one. Only `tool.started` opens; only
    // `tool.completed`/`tool.failed` close.
    expect(
      collectToolDurations([
        toolEvent('tool.approval.requested', 'gated', '2026-06-16T10:00:00.000Z'),
        toolEvent('tool.started', 'gated', '2026-06-16T10:00:30.000Z'),
        toolEvent('tool.completed', 'gated', '2026-06-16T10:00:30.400Z'),
      ])
    ).toEqual({ gated: 400 });
  });

  it('does NOT close out a tool that is still suspended server-side (BST-558)', () => {
    // The unanswerable-pause rejection must not be mistaken for a terminal tool
    // event: the tool is still suspended (`runStillSuspended: true`), and a
    // later build that registers the resume UI answers this very pause and
    // emits the real `tool.completed`. A duration here would be a lie.
    expect(
      collectToolDurations([
        toolEvent('tool.started', 'suspended', '2026-06-16T10:00:00.000Z'),
        toolEvent(UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND, 'suspended', '2026-06-16T10:00:01.000Z'),
      ])
    ).toEqual({});
  });
});
