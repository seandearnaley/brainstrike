import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MaxSelectionCountSetting from '../max-selection-count-setting';

describe('MaxSelectionCountSetting', () => {
  it('renders label and input with value', () => {
    render(<MaxSelectionCountSetting onChange={vi.fn()} value={2} />);
    const input = screen.getByLabelText(/Max Selection Count/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(2);
  });

  it('calls onChange with numeric value', () => {
    const onChange = vi.fn();
    render(<MaxSelectionCountSetting onChange={onChange} value={0} />);
    const input = screen.getByLabelText(/Max Selection Count/i);
    fireEvent.change(input, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
