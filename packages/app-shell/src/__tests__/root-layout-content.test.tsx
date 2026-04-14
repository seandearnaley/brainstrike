import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render, screen } from '@testing-library/react';

import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContent } from '../root-layout-content';
import type { NavigationItem } from '../types';

// Mock dependencies - avoid duplicate mocks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: new MemoryStorageAdapter(),
    fileSystemAdapter: null,
  }),
  useFileExplorer: () => ({}),
}));

// Mock the file-explorer-ui package to avoid worker issues
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerLeftPanel: () => <div data-testid="file-explorer-left-panel" />,
  TabbedFileEditorPanel: ({ className }: { className?: string }) => (
    <div className={className} data-testid="tabbed-file-editor-panel" />
  ),
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
  FileTreeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-tree-provider">{children}</div>
  ),
  useFileSystem: () => ({
    isAccessLoading: false,
    rootDirectoryHandle: null,
    selectRootDirectory: vi.fn(),
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
    clearRootDirectory: vi.fn(),
  }),
  useOptionalFileTreeContext: () => null,
  // Mock workspace filter function - returns identity function for tests
  useWorkspaceFilterFn: () => (tree: unknown[]) => tree,
}));

// Create a stable object to hold the mock function.
const mockHandlers = {
  onNavigationClick: (_path: string) => {},
};

vi.mock('../app-layout', () => ({
  AppLayout: ({
    children,
    onNavigationClick,
  }: {
    children: React.ReactNode;
    onNavigationClick: (path: string) => void;
  }) => {
    // The mock can now safely assign to a property of the stable object.
    mockHandlers.onNavigationClick = onNavigationClick;
    return <div>{children}</div>;
  },
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    // No-op provider for unit tests (avoids async persistence side effects)
    PanelLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    IdeLayout: ({
      children,
      leftPanelContent,
      consoleContent,
    }: {
      children: React.ReactNode;
      leftPanelContent: React.ReactNode;
      consoleContent?: React.ReactNode;
    }) => (
      <div data-testid="ide-layout">
        {leftPanelContent}
        {children}
        {consoleContent && <div data-testid="ide-console-content">{consoleContent}</div>}
      </div>
    ),
  };
});

vi.mock('@brainstrike/vector-management', () => ({
  EmbeddingRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../background-indexing/workspace-collection-sync-provider', () => ({
  WorkspaceCollectionSyncProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('RootLayoutContent', () => {
  beforeEach(() => {
    // Reset the mock function before each test
    mockHandlers.onNavigationClick = vi.fn();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const mockNavigationItems: NavigationItem[] = [
    { name: 'Explorer', path: '/', icon: () => <div /> },
    { name: 'Settings', path: '/settings', icon: () => <div /> },
  ];

  const MockHomePage = () => <div data-testid="home-page">Home</div>;
  const MockSettingsPage = () => <div data-testid="settings-page">Settings</div>;

  const renderComponent = () =>
    render(
      <RootLayoutContent
        homePageContent={<MockHomePage />}
        navigationItems={mockNavigationItems}
        settingsPageContent={<MockSettingsPage />}
      />
    );

  it('should render explorer view visible and settings hidden by default', () => {
    renderComponent();
    // All panels are always in DOM (CSS visibility pattern for performance)
    const explorerSection = screen.getByTestId('explorer-section');
    const settingsSection = screen.getByTestId('settings-section');

    expect(explorerSection).toBeInTheDocument();
    expect(settingsSection).toBeInTheDocument();

    // Explorer should be visible
    expect(explorerSection).not.toHaveClass('hidden');
    expect(explorerSection).toHaveAttribute('aria-hidden', 'false');

    // Settings should be hidden
    expect(settingsSection).toHaveClass('hidden');
    expect(settingsSection).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByTestId('settings-page')).not.toBeInTheDocument();
  });

  it('should switch to settings view and hide explorer on navigation', () => {
    renderComponent();

    // Simulate navigation click by invoking the captured function
    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    const explorerSection = screen.getByTestId('explorer-section');
    const settingsSection = screen.getByTestId('settings-section');

    // Explorer should now be hidden
    expect(explorerSection).toHaveClass('hidden');
    expect(explorerSection).toHaveAttribute('aria-hidden', 'true');

    // Settings should now be visible
    expect(settingsSection).not.toHaveClass('hidden');
    expect(settingsSection).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('should switch back to explorer view on subsequent navigation', () => {
    renderComponent();

    // To settings
    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });
    expect(screen.getByTestId('settings-section')).not.toHaveClass('hidden');

    // Back to explorer
    act(() => {
      mockHandlers.onNavigationClick('/');
    });

    const explorerSection = screen.getByTestId('explorer-section');
    const settingsSection = screen.getByTestId('settings-section');

    // Explorer should be visible again
    expect(explorerSection).not.toHaveClass('hidden');
    expect(explorerSection).toHaveAttribute('aria-hidden', 'false');

    // Settings should be hidden again
    expect(settingsSection).toHaveClass('hidden');
    expect(settingsSection).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('should render the tabbed file editor panel in console content', () => {
    renderComponent();

    expect(screen.getByTestId('ide-console-content')).toBeInTheDocument();
    expect(screen.getByTestId('tabbed-file-editor-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tabbed-file-editor-panel')).toHaveClass('h-full');
  });

  it('should provide correct sidebar content to IDE layout', () => {
    renderComponent();

    expect(screen.getByTestId('file-explorer-left-panel')).toBeInTheDocument();
  });
});
