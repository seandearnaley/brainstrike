import type { AssistantToolSuspendRequest } from '@brainstrike/assistant-contract/tool-suspend';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantToolSuspendNotice, PlanModeExitProvider } from '../assistant-tool-suspend-notice';
import {
  __resetUnreadablePauseLogForTests,
  UNREADABLE_PAUSE_LOG_CAPACITY,
} from '../unreadable-pause-log-cache';

const appendMessageMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());
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

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ warn: loggerWarnMock }),
  };
});

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

beforeEach(() => {
  __resetUnreadablePauseLogForTests();
});

describe('AssistantToolSuspendNotice', () => {
  beforeEach(() => {
    appendMessageMock.mockReset();
    loggerWarnMock.mockReset();
    appendMessageMock.mockImplementation((message: { role?: 'user' }) => {
      threadMessagesMock.push({ role: message.role ?? 'user' });
    });
    threadMessagesMock.splice(0);
  });

  it.each(['claimed', 'consumed', 'interrupted', 'unknown'])(
    'preserves a recovered plan but prevents resubmitting a %s decision',
    async (decisionState) => {
      const user = userEvent.setup();
      render(
        <AssistantToolSuspendNotice
          data={{
            ...planRequest,
            decisionState,
            delegation: {
              path: [
                {
                  childRuntimeRunId: 'child',
                  parentRuntimeRunId: planRequest.runId,
                  parentToolCallId: planRequest.toolCallId,
                  personaId: 'worker',
                },
              ],
              toolCallId: 'leaf',
            },
            stale: true,
            suspendedAt: '2026-09-10T00:00:00Z',
          }}
        />
      );
      expect(screen.getByText('Refactor the parser.')).toBeInTheDocument();
      const approve = screen.getByRole('button', { name: 'Approve' });
      expect(approve).toBeDisabled();
      expect(screen.getByRole('button', { name: /reject/i })).toBeDisabled();
      expect(screen.getByTestId('delegated-decision-recovery-status')).toBeInTheDocument();
      await user.click(approve);
      expect(appendMessageMock).not.toHaveBeenCalled();
    }
  );

  it('renders the plan overview, steps, risks, and verification', () => {
    render(<AssistantToolSuspendNotice data={planRequest} />);
    expect(screen.getByTestId('assistant-submit-plan-notice')).toBeInTheDocument();
    expect(screen.getByText(/Parser refactor/)).toBeInTheDocument();
    expect(screen.getByText('Refactor the parser.')).toBeInTheDocument();
    expect(screen.getByText('Read the code')).toBeInTheDocument();
    expect(screen.getByText(/May touch many files/)).toBeInTheDocument();
    expect(screen.getByText(/Run the tests/)).toBeInTheDocument();
  });

  it('surfaces a malformed plan payload and allows safe rejection only', async () => {
    const user = userEvent.setup();
    render(
      <AssistantToolSuspendNotice
        data={{
          ...planRequest,
          suspendPayload: { overview: 42, steps: 'not-an-array', title: { nested: true } },
        }}
      />
    );

    expect(screen.getByTestId('assistant-submit-plan-payload-unreadable')).toHaveAttribute(
      'role',
      'alert'
    );
    expect(screen.getByText(/plan details could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/"overview": 42/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toEqual({ action: 'rejected' });
  });

  it('keeps readable plan terms when optional presentation fields drift', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...planRequest,
          suspendPayload: {
            overview: 'Refactor safely.',
            risks: 42,
            steps: [
              { title: 'Keep this step' },
              { detail: { richer: true }, title: 'Keep this title' },
            ],
            title: 'Compatible plan',
            verification: { command: 'pnpm test' },
          },
        }}
      />
    );

    expect(screen.getByText(/Compatible plan/)).toBeInTheDocument();
    expect(screen.getByText('Refactor safely.')).toBeInTheDocument();
    expect(screen.getByText('Keep this step')).toBeInTheDocument();
    expect(screen.getByText('Keep this title')).toBeInTheDocument();
    expect(screen.queryByText(/Risks:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Verification:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
  });

  it('refuses approval when any plan step terms are unreadable', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...planRequest,
          suspendPayload: {
            overview: 'Refactor safely.',
            steps: [{ title: 'Readable step' }, { title: 42 }],
            title: 'Lossy plan',
          },
        }}
      />
    );

    expect(screen.getByTestId('assistant-submit-plan-payload-unreadable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled();
  });

  it.each([undefined, null])(
    'keeps the actionable legacy fallback when a plan payload is absent (%s)',
    (suspendPayload) => {
      render(<AssistantToolSuspendNotice data={{ ...planRequest, suspendPayload }} />);

      expect(screen.getByText('Plan for your approval')).toBeInTheDocument();
      expect(screen.getByText('A plan was submitted for your review.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /reject/i })).toBeEnabled();
    }
  );

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

  it('approving a delegated plan preserves the root plan-mode authority', async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    const delegation = {
      path: [
        {
          childRuntimeRunId: 'run-1',
          parentRuntimeRunId: 'root-run',
          parentToolCallId: 'delegate-plan',
          personaId: 'decision-probe',
        },
      ],
      toolCallId: 'call-1',
    };
    render(
      <PlanModeExitProvider onExit={onExit}>
        <AssistantToolSuspendNotice data={{ ...planRequest, delegation }} />
      </PlanModeExitProvider>
    );
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(onExit).not.toHaveBeenCalled();
    expect(lastResumeAction()).toMatchObject({
      delegation,
      resumeData: { action: 'approved' },
      runId: 'root-run',
      toolCallId: 'delegate-plan',
    });
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

  it('routes a child question to its parent snapshot with exact leaf identity', async () => {
    const user = userEvent.setup();
    const delegation = {
      path: [
        {
          childRuntimeRunId: 'run-2',
          parentRuntimeRunId: 'root-run',
          parentToolCallId: 'delegate-1',
          personaId: 'explore',
        },
      ],
      toolCallId: 'call-2',
    };
    render(<AssistantToolSuspendNotice data={{ ...askFreeTextRequest, delegation }} />);
    await user.type(screen.getByRole('textbox'), 'Paris');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    expect(lastResumeAction()).toMatchObject({
      delegation,
      resumeData: { answer: 'Paris' },
      runId: 'root-run',
      toolCallId: 'delegate-1',
    });
  });

  it('askUser free-text appends the {answer} envelope (rider-attachable, never a bare string)', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={askFreeTextRequest} />);
    expect(screen.getByTestId('assistant-ask-user-notice')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/your answer/i), 'San Francisco');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toEqual({ answer: 'San Francisco' });
  });

  it('keeps a malformed askUser payload visible without allowing an answer', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...askFreeTextRequest,
          suspendPayload: { options: 'not-an-array', question: { nested: true } },
        }}
      />
    );

    expect(screen.getByTestId('assistant-ask-user-payload-unreadable')).toHaveAttribute(
      'role',
      'alert'
    );
    expect(screen.getByText(/question details could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/"options": "not-an-array"/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /your answer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it('makes a readable question explicitly answerable when its choices are unreadable', async () => {
    const user = userEvent.setup();
    render(
      <AssistantToolSuspendNotice
        data={{
          ...askFreeTextRequest,
          suspendPayload: {
            options: [{ label: 'Keep me' }, { label: 42 }],
            question: 'Still readable?',
            selectionMode: 'single_select',
          },
        }}
      />
    );

    expect(screen.getByTestId('assistant-ask-user-payload-unreadable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep me' })).not.toBeInTheDocument();
    expect(screen.getByText('Still readable?')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /answer in your own words/i }), 'No');
    await user.click(screen.getByRole('button', { name: /send answer/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()?.['resumeData']).toEqual({ answer: 'No' });
  });

  it('bounds unreadable payload diagnostics inside the notice', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...askFreeTextRequest,
          suspendPayload: { options: 'not-an-array', question: { nested: true } },
        }}
      />
    );

    expect(screen.getByText(/"options": "not-an-array"/)).toHaveClass('max-h-48', 'overflow-auto');
  });

  it('caps serialized unreadable payload diagnostics before rendering or logging them', async () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...askFreeTextRequest,
          suspendPayload: { options: 'x'.repeat(8000), question: { nested: true } },
        }}
      />
    );

    const diagnostic = screen
      .getByTestId('assistant-ask-user-payload-unreadable')
      .querySelector('pre');
    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.textContent).toContain('… (truncated)');
    expect(diagnostic?.textContent?.length).toBeLessThanOrEqual(4020);
    await waitFor(() => expect(loggerWarnMock).toHaveBeenCalledTimes(1));
    const loggedContext = loggerWarnMock.mock.calls[0]?.[1] as
      | { suspendPayload?: unknown }
      | undefined;
    expect(loggedContext?.suspendPayload).toBe(diagnostic?.textContent);
  });

  it('redacts secrets before rendering or logging unreadable payload diagnostics', async () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...askFreeTextRequest,
          suspendPayload: {
            nested: { apiKey: 'sk-sensitive', password: 'also-sensitive' },
            options: 'not-an-array',
            question: { nested: true },
          },
        }}
      />
    );

    const diagnostic = screen
      .getByTestId('assistant-ask-user-payload-unreadable')
      .querySelector('pre');
    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.textContent).toContain('[REDACTED]');
    expect(diagnostic?.textContent).not.toContain('sk-sensitive');
    expect(diagnostic?.textContent).not.toContain('also-sensitive');
    await waitFor(() => expect(loggerWarnMock).toHaveBeenCalledTimes(1));
    const loggedContext = loggerWarnMock.mock.calls[0]?.[1] as
      | { suspendPayload?: unknown }
      | undefined;
    expect(loggedContext?.suspendPayload).toBe(diagnostic?.textContent);
  });

  it.each([
    ['a non-array option list', { options: 'not-an-array', question: 'Pick one' }],
    ['an option list with no readable entries', { options: [{ label: 42 }], question: 'Pick one' }],
    [
      'an unknown selection mode',
      { options: [{ label: 'Keep me' }], question: 'Pick one', selectionMode: 'ranked' },
    ],
  ])('surfaces %s with an explicit free-text recovery', (_case, suspendPayload) => {
    render(<AssistantToolSuspendNotice data={{ ...askFreeTextRequest, suspendPayload }} />);

    expect(screen.getByTestId('assistant-ask-user-payload-unreadable')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /answer in your own words/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Keep me' })).not.toBeInTheDocument();
  });

  it('logs an unreadable pause only once across unmount and remount', async () => {
    const data = {
      ...askFreeTextRequest,
      runId: 'run-log-dedupe',
      suspendPayload: { options: 'not-an-array', question: { nested: true } },
      toolCallId: 'call-log-dedupe',
    };
    const view = render(<AssistantToolSuspendNotice data={data} />);
    await waitFor(() => expect(loggerWarnMock).toHaveBeenCalledTimes(1));

    view.unmount();
    render(
      <AssistantToolSuspendNotice
        data={{
          ...data,
          suspendPayload: { options: 'not-an-array', question: { nested: true } },
        }}
      />
    );

    await waitFor(() => expect(loggerWarnMock).toHaveBeenCalledTimes(1));
  });

  it('resets unreadable-pause log identities for deterministic test isolation', async () => {
    const data = {
      ...askFreeTextRequest,
      runId: 'run-log-reset',
      suspendPayload: { options: 'not-an-array', question: { nested: true } },
      toolCallId: 'call-log-reset',
    };
    const first = render(<AssistantToolSuspendNotice data={data} />);
    await waitFor(() => expect(loggerWarnMock).toHaveBeenCalledTimes(1));

    first.unmount();
    __resetUnreadablePauseLogForTests();
    loggerWarnMock.mockReset();
    render(<AssistantToolSuspendNotice data={data} />);

    await waitFor(() => expect(loggerWarnMock).toHaveBeenCalledTimes(1));
  });

  it('bounds unreadable-pause log identities and evicts the oldest deterministically', async () => {
    for (let index = 0; index <= UNREADABLE_PAUSE_LOG_CAPACITY; index += 1) {
      const view = render(
        <AssistantToolSuspendNotice
          data={{
            ...askFreeTextRequest,
            runId: `run-log-cap-${index}`,
            suspendPayload: { options: 'not-an-array', question: { nested: true } },
            toolCallId: `call-log-cap-${index}`,
          }}
        />
      );
      view.unmount();
    }

    await waitFor(() =>
      expect(loggerWarnMock).toHaveBeenCalledTimes(UNREADABLE_PAUSE_LOG_CAPACITY + 1)
    );

    render(
      <AssistantToolSuspendNotice
        data={{
          ...askFreeTextRequest,
          runId: 'run-log-cap-0',
          suspendPayload: { options: 'not-an-array', question: { nested: true } },
          toolCallId: 'call-log-cap-0',
        }}
      />
    );

    await waitFor(() =>
      expect(loggerWarnMock).toHaveBeenCalledTimes(UNREADABLE_PAUSE_LOG_CAPACITY + 2)
    );
  });

  it.each([undefined, null])(
    'keeps the actionable legacy free-text fallback when an askUser payload is absent (%s)',
    (suspendPayload) => {
      render(<AssistantToolSuspendNotice data={{ ...askFreeTextRequest, suspendPayload }} />);

      expect(screen.getByText('The assistant has a question')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /your answer/i })).toBeEnabled();
    }
  );

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
    expect(lastResumeAction()?.['resumeData']).toEqual({ answer: 'Yes' });
  });

  it('askUser multi-select appends a string-array {answer} envelope', async () => {
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
    expect(lastResumeAction()?.['resumeData']).toEqual({ answer: ['a', 'b'] });
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

  it('renders a VISIBLE rejection (not an inert waiting card) for an unregistered suspending tool', async () => {
    const user = userEvent.setup();
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
    const notice = screen.getByTestId('assistant-tool-suspend-unsupported-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveAttribute('role', 'alert');
    expect(screen.getByText(/Cannot resume brainstrike\.somethingElse/)).toBeInTheDocument();
    // Never present the pause as still-actionable, and never guess a typed action.
    expect(screen.queryByText(/Waiting on input/)).not.toBeInTheDocument();
    // The copy must claim nothing about server-side state: the run is NOT stopped
    // (the mapper leaves the Mastra snapshot suspended on purpose) and there is no
    // run.failed to point at.
    expect(
      screen.getByText(/the pause cannot be answered and the run cannot continue here/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/run was stopped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/run diagnostics/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    // The user is not stranded: the dead card is explicitly dismissible.
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(
      screen.queryByTestId('assistant-tool-suspend-unsupported-notice')
    ).not.toBeInTheDocument();
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it('caps serialized diagnostics for an unregistered suspending tool', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-unsupported-large',
          suspendPayload: { detail: 'x'.repeat(8000) },
          toolCallId: 'call-unsupported-large',
          toolName: 'brainstrike.somethingElse',
        }}
      />
    );

    const diagnostic = screen
      .getByTestId('assistant-tool-suspend-unsupported-notice')
      .querySelector('pre');
    expect(diagnostic?.textContent).toContain('… (truncated)');
    expect(diagnostic?.textContent?.length).toBeLessThanOrEqual(4020);
  });

  it('leaves the REGISTERED suspending tools rendering and resuming normally', async () => {
    const user = userEvent.setup();
    const plan = render(<AssistantToolSuspendNotice data={planRequest} />);
    expect(screen.getByTestId('assistant-submit-plan-notice')).toBeInTheDocument();
    expect(
      screen.queryByTestId('assistant-tool-suspend-unsupported-notice')
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(1));
    expect(lastResumeAction()).toMatchObject({
      resumeData: { action: 'approved' },
      toolName: 'brainstrike.submitPlan',
    });
    plan.unmount();

    render(<AssistantToolSuspendNotice data={askFreeTextRequest} />);
    expect(screen.getByTestId('assistant-ask-user-notice')).toBeInTheDocument();
    expect(
      screen.queryByTestId('assistant-tool-suspend-unsupported-notice')
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/your answer/i), 'Lisbon');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(appendMessageMock).toHaveBeenCalledTimes(2));
    expect(lastResumeAction()).toMatchObject({
      resumeData: { answer: 'Lisbon' },
      toolName: 'brainstrike.askUser',
    });
  });
});

