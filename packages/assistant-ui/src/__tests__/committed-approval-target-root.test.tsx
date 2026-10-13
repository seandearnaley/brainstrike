/**
 * BST-1990 (D4): a file tool's approval names the folder the host resolved, so
 * a write with no `root` argument still says where it lands.
 */
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommittedApprovalStrip, type CommittedPendingApproval } from '../committed-approval-strip';

function write(targetRoot?: CommittedPendingApproval['targetRoot']): CommittedPendingApproval {
  return {
    args: { content: 'hello\n', path: 'notes.md' },
    interactionId: 'interaction-1',
    respond: vi.fn(async () => undefined),
    risk: 'edit',
    runId: 'run-1',
    ...(targetRoot ? { targetRoot } : {}),
    toolCallId: 'call-1',
    toolName: 'brainstrike.writeWorkspaceFile',
  };
}

async function review(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
  return screen.getByRole('dialog', { name: 'Pending approvals' });
}

describe('a committed file approval', () => {
  it('names the host-resolved folder when the call gave no root', async () => {
    render(
      <CommittedApprovalStrip
        approvals={[write({ displayName: 'alpha-root', rootId: 'r-alpha' })]}
      />
    );
    const dialog = await review();
    expect(within(dialog).getByTestId('approval-workspace-root-value')).toHaveTextContent(
      'alpha-root'
    );
  });

  it('names no folder when the host resolved none', async () => {
    render(<CommittedApprovalStrip approvals={[write()]} />);
    const dialog = await review();
    expect(within(dialog).getByTestId('approval-file-target-summary')).toHaveTextContent(
      'notes.md'
    );
    expect(within(dialog).queryByTestId('approval-workspace-root-value')).toBeNull();
  });
});
