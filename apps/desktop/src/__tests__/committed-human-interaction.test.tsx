// @vitest-environment jsdom

import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { CommittedThreadView } from '@brainstrike/agent-host/thread-view';
import {
  CommittedAssistantConversation,
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '@brainstrike/assistant-ui';
// Actual canonical tools, HostCore, authenticated socket, SQLite and public SDK captures.
import recordedPlan from '@brainstrike/test-utils/fixtures/committed-host-plan.json';
import recordedQuestion from '@brainstrike/test-utils/fixtures/committed-host-question.json';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
// HostCore with the canonical run_python binding (network-consent.integration.test.ts).
import recordedNetwork from './fixtures/committed-host-network.json';

afterEach(cleanup);
test.each([
  { kind: 'question', recording: recordedQuestion },
  { kind: 'plan', recording: recordedPlan },
])(
  'replays the committed $kind and retries rejected dispatch without inventing a response',
  async ({ kind, recording }) => {
    const rows = recording.map((row) => HostLogRowSchema.parse(row));
    const started = rows.find(({ event }) => event.type === 'run.started');
    const admitted = rows.find(
      ({ event }) => event.type === 'command.accepted' && event.method === 'run/start'
    );
    const requested = rows.findIndex(({ event }) => event.type === 'interaction.requested');
    const answered = rows.findIndex(({ event }) => event.type === 'interaction.responded');
    const response = rows[answered]?.event;
    if (
      started?.event.type !== 'run.started' ||
      admitted?.event.type !== 'command.accepted' ||
      response?.type !== 'interaction.responded' ||
      !('resumeData' in response)
    ) {
      throw new Error('Actual canonical interaction recording is incomplete');
    }
    const view = new CommittedThreadView(started.threadId);
    const identity = committedRunIdentity(rows, started.event.runId);
    view.accept(rows.slice(0, requested + 1));
    const store = new CommittedAssistantLogStore({
      identifyRun: () => identity,
      source: {
        getSnapshot: (): CommittedAssistantLogSourceSnapshot => ({
          connected: true,
          error: undefined,
          rows: view.getSnapshot(),
        }),
        subscribe: view.subscribe,
      },
      threadId: started.threadId,
    });
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Owned dispatcher rejected the answer'))
      .mockResolvedValue(undefined);
    try {
      render(
        <TooltipProvider>
          <CommittedAssistantConversation
            commands={{ onNew: vi.fn(), onRespondToToolApproval: dispatch }}
            label="Recorded canonical interaction"
            store={store}
          />
        </TooltipProvider>
      );
      if (kind === 'question') {
        fireEvent.click(screen.getByLabelText('Local', { exact: true }));
        fireEvent.click(screen.getByLabelText('Preview', { exact: true }));
      } else {
        fireEvent.change(screen.getByRole('textbox', { name: 'Plan feedback' }), {
          target: { value: 'Inspect the current change first.' },
        });
      }
      const decision = screen.getByRole('group', {
        name: kind === 'question' ? 'Question for you' : 'Plan decision',
      });
      const button = within(decision).getByRole('button', {
        name: kind === 'question' ? 'Send answer' : 'Reject plan',
      });
      fireEvent.click(button);
      // Wait for the decision's own error, not any alert: the message's error
      // live region (an empty role="alert") can mount first, before the
      // rejection has rendered and re-enabled the button (BST-1991).
      await within(decision).findByRole('alert');
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(store.getCommittedView().pendingInteractions).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(dispatch.mock.calls[0]?.[0].text)).toEqual(response.resumeData);
      fireEvent.click(button);
      await act(async () => undefined);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(store.getCommittedView().pendingInteractions).toHaveLength(1);
      await act(async () => {
        view.accept(rows.slice(requested + 1));
      });
      expect(store.getCommittedView().pendingInteractions).toHaveLength(0);
      expect(
        screen.queryByRole('group', {
          name: kind === 'question' ? 'Question for you' : 'Plan decision',
        })
      ).toBeNull();
    } finally {
      store.dispose();
    }
  }
);

test('replays a run_python network card: facts, ticked domains, the approval grant, then a per-call ask', async () => {
  const rows = recordedNetwork.map((row) => HostLogRowSchema.parse(row));
  const started = rows.find(({ event }) => event.type === 'run.started');
  const cards = rows.flatMap(({ event }, index) =>
    event.type === 'interaction.requested' ? [index] : []
  );
  const [first, second] = cards;
  if (started?.event.type !== 'run.started' || first === undefined || second === undefined) {
    throw new Error('Recorded network consent log is incomplete');
  }
  const view = new CommittedThreadView(started.threadId);
  const identity = committedRunIdentity(rows, started.event.runId);
  view.accept(rows.slice(0, first + 1));
  const store = new CommittedAssistantLogStore({
    identifyRun: () => identity,
    source: {
      getSnapshot: (): CommittedAssistantLogSourceSnapshot => ({
        connected: true,
        error: undefined,
        rows: view.getSnapshot(),
      }),
      subscribe: view.subscribe,
    },
    threadId: started.threadId,
  });
  const dispatch = vi.fn().mockResolvedValue(undefined);
  try {
    render(
      <TooltipProvider>
        <CommittedAssistantConversation
          commands={{ onNew: vi.fn(), onRespondToToolApproval: dispatch }}
          label="Recorded network consent"
          store={store}
        />
      </TooltipProvider>
    );
    const card = screen.getByRole('group', { name: 'Internet access for brainstrike.runPython' });
    // The code-execution facts and the requested domain, asked here, not later.
    expect(within(card).getByTestId('approval-run-python-write')).toBeTruthy();
    expect(within(card).queryByTestId('approval-run-python-forewarning')).toBeNull();
    expect(within(card).getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Allow commands this session' }));
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('checkbox', { name: 'pypi.org' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Allow commands this session' }));
    await act(async () => undefined);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      approved: true,
      optionId: 'grant-session',
      text: JSON.stringify({ action: 'allow' }),
    });

    await act(async () => {
      view.accept(rows.slice(first + 1, second + 1));
    });
    const next = screen.getByRole('group', { name: 'Internet access for brainstrike.runPython' });
    expect(within(next).queryByRole('button', { name: 'Always allow' })).toBeNull();
    expect(within(next).queryByRole('button', { name: 'Allow commands this session' })).toBeNull();
    fireEvent.click(within(next).getByRole('checkbox', { name: 'pypi.org' }));
    fireEvent.click(within(next).getByRole('button', { name: 'Allow pypi.org' }));
    await act(async () => undefined);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      approved: true,
      text: JSON.stringify({ action: 'allow' }),
    });
    expect(dispatch.mock.calls[1]?.[0]).not.toHaveProperty('optionId');

    await act(async () => {
      view.accept(rows.slice(second + 1));
    });
    expect(store.getCommittedView().pendingInteractions).toHaveLength(0);
    expect(screen.queryByTestId('committed-network-consent')).toBeNull();
  } finally {
    store.dispose();
  }
});
