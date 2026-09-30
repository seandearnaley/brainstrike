import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorFallback } from '../error-fallback';

describe('ErrorFallback', () => {
  it('renders default error message', () => {
    const { getByText, container } = render(<ErrorFallback />);
    expect(getByText('Something went wrong.')).toBeInTheDocument();
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('p-4');
    expect(root).toHaveClass('text-destructive');
  });

  it('renders custom message', () => {
    const { getByText } = render(<ErrorFallback message="Custom Error" />);
    expect(getByText('Custom Error')).toBeInTheDocument();
  });
});
