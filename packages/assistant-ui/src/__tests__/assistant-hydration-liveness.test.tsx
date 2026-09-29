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
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
} from '../assistant-detail-level-context';
import { AssistantRunEventProvider } from '../assistant-run-event-context';
import { AssistantRunTimelineDataPart } from '../assistant-run-timeline-data-part';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import { renderWithApprovalSubmissions as render } from './approval-submission-test-utils';
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

/**
 * The wrapper `Harness` needs to nest `AssistantRunEventProvider` (and the
 * data UIs it depends on) INSIDE `AssistantRuntimeProvider` — see the task-7
 * report for why the brief's original outside-in nesting crashes. Shared by
 * every case here so there is exactly one place that defines it.
 */
const withRunEventContext = (content: ReactNode): ReactNode => (
  <AssistantRunEventProvider>
    <DataUis />
    {content}
  </AssistantRunEventProvider>
);

function renderHydrated(
  messages: ThreadMessageLike[],
  detail: 'standard' | 'developer' = 'standard'
) {
  window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, detail);
  return render(
    <AssistantDetailLevelProvider>
      <Harness adapter={neverRun} initialMessages={messages}>
        {withRunEventContext}
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
    // The headline span's direct text is exactly "Stopped" (no sibling text
    // merged in) — assert the exact string, not a loosened regex, scoped to
    // the headline because the row also carries an sr-only phase
    // announcement that reads "Stopped" too.
    expect(
      screen.getByText('Stopped', { selector: '.bs-activity-summary-label' })
    ).toBeInTheDocument();
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
    // The notice's actual heading copy is "Tool approval required" with a
    // "Pending" status chip (assistant-tool-approval-notice.tsx). The run-
    // timeline ROW below reads the raw event kind, 'tool.approval.requested',
    // only because this fixture's `runEventPart` sets `label` to the kind for
    // convenience — the real agent-emitted event carries a human-readable
    // label (e.g. "Awaiting your approval"); assert against this fixture's
    // actual, stable text rather than production copy this fixture never
    // sends.
    expect(await screen.findByText('Tool approval required')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Approval requested')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve brainstrike.executeCommand' })
    ).toBeEnabled();
    // The ONE legitimate live element on a reloaded thread: the pending pause
    // row — anchor it to the actual run-timeline row, not just a page-wide count.
    const row = screen.getByTestId('assistant-run-timeline');
    expect(row.querySelector('[data-live="true"]')).not.toBeNull();
    expect(live(container)).toHaveLength(1);
  });

  /**
   * PR #3061 review, Finding 2: a settled earlier leg's OWN run-scoped rows
   * read statically once it settles, even while a LATER leg (a fresh resume
   * after an approval pause) is genuinely still running. This is not a race
   * to fix — record it as the intended, self-consistent outcome (developer
   * detail only): the paused leg never emits a run terminal of its own (it
   * returns `finished` at the pause; desktop only UPDATEs
   * `thread_runs.status`), and the resume leg mints its OWN runId rather than
   * continuing the paused one — so leg A's `run.started` row can never pair
   * with anything in the thread, in ANY message ordering.
   */
  it("a settled leg's run row reads Interrupted while a later leg's own rows read Running", async () => {
    const pause = runEventPart({
      id: 'p',
      kind: 'tool.approval.requested',
      runId: 'run-a',
      status: 'running',
      timestamp: T(1),
      toolCallId: 'x',
    });
    renderHydrated(
      [
        {
          content: [
            runEventPart({
              id: 'r-a',
              kind: 'run.started',
              runId: 'run-a',
              status: 'running',
              timestamp: T(0),
            }),
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
                suspendedAt: T(1),
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
        {
          content: [
            runEventPart({
              id: 'r-b',
              kind: 'run.started',
              runId: 'run-b',
              status: 'running',
              timestamp: T(2),
            }),
            runEventPart({
              id: 's-b',
              kind: 'tool.started',
              runId: 'run-b',
              status: 'running',
              timestamp: T(3),
              toolCallId: 'y',
            }),
          ],
          role: 'assistant',
          status: { type: 'running' },
        },
      ],
      'developer'
    );

    await screen.findByText('Tool approval required');
    const timelines = screen.getAllByTestId('timeline');
    expect(timelines).toHaveLength(3);
    const [messageA, , messageB] = timelines;
    if (!(messageA && messageB)) {
      throw new Error('Expected three hydrated messages.');
    }

    const rowByLabel = (scope: HTMLElement, text: string): HTMLElement => {
      const row = within(scope)
        .getAllByTestId('assistant-run-timeline')
        .find((candidate) => candidate.textContent?.includes(text));
      if (!row) {
        throw new Error(`Expected a run-timeline row containing "${text}".`);
      }
      return row;
    };

    // A settled: its run.started row can never pair (see the block comment
    // above), so it downgrades to the renderer-only 'interrupted' status —
    // static, not a pulsing spinner.
    expect(
      within(rowByLabel(messageA, 'run.started')).getByLabelText('Interrupted')
    ).toBeInTheDocument();

    // The SAME message's pause row is exempt from that downgrade: a pending
    // `brainstrike.tool-approval` card for toolCallId x (message 2) is still
    // in the thread, so it stays genuinely actionable.
    const pauseRow = rowByLabel(messageA, 'Approval requested');
    expect(within(pauseRow).getByLabelText('Running')).toBeInTheDocument();
    expect(pauseRow.querySelector('[data-live="true"]')).not.toBeNull();

    // B is a genuinely running leg (its own message never settled) — nothing
    // in it gets downgraded.
    expect(
      within(rowByLabel(messageB, 'run.started')).getByLabelText('Running')
    ).toBeInTheDocument();
    expect(
      within(rowByLabel(messageB, 'tool.started')).getByLabelText('Running')
    ).toBeInTheDocument();
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
    const group = await screen.findByTestId('assistant-activity-group');
    // The delegation card renders collapsed by default (`useState(false)` in
    // SubagentExecutionCard), and only renders child rows once expanded — so
    // the zero-live assertion below is vacuous unless the child row actually
    // reaches the DOM. Expand the turn's activity group, then the card
    // itself, before checking liveness.
    const user = userEvent.setup();
    await user.click(within(group).getByRole('button', { name: 'Expand activity' }));
    const cardToggle = within(group).getByRole('button', { expanded: false });
    expect(cardToggle).toHaveTextContent('1 tool call');
    await user.click(cardToggle);
    const childRow = screen.getByText('brainstrike_grepSearch').closest('li');
    expect(childRow).not.toBeNull();
    // Interrupted (not running): the owning message already settled
    // (`cancelled`) with no terminal `subagent.tool.*` event for this child,
    // so `readLiveSubagentToolRowsFromMessages` downgrades it from 'running'
    // to 'interrupted' — CircleSlash, not the pulsing CircleDashed.
    expect(childRow?.querySelector('svg')).toHaveClass('lucide-circle-slash');
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
        <Harness adapter={adapter}>{withRunEventContext}</Harness>
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

  // BST-1679 task 6: a hydrated `requires-action` message is not something
  // persistence produces (hydrated messages are hard-coded `complete` — see
  // the `settled` fixture used throughout this file), so unlike the parts
  // test's genuinely-live approval-wait case, the reload counterpart here is
  // a delegation call that already carries its result.
  it('reads a hydrated resolved delegation as Delegated, with no live indicator', async () => {
    const { container } = renderHydrated([
      {
        content: [
          {
            args: {},
            argsText: '{}',
            result: { subAgentToolResults: [], text: 'Found it.' },
            toolCallId: 'delegate-1',
            toolName: 'agent-explore',
            type: 'tool-call' as const,
          },
        ],
        role: 'assistant',
        status: settled,
      },
    ]);
    const group = await screen.findByTestId('assistant-activity-group');
    expect(
      within(group).getByText('Delegated to Explorer', { selector: '.bs-activity-summary-label' })
    ).toBeInTheDocument();
    expect(within(group).getByText(/1 step\b/)).toBeInTheDocument();
    expect(live(container)).toHaveLength(0);
  });
});
