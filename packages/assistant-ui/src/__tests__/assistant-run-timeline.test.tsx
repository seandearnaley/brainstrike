import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND } from '@brainstrike/assistant-contract/tool-suspend';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveAssistantRunEventRows,
  getMatchingCompletedKind,
  isAlwaysVisibleRunEvent,
  resolveAssistantRunEventRenderPlan,
  resolveAssistantRunEventStatus,
} from '../assistant-run-event-derivation';
import { AssistantRunTimeline } from '../assistant-run-timeline';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

function renderTimeline(data: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <AssistantRunTimeline data={data} />
    </TooltipProvider>
  );
}

function runEventPart(event: Record<string, unknown>) {
  return { data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME };
}

function countedParts(parts: unknown[], reads: { count: number }): unknown[] {
  return new Proxy(parts, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        reads.count += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('deriveAssistantRunEventRows', () => {
  it('scans message parts once for every row in an update', () => {
    const reads = { count: 0 };
    const started = Array.from({ length: 40 }, (_, index) => ({
      id: `start-${index}`,
      kind: 'memory.observation.started',
      label: 'Observation started',
      status: 'running',
      timestamp: `2026-06-05T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const completed = started.map((event, index) => ({
      ...event,
      id: `complete-${index}`,
      kind: 'memory.observation.completed',
      label: `Observation completed ${index}`,
      status: 'completed',
    }));
    const parts = countedParts([...started, ...completed].map(runEventPart), reads);

    const rows = deriveAssistantRunEventRows([{ id: 'message-1', parts }]);

    expect(reads.count).toBe(parts.length);
    expect(rows.statuses['start-0']).toBe('completed');
    expect(rows.renderPlanKeys['start-0']).toBe('hidden');
    expect(rows.statuses['complete-0']).toBe('completed');
    expect(rows.renderPlanKeys['complete-0']).toBe('visible:1');
  });

  it('matches the established per-row status and render-plan behavior', () => {
    const events = [
      {
        id: 'run-start',
        kind: 'run.started',
        label: 'Run',
        runId: 'run-1',
        status: 'running',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
      {
        id: 'tool-start',
        kind: 'tool.started',
        label: 'Read',
        metadata: { toolCallId: 'call-1' },
        runId: 'run-1',
        status: 'running',
        timestamp: '2026-06-05T00:00:01.000Z',
      },
      {
        id: 'tool-done',
        kind: 'tool.completed',
        label: 'Read complete',
        metadata: { toolCallId: 'call-1' },
        runId: 'run-1',
        status: 'completed',
        timestamp: '2026-06-05T00:00:02.000Z',
      },
      {
        id: 'repeat-1',
        kind: 'memory.working.loaded',
        label: 'Memory read',
        status: 'info',
        timestamp: '2026-06-05T00:00:03.000Z',
      },
      {
        id: 'repeat-2',
        kind: 'memory.working.loaded',
        label: 'Memory read',
        status: 'info',
        timestamp: '2026-06-05T00:00:04.000Z',
      },
      {
        id: 'run-done',
        kind: 'run.finished',
        label: 'Done',
        runId: 'run-1',
        status: 'completed',
        timestamp: '2026-06-05T00:00:05.000Z',
      },
    ];
    const messages = [
      {
        parts: [
          ...events.map(runEventPart),
          { toolCallId: 'call-1', toolName: 'brainstrike.readFile', type: 'tool-call' },
        ],
      },
    ];
    const rows = deriveAssistantRunEventRows(messages);

    for (const event of events) {
      const expectedPlan = resolveAssistantRunEventRenderPlan(messages, event);
      expect(rows.statuses[event.id]).toBe(
        resolveAssistantRunEventStatus(messages, event as never)
      );
      expect(rows.renderPlanKeys[event.id]).toBe(
        expectedPlan.hidden ? 'hidden' : `visible:${expectedPlan.repeatCount}`
      );
    }
  });

  it('keeps the unanswerable-pause rejection visible despite its tool card (BST-558)', () => {
    // The Developer path. `initialRenderPlanKey` mirrors
    // `resolveAssistantRunEventRenderPlan`'s card suppression, so it must also
    // mirror the always-visible exemption — otherwise raising the Detail level
    // HIDES a row the default level shows. The `tool-call` part below is the
    // one `DataStreamMapper.handleToolSuspendRequired` always emits for the
    // suspended call, so this is the real thread shape, not a synthetic one.
    const rejected = {
      id: 'reject-1',
      kind: UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
      label: 'Tool pause cannot be answered by this build',
      metadata: { toolCallId: 'call-future', toolName: 'brainstrike.someFutureSuspendingTool' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const carded = {
      id: 'tool-failed-1',
      kind: 'tool.failed',
      label: 'Tool failed',
      metadata: { toolCallId: 'call-ordinary', toolName: 'brainstrike.readFile' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:02.000Z',
    };
    const messages = [
      {
        parts: [
          runEventPart(rejected),
          runEventPart(carded),
          {
            toolCallId: 'call-future',
            toolName: 'brainstrike.someFutureSuspendingTool',
            type: 'tool-call',
          },
          { toolCallId: 'call-ordinary', toolName: 'brainstrike.readFile', type: 'tool-call' },
        ],
      },
    ];

    const rows = deriveAssistantRunEventRows(messages);

    expect(rows.renderPlanKeys[rejected.id]).toBe('visible:1');
    // CONTROL: an ordinary carded tool.failed is still suppressed.
    expect(rows.renderPlanKeys[carded.id]).toBe('hidden');
  });
});

describe('getMatchingCompletedKind', () => {
  it('maps run.step.started to run.step.finished (not .completed)', () => {
    expect(getMatchingCompletedKind('run.step.started')).toBe('run.step.finished');
  });
  it('keeps run.started -> run.finished and tool.started -> tool.completed', () => {
    expect(getMatchingCompletedKind('run.started')).toBe('run.finished');
    expect(getMatchingCompletedKind('tool.started')).toBe('tool.completed');
  });
  it('maps non-run *.started to *.completed', () => {
    expect(getMatchingCompletedKind('memory.semantic.started')).toBe('memory.semantic.completed');
  });
});

describe('isAlwaysVisibleRunEvent', () => {
  const ts = '2026-06-16T10:00:00.000Z';
  const event = (kind: string, status: string) => ({
    id: 'e',
    kind,
    label: kind,
    status,
    timestamp: ts,
  });

  it('forces run-level failure and cancellation rows to stay visible', () => {
    expect(isAlwaysVisibleRunEvent(event('run.failed', 'failed'))).toBe(true);
    expect(isAlwaysVisibleRunEvent(event('run.cancelled', 'cancelled'))).toBe(true);
  });

  it('forces the unanswerable-tool-pause rejection to stay visible (BST-558)', () => {
    // `tool.resume.unsupported` is the ONLY durable surface for a suspending
    // tool this build has no resume UI for: the `brainstrike.tool-suspend`
    // notice is transient, so after a reload this row is all that is left.
    expect(isAlwaysVisibleRunEvent(event('tool.resume.unsupported', 'failed'))).toBe(true);
  });

  it('does not force background bookkeeping or already-carded tool failures', () => {
    // tool.failed already surfaces on its ToolFallback card — never double-report.
    expect(isAlwaysVisibleRunEvent(event('tool.failed', 'failed'))).toBe(false);
    expect(isAlwaysVisibleRunEvent(event('memory.semantic.completed', 'completed'))).toBe(false);
    expect(isAlwaysVisibleRunEvent(event('run.finished', 'completed'))).toBe(false);
    expect(isAlwaysVisibleRunEvent(event('run.started', 'running'))).toBe(false);
  });

  it('returns false for non-run-event data', () => {
    expect(isAlwaysVisibleRunEvent(null)).toBe(false);
    expect(isAlwaysVisibleRunEvent({ kind: 'run.failed' })).toBe(false);
  });
});

describe('resolveAssistantRunEventStatus', () => {
  it('resolves a running generation step to completed when a finished event follows', () => {
    const started = {
      id: 'e1',
      kind: 'run.step.started',
      label: 'Generation step started',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const finished = {
      id: 'e2',
      kind: 'run.step.finished',
      label: 'Generation step completed',
      status: 'completed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [
      { parts: [runEventPart(started), runEventPart(finished)], role: 'assistant' },
    ];
    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('completed');
  });

  it('leaves tool.started RUNNING when the pause is only unanswerable here (BST-558)', () => {
    // `getMatchingFailedKind` resolves tool.started ONLY on tool.failed. The
    // unanswerable-pause rejection must not close it out: the tool is genuinely
    // still suspended server-side, exactly as `runStillSuspended: true` says.
    const started = {
      id: 't1',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-future', toolName: 'brainstrike.someFutureSuspendingTool' },
      runId: 'run-1',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const rejected = {
      id: 't2',
      kind: UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
      label: 'Tool pause cannot be answered by this build',
      metadata: { toolCallId: 'call-future', toolName: 'brainstrike.someFutureSuspendingTool' },
      runId: 'run-1',
      status: 'failed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [
      { parts: [runEventPart(started), runEventPart(rejected)], role: 'assistant' },
    ];
    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('running');
  });
});

describe('resolveAssistantRunEventRenderPlan', () => {
  const ts = '2026-06-11T00:00:00.000Z';

  it('hides tool.* events when their tool-call part renders as a card', () => {
    const started = {
      id: 't1',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-1', toolName: 'brainstrike.grepSearch' },
      status: 'running',
      timestamp: ts,
    };
    const messages = [
      {
        parts: [
          { toolCallId: 'call-1', toolName: 'brainstrike.grepSearch', type: 'tool-call' },
          runEventPart(started),
        ],
        role: 'assistant',
      },
    ];
    expect(resolveAssistantRunEventRenderPlan(messages, started).hidden).toBe(true);
  });

  it('hides subagent.* events from the timeline (they render inside the SubagentCard)', () => {
    for (const kind of [
      'subagent.started',
      'subagent.tool.started',
      'subagent.tool.completed',
      'subagent.finished',
    ]) {
      const event = {
        id: `s-${kind}`,
        kind,
        label: 'Subagent',
        metadata: { parentToolCallId: 'delegation-1', personaId: 'explore' },
        status: 'running',
        timestamp: ts,
      };
      const messages = [{ parts: [runEventPart(event)], role: 'assistant' }];
      expect(resolveAssistantRunEventRenderPlan(messages, event).hidden).toBe(true);
    }
  });

  it('keeps tool.* events visible when no matching tool-call part exists', () => {
    const started = {
      id: 't1',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-9', toolName: 'brainstrike.grepSearch' },
      status: 'running',
      timestamp: ts,
    };
    const messages = [{ parts: [runEventPart(started)], role: 'assistant' }];
    expect(resolveAssistantRunEventRenderPlan(messages, started)).toEqual({
      hidden: false,
      repeatCount: 1,
    });
  });

  it('hides a started row once its terminal row exists, but not while running', () => {
    const started = {
      id: 's1',
      kind: 'memory.observation.started',
      label: 'Observation started',
      status: 'running',
      timestamp: ts,
    };
    const runningMessages = [{ parts: [runEventPart(started)], role: 'assistant' }];
    expect(resolveAssistantRunEventRenderPlan(runningMessages, started).hidden).toBe(false);

    const completed = {
      id: 's2',
      kind: 'memory.observation.completed',
      label: 'Observation completed',
      status: 'completed',
      timestamp: ts,
    };
    const finishedMessages = [
      { parts: [runEventPart(started), runEventPart(completed)], role: 'assistant' },
    ];
    expect(resolveAssistantRunEventRenderPlan(finishedMessages, started).hidden).toBe(true);
    expect(resolveAssistantRunEventRenderPlan(finishedMessages, completed).hidden).toBe(false);
  });

  it('collapses consecutive identical rows into the first with a repeat count', () => {
    const first = {
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Observational memory read',
      status: 'info',
      timestamp: ts,
    };
    const second = { ...first, id: 'm2' };
    const third = { ...first, id: 'm3' };
    const messages = [
      {
        parts: [runEventPart(first), runEventPart(second), runEventPart(third)],
        role: 'assistant',
      },
    ];
    expect(resolveAssistantRunEventRenderPlan(messages, first)).toEqual({
      hidden: false,
      repeatCount: 3,
    });
    expect(resolveAssistantRunEventRenderPlan(messages, second).hidden).toBe(true);
    expect(resolveAssistantRunEventRenderPlan(messages, third).hidden).toBe(true);
  });

  it('does not collapse rows with different details', () => {
    const first = {
      detail: '3 notes',
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Observational memory read',
      status: 'info',
      timestamp: ts,
    };
    const second = { ...first, detail: '5 notes', id: 'm2' };
    const messages = [{ parts: [runEventPart(first), runEventPart(second)], role: 'assistant' }];
    expect(resolveAssistantRunEventRenderPlan(messages, first)).toEqual({
      hidden: false,
      repeatCount: 1,
    });
    expect(resolveAssistantRunEventRenderPlan(messages, second).hidden).toBe(false);
  });
});

describe('AssistantRunTimeline render', () => {
  it('renders a ×n repeat badge when repeatCount is above one', () => {
    render(
      <TooltipProvider>
        <AssistantRunTimeline
          data={{
            id: 'm1',
            kind: 'memory.working.loaded',
            label: 'Observational memory read',
            status: 'info',
            timestamp: '2026-06-11T00:00:00.000Z',
          }}
          repeatCount={2}
        />
      </TooltipProvider>
    );
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByTitle('Repeated 2 times')).toBeInTheDocument();
  });

  it('tints a memory event, omits the standalone status pill, and hides kind until expanded', () => {
    renderTimeline({
      detail: 'Loaded 3 notes',
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Working memory loaded',
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
    });
    const card = screen.getByTestId('assistant-run-timeline');
    expect(card.getAttribute('data-tool-category')).toBe('memory');
    expect(screen.queryByText('Completed')).toBeNull(); // no visible pill text
    expect(screen.queryByText('memory.working.loaded')).toBeNull(); // kind only in fold
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('memory.working.loaded')).toBeInTheDocument();
  });

  it('classifies a tool run event by its tool metadata', () => {
    renderTimeline({
      id: 't1',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolName: 'brainstrike.queryEmbeddingSpace' },
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
    });
    expect(screen.getByTestId('assistant-run-timeline').getAttribute('data-tool-category')).toBe(
      'internal'
    );
  });

  it('renders running run activity with the shared thinking indicator', () => {
    renderTimeline({
      id: 'r1',
      kind: 'run.step.started',
      label: 'Generating response',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    });

    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByLabelText('Running').querySelector('.lucide-circle-dashed')).not.toBeNull();
    expect(screen.getByTestId('assistant-thinking-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-tone', 'greyscale');
    expect(screen.getAllByTestId('assistant-thinking-mark')).toHaveLength(1);
  });
});
