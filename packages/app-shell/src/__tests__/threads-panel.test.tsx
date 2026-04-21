import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadsPanel } from '../threads-panel';

describe('ThreadsPanel', () => {
  it('marks the placeholder history list as preview-only', () => {
    render(<ThreadsPanel />);

    expect(screen.getByTestId('threads-preview-badge')).toHaveTextContent('Preview');
    expect(screen.getByText('Search threads coming soon')).toBeVisible();
    expect(screen.getByText('Placeholder agent history for this shell slice.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeDisabled();
    expect(screen.getByTestId('selected-thread-row')).toBeDisabled();
  });
});
