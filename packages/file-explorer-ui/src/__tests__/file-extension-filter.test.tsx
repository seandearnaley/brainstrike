import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExtensionFilter from '../file-extension-filter';

// Simplify the tests to focus on core functionality without debounce
describe('FileExtensionFilter', () => {
  const defaultProps = {
    includeFilters: ['*.ts', '*.tsx'],
    excludeFilters: ['*.spec.ts'],
    useRegex: false,
    onFilterChange: vi.fn(),
    filterError: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders include and exclude inputs with initial values', () => {
    render(<FileExtensionFilter {...defaultProps} />);
    expect(screen.getByLabelText(/Files to Include/i)).toHaveValue('*.ts, *.tsx');
    expect(screen.getByLabelText(/Files to Exclude/i)).toHaveValue('*.spec.ts');
  });

  it('maintains input value while typing without reverting', () => {
    vi.useFakeTimers();
    render(<FileExtensionFilter {...defaultProps} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);
    fireEvent.change(includeInput, { target: { value: '*.j' } });
    fireEvent.change(includeInput, { target: { value: '*.js' } });

    expect(includeInput).toHaveValue('*.js');
    vi.useRealTimers();
  });

  it('debounces filter changes', () => {
    vi.useFakeTimers();
    const onFilterChange = vi.fn();
    render(<FileExtensionFilter {...defaultProps} onFilterChange={onFilterChange} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);
    fireEvent.change(includeInput, { target: { value: '*.jsx' } });

    expect(onFilterChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onFilterChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith(['*.jsx'], defaultProps.excludeFilters, false);
    vi.useRealTimers();
  });

  it('handles regex mode placeholder text', () => {
    render(<FileExtensionFilter {...defaultProps} useRegex={true} />);
    const includeInput = screen.getByLabelText(/Files to Include/i);
    expect(includeInput).toHaveAttribute(
      'placeholder',
      'Enter regex patterns, separated by commas'
    );
  });

  it('displays filter error when present', () => {
    render(
      <FileExtensionFilter {...defaultProps} useRegex={true} filterError="Invalid regex pattern" />
    );
    expect(screen.getByText('Invalid regex pattern')).toBeInTheDocument();
  });

  it('shows example placeholders when not using regex', () => {
    render(<FileExtensionFilter {...defaultProps} />);
    expect(screen.getByLabelText(/Files to Include/i)).toHaveAttribute(
      'placeholder',
      'e.g. *.ts, src/**/*.js'
    );
    expect(screen.getByLabelText(/Files to Exclude/i)).toHaveAttribute(
      'placeholder',
      'e.g. *.test.js, node_modules/**'
    );
  });

  it('calls onFilterChange after debounced input', async () => {
    vi.useFakeTimers();
    const onFilterChange = vi.fn();
    render(<FileExtensionFilter {...defaultProps} onFilterChange={onFilterChange} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);
    act(() => {
      fireEvent.change(includeInput, { target: { value: 'foo' } });
      vi.advanceTimersByTime(300);
    });

    expect(onFilterChange).toHaveBeenCalledWith(['foo'], defaultProps.excludeFilters, false);
    vi.useRealTimers();
  });
});
