import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import IncludeProjectTreeSetting from '../include-project-tree-setting';

describe('IncludeProjectTreeSetting', () => {
  it('renders switch with label and state', () => {
    render(<IncludeProjectTreeSetting checked={true} onChange={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: /Include Project Tree/i });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute('data-state', 'checked');
  });

  it('calls onChange when toggled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<IncludeProjectTreeSetting checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: /Include Project Tree/i });
    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
