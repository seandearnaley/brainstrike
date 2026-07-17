import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClearDatabaseDialog } from '../components/clear-database-dialog';

describe('ClearDatabaseDialog', () => {
  const baseProps = {
    chunksCount: 12,
    clearing: false,
    onClear: vi.fn(async () => {
      // resolved clear stub
    }),
    recordsCount: 3,
    setShowClearDialog: vi.fn(),
    showClearDialog: true,
  };

  it('speaks about clearing collections data, not the database engine', () => {
    render(<ClearDatabaseDialog {...baseProps} />);

    // Users act on collections (the surface named by the Library tab); the
    // description still names the database as the storage being emptied.
    expect(screen.getByRole('heading', { name: 'Clear All Collections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear All Collections' })).toBeInTheDocument();
    expect(
      screen.getByText(/permanently delete all imported files \(3\) and chunks \(12\)/)
    ).toBeInTheDocument();
  });

  it('blocks clearing while collection counts are pending', () => {
    render(<ClearDatabaseDialog {...baseProps} countsPending />);

    expect(screen.getByText(/Collection counts are still loading/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear All Collections' })).toBeDisabled();
  });
});
