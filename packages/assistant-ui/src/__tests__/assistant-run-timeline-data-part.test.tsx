import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantRunTimelineDataPart } from '../assistant-run-timeline-data-part';

// `useAuiState` is mocked so the data part renders without a live
// AssistantRuntimeProvider — same pattern as
// run-lifecycle-notifications-hydration.test.tsx. The mock is hoisted above the
// component import, so it is in place before `@assistant-ui/react` is evaluated.
let mockMessages: unknown[] = [];
vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(selector: (state: { thread: { messages: unknown[] } }) => T) =>
    selector({ thread: { messages: mockMessages } }),
}));

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

function runEventMessage(event: AssistantRunEvent) {
  return { content: [{ data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' }] };
}

/**
 * The `tool-call` part `DataStreamMapper.handleToolSuspendRequired` ALWAYS emits
 * for the suspended call, carrying the same id the run event holds in
 * `metadata.toolCallId`. A fixture without it is a thread shape the emitter
 * cannot produce, and it silently skips `hasToolCallPartForEvent` — the rule
 * that actually decides whether this row renders (review of PR #1977).
 */
function toolCallMessage(toolCallId: string, toolName: string) {
  return { content: [{ toolCallId, toolName, type: 'tool-call' }] };
}

/** The data part rendered exactly as assistant-ui invokes it for a run event. */
function renderDataPart(event: AssistantRunEvent) {
  return wrap(
    <AssistantRunTimelineDataPart
      data={event}
      name={ASSISTANT_RUN_EVENT_DATA_NAME}
      status={{ type: 'complete' }}
      type="data"
    />
  );
}

const unsupportedResumeEvent = {
  id: 'event-unsupported-1',
  kind: 'tool.resume.unsupported',
  label: 'Tool pause cannot be answered by this build',
  metadata: {
    resumeSupportedByClient: false,
    runStillSuspended: true,
    toolCallId: 'call-future-tool',
    toolName: 'brainstrike.someFutureSuspendingTool',
  },
  runId: 'run-1',
  sequence: 1,
  status: 'failed',
  timestamp: '2026-07-24T12:00:01.000Z',
} satisfies AssistantRunEvent;

const ordinaryToolFailedEvent = {
  id: 'event-tool-failed-1',
  kind: 'tool.failed',
  label: 'Tool failed',
  metadata: { toolCallId: 'call-ordinary-tool', toolName: 'brainstrike.readFile' },
  runId: 'run-1',
  sequence: 3,
  status: 'failed',
  timestamp: '2026-07-24T12:00:03.000Z',
} satisfies AssistantRunEvent;

const backgroundEvent = {
  id: 'event-background-1',
  kind: 'memory.configured',
  label: 'Memory configured',
  runId: 'run-1',
  sequence: 2,
  status: 'completed',
  timestamp: '2026-07-24T12:00:02.000Z',
} satisfies AssistantRunEvent;

// The Detail level is untouched, so `useAssistantDetailLevel`
// returns DEFAULT_ASSISTANT_DETAIL_LEVEL ('standard') — exactly the level a
// user sees without touching the Detail control.
describe('AssistantRunTimelineDataPart at the DEFAULT detail level', () => {
  beforeEach(() => {
    mockMessages = [];
  });

  it('renders the unanswerable-tool-pause rejection alongside the tool-call part the mapper emits (BST-558)', () => {
    // The REAL thread shape: the mapper's `tool-call` part for the suspended
    // call sits in the thread next to the run event. Without the
    // always-visible exemption in `resolveAssistantRunEventRenderPlan`, this
    // part sends the row down the HIDDEN branch and the "durable, always
    // visible" claim is false at every detail level.
    mockMessages = [
      toolCallMessage('call-future-tool', 'brainstrike.someFutureSuspendingTool'),
      runEventMessage(unsupportedResumeEvent),
    ];

    renderDataPart(unsupportedResumeEvent);

    expect(screen.getByTestId('assistant-run-timeline')).toBeInTheDocument();
    expect(screen.getByText('Tool pause cannot be answered by this build')).toBeInTheDocument();
  });

  it('CONTROL: an ordinary tool.failed row IS still suppressed by its tool card', () => {
    // Proves the exemption above is scoped to the always-visible kinds and did
    // not disable `hasToolCallPartForEvent` for the `tool.*` rows it exists for.
    mockMessages = [
      toolCallMessage('call-ordinary-tool', 'brainstrike.readFile'),
      runEventMessage(ordinaryToolFailedEvent),
    ];

    renderDataPart(ordinaryToolFailedEvent);

    expect(screen.queryByTestId('assistant-run-timeline')).not.toBeInTheDocument();
  });

  it('still hides ordinary background bookkeeping rows', () => {
    mockMessages = [runEventMessage(backgroundEvent)];

    renderDataPart(backgroundEvent);

    expect(screen.queryByTestId('assistant-run-timeline')).not.toBeInTheDocument();
  });
});
