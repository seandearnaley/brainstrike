import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import RootLayout from '../layout';

// Mock the UI package
vi.mock('@brainstrike/ui', () => ({
  appleTouchIcon: '/test-apple-touch-icon.png',
  icon16: '/test-icon-16.png',
  icon32: '/test-icon-32.png',
  icon48: '/test-icon-48.png',
  icon192: '/test-icon-192.png',
  icon512: '/test-icon-512.png',
  RouterProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="router-provider">{children}</div>
  ),
}));

describe('RootLayout', () => {
  test('renders the router provider around its children', () => {
    render(
      <RootLayout>
        <div>Test Content</div>
      </RootLayout>
    );

    expect(screen.getByTestId('router-provider')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  // BST-1281: document metadata moved to the single `useDocumentTitle` writer,
  // and `lang="en"` is static markup in apps/web/index.html — this layout must
  // not reintroduce a per-surface writer for either.
  test('writes no document metadata of its own', () => {
    render(
      <RootLayout>
        <div>Test Content</div>
      </RootLayout>
    );

    expect(document.head.querySelectorAll('title')).toHaveLength(0);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(0);
  });
});
