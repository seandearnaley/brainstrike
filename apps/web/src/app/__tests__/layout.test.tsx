import { render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, test, vi } from 'vitest';
import RootLayout from '../layout';

// Mock the UI package
vi.mock('@brainstrike/ui', () => ({
  RouterProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="router-provider">{children}</div>
  ),
  appleTouchIcon: '/test-apple-touch-icon.png',
  icon16: '/test-icon-16.png',
  icon32: '/test-icon-32.png',
  icon48: '/test-icon-48.png',
  icon192: '/test-icon-192.png',
  icon512: '/test-icon-512.png',
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

    // Check for correct title and meta tags
    await waitFor(() => {
      expect(document.title).toBe('BrainStrike.ai');
    });
    await waitFor(() => {
      expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
        'Multi-app dashboard'
      );
    });

    // Check for RouterProvider
    expect(screen.getByTestId('router-provider')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  test('renders correctly in the DOM', async () => {
    render(
      <HelmetProvider>
        <RootLayout>
          <div>Test Content</div>
        </RootLayout>
      </HelmetProvider>
    );

    // Verify HTML structure
    await waitFor(() => {
      expect(document.documentElement.getAttribute('lang')).toBe('en');
    });
  });
});
