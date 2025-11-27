import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from '../app-layout';
import type { AppShellConfig, NavigationItem } from '../types';

// Mock the file-explorer-ui package to avoid worker issues
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
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
  StatusBar: ({ leftContent }: { leftContent?: React.ReactNode }) => (
    <div data-testid="status-bar">{leftContent}</div>
  ),
  ErrorBoundary: class MockErrorBoundary extends React.Component<{ children: React.ReactNode }> {
    override render() {
      return <div data-testid="error-boundary">{this.props.children}</div>;
    }
  },
}));

// Mock the status items
vi.mock('../status-items', () => ({
  DatabaseStatusItem: () => <div data-testid="database-status-item">DB Status</div>,
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
