import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FileExtensionFilter from '../file-extension-filter';

describe('FileExtensionFilter', () => {
  const defaultProps = {
    includeFilters: ['*.ts'],
    excludeFilters: ['*.test.ts'],
    onFilterChange: jest.fn(),
    useRegex: false,
    filterError: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders include and exclude inputs with initial values', () => {
    render(<FileExtensionFilter {...defaultProps} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);
    const excludeInput = screen.getByLabelText(/Files to Exclude/i);

    expect(includeInput).toHaveValue('*.ts');
    expect(excludeInput).toHaveValue('*.test.ts');
  });

  it('maintains input value while typing without reverting', async () => {
    const user = userEvent.setup({ delay: null });
    render(<FileExtensionFilter {...defaultProps} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);

    // Type slowly to simulate user input
    await user.type(includeInput, ', *.tsx');
    expect(includeInput).toHaveValue('*.ts, *.tsx');

    // Fast-forward timers to trigger debounce
    jest.runAllTimers();

    // Value should still be the same after debounce
    expect(includeInput).toHaveValue('*.ts, *.tsx');
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      ['*.ts', '*.tsx'],
      defaultProps.excludeFilters,
      defaultProps.useRegex
    );
  });

  it('debounces filter changes', async () => {
    const user = userEvent.setup({ delay: null });
    render(<FileExtensionFilter {...defaultProps} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);

    // Type multiple changes quickly
    await user.type(includeInput, ', *.tsx');

    // Should not call onFilterChange immediately
    expect(defaultProps.onFilterChange).not.toHaveBeenCalled();

    // Fast-forward timers
    jest.runAllTimers();

    // Should call onFilterChange once with final value
    expect(defaultProps.onFilterChange).toHaveBeenCalledTimes(1);
    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      ['*.ts', '*.tsx'],
      defaultProps.excludeFilters,
      defaultProps.useRegex
    );
  });

  it('handles regex mode placeholder text', () => {
    render(<FileExtensionFilter {...defaultProps} useRegex={true} />);

    const includeInput = screen.getByLabelText(/Files to Include/i);
    const excludeInput = screen.getByLabelText(/Files to Exclude/i);

    expect(includeInput).toHaveAttribute(
      'placeholder',
      'Enter regex patterns, separated by commas'
    );
    expect(excludeInput).toHaveAttribute(
      'placeholder',
      'Enter regex patterns, separated by commas'
    );
  });

  it('displays filter error when present', () => {
    render(<FileExtensionFilter {...defaultProps} filterError="Invalid regex pattern" />);
    expect(screen.getByText('Invalid regex pattern')).toBeInTheDocument();
  });
});
