import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { runEventsSpanMs } from '../tool-activity';
import { formatActivityDuration } from '../tool-durations';
import {
  collectGroupToolCallIds,
  useChainActivityDerivations,
} from '../use-chain-activity-derivations';

/**
 * The pure elapsed/duration helpers behind the activity trace's meta line.
 * They outlived `AssistantActivityGroup` (deleted in BST-1679, together with
 * `summarizeToolActivity` — `deriveActivitySteps`/`summarizeActivity` in
 * activity-trace-model.ts supersede it), so their cases live here rather than
 * in a file named after a component that no longer exists.
 */

const toolPart = (overrides: Record<string, unknown>) => ({
  toolName: 'brainstrike.grepSearch',
  type: 'tool-call',
  ...overrides,
});

const runEventPart = (timestamp: string) => ({
  data: { id: timestamp, kind: 'tool.started', label: 'x', status: 'completed', timestamp },
  name: ASSISTANT_RUN_EVENT_DATA_NAME,
});

describe('runEventsSpanMs', () => {
  it('derives the elapsed fallback only from the current group, retaining message-wide tool durations', () => {
    const first = toolPart({ status: { type: 'complete' }, toolCallId: 'a' });
    const second = toolPart({ status: { type: 'complete' }, toolCallId: 'b' });
    const event = (timestamp: string, toolCallId: string, kind: string) => {
      const part = runEventPart(timestamp);
      return { ...part, data: { ...part.data, kind, metadata: { toolCallId } } };
    };
    const parts = [
      first,
      second,
      event('2026-09-05T10:00:00.000Z', 'a', 'tool.started'),
      event('2026-09-05T10:00:02.000Z', 'a', 'tool.completed'),
      event('2026-09-05T10:00:20.000Z', 'b', 'tool.started'),
      event('2026-09-05T10:00:25.000Z', 'b', 'tool.completed'),
    ];
    const { result } = renderHook(() => useChainActivityDerivations(parts, 'message-1', [first]));
    expect(result.current.activityFallbackMs).toBe(2000);
    expect(result.current.toolDurations).toEqual({ a: 2000, b: 5000 });
  });

  it('returns the min→max timestamp span across run events', () => {
    const span = runEventsSpanMs([
      runEventPart('2026-06-16T10:00:00.000Z'),
      runEventPart('2026-06-16T10:00:12.500Z'),
      toolPart({ status: { type: 'complete' } }),
    ]);
    expect(span).toBe(12_500);
  });

  it('returns undefined with fewer than two timestamped events', () => {
    expect(runEventsSpanMs([runEventPart('2026-06-16T10:00:00.000Z')])).toBeUndefined();
    expect(runEventsSpanMs([toolPart({ status: { type: 'complete' } })])).toBeUndefined();
  });
});

describe('collectGroupToolCallIds', () => {
  it('collects string toolCallIds from tool-call parts in a single pass', () => {
    const ids = collectGroupToolCallIds([
      toolPart({ status: { type: 'complete' }, toolCallId: 'a' }),
      { type: 'reasoning' },
      toolPart({ status: { type: 'complete' }, toolCallId: 'b' }),
      toolPart({ status: { type: 'complete' }, toolCallId: 'a' }),
    ]);
    expect([...ids]).toEqual(['a', 'b']);
  });

  it('ignores non-tool-call parts and non-string or missing toolCallIds', () => {
    const ids = collectGroupToolCallIds([
      { text: 'hello', type: 'text' },
      toolPart({ status: { type: 'complete' } }),
      toolPart({ status: { type: 'complete' }, toolCallId: 42 }),
      toolPart({ status: { type: 'complete' }, toolCallId: 'ok' }),
    ]);
    expect([...ids]).toEqual(['ok']);
  });
});

describe('formatActivityDuration', () => {
  it('formats sub-second, second, and minute durations', () => {
    expect(formatActivityDuration(420)).toBe('420ms');
    expect(formatActivityDuration(3400)).toBe('3.4s');
    expect(formatActivityDuration(72_000)).toBe('1m 12s');
  });
});
