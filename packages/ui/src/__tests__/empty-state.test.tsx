import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../empty-state';

describe('EmptyState', () => {
  it('renders required and optional content, and merges icon classes', () => {
    render(
      <EmptyState
        action={<button type="button">Retry</button>}
        className="custom-empty"
        description="No files are available."
        icon={<span className="origin-icon">X</span>}
        title="Nothing here yet"
      />
    );

    expect(screen.getByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
    expect(screen.getByText('No files are available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    const icon = screen.getByText('X');
    expect(icon.className).toContain('origin-icon');
    expect(icon.className).toContain('h-9');
    expect(icon.className).toContain('w-9');

    const root = icon.closest('.custom-empty');
    expect(root).toBeTruthy();
  });

  it('renders only required content when optional props are omitted', () => {
    render(<EmptyState title="Just a title" />);

    expect(screen.getByRole('heading', { name: 'Just a title' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('No files are available.')).not.toBeInTheDocument();
  });

  it('applies the shared panel surface gradient token', () => {
    const { container } = render(<EmptyState title="Token check" />);
    const root = container.firstElementChild;
    expect(root).toBeTruthy();
    expect(root?.className).toContain('bg-panel-surface');
  });
});
