import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async'; // Import HelmetProvider
import { describe, expect, it, vi } from 'vitest';
import RootLayout from '../layout';

// Mock the Inter font
vi.mock('next/font/google', () => ({
  Inter: () => ({
    className: 'inter-font',
  }),
}));

// Mock the components
vi.mock('../../components/custom/sidebar/sidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="sidebar">Sidebar Mock</div>,
}));

vi.mock('@brainstrike/ui', () => ({
  __esModule: true,
  Toaster: () => <div data-testid="toaster">Toaster Mock</div>,
  RouterProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="router-provider">{children}</div>
  ),
  ThemeProvider: ({
    children,
    defaultTheme,
    storageKey,
  }: {
    children: React.ReactNode;
    defaultTheme?: string;
    storageKey?: string;
  }) => (
    <div data-testid="theme-provider" data-theme={defaultTheme} data-storage-key={storageKey}>
      {children}
    </div>
  ),
  // Mock icon assets
  icon16: '/mock-icon-16.png',
  icon32: '/mock-icon-32.png',
  icon48: '/mock-icon-48.png',
  icon192: '/mock-icon-192.png',
  icon512: '/mock-icon-512.png',
  appleTouchIcon: '/mock-apple-touch-icon.png',
}));

describe('RootLayout', () => {
  it('renders with correct structure and components', () => {
    const layout = RootLayout({ children: <div>Test Content</div> });

    // Verify the root structure
    expect(layout.type).toBe('html');
    expect(layout.props.lang).toBe('en');

    // Get the body element - account for head elements
    const body = Array.isArray(layout.props.children)
      ? layout.props.children.find(
          (child: React.ReactNode) =>
            typeof child === 'object' && child !== null && 'type' in child && child.type === 'body'
        )
      : layout.props.children;

    expect(body.type).toBe('body');

    // Check if className exists before testing it
    if (body.props && 'className' in body.props) {
      expect(body.props.className).toBe('inter-font');
    }

    // Get the ThemeProvider
    const themeProvider = body.props.children;
    expect(themeProvider.type.name).toBe('ThemeProvider');
    expect(themeProvider.props.defaultTheme).toBe('system');
    expect(themeProvider.props.storageKey).toBe('app-theme');

    // Get the RouterProvider and its children
    const routerProvider = themeProvider.props.children;
    expect(routerProvider.type.name).toBe('RouterProvider');

    // Check if children is an array or a single element
    const routerChildren = routerProvider.props.children;
    const mainContainer = Array.isArray(routerChildren) ? routerChildren[0] : routerChildren;
    const toaster = Array.isArray(routerChildren) ? routerChildren[1] : null;

    expect(mainContainer.props.className).toBe('flex h-screen');

    // Verify sidebar is present
    const [sidebar, main] = mainContainer.props.children;
    expect(sidebar.type.name).toBe('default'); // Sidebar component

    // Verify main content area
    expect(main.type).toBe('main');
    expect(main.props.className).toBe('flex-1 overflow-auto p-4');
    expect(main.props.children).toEqual(<div>Test Content</div>);

    // Verify toaster is present
    expect(toaster.type.name).toBe('Toaster');
  });

  it('renders correctly in the DOM', () => {
    // Render the actual RootLayout wrapped only in HelmetProvider
    const { container } = render(
      <HelmetProvider>
        <RootLayout>
          <div>Test Content</div>
        </RootLayout>
      </HelmetProvider>
    );

    // Verify the components are rendered using their mock test IDs
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('toaster')).toBeInTheDocument();
    expect(screen.getByText('Test Content')).toBeInTheDocument();

    // Verify the structure
    const main = screen.getByRole('main');
    expect(main).toHaveClass('flex-1', 'overflow-auto', 'p-4');

    const flexContainer = container.querySelector('.flex.h-screen');
    expect(flexContainer).toBeInTheDocument();
  });
});
