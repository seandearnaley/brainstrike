// packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  type ChatModelAdapter,
  type ThreadMessageLike,
  useAssistantDataUI,
} from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
} from '../assistant-detail-level-context';
import { AssistantRunEventProvider } from '../assistant-run-event-context';
import { AssistantRunTimelineDataPart } from '../assistant-run-timeline-data-part';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import {
  completedPartsWithEvents,
  Harness,
  runEventPart,
} from './assistant-activity-timeline-fixtures';

const neverRun: ChatModelAdapter = {
  async run() {
    throw new Error('Hydration must not invoke a model.');
  },
};
const settled = { reason: 'stop', type: 'complete' } as const;
const cancelled = { reason: 'cancelled', type: 'incomplete' } as const;
const T = (s: number) => `2026-09-07T00:00:${String(s).padStart(2, '0')}.000Z`;

/** Registers the two data UIs the real panel registers, so rows can render. */
function DataUis() {
  useAssistantDataUI({ name: ASSISTANT_RUN_EVENT_DATA_NAME, render: AssistantRunTimelineDataPart });
  useAssistantDataUI({
    name: TOOL_APPROVAL_DATA_NAME,
    render: ({ data }) => <AssistantToolApprovalNotice data={data} />,
  });
  return null;
}

function renderHydrated(
  messages: ThreadMessageLike[],
  detail: 'standard' | 'developer' = 'standard'
) {
  window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, detail);
  return render(
    <AssistantDetailLevelProvider>
      <Harness adapter={neverRun} initialMessages={messages}>
        {(content) => (
          <AssistantRunEventProvider>
            <DataUis />
            {content}
          </AssistantRunEventProvider>
        )}
      </Harness>
    </AssistantDetailLevelProvider>
  );
}

const live = (container: HTMLElement) => container.querySelectorAll('[data-live="true"]');

afterEach(() => {
  window.localStorage.clear();
});

