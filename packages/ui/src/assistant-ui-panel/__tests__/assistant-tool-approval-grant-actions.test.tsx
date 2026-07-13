import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({ append: appendMock }),
  }),
  useAuiState: (selector: (state: { thread: { messages: readonly unknown[] } }) => unknown) =>
    selector({ thread: { messages: [] } }),
}));

import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import {
  type ToolApprovalGrantHandlers,
  ToolApprovalGrantProvider,
} from '../tool-approval-grant-context';

const baseApproval = {
  args: { command: 'git status' },
  riskCategory: 'execute',
  runId: 'run-1',
  toolCallId: 'call-1',
  toolName: 'brainstrike.executeCommand',
};

function makeHandlers(): ToolApprovalGrantHandlers {
  return {
    grantCategoryForSession: vi.fn(),
    grantToolAlways: vi.fn(),
  };
}

function renderNotice(data: unknown, handlers: ToolApprovalGrantHandlers | null): void {
  const notice = <AssistantToolApprovalNotice data={data} />;
  const tree: ReactNode = handlers ? (
    <ToolApprovalGrantProvider handlers={handlers}>{notice}</ToolApprovalGrantProvider>
  ) : (
    notice
  );
  render(tree);
}

/** The approve action embedded in the appended message, or null. */
function appendedApprovalAction(): unknown {
  const call = appendMock.mock.calls.at(-1);
  if (!call) {
    return null;
  }
  const message = call[0] as {
    runConfig?: { custom?: Record<string, unknown> };
  };
  return message.runConfig?.custom?.['brainstrikeToolApproval'] ?? null;
}

describe('AssistantToolApprovalNotice grant actions', () => {
  beforeEach(() => {
    appendMock.mockClear();
  });

  it('renders both grant buttons when handlers are provided and the approval is policy-driven', () => {
    renderNotice(baseApproval, makeHandlers());

    expect(screen.getByTestId('approval-grant-tool-always')).toBeInTheDocument();
    expect(screen.getByTestId('approval-grant-category-session')).toBeInTheDocument();
    // The session button names the category in user terms.
    expect(screen.getByTestId('approval-grant-category-session').textContent).toMatch(
      /commands this session/i
    );
  });

  it('"Always allow" records a persistent tool override AND approves the pending call', async () => {
    const handlers = makeHandlers();
    renderNotice(baseApproval, handlers);

    await userEvent.click(screen.getByTestId('approval-grant-tool-always'));

    expect(handlers.grantToolAlways).toHaveBeenCalledWith('brainstrike.executeCommand');
    expect(appendedApprovalAction()).toMatchObject({
      action: 'approve',
      runId: 'run-1',
      toolCallId: 'call-1',
    });
  });

  it('the session button records a session category grant AND approves the pending call', async () => {
    const handlers = makeHandlers();
    renderNotice(baseApproval, handlers);

    await userEvent.click(screen.getByTestId('approval-grant-category-session'));

    expect(handlers.grantCategoryForSession).toHaveBeenCalledWith('execute');
    expect(appendedApprovalAction()).toMatchObject({
      action: 'approve',
      runId: 'run-1',
      toolCallId: 'call-1',
    });
  });

  it('omits grant buttons without a provider (web / ungated hosts)', () => {
    renderNotice(baseApproval, null);

    expect(screen.queryByTestId('approval-grant-tool-always')).toBeNull();
    expect(screen.queryByTestId('approval-grant-category-session')).toBeNull();
    // Plain Approve/Decline still render.
    expect(screen.getByRole('button', { name: /^approve /i })).toBeInTheDocument();
  });

  it('omits grant buttons when the approval carries no risk category (non-policy pause)', () => {
    const { riskCategory: _riskCategory, ...withoutRisk } = baseApproval;
    renderNotice(withoutRisk, makeHandlers());

    expect(screen.queryByTestId('approval-grant-tool-always')).toBeNull();
    expect(screen.queryByTestId('approval-grant-category-session')).toBeNull();
  });

  it('disables grant buttons after any action is submitted', async () => {
    renderNotice(baseApproval, makeHandlers());

    await userEvent.click(screen.getByRole('button', { name: /^approve /i }));

    expect((screen.getByTestId('approval-grant-tool-always') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByTestId('approval-grant-category-session') as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
