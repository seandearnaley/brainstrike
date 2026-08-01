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
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../tooltip';
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
