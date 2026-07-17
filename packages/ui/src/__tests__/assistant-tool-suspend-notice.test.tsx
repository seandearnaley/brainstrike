import type { AssistantToolSuspendRequest } from '@brainstrike/assistant-contract/tool-suspend';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantToolSuspendNotice,
  PlanModeExitProvider,
} from '../assistant-ui-panel/assistant-tool-suspend-notice';

const appendMessageMock = vi.hoisted(() => vi.fn());
const threadMessagesMock = vi.hoisted(
  () =>
    [] as Array<{
      metadata?: { custom?: Record<string, unknown> };
      role: 'assistant' | 'user';
      status?: { type: string };
    }>
);

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ thread: () => ({ append: appendMessageMock }) }),
  useAuiState: (
    selector: (state: { thread: { messages: typeof threadMessagesMock } }) => unknown
  ) => selector({ thread: { messages: threadMessagesMock } }),
}));

function lastResumeAction(): Record<string, unknown> | undefined {
  const message = appendMessageMock.mock.calls.at(-1)?.[0] as
    | { runConfig?: { custom?: Record<string, unknown> } }
    | undefined;
  return message?.runConfig?.custom?.['brainstrikeToolSuspend'] as
    | Record<string, unknown>
    | undefined;
}

const planRequest: AssistantToolSuspendRequest = {
  runId: 'run-1',
  suspendPayload: {
    overview: 'Refactor the parser.',
    risks: 'May touch many files.',
    steps: [{ title: 'Read the code' }, { detail: 'carefully', title: 'Rewrite it' }],
    title: 'Parser refactor',
    verification: 'Run the tests.',
  },
  toolCallId: 'call-1',
  toolName: 'brainstrike.submitPlan',
};

const askFreeTextRequest: AssistantToolSuspendRequest = {
  runId: 'run-2',
  suspendPayload: { question: 'Which city?' },
  toolCallId: 'call-2',
  toolName: 'brainstrike.askUser',
};

describe('AssistantToolSuspendNotice', () => {
  beforeEach(() => {
    appendMessageMock.mockReset();
    appendMessageMock.mockImplementation((message: { role?: 'user' }) => {
      threadMessagesMock.push({ role: message.role ?? 'user' });
    });
    threadMessagesMock.splice(0);
  });

  it('renders the plan overview, steps, risks, and verification', () => {
    render(<AssistantToolSuspendNotice data={planRequest} />);
    expect(screen.getByTestId('assistant-submit-plan-notice')).toBeInTheDocument();
    expect(screen.getByText(/Parser refactor/)).toBeInTheDocument();
    expect(screen.getByText('Refactor the parser.')).toBeInTheDocument();
    expect(screen.getByText('Read the code')).toBeInTheDocument();
    expect(screen.getByText(/May touch many files/)).toBeInTheDocument();
    expect(screen.getByText(/Run the tests/)).toBeInTheDocument();
  });

  it('Approve appends a resume action { action: "approved" }', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={planRequest} />);
    await user.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()).toMatchObject({
      resumeData: { action: 'approved' },
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'brainstrike.submitPlan',
    });
  });

  it('Approve exits plan mode (clears the toggle) BEFORE composing the resume', async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(
      <PlanModeExitProvider onExit={onExit}>
        <AssistantToolSuspendNotice data={planRequest} />
      </PlanModeExitProvider>
    );
    await user.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Reject does NOT exit plan mode (stays on so the model can revise)', async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(
      <PlanModeExitProvider onExit={onExit}>
        <AssistantToolSuspendNotice data={planRequest} />
      </PlanModeExitProvider>
    );
    await user.click(screen.getByRole('button', { name: /reject/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('Reject with feedback appends { action: "rejected", feedback }', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={planRequest} />);
    await user.type(screen.getByLabelText(/feedback/i), 'tighten step 2');
    await user.click(screen.getByRole('button', { name: /reject/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toEqual({
      action: 'rejected',
      feedback: 'tighten step 2',
    });
  });

  it('askUser free-text appends the typed string', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={askFreeTextRequest} />);
    expect(screen.getByTestId('assistant-ask-user-notice')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/your answer/i), 'San Francisco');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toBe('San Francisco');
  });

  it('askUser single-select appends the chosen label', async () => {
    const user = userEvent.setup();
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-3',
          suspendPayload: { options: [{ label: 'Yes' }, { label: 'No' }], question: 'OK?' },
          toolCallId: 'call-3',
          toolName: 'brainstrike.askUser',
        }}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toBe('Yes');
  });

  it('askUser multi-select appends a string array', async () => {
    const user = userEvent.setup();
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-4',
          suspendPayload: {
            options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
            question: 'Pick any',
            selectionMode: 'multi_select',
          },
          toolCallId: 'call-4',
          toolName: 'brainstrike.askUser',
        }}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: /a/i }));
    await user.click(screen.getByRole('checkbox', { name: /b/i }));
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toEqual(['a', 'b']);
  });

  it('locks the controls once a matching resume is in-flight (pending run)', () => {
    threadMessagesMock.push({
      metadata: { custom: { brainstrikeToolSuspend: { runId: 'run-1', toolCallId: 'call-1' } } },
      role: 'user',
    });
    // A following assistant message still streaming (no terminal status) → pending.
    threadMessagesMock.push({ role: 'assistant', status: { type: 'running' } });
    render(<AssistantToolSuspendNotice data={planRequest} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeDisabled();
  });

  it('re-enables the controls when the resumed run FAILED (retryable), not permanently locking', () => {
    // Regression: a stale/failed resume must not permanently disable the notice.
    threadMessagesMock.push({
      metadata: { custom: { brainstrikeToolSuspend: { runId: 'run-1', toolCallId: 'call-1' } } },
      role: 'user',
    });
    // The assistant run that followed the resume finished as `incomplete` (failed).
    threadMessagesMock.push({ role: 'assistant', status: { type: 'incomplete' } });
    render(<AssistantToolSuspendNotice data={planRequest} />);
    expect(screen.getByRole('button', { name: /approve/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /reject/i })).not.toBeDisabled();
  });

  it('keeps the controls locked when the resumed run COMPLETED', () => {
    threadMessagesMock.push({
      metadata: { custom: { brainstrikeToolSuspend: { runId: 'run-1', toolCallId: 'call-1' } } },
      role: 'user',
    });
    threadMessagesMock.push({ role: 'assistant', status: { type: 'complete' } });
    render(<AssistantToolSuspendNotice data={planRequest} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
  });

  it('renders a generic fallback for an unknown suspending tool (no throw)', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-5',
          suspendPayload: { foo: 'bar' },
          toolCallId: 'call-5',
          toolName: 'brainstrike.somethingElse',
        }}
      />
    );
    expect(screen.getByTestId('assistant-tool-suspend-notice')).toBeInTheDocument();
    expect(screen.getByText(/Waiting on input/)).toBeInTheDocument();
  });
});
