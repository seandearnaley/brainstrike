import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RootLayoutContent from '../root-layout-content';

// Mock the file-explorer-hooks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    storageAdapter: {
      // Mock storage adapter
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
  })),
}));

// Mock the file-explorer-ui
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
  UnifiedFileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="unified-file-explorer-provider">{children}</div>
  ),
}));

let capturedOnNavigationClick: ((path: string) => void) | undefined;

type MockAppLayoutProps = {
  children: React.ReactNode;
  config: {
    title: string;
    navigationItems: unknown[];
  };
  currentPath: string;
  onNavigationClick?: (path: string) => void;
};

type MockAppConfig = {
  title: string;
  description: string;
  themeStorageKey: string;
  navigationItems: unknown[];
};

// Mock the app-shell package
vi.mock('@brainstrike/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/app-shell')>();
  return {
    ...actual,
    AppLayout: ({ children, config, currentPath, onNavigationClick }: MockAppLayoutProps) => {
      capturedOnNavigationClick = onNavigationClick;
      return (
        <div data-current-path={currentPath} data-testid="app-layout">
          <div data-testid="app-config-title">{config.title}</div>
          <div data-testid="navigation-items-count">{config.navigationItems.length}</div>
          {children}
        </div>
      );
    },
    createAppConfig: (config: Partial<MockAppConfig>) => ({
      title: 'BrainStrike.ai',
      description: 'Multi-app dashboard',
      themeStorageKey: 'app-theme',
      navigationItems: [],
      ...config,
    }),
    RootLayoutContent: ({
      sidebarContent,
      homePageContent,
      settingsPageContent,
      navigationItems,
    }: {
      sidebarContent?: React.ReactNode;
      homePageContent: React.ReactNode;
      settingsPageContent: React.ReactNode;
      navigationItems: unknown[];
    }) => {
      const [activeTab, setActiveTab] = React.useState<'explorer' | 'settings'>('explorer');

      const handleNavigationClick = (path: string) => {
        if (path === '/') {
          setActiveTab('explorer');
        } else if (path === '/settings') {
          setActiveTab('settings');
        }
      };

      capturedOnNavigationClick = handleNavigationClick;

      return (
        <div data-testid="file-explorer-provider">
          <div
            data-current-path={activeTab === 'explorer' ? '/' : '/settings'}
            data-testid="app-layout"
          >
            <div data-testid="app-config-title">BrainStrike.ai</div>
            <div data-testid="navigation-items-count">{navigationItems.length}</div>
            {sidebarContent && <aside>{sidebarContent}</aside>}
            <main>{activeTab === 'explorer' ? homePageContent : settingsPageContent}</main>
          </div>
        </div>
      );
    },
  };
});

// Mock the page components
vi.mock('../home-page-content', () => ({
  default: () => <div data-testid="home-page-content">Home Page Content</div>,
  WebFileExplorerLeftPanel: () => <div data-testid="web-file-explorer-left-panel">Left Panel</div>,
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

  it('includes three navigation items in the configuration', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('navigation-items-count')).toHaveTextContent('3');
  });

  it('shows settings page when navigation callback is triggered', () => {
    render(<RootLayoutContent />);
    act(() => {
      capturedOnNavigationClick?.('/settings');
    });

    expect(screen.getByTestId('settings-page-content')).toBeInTheDocument();
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-current-path', '/settings');
  });

  it('toggles back to the explorer page', () => {
    render(<RootLayoutContent />);
    act(() => {
      capturedOnNavigationClick?.('/settings');
    });
    act(() => {
      capturedOnNavigationClick?.('/');
    });

    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-current-path', '/');
  });
});
