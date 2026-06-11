import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DisconnectRootDialog } from '../disconnect-root-dialog';

describe('DisconnectRootDialog', () => {
  function renderDialog(onConfirm = vi.fn(), onOpenChange = vi.fn()) {
    render(
      <DisconnectRootDialog
        displayName="my-project"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
        open={true}
      />
    );
    return { onConfirm, onOpenChange };
  }

  it('confirms WITHOUT data deletion by default', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    expect(screen.getByText('Disconnect my-project?')).toBeInTheDocument();
    // Default body states data is KEPT.
    expect(screen.getByText(/indexed data is kept/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ deleteData: false });
  });

  it('confirms WITH data deletion when the checkbox is checked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.click(screen.getByRole('checkbox', { name: /also delete indexed data/i }));
    // Checked body copy states data WILL be deleted.
    expect(screen.getByText(/permanently deletes/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ deleteData: true });
  });

  it('cancel closes without confirming', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('resets the checkbox when reopened', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <DisconnectRootDialog
        displayName="my-project"
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open={true}
      />
    );
    await user.click(screen.getByRole('checkbox', { name: /also delete indexed data/i }));

    rerender(
      <DisconnectRootDialog
        displayName="my-project"
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open={false}
      />
    );
    rerender(
      <DisconnectRootDialog
        displayName="my-project"
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    // A destructive opt-in must NEVER survive a close/reopen cycle.
    expect(screen.getByRole('checkbox', { name: /also delete indexed data/i })).not.toBeChecked();
  });
});
