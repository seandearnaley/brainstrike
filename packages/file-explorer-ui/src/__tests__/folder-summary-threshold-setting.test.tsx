import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FolderSummaryThresholdSetting from '../folder-summary-threshold-setting';

describe('FolderSummaryThresholdSetting', () => {
  it('renders label and input with value', () => {
    render(<FolderSummaryThresholdSetting value={5} onChange={vi.fn()} />);
    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(5);
  });

  it('calls onChange with numeric value', () => {
    const onChange = vi.fn();
    render(<FolderSummaryThresholdSetting value={0} onChange={onChange} />);
    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    fireEvent.change(input, { target: { value: '10' } });
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
