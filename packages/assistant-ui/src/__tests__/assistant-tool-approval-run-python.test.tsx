/**
 * BST-1070 Gate A: the `run_python` pre-run approval card.
 *
 * The rules pinned here come straight from the design's hard lines:
 * - the safe state is STATED, never implied — "No internet access" is a
 *   rendered row, not a missing one;
 * - an empty `allowRead` under the fence's permissive default must NEVER
 *   render as "can't read your files";
 * - a card that cannot read the call (args fail strict narrowing) or cannot
 *   confirm its terms (executionContext absent/invalid) keeps Approve/Decline
 *   but SUPPRESSES the grant buttons — no "always allow" for a call we can't
 *   describe;
 * - every other tool's card is completely unaffected by the suppression seam.
 */
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithApprovalSubmissions as render } from './approval-submission-test-utils';

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({ append: vi.fn().mockResolvedValue(undefined) }),
  }),
  useAuiState: (selector: (state: { thread: { messages: readonly unknown[] } }) => unknown) =>
    selector({ thread: { messages: [] } }),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  CodeSurface: ({
    value,
    language,
    path,
    testId,
    truncated,
  }: {
    value: string;
    language?: string;
    path?: string;
    testId?: string;
    truncated?: boolean;
  }) => (
    <div
      data-language={language}
      data-path={path}
      data-testid={testId ?? 'code-surface'}
      data-truncated={truncated ? 'true' : 'false'}
      data-value={value}
    />
  ),
}));

import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import {
  type ToolApprovalGrantHandlers,
  ToolApprovalGrantProvider,
} from '../tool-approval-grant-context';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

const executionContext = {
  allowedDomains: [] as readonly string[],
  allowRead: [] as readonly string[],
  allowWrite: [] as readonly string[],
  defaultReadAccess: 'permissive',
  executorKind: 'fence',
  language: 'python',
  policyFingerprint: 'fp-test',
  scratchParentDir: '/var/folders/xx/T',
  timeoutMs: 30_000,
} as const;

const baseApproval = {
  args: { code: 'print(1)' },
  executionContext,
  policyDecision: 'ask',
  riskCategory: 'execute',
  runId: 'run-py-1',
  toolCallId: 'call-py-1',
  toolName: 'brainstrike.runPython',
};

function makeHandlers(): ToolApprovalGrantHandlers {
  return {
    grantAllToolsForSession: vi.fn(),
    grantCategoryForSession: vi.fn(),
    grantToolAlways: vi.fn(),
  };
}

function renderNotice(data: unknown, handlers: ToolApprovalGrantHandlers | null = null): void {
  const notice = <AssistantToolApprovalNotice data={data} />;
  const tree: ReactNode = handlers ? (
    <ToolApprovalGrantProvider handlers={handlers}>{notice}</ToolApprovalGrantProvider>
  ) : (
    notice
  );
  render(tree);
}

