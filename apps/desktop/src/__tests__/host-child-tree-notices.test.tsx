// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { PendingHostApproval } from '@brainstrike/agent-host/thread-view';
import {
  type SubagentAnsweredApproval,
  SubagentApprovalHistoryContext,
} from '@brainstrike/assistant-ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactElement, use } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { HostApprovalHistoryProvider, HostChildWaiting } from '../renderer/host-child-tree-notices';
import type {
  HostTreeAnsweredApproval,
  HostTreeApprovals,
  HostTreeInteraction,
} from '../renderer/host-tree-approvals';

const { opened } = vi.hoisted(() => ({ opened: vi.fn() }));
vi.mock('@brainstrike/app-shell', () => ({ openHostChildTab: opened }));
afterEach(() => {
  cleanup();
  opened.mockReset();
});

function requested(kind: PendingHostApproval['kind'], interactionId: string): PendingHostApproval {
  return {
    input: { question: 'Which root?' },
    interactionId,
    kind,
    runId: 'child-run',
    toolCallId: `${interactionId}-call`,
    toolId: kind === 'approval' ? 'write_file' : kind === 'question' ? 'ask_user' : 'submit_plan',
    toolIdentity: 'identity-1',
    type: 'interaction.requested',
  } as PendingHostApproval;
}

/** A tree with fixed snapshots; nothing changes during these renders. */
function tree(
  interactions: readonly HostTreeInteraction[],
  answered: readonly HostTreeAnsweredApproval[] = []
): Pick<HostTreeApprovals, 'getAnswered' | 'getInteractions' | 'subscribe'> {
  return {
    getAnswered: () => answered,
    getInteractions: () => interactions,
    subscribe: () => () => undefined,
  };
}

test('the root names each child question or plan waiting beneath it and opens that child to answer', () => {
  render(
    <HostChildWaiting
      tree={tree([
        {
          interaction: requested('question', 'q-1'),
          owner: 'Cedar-1a2b3c',
          persona: 'worker',
          threadId: 'child-a',
        },
        {
          interaction: requested('plan', 'p-1'),
          owner: 'Maple-4d5e6f',
          persona: 'worker',
          threadId: 'child-b',
        },
      ])}
    />
  );
  const waiting = screen.getAllByTestId('host-child-waiting');
  expect(waiting.map((item) => item.textContent)).toEqual([
    expect.stringContaining('Cedar-1a2b3c asks you a question'),
    expect.stringContaining('Maple-4d5e6f proposes a plan'),
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Answer in Maple-4d5e6f' }));
  expect(opened).toHaveBeenCalledWith({ persona: 'worker', threadId: 'child-b' });
});

test('nothing renders while no child waits', () => {
  const { container } = render(<HostChildWaiting tree={tree([])} />);
  expect(container).toBeEmptyDOMElement();
});

function HistoryProbe({ threadId }: { readonly threadId: string }): ReactElement {
  const history = use(SubagentApprovalHistoryContext);
  return <pre data-testid={threadId}>{JSON.stringify(history?.(threadId))}</pre>;
}

test('each delegation card reads its own child’s answered approvals, owner-named', () => {
  render(
    <HostApprovalHistoryProvider
      tree={tree(
        [],
        [
          {
            approval: { ...requested('approval', 'a-1'), input: { path: 'notes.md' } },
            byPolicy: true,
            decision: 'approve',
            owner: 'Cedar-1a2b3c',
            threadId: 'child-a',
          },
        ]
      )}
    >
      <HistoryProbe threadId="child-a" />
      <HistoryProbe threadId="child-b" />
    </HostApprovalHistoryProvider>
  );
  const expected: SubagentAnsweredApproval[] = [
    {
      args: { path: 'notes.md' },
      byPolicy: true,
      decision: 'approve',
      interactionId: 'a-1',
      owner: 'Cedar-1a2b3c',
      runId: 'child-run',
      toolCallId: 'a-1-call',
      toolName: 'write_file',
    },
  ];
  expect(JSON.parse(screen.getByTestId('child-a').textContent ?? '')).toEqual(expected);
  expect(JSON.parse(screen.getByTestId('child-b').textContent ?? '')).toEqual([]);
});
