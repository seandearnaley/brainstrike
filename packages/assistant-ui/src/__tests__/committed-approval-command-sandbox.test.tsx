/**
 * BST-2360: a command's approval says when the command would run with no OS
 * sandbox (Windows, the standalone host), before the person approves it.
 */
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommittedApprovalStrip, type CommittedPendingApproval } from '../committed-approval-strip';

function command(
  facts: Pick<CommittedPendingApproval, 'sandboxed'>,
  args: Record<string, unknown> = {}
): CommittedPendingApproval {
  return {
    args: { command: 'npm test', ...args },
    interactionId: 'interaction-1',
    respond: vi.fn(async () => undefined),
    risk: 'execute',
    runId: 'run-1',
    ...facts,
    toolCallId: 'call-1',
    toolName: 'brainstrike.executeCommand',
  };
}

async function review(approval: CommittedPendingApproval): Promise<HTMLElement> {
  render(<CommittedApprovalStrip approvals={[approval]} />);
  await userEvent.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
  return screen.getByRole('dialog', { name: 'Pending approvals' });
}

describe('a committed command approval', () => {
  it('warns that a command on a host with no sandbox has full access', async () => {
    const dialog = await review(command({ sandboxed: false }));
    expect(within(dialog).getByTestId('approval-command-no-sandbox')).toHaveTextContent(
      'Commands run without a sandbox on this computer, with full access to your files and network.'
    );
  });

  it('says nothing more where the sandbox runs the command', async () => {
    const sandboxed = await review(command({ sandboxed: true }));
    expect(within(sandboxed).queryByTestId('approval-command-no-sandbox')).toBeNull();
  });

  it('keeps the outside-the-sandbox warning for a call that asks to run outside', async () => {
    const dialog = await review(command({ sandboxed: false }, { dangerouslyDisableSandbox: true }));
    expect(within(dialog).getByTestId('approval-command-outside-sandbox')).toBeVisible();
    expect(within(dialog).queryByTestId('approval-command-no-sandbox')).toBeNull();
  });
});