describe('run_python approval card — fact rows', () => {
  it('renders the code, the lead line, and every fact row — the safe state is stated, never implied', () => {
    renderNotice(baseApproval, makeHandlers());

    expect(
      screen.getByText('Run this Python code on your computer, in a sandbox.')
    ).toBeInTheDocument();
    const code = screen.getByTestId('approval-run-python-code');
    expect(code.getAttribute('data-value')).toBe('print(1)');
    expect(code.getAttribute('data-language')).toBe('python');

    // "No internet access" is an explicit row: a missing row is ambiguous, an
    // explicit negative is not.
    expect(screen.getByTestId('approval-run-python-internet')).toHaveTextContent(
      'No internet access'
    );
    const write = screen.getByTestId('approval-run-python-write');
    expect(write).toHaveTextContent('/var/folders/xx/T');
    expect(write).toHaveTextContent(/nowhere else/i);
    // Reads are PERMISSIVE by default in the fence — an empty allowRead means
    // "most files", and rendering "can't read your files" would be a lie on a
    // security surface.
    const read = screen.getByTestId('approval-run-python-read');
    expect(read).toHaveTextContent(/most files on this computer/i);
    expect(read).not.toHaveTextContent(/can't read your files/i);
    expect(screen.getByTestId('approval-run-python-time')).toHaveTextContent(
      'Stops after 30 seconds'
    );
    expect(screen.getByTestId('approval-run-python-sandbox')).toHaveTextContent(
      'Isolated sandbox on this machine'
    );

    // Well-formed call with confirmed terms: grants render normally.
    expect(screen.getByTestId('approval-grant-tool-always')).toBeInTheDocument();
    expect(screen.getByTestId('approval-grant-category-session')).toBeInTheDocument();
  });

  it('formats minute-round timeouts in minutes', () => {
    renderNotice(
      {
        ...baseApproval,
        args: { code: 'print(1)', timeoutMs: 300_000 },
        executionContext: { ...executionContext, timeoutMs: 300_000 },
      },
      null
    );
    expect(screen.getByTestId('approval-run-python-time')).toHaveTextContent(
      'Stops after 5 minutes'
    );
  });

  it('renders a sub-second time limit exactly, never rounded to a false statement', () => {
    renderNotice(
      {
        ...baseApproval,
        args: { code: 'print(1)', timeoutMs: 400 },
        executionContext: { ...executionContext, timeoutMs: 400 },
      },
      null
    );
    expect(screen.getByTestId('approval-run-python-time')).toHaveTextContent(
      'Stops after 0.4 seconds'
    );
  });

  it('renders a VM sandbox row for executorKind vm and lists allowRead under a none read default', () => {
    renderNotice(
      {
        ...baseApproval,
        executionContext: {
          ...executionContext,
          allowRead: ['/shared/data'],
          defaultReadAccess: 'none',
          executorKind: 'vm',
        },
      },
      null
    );
    expect(screen.getByTestId('approval-run-python-sandbox')).toHaveTextContent('Virtual machine');
    expect(screen.getByTestId('approval-run-python-read')).toHaveTextContent('/shared/data');
  });

  it('states "nothing" for reads only when the sandbox default is none AND the list is empty', () => {
    renderNotice(
      {
        ...baseApproval,
        executionContext: { ...executionContext, defaultReadAccess: 'none' },
      },
      null
    );
    expect(screen.getByTestId('approval-run-python-read')).toHaveTextContent(
      /can't read your files/i
    );
  });

  it('forewarns when the context reports requested domains (future network half)', () => {
    renderNotice(
      {
        ...baseApproval,
        executionContext: {
          ...executionContext,
          allowedDomains: ['pypi.org', '*.githubusercontent.com'],
        },
      },
      null
    );
    expect(screen.getByTestId('approval-run-python-internet')).toHaveTextContent(
      'Wants to reach 2 domains'
    );
    expect(screen.getByTestId('approval-run-python-forewarning')).toHaveTextContent(
      /asked about internet access separately/i
    );
  });

  it('renders the empty-script line without mounting a code surface', () => {
    renderNotice(
      { ...baseApproval, args: { code: '' }, executionContext: undefined },
      makeHandlers()
    );
    expect(screen.getByText(/this script is empty/i)).toBeInTheDocument();
    expect(screen.queryByTestId('approval-run-python-code')).not.toBeInTheDocument();
    // An empty script provably does nothing — the missing-context alarm would
    // cry wolf, so it is exempt (grants stay suppressed regardless).
    expect(screen.queryByTestId('approval-run-python-context-missing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-grant-tool-always')).not.toBeInTheDocument();
  });
});

describe('run_python approval card — fail-safe paths', () => {
  it('suppresses grants and invents no fact rows when executionContext is absent', () => {
    renderNotice({ ...baseApproval, executionContext: undefined }, makeHandlers());

    expect(screen.getByTestId('approval-run-python-context-missing')).toHaveTextContent(
      /couldn't confirm what this script is allowed to touch/i
    );
    // The disappearing grant buttons come with a visible reason, same as the
    // unreadable-args path.
    expect(screen.getByTestId('approval-run-python-grants-suppressed-note')).toHaveTextContent(
      /won't offer "always allow"/i
    );
    expect(screen.queryByTestId('approval-run-python-internet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-run-python-write')).not.toBeInTheDocument();
    // Approve/Decline stay; grants are suppressed.
    expect(screen.getByRole('button', { name: /approve brainstrike.runPython/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /decline brainstrike.runPython/i })).toBeEnabled();
    expect(screen.queryByTestId('approval-grant-tool-always')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-grant-category-session')).not.toBeInTheDocument();
  });

  it('suppresses grants when executionContext fails the exact-shape guard', () => {
    renderNotice(
      { ...baseApproval, executionContext: { ...executionContext, injected: true } },
      makeHandlers()
    );
    expect(screen.getByTestId('approval-run-python-context-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-grant-tool-always')).not.toBeInTheDocument();
  });

  it('suppresses grants with a visible reason when the args fail strict narrowing', () => {
    renderNotice(
      {
        ...baseApproval,
        args: { code: 'print(1)', unknownField: true },
        executionContext: undefined,
      },
      makeHandlers()
    );
    expect(screen.getByTestId('approval-preview-parse-error')).toBeInTheDocument();
    expect(screen.getByTestId('approval-run-python-grants-suppressed-note')).toHaveTextContent(
      /won't offer "always allow" for a call we can't read/i
    );
    expect(screen.queryByTestId('approval-grant-tool-always')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve brainstrike.runPython/i })).toBeEnabled();
  });

  it("leaves every other tool's grants untouched by the suppression seam", () => {
    renderNotice(
      {
        args: { command: 'git status' },
        policyDecision: 'ask',
        riskCategory: 'execute',
        runId: 'run-cmd-1',
        toolCallId: 'call-cmd-1',
        toolName: 'brainstrike.executeCommand',
      },
      makeHandlers()
    );
    expect(screen.getByTestId('approval-grant-tool-always')).toBeInTheDocument();
    expect(screen.getByTestId('approval-grant-category-session')).toBeInTheDocument();
  });
});

describe('run_python approval card — shared copy', () => {
  it('the execute reason line covers code, not only commands', () => {
    renderNotice(baseApproval, null);
    expect(
      screen.getByText(/requires approval: execute \(runs commands or code on your computer\)/i)
    ).toBeInTheDocument();
  });
});
