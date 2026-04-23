import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadsPanel } from '../threads-panel';

describe('ThreadsPanel', () => {
  it('marks the placeholder history surface as preview-only', () => {
    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-preview-badge')).toHaveTextContent('Preview');
    expect(screen.getByText('Search threads coming soon')).toBeVisible();
    expect(
      screen.getByText('Thread history is intentionally placeholder-only in this slice.')
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeDisabled();
    expect(screen.getByTestId('threads-placeholder-card')).toBeVisible();
    expect(screen.getByText('Your agent threads will appear here')).toBeVisible();
  });
});
