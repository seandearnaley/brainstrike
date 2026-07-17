import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportProgress, type ImportProgress as ImportProgressType } from '../import-progress';

describe('ImportProgress', () => {
  const createProgress = (overrides: Partial<ImportProgressType> = {}): ImportProgressType => ({
    completed: 5,
    errors: [],
    total: 10,
    ...overrides,
  });

  it('renders import progress card', () => {
    render(<ImportProgress progress={createProgress()} />);

    expect(screen.getByText('Import Progress')).toBeInTheDocument();
  });

  it('displays completed and total files count', () => {
    render(<ImportProgress progress={createProgress({ completed: 15, total: 20 })} />);

    expect(screen.getByText('15 of 20 files')).toBeInTheDocument();
  });

  it('calculates and displays percentage correctly', () => {
    render(<ImportProgress progress={createProgress({ completed: 5, total: 10 })} />);

    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('displays 0% when total is 0', () => {
    render(<ImportProgress progress={createProgress({ completed: 0, total: 0 })} />);

    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows current file when provided', () => {
    render(<ImportProgress progress={createProgress({ current: 'test-file.txt' })} />);

    expect(screen.getByText('Current: test-file.txt')).toBeInTheDocument();
  });

  it('does not show current file when not provided', () => {
    render(<ImportProgress progress={createProgress()} />);

    expect(screen.queryByText(/Current:/)).not.toBeInTheDocument();
  });

  it('displays imported count badge', () => {
    render(<ImportProgress progress={createProgress({ completed: 8, errors: [] })} />);

    expect(screen.getByText('8 imported')).toBeInTheDocument();
  });

  it('displays imported count minus errors', () => {
    const errors = [
      { error: 'Failed', file: 'error1.txt' },
      { error: 'Failed', file: 'error2.txt' },
    ];
    render(<ImportProgress progress={createProgress({ completed: 8, errors })} />);

    expect(screen.getByText('6 imported')).toBeInTheDocument();
  });

  it('displays error count badge when errors exist', () => {
    const errors = [
      { error: 'Failed to import', file: 'error1.txt' },
      { error: 'Invalid format', file: 'error2.txt' },
    ];
    render(<ImportProgress progress={createProgress({ errors })} />);

    expect(screen.getByText('2 errors')).toBeInTheDocument();
  });

  it('does not display error badge when no errors', () => {
    render(<ImportProgress progress={createProgress({ errors: [] })} />);

    expect(screen.queryByText(/errors/)).not.toBeInTheDocument();
  });

  it('shows check icon when import is complete', () => {
    render(<ImportProgress progress={createProgress({ completed: 10, total: 10 })} />);

    // The CheckCircle icon should be present when complete — no spinner
    expect(screen.queryByTestId('import-progress-spinner')).not.toBeInTheDocument();
  });

  it('shows spinner when import is in progress', () => {
    render(<ImportProgress progress={createProgress({ completed: 5, total: 10 })} />);

    expect(screen.getByTestId('import-progress-spinner')).toBeInTheDocument();
  });

  it('renders close button when onClose is provided', () => {
    const onClose = vi.fn();
    render(<ImportProgress onClose={onClose} progress={createProgress()} />);

    const closeButton = screen.getByRole('button');
    expect(closeButton).toBeInTheDocument();
  });

  it('does not render close button when onClose is not provided', () => {
    render(<ImportProgress progress={createProgress()} />);

    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<ImportProgress onClose={onClose} progress={createProgress()} />);

    const closeButton = screen.getByRole('button');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles error list visibility when view errors button is clicked', () => {
    const errors = [{ error: 'Failed to import', file: 'error.txt' }];
    render(<ImportProgress progress={createProgress({ errors })} />);

    const viewErrorsButton = screen.getByRole('button', { name: /view 1 error/i });
    const errorListId = viewErrorsButton.getAttribute('aria-controls');
    const errorMessage = screen.getByText('Failed to import');

    expect(errorListId).toBeTruthy();
    expect(document.getElementById(errorListId ?? '')).toHaveAttribute('hidden');
    expect(errorMessage).not.toBeVisible();

    // Click to show errors
    fireEvent.click(viewErrorsButton);

    // Now errors should be visible
    expect(document.getElementById(errorListId ?? '')).not.toHaveAttribute('hidden');
    expect(screen.getByText('Failed to import')).toBeInTheDocument();
    expect(screen.getByText('error.txt')).toBeInTheDocument();

    // Click again to hide
    fireEvent.click(viewErrorsButton);
    expect(document.getElementById(errorListId ?? '')).toHaveAttribute('hidden');
    expect(errorMessage).not.toBeVisible();
  });

  it('uses a unique error list id per component instance', () => {
    const errors = [{ error: 'Failed to import', file: 'error.txt' }];
    render(
      <>
        <ImportProgress progress={createProgress({ errors })} />
        <ImportProgress progress={createProgress({ errors })} />
      </>
    );

    const toggleButtons = screen.getAllByRole('button', { name: /view 1 error/i });
    const [firstId, secondId] = toggleButtons.map((button) => button.getAttribute('aria-controls'));

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(document.getElementById(firstId ?? '')).toBeInTheDocument();
    expect(document.getElementById(secondId ?? '')).toBeInTheDocument();
  });

  it('displays correct singular error text', () => {
    const errors = [{ error: 'Failed', file: 'error.txt' }];
    render(<ImportProgress progress={createProgress({ errors })} />);

    expect(screen.getByText('View 1 error')).toBeInTheDocument();
  });

  it('displays correct plural errors text', () => {
    const errors = [
      { error: 'Failed', file: 'error1.txt' },
      { error: 'Failed', file: 'error2.txt' },
    ];
    render(<ImportProgress progress={createProgress({ errors })} />);

    expect(screen.getByText('View 2 errors')).toBeInTheDocument();
  });

  it('renders error details correctly', () => {
    const errors = [
      { error: 'File size exceeded limit', file: 'path/to/file.txt' },
      { error: 'Invalid encoding', file: 'another/file.js' },
    ];
    render(<ImportProgress progress={createProgress({ errors })} />);

    // Show errors
    const viewErrorsButton = screen.getByText(/View 2 errors/);
    fireEvent.click(viewErrorsButton);

    expect(screen.getByText('path/to/file.txt')).toBeInTheDocument();
    expect(screen.getByText('File size exceeded limit')).toBeInTheDocument();
    expect(screen.getByText('another/file.js')).toBeInTheDocument();
    expect(screen.getByText('Invalid encoding')).toBeInTheDocument();
  });

  it('handles edge case of 100% completion', () => {
    render(<ImportProgress progress={createProgress({ completed: 100, total: 100 })} />);

    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('100 of 100 files')).toBeInTheDocument();
  });

  it('handles edge case of 0 files', () => {
    render(<ImportProgress progress={createProgress({ completed: 0, total: 0 })} />);

    expect(screen.getByText('0 of 0 files')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  // ── Additional coverage tests ───────────────────────────────────────

  it('renders progress bar with correct percentage value', () => {
    render(<ImportProgress progress={createProgress({ completed: 7, total: 10 })} />);

    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('7 of 10 files')).toBeInTheDocument();
  });

  it('shows close button and error toggle simultaneously', () => {
    const onClose = vi.fn();
    const errors = [{ error: 'Oops', file: 'err.txt' }];
    render(<ImportProgress onClose={onClose} progress={createProgress({ errors })} />);

    const buttons = screen.getAllByRole('button');
    // Close button + error toggle button
    expect(buttons.length).toBe(2);
  });

  it('renders ChevronDown when errors are expanded', () => {
    const errors = [{ error: 'Oops', file: 'err.txt' }];
    render(<ImportProgress progress={createProgress({ errors })} />);

    const toggle = screen.getByText(/View 1 error/);
    fireEvent.click(toggle);

    // Error content visible
    expect(screen.getByText('Oops')).toBeInTheDocument();
    expect(screen.getByText('err.txt')).toBeInTheDocument();
  });

  it('handles errors with unique file-error key combinations', () => {
    const errors = [
      { error: 'Error A', file: 'same-file.txt' },
      { error: 'Error B', file: 'same-file.txt' },
    ];
    render(<ImportProgress progress={createProgress({ errors })} />);

    fireEvent.click(screen.getByText(/View 2 errors/));

    expect(screen.getByText('Error A')).toBeInTheDocument();
    expect(screen.getByText('Error B')).toBeInTheDocument();
  });

  it('rounds percentage correctly for non-round numbers', () => {
    // 3/7 = 42.857... should round to 43%
    render(<ImportProgress progress={createProgress({ completed: 3, total: 7 })} />);

    expect(screen.getByText('43%')).toBeInTheDocument();
  });

  it('shows 1% when barely started', () => {
    // 1/100 = 1%
    render(<ImportProgress progress={createProgress({ completed: 1, total: 100 })} />);

    expect(screen.getByText('1%')).toBeInTheDocument();
  });

  it('shows 0 imported when all completed files are errors', () => {
    const errors = [
      { error: 'fail', file: 'a.txt' },
      { error: 'fail', file: 'b.txt' },
    ];
    render(<ImportProgress progress={createProgress({ completed: 2, errors })} />);

    expect(screen.getByText('0 imported')).toBeInTheDocument();
  });

  it('does not render error details section when there are no errors', () => {
    render(<ImportProgress progress={createProgress({ errors: [] })} />);

    // No CardContent with error toggling should be rendered
    expect(screen.queryByText(/View/)).not.toBeInTheDocument();
  });

  it('does not render current file text when current is omitted', () => {
    render(<ImportProgress progress={createProgress()} />);

    expect(screen.queryByText(/Current:/)).not.toBeInTheDocument();
  });

  it('renders without crashing when given minimal props', () => {
    const { container } = render(
      <ImportProgress progress={{ completed: 0, errors: [], total: 0 }} />
    );

    expect(container.querySelector('.w-full')).toBeInTheDocument();
  });
});
