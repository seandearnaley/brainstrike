import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssistantRunTimeline,
  resolveAssistantRunEventStatus,
} from '../assistant-ui-panel/assistant-run-timeline';
import { TooltipProvider } from '../tooltip';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

function wrap(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const baseEvent = {
  id: 'event-1',
  kind: 'memory.configured',
  label: 'Memory configured',
  runId: 'run-1',
  sequence: 1,
  status: 'completed',
  timestamp: '2026-04-24T12:00:00.000Z',
  metadata: {
    threadId: 'thread-1',
    resourceId: 'workspace-1',
  },
} satisfies AssistantRunEvent;

function createMessageWithRunEvents(events: readonly AssistantRunEvent[]): unknown {
  return {
    role: 'assistant',
    content: events.map((event) => ({
      data: event,
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
      type: 'data',
    })),
  };
}

describe('AssistantRunTimeline', () => {
  it('renders a compact assistant activity row by default', () => {
    wrap(<AssistantRunTimeline data={baseEvent} />);

    expect(screen.getByTestId('assistant-run-timeline')).toBeInTheDocument();
    expect(screen.getByText('Memory configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('threadId')).not.toBeInTheDocument();
  });

  it('renders running, failed, cancelled, and informational status labels', () => {
    const cases = [
      ['running', 'Semantic recall'],
      ['failed', 'Tool failed'],
      ['cancelled', 'Run cancelled'],
      ['info', 'Context budget'],
    ] as const;

    wrap(
      cases.map(([status, label], index) => (
        <AssistantRunTimeline
          data={{
            ...baseEvent,
            id: `event-${status}`,
            kind: `run.${status}`,
            label,
            sequence: index + 2,
            status,
          }}
          key={status}
        />
      ))
    );

    expect(screen.getByText('Semantic recall')).toBeInTheDocument();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByText('Tool failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Run cancelled')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Context budget')).toBeInTheDocument();
    expect(screen.getByLabelText('Observed')).toBeInTheDocument();
  });

  it('renders an overridden status for stale running events', () => {
    wrap(
      <AssistantRunTimeline
        data={{
          ...baseEvent,
          id: 'event-running',
          kind: 'run.step.started',
          label: 'Generation step started',
          status: 'running',
        }}
        statusOverride="completed"
      />
    );

    expect(screen.getByText('Generation step started')).toBeInTheDocument();
    expect(screen.getByLabelText('Completed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Running')).not.toBeInTheDocument();
  });

  it('expands to show sanitized event metadata', async () => {
    const user = userEvent.setup();
    wrap(<AssistantRunTimeline data={baseEvent} />);

    await user.click(screen.getByRole('button', { name: /expand run activity/i }));

    expect(screen.getByText('threadId')).toBeInTheDocument();
    expect(screen.getByText('thread-1')).toBeInTheDocument();
    expect(screen.getByText('resourceId')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /collapse run activity/i })).toBeInTheDocument();
  });

  it('expands detail text and JSON-safe metadata values', async () => {
    const user = userEvent.setup();
    wrap(
      <AssistantRunTimeline
        data={{
          ...baseEvent,
          detail: 'Loaded 4 semantic candidates.',
          durationMs: 1420,
          metadata: {
            hitCount: 4,
            cached: false,
            filters: ['typescript', 'ui'],
            nullable: null,
          },
        }}
      />
    );

    await user.click(screen.getByRole('button', { name: /expand run activity/i }));

    expect(screen.getByText('1.4s')).toBeInTheDocument();
    expect(screen.getByText('Loaded 4 semantic candidates.')).toBeInTheDocument();
    expect(screen.getByText('hitCount')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('cached')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
    expect(screen.getByText('filters')).toBeInTheDocument();
    expect(screen.getByText('["typescript","ui"]')).toBeInTheDocument();
    expect(screen.getByText('nullable')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('renders millisecond durations and invalid timestamps without coercion', async () => {
    const user = userEvent.setup();
    wrap(
      <AssistantRunTimeline
        data={{
          ...baseEvent,
          durationMs: 250,
          timestamp: 'not-a-date',
        }}
      />
    );

    // Invalid timestamp stays inline in the header.
    expect(screen.getByText('not-a-date')).toBeInTheDocument();

    // Duration moved into the expandable fold.
    await user.click(screen.getByRole('button', { name: /expand run activity/i }));
    expect(screen.getByText('250ms')).toBeInTheDocument();
  });

  it('renders nothing for malformed data parts', () => {
    const { container } = wrap(<AssistantRunTimeline data={{ label: 'Missing fields' }} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('resolveAssistantRunEventStatus', () => {
  it('marks started run and step events completed when terminal events arrive later', () => {
    const runStarted = {
      ...baseEvent,
      id: 'run-started',
      kind: 'run.started',
      label: 'Assistant run started',
      status: 'running',
    } satisfies AssistantRunEvent;
    const stepStarted = {
      ...baseEvent,
      id: 'step-started',
      kind: 'run.step.started',
      label: 'Generation step started',
      status: 'running',
    } satisfies AssistantRunEvent;
    const stepFinished = {
      ...baseEvent,
      id: 'step-finished',
      kind: 'run.step.finished',
      label: 'Generation step completed',
      status: 'completed',
    } satisfies AssistantRunEvent;
    const runFinished = {
      ...baseEvent,
      id: 'run-finished',
      kind: 'run.finished',
      label: 'Assistant run completed',
      status: 'completed',
    } satisfies AssistantRunEvent;

    const messages = [
      createMessageWithRunEvents([runStarted, stepStarted, stepFinished, runFinished]),
    ];

    expect(resolveAssistantRunEventStatus(messages, runStarted)).toBe('completed');
    expect(resolveAssistantRunEventStatus(messages, stepStarted)).toBe('completed');
  });

  it('matches tool completion by tool call id', () => {
    const toolStarted = {
      ...baseEvent,
      id: 'tool-started',
      kind: 'tool.started',
      label: 'Tool started',
      metadata: { toolCallId: 'call-1', toolName: 'read_file' },
      status: 'running',
    } satisfies AssistantRunEvent;
    const otherToolCompleted = {
      ...baseEvent,
      id: 'other-tool-completed',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolCallId: 'call-2', toolName: 'read_file' },
      status: 'completed',
    } satisfies AssistantRunEvent;
    const toolCompleted = {
      ...baseEvent,
      id: 'tool-completed',
      kind: 'tool.completed',
      label: 'Tool completed',
      metadata: { toolCallId: 'call-1', toolName: 'read_file' },
      status: 'completed',
    } satisfies AssistantRunEvent;

    expect(
      resolveAssistantRunEventStatus(
        [createMessageWithRunEvents([toolStarted, otherToolCompleted])],
        toolStarted
      )
    ).toBe('running');
    expect(
      resolveAssistantRunEventStatus(
        [createMessageWithRunEvents([toolStarted, otherToolCompleted, toolCompleted])],
        toolStarted
      )
    ).toBe('completed');
  });

  it('marks matching started events failed or cancelled from terminal run events', () => {
    const stepStarted = {
      ...baseEvent,
      id: 'step-started',
      kind: 'run.step.started',
      runId: 'run-2',
      status: 'running',
    } satisfies AssistantRunEvent;
    const otherRunFailed = {
      ...baseEvent,
      id: 'other-run-failed',
      kind: 'run.failed',
      runId: 'run-3',
      status: 'failed',
    } satisfies AssistantRunEvent;
    const runFailed = {
      ...baseEvent,
      id: 'run-failed',
      kind: 'run.failed',
      runId: 'run-2',
      status: 'failed',
    } satisfies AssistantRunEvent;
    const runCancelled = {
      ...baseEvent,
      id: 'run-cancelled',
      kind: 'run.cancelled',
      runId: 'run-2',
      status: 'cancelled',
    } satisfies AssistantRunEvent;

    expect(
      resolveAssistantRunEventStatus(
        [createMessageWithRunEvents([stepStarted, otherRunFailed, runFailed])],
        stepStarted
      )
    ).toBe('failed');
    expect(
      resolveAssistantRunEventStatus(
        [createMessageWithRunEvents([stepStarted, otherRunFailed, runCancelled])],
        stepStarted
      )
    ).toBe('cancelled');
  });

  it('matches failed tool completions by tool call id', () => {
    const toolStarted = {
      ...baseEvent,
      id: 'tool-started',
      kind: 'tool.started',
      metadata: { toolCallId: 'call-1', toolName: 'write_file' },
      status: 'running',
    } satisfies AssistantRunEvent;
    const otherToolFailed = {
      ...baseEvent,
      id: 'other-tool-failed',
      kind: 'tool.failed',
      metadata: { toolCallId: 'call-2', toolName: 'write_file' },
      status: 'failed',
    } satisfies AssistantRunEvent;
    const toolFailed = {
      ...baseEvent,
      id: 'tool-failed',
      kind: 'tool.failed',
      metadata: { toolCallId: 'call-1', toolName: 'write_file' },
      status: 'failed',
    } satisfies AssistantRunEvent;

    expect(
      resolveAssistantRunEventStatus(
        [createMessageWithRunEvents([toolStarted, otherToolFailed])],
        toolStarted
      )
    ).toBe('running');
    expect(
      resolveAssistantRunEventStatus(
        [createMessageWithRunEvents([toolStarted, otherToolFailed, toolFailed])],
        toolStarted
      )
    ).toBe('failed');
  });

  it('reads assistant run events from message parts arrays', () => {
    const runStarted = {
      ...baseEvent,
      id: 'run-started',
      kind: 'run.started',
      status: 'running',
    } satisfies AssistantRunEvent;
    const runFinished = {
      ...baseEvent,
      id: 'run-finished',
      kind: 'run.finished',
      status: 'completed',
    } satisfies AssistantRunEvent;

    const messages = [
      {
        parts: [
          { data: runStarted, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' },
          { data: runFinished, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' },
        ],
      },
    ];

    expect(resolveAssistantRunEventStatus(messages, runStarted)).toBe('completed');
  });

  it('keeps non-running and unsupported running statuses unchanged', () => {
    expect(resolveAssistantRunEventStatus([], null)).toBe('info');
    expect(resolveAssistantRunEventStatus([], baseEvent)).toBe('completed');
    expect(
      resolveAssistantRunEventStatus([], {
        ...baseEvent,
        id: 'memory-running',
        kind: 'memory.configured',
        status: 'running',
      })
    ).toBe('running');
  });
});
