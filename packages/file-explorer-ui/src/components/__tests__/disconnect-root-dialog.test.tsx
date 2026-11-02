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

  it('confirms the disconnect and says the saved data is kept', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    expect(screen.getByText('Disconnect my-project?')).toBeInTheDocument();
    expect(screen.getByText(/saved data is kept/iu)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('cancel closes without confirming', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
