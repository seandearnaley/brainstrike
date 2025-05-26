import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import UseRegexSetting from '../use-regex-setting';

describe('UseRegexSetting', () => {
  it('renders switch with label and state', () => {
    render(<UseRegexSetting checked={true} onChange={vi.fn()} />);
    const sw = screen.getByRole('switch', { name: /Use Regex Filters/i });
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute('data-state', 'checked');
  });

  it('calls onChange when toggled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<UseRegexSetting checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: /Use Regex Filters/i });
    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
