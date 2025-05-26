import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RootLayoutContent from '../root-layout-content';

interface MockAppLayoutProps {
  children: React.ReactNode;
  config: {
    title: string;
    navigationItems: unknown[];
  };
  currentPath: string;
  onNavigationClick?: (path: string) => void;
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

// Mock the page components
vi.mock('../home-page-content', () => ({
  default: () => <div data-testid="home-page-content">Home Page Content</div>,
}));

vi.mock('../settings/page-content', () => ({
  default: () => <div data-testid="settings-page-content">Settings Page Content</div>,
}));

describe('RootLayoutContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('passes the correct initial current path to AppLayout', () => {
    render(<RootLayoutContent />);
    const appLayout = screen.getByTestId('app-layout');
    expect(appLayout).toHaveAttribute('data-current-path', '/');
  });

  it('renders home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
    expect(screen.getByText('Home Page Content')).toBeInTheDocument();
  });

  it('uses the correct app configuration', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-config-title')).toHaveTextContent('BrainStrike.ai');
  });
});
