import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../tooltip';
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

const backgroundEvent = {
  id: 'event-background-1',
  kind: 'memory.configured',
  label: 'Memory configured',
  runId: 'run-1',
  sequence: 2,
  status: 'completed',
  timestamp: '2026-07-24T12:00:02.000Z',
} satisfies AssistantRunEvent;

// No AssistantDetailLevelProvider is mounted, so `useAssistantDetailLevel`
// returns DEFAULT_ASSISTANT_DETAIL_LEVEL ('standard') — exactly the level a
// user sees without touching the Detail control.
describe('AssistantRunTimelineDataPart at the DEFAULT detail level', () => {
  beforeEach(() => {
    mockMessages = [];
  });

  it('renders the unanswerable-tool-pause rejection (BST-558)', () => {
    mockMessages = [runEventMessage(unsupportedResumeEvent)];

    renderDataPart(unsupportedResumeEvent);

    expect(screen.getByTestId('assistant-run-timeline')).toBeInTheDocument();
    expect(screen.getByText('Tool pause cannot be answered by this build')).toBeInTheDocument();
  });

  it('still hides ordinary background bookkeeping rows', () => {
    mockMessages = [runEventMessage(backgroundEvent)];

    renderDataPart(backgroundEvent);

    expect(screen.queryByTestId('assistant-run-timeline')).not.toBeInTheDocument();
  });
});
