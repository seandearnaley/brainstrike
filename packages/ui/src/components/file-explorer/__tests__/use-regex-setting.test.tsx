import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UseRegexSetting from '../use-regex-setting';

describe('UseRegexSetting', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders switch with correct label and state', () => {
    render(<UseRegexSetting checked={false} onChange={onChange} />);
    const switchEl = screen.getByRole('switch', { name: /Use Regex Filters/i });
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).not.toBeChecked();
  });

  it('calls onChange when toggled', () => {
    render(<UseRegexSetting checked={false} onChange={onChange} />);
    const switchEl = screen.getByRole('switch', { name: /Use Regex Filters/i });
    fireEvent.click(switchEl);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
