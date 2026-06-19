import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from '../app-layout';
import type { AppShellConfig, NavigationItem } from '../types';

vi.mock('@brainstrike/preferences', () => ({
  useDatabaseStatusSync: () => {},
  GlobalDownloadIndicator: () => <div data-testid="global-download-indicator" />,
}));

// Mock the shell barrel to avoid worker/provider setup in layout tests.
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
  FileSystemProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock the file-explorer-hooks package
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: null,
    storageAdapter: null,
  }),
}));

// Mock the UI package
vi.mock('@brainstrike/ui', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
  Toaster: () => <div data-testid="toaster" />,
  NavigationSidebar: ({
    currentPath,
    onItemClick,
    children,
  }: {
    items: NavigationItem[];
    currentPath: string;
    onItemClick?: (path: string) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="navigation-sidebar">
      <span data-testid="nav-path">{currentPath}</span>
      {onItemClick && <div data-testid="nav-click-handler" />}
      {children}
    </div>
  ),
  ThemeToggle: () => <div data-testid="theme-toggle" />,
  StatusBar: ({
    leftContent,
    centerContent,
    rightContent,
  }: {
    leftContent?: React.ReactNode;
    centerContent?: React.ReactNode;
    rightContent?: React.ReactNode;
  }) => (
    <div data-testid="status-bar">
      <div data-testid="status-bar-left">{leftContent}</div>
      <div data-testid="status-bar-center">{centerContent}</div>
      <div data-testid="status-bar-right">{rightContent}</div>
    </div>
  ),
  // biome-ignore lint/style/useReactFunctionComponents: Class component needed for ErrorBoundary mock
  ErrorBoundary: class MockErrorBoundary extends React.Component<{ children: React.ReactNode }> {
    override render() {
      return <div data-testid="error-boundary">{this.props.children}</div>;
    }
  },
}));

// Mock the status items
vi.mock('../status-items', () => ({
  CollectionSyncStatusItem: () => (
    <div data-testid="collection-sync-status-item">Workspace Index Cache Status</div>
  ),
  DatabaseStatusItem: () => <div data-testid="database-status-item">DB Status</div>,
  IndexingStatusItem: () => <div data-testid="indexing-status-item">Indexing Status</div>,
}));

// Mock the file-explorer-hooks package
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: {},
    fileSystemAdapter: {},
  }),
}));

const mockConfig: AppShellConfig = {
  themeStorageKey: 'test-theme',
  navigationItems: [{ name: 'Home', path: '/', icon: () => null }],
  title: 'Test App',
  description: 'A test application',
};

describe('AppLayout', () => {
  it('should render the main components', () => {
    render(
      <AppLayout config={mockConfig} currentPath="/">
        <div>Page Content</div>
      </AppLayout>
    );
    expect(screen.getByTestId('theme-provider')).toBeInTheDocument();
    expect(screen.getByTestId('tooltip-provider')).toBeInTheDocument();
    expect(screen.getByTestId('navigation-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('toaster')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByText('Page Content')).toBeInTheDocument();
  });

  it('should render the status bar with database status', () => {
    render(
      <AppLayout config={mockConfig} currentPath="/">
        <div>Page Content</div>
      </AppLayout>
    );
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('database-status-item')).toBeInTheDocument();
    expect(screen.getByTestId('indexing-status-item')).toBeInTheDocument();
    expect(screen.getByTestId('collection-sync-status-item')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-status-item')).not.toBeInTheDocument();
  });

  it('should pass correct props to NavigationSidebar', () => {
    const handleNavClick = vi.fn();
    render(
      <AppLayout config={mockConfig} currentPath="/settings" onNavigationClick={handleNavClick}>
        <div />
      </AppLayout>
    );

    expect(screen.getByTestId('nav-path')).toHaveTextContent('/settings');
    expect(screen.getByTestId('nav-click-handler')).toBeInTheDocument();
  });
});
