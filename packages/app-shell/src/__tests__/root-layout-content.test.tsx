import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContent } from '../root-layout-content';
import type { NavigationItem } from '../types';

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: new MemoryStorageAdapter(),
    fileSystemAdapter: null,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerLeftPanel: () => <div data-testid="file-explorer-left-panel" />,
  TabbedFileEditorPanel: ({ className }: { className?: string }) => (
    <div className={className} data-testid="tabbed-file-editor-panel" />
  ),
  FileTreeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-tree-provider">{children}</div>
  ),
  useFileSystem: () => ({
    rootDirectoryHandle: null,
  }),
}));

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
    mockHandlers.onNavigationClick = onNavigationClick;
    return <div data-testid="app-layout">{children}</div>;
  },
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    PanelLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    IdeLayout: ({
      children,
      leftPanelContent,
      rightPanelContent,
      consoleContent,
    }: {
      children: React.ReactNode;
      leftPanelContent?: React.ReactNode;
      rightPanelContent?: React.ReactNode;
      consoleContent?: React.ReactNode;
    }) => (
      <div data-testid="ide-layout">
        {leftPanelContent}
        {children}
        {rightPanelContent}
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

vi.mock('../assistant-chat-panel', () => ({
  AssistantChatPanel: () => <div data-testid="assistant-chat-shell" />,
}));

vi.mock('../threads-panel', () => ({
  ThreadsPanel: () => <div data-testid="threads-shell" />,
}));

vi.mock('../database-drawer', () => ({
  DatabaseDrawer: () => <div data-testid="database-drawer" />,
}));

describe('RootLayoutContent', () => {
  beforeEach(() => {
    mockHandlers.onNavigationClick = vi.fn();
    usePanelLayoutStore.setState({
      activeTab: 'explorer',
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
      sizes: [25, 20, 20],
    });
    useContextExplorerLayoutStore.setState({
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
      sizes: [25, 20, 20],
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const navigationItems: NavigationItem[] = [
    { name: 'Context Explorer', path: '/', icon: () => <div /> },
    { name: 'Settings', path: '/settings', icon: () => <div /> },
  ];

  const renderComponent = (
    overrides: Partial<React.ComponentProps<typeof RootLayoutContent>> = {}
  ) =>
    render(
      <RootLayoutContent
        contextExplorerPageContent={<div data-testid="context-explorer-page">Context Explorer</div>}
        navigationItems={navigationItems}
        promptsPageContent={<div data-testid="prompts-page">Prompts</div>}
        settingsPageContent={<div data-testid="settings-page">Settings</div>}
        {...overrides}
      />
    );

  it('renders the agent shell and explorer route by default', () => {
    renderComponent();

    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(screen.getByTestId('threads-shell')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('database-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-section')).not.toHaveClass('hidden');
    expect(screen.getByTestId('context-explorer-page')).toBeInTheDocument();
    expect(screen.getByTestId('file-explorer-left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tabbed-file-editor-panel')).toBeInTheDocument();
  });

  it('keeps the agent shell mounted while switching routes', () => {
    renderComponent();

    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    expect(screen.getByTestId('threads-shell')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-section')).toHaveClass('hidden');
    expect(screen.getByTestId('settings-section')).not.toHaveClass('hidden');
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('keeps prompts mounted after first visit', () => {
    renderComponent();

    act(() => {
      mockHandlers.onNavigationClick('/prompts');
    });
    expect(screen.getByTestId('prompts-page')).toBeInTheDocument();

    act(() => {
      mockHandlers.onNavigationClick('/');
    });

    expect(screen.getByTestId('prompts-page')).toBeInTheDocument();
    expect(screen.getByTestId('prompts-section')).toHaveClass('hidden');
  });
});
