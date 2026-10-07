// @vitest-environment jsdom

import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { CommittedThreadView } from '@brainstrike/agent-host/thread-view';
import {
  CommittedAssistantConversation,
  type CommittedAssistantLogSourceSnapshot,
  CommittedAssistantLogStore,
} from '@brainstrike/assistant-ui';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
// Actual canonical tools, HostCore, authenticated socket, SQLite and public SDK captures.
import recordedPlan from './fixtures/committed-host-plan.json';
import recordedQuestion from './fixtures/committed-host-question.json';

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
      const button = screen.getByRole('button', {
        name: kind === 'question' ? 'Send answer' : 'Reject plan',
      });
      fireEvent.click(button);
      await screen.findByRole('alert');
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
