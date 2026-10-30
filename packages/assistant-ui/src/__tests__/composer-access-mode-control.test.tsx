import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ComposerAccessModeControl } from '../composer-access-mode-control';

describe('ComposerAccessModeControl', () => {
  it('names the current mode and switches it from the menu', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<ComposerAccessModeControl access={{ mode: 'ask', onChange }} />);

    const trigger = screen.getByRole('button', { name: /access: ask for approval/iu });
    await user.click(trigger);
    expect(screen.getByRole('menuitemradio', { name: /ask for approval/iu })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('menuitemradio', { name: /^auto/iu }));

    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('marks full access so the composer can show it as a warning', () => {
    render(<ComposerAccessModeControl access={{ mode: 'full', onChange: vi.fn() }} />);

    expect(screen.getByRole('button', { name: /access: full access/iu })).toHaveAttribute(
      'data-access-mode',
      'full'
    );
  });
});