describe('hydrated threads render no live indicator unless something is genuinely pending', () => {
  it('completed turn with every call fenced by run events', async () => {
    const { container } = renderHydrated([
      { content: completedPartsWithEvents, role: 'assistant', status: settled },
    ]);
    await screen.findByText('Review complete.');
    expect(live(container)).toHaveLength(0);
  });

  it('killed turn: run.started and run.step.started never got a terminal (developer detail shows the rows)', async () => {
    // No run.cancelled / run.failed was ever written (renderer killed mid-run),
    // so the pairing has nothing to close these rows with: only the settled
    // owner message can stop them spinning.
    const content = [
      runEventPart({ id: 'r', kind: 'run.started', status: 'running', timestamp: T(0) }),
      runEventPart({ id: 'st', kind: 'run.step.started', status: 'running', timestamp: T(1) }),
      // No `result`: the tool call itself never resolved either (a genuinely
      // killed mid-run turn), so its status mirrors the settled message's
      // `cancelled` status — which is what makes the group's own done label
      // read "Stopped" (assistant-ui's `getGroupStatus` mirrors the LAST
      // contained part; a resolved tool call here would read "Worked").
      {
        args: {},
        argsText: '{}',
        toolCallId: 'x',
        toolName: 'brainstrike.executeCommand',
        type: 'tool-call' as const,
      },
    ];
    const { container } = renderHydrated(
      [{ content, role: 'assistant', status: cancelled }],
      'developer'
    );
    await screen.findByTestId('assistant-activity-group');
    expect(screen.getAllByLabelText('Interrupted').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Running')).not.toBeInTheDocument();
    expect(live(container)).toHaveLength(0);
    expect(screen.getByText(/Stopped/)).toBeInTheDocument();
  });

  it('an always-visible run event renders as a standalone row, never inside a collapsed group', async () => {
    const content = [
      ...completedPartsWithEvents,
      runEventPart({ id: 'c', kind: 'run.cancelled', status: 'cancelled', timestamp: T(30) }),
    ];
    renderHydrated([{ content, role: 'assistant', status: cancelled }]);
    const row = await screen.findByTestId('assistant-run-timeline');
    expect(row).toHaveTextContent('run.cancelled');
    for (const group of screen.getAllByTestId('assistant-activity-group')) {
      expect(group.contains(row)).toBe(false);
    }
  });

  it('approval answered on a second leg (pause in message A, terminal in message B)', async () => {
    const pause = runEventPart({
      id: 'p',
      kind: 'tool.approval.requested',
      runId: 'run-a',
      status: 'running',
      timestamp: T(0),
      toolCallId: 'x',
    });
    const done = runEventPart({
      id: 'd',
      kind: 'tool.completed',
      runId: 'run-b',
      timestamp: T(5),
      toolCallId: 'x',
    });
    const { container } = renderHydrated([
      {
        content: [
          {
            args: {},
            argsText: '{}',
            toolCallId: 'x',
            toolName: 'brainstrike.executeCommand',
            type: 'tool-call' as const,
          },
          pause,
        ],
        role: 'assistant',
        status: settled,
      },
      {
        content: [done, { text: 'Ran it.', type: 'text' as const }],
        role: 'assistant',
        status: settled,
      },
    ]);
    await screen.findByText('Ran it.');
    expect(live(container)).toHaveLength(0);
  });

  it('abandoned approval: settled message, no card, no terminal → interrupted, not live', async () => {
    const pause = runEventPart({
      id: 'p',
      kind: 'tool.approval.requested',
      runId: 'run-a',
      status: 'running',
      timestamp: T(0),
      toolCallId: 'x',
    });
    const { container } = renderHydrated([
      {
        content: [
          {
            args: {},
            argsText: '{}',
            toolCallId: 'x',
            toolName: 'brainstrike.executeCommand',
            type: 'tool-call' as const,
          },
          pause,
        ],
        role: 'assistant',
        status: settled,
      },
    ]);
    expect(await screen.findByText('Approval was pending')).toBeInTheDocument();
    expect(live(container)).toHaveLength(0);
  });

  it('rediscovered still-suspended approval: the pause row and its card stay actionable', async () => {
    const pause = runEventPart({
      id: 'p',
      kind: 'tool.approval.requested',
      runId: 'run-a',
      status: 'running',
      timestamp: T(0),
      toolCallId: 'x',
    });
    const { container } = renderHydrated([
      {
        content: [
          {
            args: {},
            argsText: '{}',
            toolCallId: 'x',
            toolName: 'brainstrike.executeCommand',
            type: 'tool-call' as const,
          },
          pause,
        ],
        role: 'assistant',
        status: settled,
      },
      {
        content: [
          {
            data: {
              runId: 'run-a',
              stale: false,
              suspendedAt: T(0),
              toolCallId: 'x',
              toolName: 'brainstrike.executeCommand',
            },
            name: TOOL_APPROVAL_DATA_NAME,
            type: 'data' as const,
          },
        ],
        id: 'suspended-approval:run-a:x',
        role: 'assistant',
        status: settled,
      },
    ]);
    // The notice's actual copy is "Tool approval required" with a "Pending"
    // status chip (brainstrike/src/assistant-tool-approval-notice.tsx),
    // not the "Awaiting your approval" wording the brief sketched — assert
    // the real, stable strings instead of loosening the check.
    expect(await screen.findByText('Tool approval required')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.executeCommand' })
    ).toBeEnabled();
    // The ONE legitimate live element on a reloaded thread: the pending pause row.
    expect(live(container)).toHaveLength(1);
  });

  it('interrupted subagent delegation: child rows are static', async () => {
    const childStarted = {
      data: {
        id: 'cs',
        kind: 'subagent.tool.started',
        label: 'Subagent tool started',
        metadata: {
          childToolName: 'brainstrike_grepSearch',
          parentToolCallId: 'p1',
          toolCallId: 'c1',
        },
        status: 'running',
        timestamp: T(1),
      },
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
      type: 'data' as const,
    };
    const { container } = renderHydrated([
      {
        content: [
          {
            args: { task: 'explore' },
            argsText: '{"task":"explore"}',
            toolCallId: 'p1',
            toolName: 'agent-explorer',
            type: 'tool-call' as const,
          },
          childStarted,
        ],
        role: 'assistant',
        status: cancelled,
      },
    ]);
    await screen.findByTestId('assistant-activity-group');
    expect(live(container)).toHaveLength(0);
  });

  it('a LIVE run that finishes ends with no live indicator (parity with hydration)', async () => {
    const finish = { release: () => {} };
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: completedPartsWithEvents.slice(0, 9) };
        await new Promise<void>((resolve) => {
          finish.release = resolve;
        });
        yield { content: completedPartsWithEvents };
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <AssistantDetailLevelProvider>
        <Harness adapter={adapter}>
          {(content) => (
            <AssistantRunEventProvider>
              <DataUis />
              {content}
            </AssistantRunEventProvider>
          )}
        </Harness>
      </AssistantDetailLevelProvider>
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    expect(live(container).length).toBeGreaterThan(0);
    await act(async () => {
      finish.release();
    });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(live(container)).toHaveLength(0));
  }, 20_000);
});
