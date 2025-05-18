import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Switch } from '../../src/switch';

describe('Switch', () => {
  it('toggles checked state on click', async () => {
    const user = userEvent.setup();
    render(<Switch />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('data-state', 'unchecked');

    await user.click(sw);
    expect(sw).toHaveAttribute('data-state', 'checked');
  });
});
