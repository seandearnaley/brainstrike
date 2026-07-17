import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountMenu } from '../account-menu';

describe('AccountMenu', () => {
  it('opens upward from the profile trigger and launches settings', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(<AccountMenu onOpenSettings={onOpenSettings} />);

    const trigger = screen.getByRole('button', { name: 'Open profile menu' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);

    expect(screen.getByText('Local profile')).toBeInTheDocument();
    expect(screen.getByText('Stored on this device')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Settings…' }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
