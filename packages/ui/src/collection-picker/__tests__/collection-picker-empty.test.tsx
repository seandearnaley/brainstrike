import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionPickerEmpty } from '../collection-picker-empty';

vi.mock('../../tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('CollectionPickerEmpty', () => {
  it('does not render a redundant tooltip for the self-describing create button', () => {
    render(<CollectionPickerEmpty onCreate={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Create First Collection' })).toBeInTheDocument();
    expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
    expect(screen.queryByText('Create new collection')).not.toBeInTheDocument();
  });
});
