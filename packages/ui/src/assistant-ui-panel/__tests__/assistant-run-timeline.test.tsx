import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import {
  AssistantRunTimeline,
  getMatchingCompletedKind,
  isAlwaysVisibleRunEvent,
  resolveAssistantRunEventRenderPlan,
  resolveAssistantRunEventStatus,
} from '../assistant-run-timeline';

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
