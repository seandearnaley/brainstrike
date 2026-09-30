/**
 * BST-1070 result surface: `run_python` has four terminal states plus an
 * orthogonal truncation modifier, and the design's two easy-to-get-wrong rules
 * are pinned here:
 * - a NON-ZERO exit code is not a tool failure (amber "finished with an
 *   error", never the destructive didn't-run chrome);
 * - CANCELLED never renders as success and never renders as empty — a green
 *   check implies the work completed, a blank card implies nothing happened.
 * Plus the state the implementer is most tempted to fold away: `exitCode:
 * null, timedOut: false` is KILLED — a real state (segfault, OOM), rendered as
 * neither completed nor "nothing ran".
 */

import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

const streams = {
  stderr: '',
  stderrOmittedBytes: 0,
  stdout: '',
  stdoutOmittedBytes: 0,
};

function renderRunPython(result: unknown) {
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(
    <TooltipProvider>
      <Comp
        args={{ code: 'print(1)' }}
        result={result}
        status={{ type: 'complete' }}
        toolCallId="call-py-result"
        toolName="brainstrike.runPython"
      />
    </TooltipProvider>
  );
}

describe('run_python result surface', () => {
  it('renders a clean finish with its output pane', () => {
    renderRunPython({ ...streams, exitCode: 0, kind: 'completed', stdout: '42\n' });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent('Finished');
    expect(screen.getByTestId('run-python-stdout')).toHaveTextContent('42');
    // Empty stderr renders no pane at all.
    expect(screen.queryByTestId('run-python-stderr')).not.toBeInTheDocument();
  });

  it('says so explicitly when a clean finish printed nothing', () => {
    renderRunPython({ ...streams, exitCode: 0, kind: 'completed' });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      /didn't print anything/i
    );
  });

  it("renders a non-zero exit as an amber finish, never the destructive didn't-run chrome", () => {
    renderRunPython({
      ...streams,
      exitCode: 1,
      kind: 'completed',
      stderr: 'Traceback: boom',
    });
    const header = screen.getByTestId('run-python-result-header');
    expect(header).toHaveTextContent('Finished with an error (exit code 1)');
    expect(screen.getByTestId('run-python-result-state')).toHaveAttribute(
      'data-state',
      'completed-nonzero'
    );
    expect(screen.getByTestId('run-python-stderr')).toHaveTextContent('Traceback: boom');
  });

  it('renders a timeout with the partial output and the signal line', () => {
    renderRunPython({
      ...streams,
      kind: 'timed_out',
      signal: 'SIGKILL',
      stdout: 'tick\ntick\n',
      timeoutMs: 30_000,
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      'Stopped after 30 seconds — the script was still running.'
    );
    expect(screen.getByText(/ended by SIGKILL, so there's no exit code/i)).toBeInTheDocument();
    expect(screen.getByTestId('run-python-stdout')).toHaveTextContent('tick');
  });

  it('renders killed as its own state — not completed, not "nothing ran"', () => {
    renderRunPython({ ...streams, kind: 'killed', signal: 'SIGSEGV', stdout: 'partial' });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      /stopped by the system before it finished/i
    );
    expect(screen.getByText(/ended by SIGSEGV/i)).toBeInTheDocument();
    // Output the script produced before dying is still shown.
    expect(screen.getByTestId('run-python-stdout')).toHaveTextContent('partial');
    expect(screen.getByTestId('run-python-result-state')).toHaveAttribute('data-state', 'killed');
  });

  it('renders a defensive signal-less kill line rather than "ended by null"', () => {
    renderRunPython({ ...streams, kind: 'killed', signal: null });
    expect(
      screen.getByText(/ended before it finished, so there's no exit code/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/ended by null/i)).not.toBeInTheDocument();
  });

  it('cancelled with output renders partial output, never a success icon', () => {
    renderRunPython({
      kind: 'cancelled',
      partialStderr: '',
      partialStdout: 'halfway',
      processStarted: true,
      stderrOmittedBytes: 0,
      stdoutOmittedBytes: 0,
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent('You stopped this');
    expect(screen.getByTestId('run-python-stdout')).toHaveTextContent('halfway');
    expect(screen.getByTestId('run-python-result-state')).toHaveAttribute(
      'data-state',
      'cancelled'
    );
    // The CARD-level status also must not read as success.
    expect(screen.queryByRole('img', { name: 'Completed' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
  });

  it('cancelled with no output says so instead of rendering an empty card', () => {
    renderRunPython({
      kind: 'cancelled',
      partialStderr: '',
      partialStdout: '',
      processStarted: false,
      stderrOmittedBytes: 0,
      stdoutOmittedBytes: 0,
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      /before the script printed anything/i
    );
  });

  it("unavailable renders the didn't-run chrome with reason-specific copy and a failed card status", () => {
    renderRunPython({
      detail: 'No code-execution sandbox is configured on this machine.',
      kind: 'unavailable',
      reason: 'no_sandbox_configured',
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      /nothing ran — there's no sandbox to run python in/i
    );
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
  });

  it('explains the network_unsupported refusal instead of quietly running offline', () => {
    renderRunPython({
      detail: 'fence cannot grant network egress',
      kind: 'unavailable',
      reason: 'network_unsupported',
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      /can't give the script internet access/i
    );
    expect(screen.getByText(/wasn't run at all/i)).toBeInTheDocument();
  });

  it('a run can be both timed out AND truncated on one stream only — per-stream notes', () => {
    renderRunPython({
      ...streams,
      kind: 'timed_out',
      signal: 'SIGKILL',
      stdout: 'tail of output',
      stdoutOmittedBytes: 4_400_000,
      timeoutMs: 60_000,
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      'Stopped after 1 minute'
    );
    const note = screen.getByTestId('run-python-stdout-omitted');
    expect(note).toHaveTextContent("Output was too long — 4.4 MB wasn't captured.");
    expect(screen.queryByTestId('run-python-stderr-omitted')).not.toBeInTheDocument();
  });

  it('surfaces a scratch-cleanup failure instead of swallowing it', () => {
    renderRunPython({
      ...streams,
      exitCode: 0,
      kind: 'completed',
      scratchCleanupFailed: true,
      scratchDir: '/tmp/brainstrike-run-python-abc',
      stdout: 'done',
    });
    const note = screen.getByTestId('run-python-cleanup-failed');
    expect(note).toHaveTextContent(/couldn't be deleted/i);
    expect(note).toHaveTextContent('/tmp/brainstrike-run-python-abc');
  });

  it('is not "silent" when everything printed was omitted by truncation', () => {
    renderRunPython({
      ...streams,
      exitCode: 0,
      kind: 'completed',
      stdoutOmittedBytes: 2048,
    });
    // Empty displayed streams + positive omitted bytes: the script DID print.
    expect(screen.getByTestId('run-python-result-header')).not.toHaveTextContent(
      /didn't print anything/i
    );
    expect(screen.getByTestId('run-python-stdout-omitted')).toHaveTextContent(/wasn't captured/i);
  });

  it('a running status keeps the generic card — no structured surface, thinking indicator intact', () => {
    const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
    render(
      <TooltipProvider>
        <Comp
          args={{ code: 'print(1)' }}
          result={{ ...streams, exitCode: 0, kind: 'completed', stdout: 'partial echo' }}
          status={{ type: 'running' }}
          toolCallId="call-py-running"
          toolName="brainstrike.runPython"
        />
      </TooltipProvider>
    );
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
    expect(screen.queryByTestId('run-python-result-header')).not.toBeInTheDocument();
  });

  it('an incomplete status wins over a narrowable result so transport errors stay visible', () => {
    const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
    render(
      <TooltipProvider>
        <Comp
          args={{ code: 'print(1)' }}
          result={{ ...streams, exitCode: 0, kind: 'completed', stdout: '42' }}
          status={{ error: 'stream aborted by transport', type: 'incomplete' }}
          toolCallId="call-py-incomplete"
          toolName="brainstrike.runPython"
        />
      </TooltipProvider>
    );
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.getByText('stream aborted by transport')).toBeInTheDocument();
    expect(screen.queryByTestId('run-python-result-header')).not.toBeInTheDocument();
  });

  it('a cancelled result without omitted-byte fields fails narrowing — no bare-label surface', () => {
    renderRunPython({
      kind: 'cancelled',
      partialStderr: '',
      partialStdout: '',
      processStarted: false,
    });
    expect(screen.queryByTestId('run-python-result-header')).not.toBeInTheDocument();
  });

  it('leaves non-run_python results and malformed shapes on the generic pane', () => {
    const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
    render(
      <TooltipProvider>
        <Comp
          args={{}}
          result={{ kind: 'completed' }}
          status={{ type: 'complete' }}
          toolCallId="call-other"
          toolName="brainstrike.runPython"
        />
      </TooltipProvider>
    );
    // `completed` without its stream fields fails narrowing: no invented surface.
    expect(screen.queryByTestId('run-python-result-header')).not.toBeInTheDocument();
  });
});

describe('network_denied (Gate B, BST-1070)', () => {
  it("renders the user's refusal honestly — Stopped card, no panes, no failure chrome", () => {
    renderRunPython({ deniedDomains: ['pypi.org'], kind: 'network_denied' });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      "You didn't allow internet access, so the script didn't run."
    );
    expect(screen.getByTestId('run-python-result-state')).toHaveAttribute(
      'data-state',
      'network_denied'
    );
    expect(screen.queryByTestId('run-python-stdout')).not.toBeInTheDocument();
    // Card-level: the user's choice is a Stopped state, never Failed and
    // never a green Completed check.
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).not.toBeInTheDocument();
  });

  it('a malformed network_denied (non-string domains) stays on the generic pane', () => {
    renderRunPython({ deniedDomains: [42], kind: 'network_denied' });
    expect(screen.queryByTestId('run-python-result-header')).not.toBeInTheDocument();
  });
});

describe('gate refusal reasons (BST-1097)', () => {
  it('approval_confirmation_unavailable renders purpose-written copy, not the raw tool detail', () => {
    renderRunPython({
      detail:
        'No suspension channel is available, so the required run approval could not be requested.',
      kind: 'unavailable',
      reason: 'approval_confirmation_unavailable',
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      /needed your approval and there was no way to ask you for it/i
    );
  });

  it("resume_unrecognized says the answer couldn't be read — never that the user declined", () => {
    renderRunPython({
      detail: 'The resume data did not match either gate decision shape.',
      kind: 'unavailable',
      reason: 'resume_unrecognized',
    });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(/couldn't be read/i);
    expect(screen.queryByText(/you didn't approve/i)).not.toBeInTheDocument();
    expect(screen.getByText(/fresh prompt/i)).toBeInTheDocument();
  });
});

describe('sandbox readiness refusals (BST-1317)', () => {
  it.each([
    {
      detail: 'Missing required sandbox tools: bubblewrap (bwrap), socat, ripgrep (rg).',
      headline: /required sandbox tools are missing/i,
      reason: 'sandbox_dependencies_missing',
      remediation: /administrator to install the missing tools/i,
    },
    {
      detail: 'The host refused the sandbox namespace probe.',
      headline: /computer blocks the isolation the sandbox needs/i,
      reason: 'sandbox_namespace_blocked',
      remediation: /administrator to check the host.*sandbox support/i,
    },
    {
      detail: 'The sandbox runtime does not support this host.',
      headline: /operating system or runtime isn't supported/i,
      reason: 'sandbox_unsupported_runtime',
      remediation: /use a supported host/i,
    },
    {
      detail: 'Sandbox readiness did not finish within 5000 ms.',
      headline: /sandbox readiness check reached its time limit/i,
      reason: 'sandbox_readiness_timeout',
      remediation: /check stopped before your code could run/i,
    },
    {
      detail: 'The sandbox readiness probe exited with code 1.',
      headline: /sandbox couldn't confirm it was ready to isolate your code/i,
      reason: 'sandbox_readiness_failed',
      remediation: /administrator to check this host.*sandbox setup/i,
    },
  ])(
    'explains $reason and preserves actionable backend detail',
    ({ detail, headline, reason, remediation }) => {
      renderRunPython({ detail, kind: 'unavailable', reason });

      const header = screen.getByTestId('run-python-result-header');
      expect(header).toHaveTextContent(/^Nothing ran/);
      expect(header).toHaveTextContent(headline);
      expect(screen.getByText(remediation)).toBeInTheDocument();
      expect(screen.getByText(detail)).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
      expect(screen.queryByTestId('run-python-stdout')).not.toBeInTheDocument();
      expect(screen.queryByTestId('run-python-stderr')).not.toBeInTheDocument();
      expect(screen.getByTestId('run-python-result-state')).not.toHaveTextContent(
        /disable.*security|unsandboxed|unsafe fallback/i
      );
    }
  );

  it('keeps interpreter preparation failures distinct from sandbox readiness failures', () => {
    renderRunPython({
      detail: 'Python installation could not be completed.',
      kind: 'unavailable',
      reason: 'interpreter_unavailable',
    });

    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      "Nothing ran — the sandbox's Python couldn't be prepared on this machine."
    );
    expect(screen.queryByText(/required sandbox tools are missing/i)).not.toBeInTheDocument();
  });

  it('retains generic detail for a reason this renderer does not recognize', () => {
    const detail = 'A future backend reported a new readiness condition.';
    renderRunPython({ detail, kind: 'unavailable', reason: 'future_backend_reason' });

    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(/^Nothing ran\.$/);
    expect(screen.getByText(detail)).toBeInTheDocument();
  });
});

describe('declined (Gate A, BST-1097)', () => {
  it("renders the user's decline honestly — Stopped card, no panes, no failure chrome", () => {
    renderRunPython({ kind: 'declined' });
    expect(screen.getByTestId('run-python-result-header')).toHaveTextContent(
      "You didn't approve this, so the script didn't run."
    );
    expect(screen.getByTestId('run-python-result-state')).toHaveAttribute('data-state', 'declined');
    expect(screen.queryByTestId('run-python-stdout')).not.toBeInTheDocument();
    // The user's choice is a Stopped state, never Failed and never a green
    // Completed check.
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).not.toBeInTheDocument();
  });

  it('renders the same surface for the 1.59 framework decline envelope', () => {
    // BST-1282: since the @mastra/core 1.56 approval rework, Gate A IS the
    // framework's `requireApproval` gate, so a real decline now arrives as the
    // agent's shared `DeclinedToolCallResult` envelope rather than the tool's
    // own legacy `declined` arm. The envelope's extra fields must not defeat
    // the narrower, or the decline would fall back to the generic card and lose
    // this surface entirely.
    renderRunPython({
      kind: 'declined',
      message: 'The user declined this tool call, so it was not executed.',
      reason: 'not this path',
    });
    expect(screen.getByTestId('run-python-result-state')).toHaveAttribute('data-state', 'declined');
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).not.toBeInTheDocument();
  });
});
