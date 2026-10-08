import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CommittedApprovalStrip, type CommittedPendingApproval } from '../committed-approval-strip';

function pending(
  n: number,
  risk: CommittedPendingApproval['risk'],
  owner?: string
): CommittedPendingApproval {
  return {
    args: { path: `notes-${n}.md` },
    interactionId: `interaction-${n}`,
    ...(owner ? { owner } : {}),
    respond: vi.fn(async () => undefined),
    ...(risk ? { risk } : {}),
    runId: `run-${n}`,
    toolCallId: `call-${n}`,
    toolName: risk === 'edit' ? 'brainstrike.writeWorkspaceFile' : 'brainstrike.readWorkspaceFile',
  };
}

describe('CommittedApprovalStrip', () => {
  it('renders nothing while the tree has no pending approval', () => {
    const { container } = render(<CommittedApprovalStrip approvals={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the tree’s approvals by category, and one grant answers the first of its category', async () => {
    const reads = [1, 2, 3].map((n) => pending(n, 'read', `Cedar-00000${n}`));
    const edit = pending(4, 'edit');
    render(<CommittedApprovalStrip approvals={[...reads, edit]} />);
    expect(screen.getByRole('status')).toHaveTextContent('4 approvals waiting');
    expect(screen.getByTestId('approval-strip-count-read')).toHaveTextContent('3 reads');
    expect(screen.getByTestId('approval-strip-count-edit')).toHaveTextContent('1 edit');

    await userEvent.click(screen.getByTestId('approval-strip-grant-read'));
    // The host answers the category's siblings once the grant is recorded.
    expect(reads[0]?.respond).toHaveBeenCalledExactlyOnceWith({
      approved: true,
      optionId: 'grant-session',
    });
    expect(reads[1]?.respond).not.toHaveBeenCalled();
    expect(reads[2]?.respond).not.toHaveBeenCalled();
    expect(edit.respond).not.toHaveBeenCalled();
  });

  it('reviews each pending approval with its owner and the card’s own decisions', async () => {
    const child = pending(1, 'edit', 'Fern-a1b2c3');
    const unclassified = pending(2, undefined);
    render(<CommittedApprovalStrip approvals={[child, unclassified]} />);
    // An approval without a risk category is reviewed but never granted by category.
    expect(screen.queryByTestId('approval-strip-count-read')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Review 2 pending approvals' }));
    const review = screen.getByRole('dialog', { name: 'Pending approvals' });
    const entries = within(review).getAllByRole('group');
    expect(entries).toHaveLength(2);
    expect(
      within(entries[0] as HTMLElement).getByTestId('approval-delegation-owner')
    ).toHaveTextContent('Fern-a1b2c3');
    expect(within(entries[1] as HTMLElement).queryByTestId('approval-delegation-owner')).toBeNull();
    expect(
      within(entries[0] as HTMLElement)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Approve brainstrike.writeWorkspaceFile',
      'Always allow brainstrike.writeWorkspaceFile',
      'Allow edits this session brainstrike.writeWorkspaceFile',
      'Decline brainstrike.writeWorkspaceFile',
    ]);
    await userEvent.click(
      within(review).getByRole('button', { name: 'Decline brainstrike.readWorkspaceFile' })
    );
    expect(unclassified.respond).toHaveBeenCalledExactlyOnceWith({ approved: false });
    await userEvent.click(
      within(review).getByRole('button', { name: 'Always allow brainstrike.writeWorkspaceFile' })
    );
    expect(child.respond).toHaveBeenCalledExactlyOnceWith({
      approved: true,
      optionId: 'grant-tool',
    });
  });

  it('shows a refused decision and lets the person decide again', async () => {
    const refused = pending(1, 'read');
    vi.mocked(refused.respond).mockRejectedValueOnce(new Error('Approval was already answered'));
    render(<CommittedApprovalStrip approvals={[refused]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Review 1 pending approval' }));
    const review = screen.getByRole('dialog', { name: 'Pending approvals' });
    await userEvent.click(
      within(review).getByRole('button', { name: 'Approve brainstrike.readWorkspaceFile' })
    );
    expect(await within(review).findByRole('alert')).toHaveTextContent(
      'Approval was already answered'
    );
    await userEvent.click(
      within(review).getByRole('button', { name: 'Approve brainstrike.readWorkspaceFile' })
    );
    expect(refused.respond).toHaveBeenCalledTimes(2);
  });
});
