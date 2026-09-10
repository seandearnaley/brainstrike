import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppLayout } from '../app-layout';
import type { AppShellConfig, NavigationItem } from '../types';

vi.mock('@brainstrike/settings-ui/components/global-download-indicator', () => ({
  GlobalDownloadIndicator: () => <div data-testid="global-download-indicator" />,
}));

vi.mock('@brainstrike/app-state/hooks/use-database-status-sync', () => ({
  useDatabaseStatusSync: () => {},
}));
vi.mock('@brainstrike/settings-ui/components/global-download-indicator', () => ({
  GlobalDownloadIndicator: () => <div data-testid="global-download-indicator" />,
}));
vi.mock('@brainstrike/app-state/hooks/use-database-status-sync', () => ({
  useDatabaseStatusSync: () => {},
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
  // biome-ignore lint/style/useReactFunctionComponents: Class component needed for ErrorBoundary mock
  ErrorBoundary: class MockErrorBoundary extends React.Component<{ children: React.ReactNode }> {
    override render() {
      return <div data-testid="error-boundary">{this.props.children}</div>;
    }
  },
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
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
  ThemeToggle: () => <div data-testid="theme-toggle" />,
  Toaster: () => <div data-testid="toaster" />,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
}));

const { useModelMigrationNoticesMock } = vi.hoisted(() => ({
  useModelMigrationNoticesMock: vi.fn(),
}));

// BST-565: the retired-model toast hook is session-wide and lives HERE (not in
// a per-thread wrapper). Mocked so the layout test needs no toast plumbing.
vi.mock('../hooks/use-model-migration-notices', () => ({
  useModelMigrationNotices: useModelMigrationNoticesMock,
}));

// Mock the status items. AppLayout imports the direct modules so React Doctor
// can verify there is no status-items barrel import in the production path.
vi.mock('../status-items/database-status-item', () => ({
  DatabaseStatusItem: () => <div data-testid="database-status-item">DB Status</div>,
}));
vi.mock('../status-items/indexing-status-item', () => ({
  IndexingStatusItem: () => <div data-testid="indexing-status-item">Indexing Status</div>,
}));
vi.mock('../status-items/workspace-root-status-item', () => ({
  WorkspaceRootStatusItem: () => (
    <div data-testid="workspace-root-status-item">Workspace Root Status</div>
  ),
}));

// Mock the file-explorer-hooks package
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: {},
    storageAdapter: {},
  }),
}));

const mockConfig: AppShellConfig = {
  description: 'A test application',
  navigationItems: [{ icon: () => null, name: 'Home', path: '/' }],
  themePaletteStorageKey: 'test-theme-palette',
  themeStorageKey: 'test-theme',
  title: 'Test App',
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

  it('places the unified indexing surface at the far right after downloads', () => {
    render(
      <AppLayout config={mockConfig} currentPath="/">
        <div>Page Content</div>
      </AppLayout>
    );
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('database-status-item')).toBeInTheDocument();
    expect(screen.getByTestId('indexing-status-item')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar-center')).toBeEmptyDOMElement();
    expect(screen.getByTestId('status-bar-right')).toContainElement(
      screen.getByTestId('global-download-indicator')
    );
    expect(screen.getByTestId('status-bar-right')).toContainElement(
      screen.getByTestId('indexing-status-item')
    );
    expect(
      screen
        .getByTestId('global-download-indicator')
        .compareDocumentPosition(screen.getByTestId('indexing-status-item')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByTestId('collection-sync-status-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-status-item')).not.toBeInTheDocument();
  });

  it('places the workspace-root item on the left beside the database item', () => {
    render(
      <AppLayout config={mockConfig} currentPath="/">
        <div>Page Content</div>
      </AppLayout>
    );
    const left = screen.getByTestId('status-bar-left');
    expect(left).toContainElement(screen.getByTestId('database-status-item'));
    expect(left).toContainElement(screen.getByTestId('workspace-root-status-item'));
    expect(
      screen
        .getByTestId('database-status-item')
        .compareDocumentPosition(screen.getByTestId('workspace-root-status-item')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('mounts the session-wide retired-model notice hook exactly once (BST-565)', () => {
    useModelMigrationNoticesMock.mockClear();
    render(
      <AppLayout config={mockConfig} currentPath="/">
        <div>child</div>
      </AppLayout>
    );
    expect(useModelMigrationNoticesMock).toHaveBeenCalledTimes(1);
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
