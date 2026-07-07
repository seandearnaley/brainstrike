import { render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
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
  test('renders with correct structure and meta information', async () => {
    render(
      <HelmetProvider>
        <RootLayout>
          <div>Test Content</div>
        </RootLayout>
      </HelmetProvider>
    );

    // Check for correct title, meta tags, and lang attribute in a single waitFor
    await waitFor(() => {
      expect(document.title).toBe('BrainStrike.ai');
      expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
        'Multi-app dashboard'
      );
      expect(document.documentElement.getAttribute('lang')).toBe('en');
    });

    // Check for RouterProvider and content (synchronous assertions)
    expect(screen.getByTestId('router-provider')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });
});
