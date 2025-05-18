import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LoadingFallback } from '../loading-fallback';

describe('LoadingFallback', () => {
  it('renders default loading message', () => {
    const { getByText, container } = render(<LoadingFallback />);
    expect(getByText('Loading...')).toBeInTheDocument();
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
