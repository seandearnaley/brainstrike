import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountMenu } from '../account-menu';

function renderAccountMenu(onOpenSettings: () => void) {
  return render(
    <TooltipProvider delayDuration={0}>
      <AccountMenu onOpenSettings={onOpenSettings} />
    </TooltipProvider>
  );
}

describe('AccountMenu', () => {
  it('opens upward from the profile trigger and launches settings', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    renderAccountMenu(onOpenSettings);

    const trigger = screen.getByRole('button', { name: 'Open profile menu' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);

    expect(screen.getByText('Local profile')).toBeInTheDocument();
    expect(screen.getByText('Stored on this device')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Settings…' }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('names itself in a tooltip on hover, like the rail items', async () => {
    const user = userEvent.setup();

    renderAccountMenu(vi.fn());
    await user.hover(screen.getByRole('button', { name: 'Open profile menu' }));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Profile');
  });
});
