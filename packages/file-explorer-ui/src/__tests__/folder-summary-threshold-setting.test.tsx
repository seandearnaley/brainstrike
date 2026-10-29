import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FolderSummaryThresholdSetting from '../folder-summary-threshold-setting';

describe('FolderSummaryThresholdSetting', () => {
  it('renders label and input with value', () => {
    render(<FolderSummaryThresholdSetting onChange={vi.fn()} value={5} />);
    const input = screen.getByLabelText(/Folder Summary Threshold/iu);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(5);
  });

  it('calls onChange with numeric value', () => {
    const onChange = vi.fn();
    render(<FolderSummaryThresholdSetting onChange={onChange} value={0} />);
    const input = screen.getByLabelText(/Folder Summary Threshold/iu);
    fireEvent.change(input, { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
