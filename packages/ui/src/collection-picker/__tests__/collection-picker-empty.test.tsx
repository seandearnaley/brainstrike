import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionPickerEmpty } from '../collection-picker-empty';

describe('CollectionPickerEmpty', () => {
  it('does not render a redundant tooltip for the self-describing create button', () => {
    render(<CollectionPickerEmpty onCreate={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Create First Collection' })).toBeInTheDocument();
  });
});
