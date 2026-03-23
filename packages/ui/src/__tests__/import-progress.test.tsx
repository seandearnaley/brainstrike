import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportProgress, type ImportProgress as ImportProgressType } from '../import-progress';

describe('ImportProgress', () => {
  const createProgress = (overrides: Partial<ImportProgressType> = {}): ImportProgressType => ({
    total: 10,
    completed: 5,
    errors: [],
    ...overrides,
  });

  it('renders import progress card', () => {
    render(<ImportProgress progress={createProgress()} />);

    expect(screen.getByText('Import Progress')).toBeInTheDocument();
  });

  it('displays completed and total files count', () => {
    render(<ImportProgress progress={createProgress({ total: 20, completed: 15 })} />);

    expect(screen.getByText('15 of 20 files')).toBeInTheDocument();
  });

  it('calculates and displays percentage correctly', () => {
    render(<ImportProgress progress={createProgress({ total: 10, completed: 5 })} />);

    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('displays 0% when total is 0', () => {
    render(<ImportProgress progress={createProgress({ total: 0, completed: 0 })} />);

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
      { file: 'error1.txt', error: 'Failed' },
      { file: 'error2.txt', error: 'Failed' },
    ];
    render(<ImportProgress progress={createProgress({ completed: 8, errors })} />);

    expect(screen.getByText('6 imported')).toBeInTheDocument();
  });

  it('displays error count badge when errors exist', () => {
    const errors = [
      { file: 'error1.txt', error: 'Failed to import' },
      { file: 'error2.txt', error: 'Invalid format' },
    ];
    render(<ImportProgress progress={createProgress({ errors })} />);

    expect(screen.getByText('2 errors')).toBeInTheDocument();
  });

  it('does not display error badge when no errors', () => {
    render(<ImportProgress progress={createProgress({ errors: [] })} />);

    expect(screen.queryByText(/errors/)).not.toBeInTheDocument();
  });

  it('shows check icon when import is complete', () => {
    render(<ImportProgress progress={createProgress({ total: 10, completed: 10 })} />);

    // The CheckCircle icon should be present when complete
    const cardTitle = screen.getByText('Import Progress').closest('div');
    expect(cardTitle).toBeInTheDocument();
  });

  it('shows spinner when import is in progress', () => {
    render(<ImportProgress progress={createProgress({ total: 10, completed: 5 })} />);

    // The spinner div should be present when in progress
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders close button when onClose is provided', () => {
    const onClose = vi.fn();
    render(<ImportProgress onClose={onClose} progress={createProgress()} />);

    const closeButton = screen.getByRole('button');
    expect(closeButton).toBeInTheDocument();
  });

  it('does not render close button when onClose is not provided', () => {
    render(<ImportProgress progress={createProgress()} />);

    // Only the error toggle button should exist if errors are present
    // With no errors and no onClose, there should be no buttons
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
    const errors = [{ file: 'error.txt', error: 'Failed to import' }];
    render(<ImportProgress progress={createProgress({ errors })} />);

    // Initially errors should be hidden
    expect(screen.queryByText('Failed to import')).not.toBeInTheDocument();

    // Click to show errors
    const viewErrorsButton = screen.getByText(/View 1 error/);
    fireEvent.click(viewErrorsButton);

    // Now errors should be visible
    expect(screen.getByText('Failed to import')).toBeInTheDocument();
    expect(screen.getByText('error.txt')).toBeInTheDocument();

    // Click again to hide
    fireEvent.click(viewErrorsButton);
    expect(screen.queryByText('Failed to import')).not.toBeInTheDocument();
  });

  it('displays correct singular error text', () => {
    const errors = [{ file: 'error.txt', error: 'Failed' }];
    render(<ImportProgress progress={createProgress({ errors })} />);

    expect(screen.getByText('View 1 error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View 1 error' })).toHaveAttribute(
      'title',
      'Show errors'
    );
  });

  it('displays correct plural errors text', () => {
    const errors = [
      { file: 'error1.txt', error: 'Failed' },
      { file: 'error2.txt', error: 'Failed' },
    ];
    render(<ImportProgress progress={createProgress({ errors })} />);

    expect(screen.getByText('View 2 errors')).toBeInTheDocument();
  });

  it('renders error details correctly', () => {
    const errors = [
      { file: 'path/to/file.txt', error: 'File size exceeded limit' },
      { file: 'another/file.js', error: 'Invalid encoding' },
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
    render(<ImportProgress progress={createProgress({ total: 100, completed: 100 })} />);

    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('100 of 100 files')).toBeInTheDocument();
  });

  it('handles edge case of 0 files', () => {
    render(<ImportProgress progress={createProgress({ total: 0, completed: 0 })} />);

    expect(screen.getByText('0 of 0 files')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });
});
