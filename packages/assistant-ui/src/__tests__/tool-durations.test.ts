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

describe('collectToolDurations — producer-measured durations', () => {
  const measuredEvent = (
    kind: string,
    toolCallId: string,
    timestamp: string,
    durationMs: number
  ) => ({
    data: {
      durationMs,
      id: `${kind}-${toolCallId}`,
      kind,
      label: 'Tool',
      metadata: { toolCallId, toolName: 'brainstrike.executeCommand' },
      status: kind === 'tool.failed' ? 'failed' : 'completed',
      timestamp,
    },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
  });

  it('reports execution time, not the human approval wait', () => {
    // THE BUG. `tool.started` is emitted when the MODEL emits the call; the
    // approval gate then suspends the run before `execute` is invoked, and the
    // terminal event lands on the resume leg. The timestamp gap here is five
    // minutes; the script ran for two seconds.
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      measuredEvent('tool.completed', 'a', '2026-06-16T10:05:02.000Z', 2000),
    ]);
    expect(result).toEqual({ a: 2000 });
  });

  it('does not need the start event to have survived', () => {
    // On a reloaded thread the start event may be outside the window, and a
    // pre-BST-1440 resume leg carried no start of its own at all.
    const result = collectToolDurations([
      measuredEvent('tool.completed', 'a', '2026-06-16T10:05:02.000Z', 2000),
    ]);
    expect(result).toEqual({ a: 2000 });
  });

  it('ignores the resume leg start when a measurement is present', () => {
    // BST-1440 made the resume leg synthesise its own `tool.started` so the
    // "needs you" signal can clear on ANSWER. This is the normal path for
    // anything this build produces, and the extra start must stay INERT:
    // `durationMs` wins before `startedAt` is consulted. Were that not so, a
    // status-glyph change would have silently altered every displayed duration.
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      toolEvent('tool.started', 'a', '2026-06-16T10:05:00.000Z'),
      measuredEvent('tool.completed', 'a', '2026-06-16T10:05:02.000Z', 2000),
    ]);
    expect(result).toEqual({ a: 2000 });
  });

  it('uses the measurement on a FAILED call too', () => {
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      measuredEvent('tool.failed', 'a', '2026-06-16T10:00:30.000Z', 1500),
    ]);
    expect(result).toEqual({ a: 1500 });
  });

  it('falls back to the timestamp delta when no duration was stamped', () => {
    // Older persisted threads, and any runtime that did not record. The
    // pre-existing behaviour, never a fabricated value.
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      toolEvent('tool.completed', 'a', '2026-06-16T10:00:01.200Z'),
    ]);
    expect(result).toEqual({ a: 1200 });
  });

  it('clocks the resumed execution, not the approval wait, on the fallback path', () => {
    // The un-measured approval case, which USED to be unrepairable: the only
    // start was the pausing leg's, so the delta swallowed the human's
    // deliberation. Since BST-1440 the resume leg contributes its own
    // `tool.started`, which overwrites that entry (parts are in append order),
    // so this path is now MORE accurate than before rather than less.
    // Five-minute approval, two-second script ⇒ two seconds.
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      toolEvent('tool.started', 'a', '2026-06-16T10:05:00.000Z'),
      toolEvent('tool.completed', 'a', '2026-06-16T10:05:02.000Z'),
    ]);
    expect(result).toEqual({ a: 2000 });
  });

  it('ignores a NEGATIVE duration rather than trusting it', () => {
    // A clock adjustment mid-execution is the realistic source. NaN/Infinity
    // cannot reach here — they are not valid JSON, so the contract reader drops
    // the whole event before this code sees it.
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      measuredEvent('tool.completed', 'a', '2026-06-16T10:00:01.200Z', -5),
    ]);
    expect(result).toEqual({ a: 1200 });
  });

  it('keeps a ZERO duration instead of treating it as absent', () => {
    // A DECLINED approval-gated call is stamped 0 by the producer: the tool is
    // known not to have run. Falsy-zero would drop it and fall back to the
    // start-to-terminal gap — which for a decline is the human's deliberation
    // time, so the card would claim a never-executed tool ran for five minutes.
    const result = collectToolDurations([
      toolEvent('tool.started', 'a', '2026-06-16T10:00:00.000Z'),
      measuredEvent('tool.failed', 'a', '2026-06-16T10:05:00.000Z', 0),
    ]);
    expect(result).toEqual({ a: 0 });
  });
});
