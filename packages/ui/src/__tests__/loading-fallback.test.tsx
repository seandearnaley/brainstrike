import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingFallback } from '../loading-fallback';

describe('LoadingFallback', () => {
  it('announces the default loading message as a status', () => {
    const { getByRole, container } = render(<LoadingFallback />);
    expect(getByRole('status')).toHaveTextContent('Loading…');
    // Container should have correct layout classes
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('flex');
    expect(root).toHaveClass('items-center');
    expect(root).toHaveClass('justify-center');
    expect(root).toHaveClass('h-full');
  });

  it('renders custom message', () => {
    const { getByText } = render(<LoadingFallback message="Loading Data..." />);
    expect(getByText('Loading Data...')).toBeInTheDocument();
  });
});
