import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../../src/button';

describe('Button', () => {
  it('renders default variant', () => {
    render(<Button>Click</Button>);
    const button = screen.getByRole('button', { name: 'Click' });
    expect(button).toHaveClass('bg-primary');
  });

  it('renders as child element', () => {
    render(
      <Button asChild>
        {/* biome-ignore lint/a11y/noAmbiguousAnchorText: test fixture asserting asChild composition, not real content */}
        <a href="/link">Link</a>
      </Button>
    );
    const link = screen.getByRole('link', { name: 'Link' });
    expect(link).toHaveAttribute('href', '/link');
  });
});
