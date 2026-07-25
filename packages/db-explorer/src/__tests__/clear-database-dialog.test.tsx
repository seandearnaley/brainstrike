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

  it('discloses every destructive data category before clearing the database', () => {
    render(<ClearDatabaseDialog {...baseProps} />);

    expect(screen.getByRole('heading', { name: 'Clear Database' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Database' })).toBeInTheDocument();
    expect(
      screen.getByText(/permanently delete all imported files \(3\) and chunks \(12\)/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /assistant conversations, working memory, semantic recall, suspended runs, prompts, run history, and diagnostics/
      )
    ).toBeInTheDocument();
  });

  it('blocks clearing while collection counts are pending', () => {
    render(<ClearDatabaseDialog {...baseProps} countsPending />);

    expect(screen.getByText(/Collection counts are still loading/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear Database' })).toBeDisabled();
  });
});
