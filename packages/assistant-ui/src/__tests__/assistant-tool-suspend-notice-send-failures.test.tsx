import type { AssistantToolSuspendRequest } from '@brainstrike/assistant-contract/tool-suspend';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveThreadKeyContext } from '../active-thread-key-context';
import { AssistantToolSuspendNotice } from '../assistant-tool-suspend-notice';
import { resetFollowUpQueueStore } from '../follow-up-queue-store';
import { LiveDecisionProvider } from '../live-decision-context';

const appendMessageMock = vi.hoisted(() => vi.fn());
const threadRunningMock = vi.hoisted(() => ({ isRunning: false }));

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ thread: () => ({ append: appendMessageMock }) }),
  useAuiState: (
    selector: (state: { thread: { isRunning: boolean; messages: readonly unknown[] } }) => unknown
  ) => selector({ thread: { isRunning: threadRunningMock.isRunning, messages: [] } }),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return { ...actual, createLogger: () => ({ warn: vi.fn() }) };
});

const planRequest: AssistantToolSuspendRequest = {
  runId: 'run-plan',
  suspendPayload: { overview: 'Refactor the parser.', steps: [], title: 'Parser refactor' },
  toolCallId: 'call-plan',
  toolName: 'brainstrike.submitPlan',
};

const askRequest: AssistantToolSuspendRequest = {
  runId: 'run-ask',
  suspendPayload: { options: [{ label: 'Yes' }], question: 'OK?' },
  toolCallId: 'call-ask',
  toolName: 'brainstrike.askUser',
};

const networkRequest: AssistantToolSuspendRequest = {
  runId: 'run-net',
  suspendPayload: { allowedDomains: ['pypi.org'], kind: 'network' },
  toolCallId: 'call-net',
  toolName: 'brainstrike.runPython',
};

type AnswerNotice = (user: ReturnType<typeof userEvent.setup>) => Promise<void>;

// `thread().append` returns void in the installed assistant-ui, so a failed
// resumed run arrives as thread state (`retryable`), never as a rejection. The
// failures the notice itself must report are a synchronous append throw and a
// host refusal of the live decision.
describe('AssistantToolSuspendNotice send failures', () => {
  beforeEach(() => {
    appendMessageMock.mockReset();
    threadRunningMock.isRunning = false;
    resetFollowUpQueueStore();
  });

  it.each<[string, AssistantToolSuspendRequest, AnswerNotice]>([
    [
      'a plan approval',
      planRequest,
      (user) => user.click(screen.getByRole('button', { name: /approve/i })),
    ],
    [
      'an unreadable plan rejection',
      { ...planRequest, suspendPayload: { overview: 42 } },
      (user) => user.click(screen.getByRole('button', { name: /reject/i })),
    ],
    [
      'an askUser choice',
      askRequest,
      (user) => user.click(screen.getByRole('button', { name: 'Yes' })),
    ],
    [
      'an answer to a question with unreadable choices',
      { ...askRequest, suspendPayload: { options: 'not-an-array', question: 'Still?' } },
      async (user) => {
        await user.type(screen.getByRole('textbox', { name: /answer in your own words/i }), 'No');
        await user.click(screen.getByRole('button', { name: /send answer/i }));
      },
    ],
    [
      'a network denial',
      networkRequest,
      (user) => user.click(screen.getByTestId('run-python-network-deny')),
    ],
    [
      'an unreadable network denial',
      { ...networkRequest, suspendPayload: { kind: 'network' } },
      (user) => user.click(screen.getByRole('button', { name: /don't allow/i })),
    ],
  ])(
    'shows why the decision was not sent after a synchronous append failure (%s)',
    async (_case, data, answer) => {
      appendMessageMock.mockImplementationOnce(() => {
        throw new Error('append failed');
      });
      const user = userEvent.setup();
      render(<AssistantToolSuspendNotice data={data} />);

      await answer(user);

      expect(screen.getByText('Decision not sent: append failed')).toHaveAttribute('role', 'alert');
    }
  );

  it('clears the send error once a retried decision is sent', async () => {
    appendMessageMock.mockImplementationOnce(() => {
      throw new Error('append failed');
    });
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={planRequest} />);

    await user.click(screen.getByRole('button', { name: /approve/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Decision not sent: append failed');
    await user.click(screen.getByRole('button', { name: /approve/i }));

    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('unlocks the notice and shows why when the host refuses the live decision', async () => {
    threadRunningMock.isRunning = true;
    const user = userEvent.setup();
    render(
      <ActiveThreadKeyContext.Provider value="root-thread">
        <LiveDecisionProvider
          transport={async () => {
            throw new Error('The decision was not applied: refused');
          }}
        >
          <AssistantToolSuspendNotice data={planRequest} />
        </LiveDecisionProvider>
      </ActiveThreadKeyContext.Provider>
    );

    await user.click(screen.getByRole('button', { name: /approve/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Decision not sent: The decision was not applied: refused'
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
    expect(appendMessageMock).not.toHaveBeenCalled();
  });
});