describe('rediscovered suspend pauses (BST-1084)', () => {
  it('renders pending-since and a stale advisory on a rediscovered STALE pause, keeping controls enabled', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-redisc-1',
          stale: true,
          suspendedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          suspendPayload: { question: 'Which region?' },
          toolCallId: 'call-redisc-1',
          toolName: 'brainstrike.askUser',
        }}
      />
    );
    expect(screen.getByText(/pending since/i)).toBeInTheDocument();
    expect(screen.getByText(/pending a while/i)).toBeInTheDocument();
    // Advisory only — the answer control stays usable (surface, never auto-decline).
    // (Send itself stays disabled until text is entered, which is its normal state.)
    expect(screen.getByRole('textbox', { name: /your answer/i })).toBeEnabled();
  });

  it('renders pending-since but no advisory for a fresh rediscovered pause', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-redisc-2',
          stale: false,
          suspendedAt: new Date(Date.now() - 30 * 1000).toISOString(),
          suspendPayload: { question: 'Which region?' },
          toolCallId: 'call-redisc-2',
          toolName: 'brainstrike.askUser',
        }}
      />
    );
    expect(screen.getByText(/pending since/i)).toBeInTheDocument();
    expect(screen.queryByText(/pending a while/i)).not.toBeInTheDocument();
  });

  it('renders a LIVE pause (no suspendedAt) without the rediscovery lines', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          runId: 'run-live-1',
          suspendPayload: { question: 'Which region?' },
          toolCallId: 'call-live-1',
          toolName: 'brainstrike.askUser',
        }}
      />
    );
    expect(screen.queryByText(/pending since/i)).not.toBeInTheDocument();
  });

  it('renders the dead-end notice with rediscovery lines for an unregistered rediscovered pause', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          resumeSupported: false,
          runId: 'run-redisc-3',
          stale: true,
          suspendedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          suspendPayload: { question: 'why?' },
          toolCallId: 'call-redisc-3',
          toolName: 'brainstrike.someFutureSuspendingTool',
        }}
      />
    );
    expect(screen.getByTestId('assistant-tool-suspend-unsupported-notice')).toBeInTheDocument();
    expect(screen.getByText(/pending since/i)).toBeInTheDocument();
  });
});

