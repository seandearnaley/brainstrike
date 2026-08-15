import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Force the explorer component to suspend so Suspense fallback renders
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  __esModule: true,
  ContextExplorerAppBody: () => {
    // Throw a never-resolving promise to simulate a suspended component
    throw new Promise(() => {});
  },
}));

import ContextExplorerPageContent from '../context-explorer-page-content';

describe('ContextExplorerPageContent (fallback)', () => {
  it('renders Suspense fallback while explorer is loading', () => {
    render(<ContextExplorerPageContent />);

    // Verify the fallback content is displayed
    expect(screen.getByText('Loading...', { exact: false })).toBeInTheDocument();
  });
});
