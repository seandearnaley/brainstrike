import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, vi } from 'vitest';
import RootLayoutContent from '../root-layout-content';

interface MockAppLayoutProps {
  children: React.ReactNode;
  config: {
    title: string;
    navigationItems: unknown[];
  };
  currentPath: string;
}

interface MockAppConfig {
  title: string;
  description: string;
  themeStorageKey: string;
  navigationItems: unknown[];
}

// Mock the app-shell package
vi.mock('@brainstrike/app-shell', () => ({
  AppLayout: ({ children, config, currentPath }: MockAppLayoutProps) => (
    <div data-testid="app-layout" data-current-path={currentPath}>
      <div data-testid="app-config-title">{config.title}</div>
      {children}
    </div>
  ),
  createAppConfig: (config: Partial<MockAppConfig>) => ({
    title: 'BrainStrike.ai',
    description: 'Multi-app dashboard',
    themeStorageKey: 'app-theme',
    navigationItems: [],
    ...config,
  }),
}));

// Mock react-router-dom
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useLocation: () => ({ pathname: '/test-path' }),
    Outlet: () => <div data-testid="outlet">Outlet Content</div>,
  };
});

describe('RootLayoutContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(
      <MemoryRouter>
        <RootLayoutContent />
      </MemoryRouter>
    );

    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('passes the correct current path to AppLayout', () => {
    render(
      <MemoryRouter>
        <RootLayoutContent />
      </MemoryRouter>
    );

    const appLayout = screen.getByTestId('app-layout');
    expect(appLayout).toHaveAttribute('data-current-path', '/test-path');
  });

  it('renders the outlet for child routes', () => {
    render(
      <MemoryRouter>
        <RootLayoutContent />
      </MemoryRouter>
    );

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(screen.getByText('Outlet Content')).toBeInTheDocument();
  });

  it('uses the correct app configuration', () => {
    render(
      <MemoryRouter>
        <RootLayoutContent />
      </MemoryRouter>
    );

    expect(screen.getByTestId('app-config-title')).toHaveTextContent('BrainStrike.ai');
  });
});