describe('run_python network escalation — Gate B (BST-1070)', () => {
  const networkRequest = {
    runId: 'run-net-1',
    suspendPayload: {
      allowedDomains: ['pypi.org', '*.githubusercontent.com'],
      kind: 'network',
    },
    toolCallId: 'call-net-1',
    toolName: 'brainstrike.runPython',
  };

  beforeEach(() => {
    appendMessageMock.mockClear();
    threadMessagesMock.splice(0);
  });

  it('renders the escalation with deny primary-and-first and allow disabled until EVERY domain is ticked', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={networkRequest} />);

    expect(screen.getByText('This script wants to reach the internet')).toBeInTheDocument();
    expect(screen.getByText(/every other address is blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/it can also send data out/i)).toBeInTheDocument();
    expect(screen.getByText(/no "always allow" for internet access/i)).toBeInTheDocument();
    // Wildcard gloss, exact host bare.
    expect(screen.getByText('— any host ending in .githubusercontent.com')).toBeInTheDocument();

    const deny = screen.getByTestId('run-python-network-deny');
    const allow = screen.getByTestId('run-python-network-allow');
    // Deny precedes allow in DOM order (a click where Approve usually sits denies).
    expect(deny.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(allow).toBeDisabled();
    expect(allow).toHaveTextContent('Allow these 2 domains');
    expect(screen.getByText(/tick each domain above/i)).toBeInTheDocument();

    // One tick is not enough.
    await user.click(screen.getByTestId('run-python-network-domain-pypi.org'));
    expect(allow).toBeDisabled();
    await user.click(screen.getByTestId('run-python-network-domain-*.githubusercontent.com'));
    expect(allow).toBeEnabled();
  });

  it('never renders grant buttons — there is no grant surface on this channel', () => {
    render(<AssistantToolSuspendNotice data={networkRequest} />);
    expect(screen.queryByTestId('approval-grant-tool-always')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-grant-category-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-grant-overflow')).not.toBeInTheDocument();
  });

  it('deny resumes with {action:"deny"} and needs no ticks', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={networkRequest} />);
    await user.click(screen.getByTestId('run-python-network-deny'));
    expect(lastResumeAction()).toMatchObject({
      resumeData: { action: 'deny' },
      runId: 'run-net-1',
      toolCallId: 'call-net-1',
    });
  });

  it('allow (after ticking all) resumes with {action:"allow"} and names the count', async () => {
    const user = userEvent.setup();
    render(<AssistantToolSuspendNotice data={networkRequest} />);
    await user.click(screen.getByTestId('run-python-network-domain-pypi.org'));
    await user.click(screen.getByTestId('run-python-network-domain-*.githubusercontent.com'));
    await user.click(screen.getByTestId('run-python-network-allow'));
    expect(lastResumeAction()).toMatchObject({ resumeData: { action: 'allow' } });
    const appended = appendMessageMock.mock.calls.at(-1)?.[0] as {
      content: Array<{ text: string }>;
    };
    expect(appended.content[0]?.text).toBe('You allowed 2 domains.');
  });

  it('a single domain names it on the allow button', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...networkRequest,
          suspendPayload: { allowedDomains: ['pypi.org'], kind: 'network' },
        }}
      />
    );
    expect(screen.getByTestId('run-python-network-allow')).toHaveTextContent('Allow pypi.org');
  });

  it('an unreadable payload offers deny ONLY — never an allow for terms it cannot state', () => {
    render(
      <AssistantToolSuspendNotice
        data={{ ...networkRequest, suspendPayload: { kind: 'network' } }}
      />
    );
    expect(screen.getByTestId('run-python-network-unreadable')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-run-python-network-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('run-python-network-allow')).not.toBeInTheDocument();
  });

  it('caps serialized diagnostics for an unreadable network payload', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...networkRequest,
          suspendPayload: { allowedDomains: 'x'.repeat(8000), kind: 'network' },
        }}
      />
    );

    const diagnostic = screen
      .getByTestId('assistant-run-python-network-notice')
      .querySelector('pre');
    expect(diagnostic?.textContent).toContain('… (truncated)');
    expect(diagnostic?.textContent?.length).toBeLessThanOrEqual(4020);
  });

  it('a REDISCOVERED escalation renders the same card with the pending-since lines', () => {
    render(
      <AssistantToolSuspendNotice
        data={{
          ...networkRequest,
          stale: true,
          suspendedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        }}
      />
    );
    expect(screen.getByText('This script wants to reach the internet')).toBeInTheDocument();
    expect(screen.getByText(/pending since/i)).toBeInTheDocument();
    expect(screen.getByText(/pending a while/i)).toBeInTheDocument();
    // Ticks reset across remounts, so allow starts disabled post-reload too.
    expect(screen.getByTestId('run-python-network-allow')).toBeDisabled();
  });
});
