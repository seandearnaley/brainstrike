import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FolderSummaryThresholdSetting from '../folder-summary-threshold-setting';

describe('FolderSummaryThresholdSetting', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders input with correct initial value and label', () => {
    render(<FolderSummaryThresholdSetting value={7} onChange={onChange} />);
    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(7);
    expect(
      screen.getByText(/Number of files to show before summarizing folder contents/i)
    ).toBeInTheDocument();
  });

  it('calls onChange with parsed value when changed', () => {
    render(<FolderSummaryThresholdSetting value={3} onChange={onChange} />);
    const input = screen.getByLabelText(/Folder Summary Threshold/i);
    fireEvent.change(input, { target: { value: '15' } });
    expect(onChange).toHaveBeenCalledWith(15);
  });
});
