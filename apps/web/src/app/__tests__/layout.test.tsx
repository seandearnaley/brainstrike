import { renderToStaticMarkup } from 'react-dom/server';
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
  test('renders with correct structure and meta information', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <div>Test Content</div>
      </RootLayout>
    );
    const doc = new DOMParser().parseFromString(markup, 'text/html');

    // Check for correct title and meta tags
    expect(doc.title).toBe('BrainStrike.ai');
    expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Multi-app dashboard'
    );

    // Check for RouterProvider
    expect(doc.querySelector('[data-testid="router-provider"]')).not.toBeNull();
    expect(doc.body.textContent).toContain('Test Content');
  });

  test('renders correctly in the DOM', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <div>Test Content</div>
      </RootLayout>
    );
    const doc = new DOMParser().parseFromString(markup, 'text/html');

    // Verify HTML structure
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
  });
});
