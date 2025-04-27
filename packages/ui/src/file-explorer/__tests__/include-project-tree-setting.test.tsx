import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import IncludeProjectTreeSetting from '../include-project-tree-setting';

describe('IncludeProjectTreeSetting', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders switch with correct label and state', () => {
    render(<IncludeProjectTreeSetting checked={true} onChange={onChange} />);
    const switchEl = screen.getByRole('switch', { name: /Include Project Tree/i });
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toBeChecked();
  });

  it('calls onChange when toggled', () => {
    render(<IncludeProjectTreeSetting checked={true} onChange={onChange} />);
    const switchEl = screen.getByRole('switch', { name: /Include Project Tree/i });
    fireEvent.click(switchEl);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
