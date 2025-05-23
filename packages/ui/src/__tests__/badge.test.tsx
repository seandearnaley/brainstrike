import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../../src/badge';

describe('Badge', () => {
  it('renders default variant', () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText('Default');
    expect(badge).toHaveClass('bg-primary');
  });

  it('renders secondary variant', () => {
    render(<Badge variant="secondary">Secondary</Badge>);
    const badge = screen.getByText('Secondary');
    expect(badge).toHaveClass('bg-secondary');
  });

  describe('Snapshots', () => {
    it('should render with correct Tailwind classes (default variant)', () => {
      const { container } = render(<Badge variant="default">Snapshot Test</Badge>);
      // This snapshot captures the rendered HTML including all Tailwind classes.
      // If padding or other base styles change unexpectedly, the snapshot will fail.
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should render with correct Tailwind classes (secondary variant)', () => {
      const { container } = render(<Badge variant="secondary">Secondary Badge</Badge>);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should render with correct Tailwind classes (destructive variant)', () => {
      const { container } = render(<Badge variant="destructive">Error Badge</Badge>);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('should render with correct Tailwind classes (outline variant)', () => {
      const { container } = render(<Badge variant="outline">Outline Badge</Badge>);
      expect(container.firstChild).toMatchSnapshot();
    });
  });
});
