// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { PendingHostApproval } from '@brainstrike/agent-host/thread-view';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract';
import {
  type SubagentAnsweredApproval,
  SubagentApprovalHistoryContext,
} from '@brainstrike/assistant-ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactElement, use } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  HostApprovalHistoryProvider,
  HostChildrenRunning,
  HostChildWaiting,
} from '../renderer/host-child-tree-notices';
import type {
  HostTreeAnsweredApproval,
  HostTreeApprovals,
  HostTreeInteraction,
  HostTreeRunning,
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

/** A root's tree whose background children are still working, while the root runs `activeTurnId`. */
function running(
  activeTurnId?: string,
  children: HostTreeRunning['children'] = [
    { owner: 'Cedar-1a2b3c', threadId: 'child-a', turnId: 'turn-1' },
    { owner: 'Fern-4d5e6f', threadId: 'child-b', turnId: 'turn-1' },
  ]
): Pick<HostTreeApprovals, 'getRunning' | 'subscribe' | 'threadId'> {
  const snapshot: HostTreeRunning = {
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
    children,
  };
  return { getRunning: () => snapshot, subscribe: () => () => undefined, threadId: 'root-1' };
}

type StopClient = Parameters<typeof HostChildrenRunning>[0]['client'];
/** The host client's one method these renders use; its generic signature is too wide to mock directly. */
function stopClient(request: (method: string, params: unknown) => Promise<unknown>): StopClient {
  return { request } as unknown as StopClient;
}

test('between the root’s runs, it names its working background children and Stop ends their turn', async () => {
  const request = vi.fn(async () => ({ outcome: 'already-terminal' as const }));
  render(<HostChildrenRunning client={stopClient(request)} tree={running()} />);
  expect(screen.getByRole('status')).toHaveTextContent('2 subagents running');
  fireEvent.click(screen.getByRole('button', { name: 'Stop 2 running subagents' }));
  // One root Stop for their shared turn: the host stops the turn's children and
  // keeps their results for the next user turn instead of waking the root.
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledWith('run/stop', {
    commandId: expect.any(String),
    runId: 'turn-1',
    threadId: 'root-1',
  });
});

test('while the root runs, it only names its working children; the composer’s Stop ends the turn', () => {
  render(<HostChildrenRunning client={stopClient(vi.fn())} tree={running('turn-1')} />);
  expect(screen.getByRole('status')).toHaveTextContent('2 subagents running');
  expect(screen.queryByRole('button')).toBeNull();
});

// Codex review on #3719: a child of turn 1 still works after the root starts
// turn 2. The composer's Stop ends turn 2 and its children only, so the strip
// keeps a Stop for the turn-1 child, and never claims turn 2's.
test('while the root runs a later turn, Stop ends only the children of earlier turns', async () => {
  const request = vi.fn(async () => ({ outcome: 'already-terminal' as const }));
  render(
    <HostChildrenRunning
      client={stopClient(request)}
      tree={running('turn-2', [
        { owner: 'Cedar-1a2b3c', threadId: 'child-a', turnId: 'turn-1' },
        { owner: 'Fern-4d5e6f', threadId: 'child-b', turnId: 'turn-2' },
      ])}
    />
  );
  expect(screen.getByRole('status')).toHaveTextContent('2 subagents running');
  fireEvent.click(screen.getByRole('button', { name: 'Stop 1 running subagent' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenCalledWith('run/stop', {
    commandId: expect.any(String),
    runId: 'turn-1',
    threadId: 'root-1',
  });
});

test('a Stop the host refuses stays visible with the host’s reason', async () => {
  const request = vi.fn(async () => {
    throw new BoundaryFailureError(INTERNAL_FAULT);
  });
  render(<HostChildrenRunning client={stopClient(request)} tree={running()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop 2 running subagents' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    describeBoundaryFailure(INTERNAL_FAULT)
  );
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
