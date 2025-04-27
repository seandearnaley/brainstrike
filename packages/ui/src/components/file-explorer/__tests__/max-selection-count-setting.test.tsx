import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MaxSelectionCountSetting from '../max-selection-count-setting';

describe('MaxSelectionCountSetting', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders input with correct initial value', () => {
    render(<MaxSelectionCountSetting value={5} onChange={onChange} />);
    const input = screen.getByLabelText(/Max Selection Count/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(5);
  });

  it('calls onChange with parsed value when changed', () => {
    render(<MaxSelectionCountSetting value={3} onChange={onChange} />);
    const input = screen.getByLabelText(/Max Selection Count/i);
    fireEvent.change(input, { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
