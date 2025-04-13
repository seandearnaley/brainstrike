import { render } from '@testing-library/react';
import { Badge } from '@brainstrike/ui';
import { describe, it, expect } from 'vitest';

describe('Tailwind Integration Snapshot', () => {
  it('should render UI package Badge component with correct Tailwind styles', () => {
    const { container } = render(<Badge variant="default">Snapshot Test</Badge>);
    // This snapshot captures the rendered HTML including Tailwind classes.
    // If padding or other base styles change unexpectedly, the snapshot will fail.
    expect(container.firstChild).toMatchSnapshot();
  });
}); 