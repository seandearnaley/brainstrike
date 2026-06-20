import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { PanelLayoutState } from '@brainstrike/ui';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootLayoutContent } from '../root-layout-content';
import type { NavigationItem } from '../types';

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: new MemoryStorageAdapter(),
    fileSystemAdapter: null,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  FileExplorerPanel: () => <div data-testid="file-explorer-panel" />,
  FileSystemProvider: ({ children }: { children: React.ReactNode }) => children,
  RootDataDeletionProvider: ({ children }: { children: React.ReactNode }) => children,
  WorkspaceTabHost: ({ className }: { className?: string }) => (
    <div className={className} data-testid="workspace-tab-host" />
  ),
  useFileSystem: () => ({
    rootDirectoryHandle: null,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/tree', () => ({
  FileTreeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-tree-provider">{children}</div>
  ),
}));

const mockHandlers = {
  onNavigationClick: (_path: string) => {},
  panelLayoutChanges: [] as Array<(state: PanelLayoutState) => void>,
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
    PanelLayoutProvider: ({
      children,
      onChange,
    }: {
      children: React.ReactNode;
      onChange?: (state: PanelLayoutState) => void;
    }) => {
      if (onChange) {
        mockHandlers.panelLayoutChanges.push(onChange);
      }
      return <>{children}</>;
    },
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
  IndexingActivityCoordinator: () => <div data-testid="indexing-activity-coordinator" />,
}));

vi.mock('../background-indexing/workspace-collection-sync-provider', () => ({
  WorkspaceCollectionSyncProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../assistant-chat-panel', () => ({
  AssistantChatPanel: () => <div data-testid="assistant-chat-shell" />,
}));

// The palette host pulls in the DB, theme, and command registry; this
// layout-routing test mocks it the same way it mocks every other child panel.
vi.mock('../command-palette-host', () => ({
  CommandPaletteHost: () => <div data-testid="command-palette-host" />,
}));

vi.mock('../agent-sidebar-panel', () => ({
  AgentSidebarPanel: ({
    threadsContent,
    databaseContent,
  }: {
    threadsContent: React.ReactNode;
    databaseContent: React.ReactNode;
  }) => (
    <div data-testid="agent-sidebar-shell">
      <div data-testid="threads-tab-content">{threadsContent}</div>
      <div data-testid="database-tab-content">{databaseContent}</div>
    </div>
  ),
}));

vi.mock('../threads-panel', () => ({
  ThreadsPanel: () => <div data-testid="threads-shell" />,
}));

vi.mock('../database-panel', () => ({
  DatabasePanel: () => <div data-testid="database-panel" />,
}));

describe('RootLayoutContent', () => {
  beforeEach(() => {
    mockHandlers.onNavigationClick = vi.fn();
    mockHandlers.panelLayoutChanges = [];
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
    vi.useRealTimers();
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

  const getRootPanelLayoutChange = () => {
    expect(mockHandlers.panelLayoutChanges).toHaveLength(2);
    const panelLayoutChange = mockHandlers.panelLayoutChanges[0];
    expect(panelLayoutChange).toBeDefined();
    return panelLayoutChange as (state: PanelLayoutState) => void;
  };

  it('renders the agent shell and explorer route by default', () => {
    renderComponent();

    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(screen.getByTestId('agent-sidebar-shell')).toBeInTheDocument();
    expect(screen.getByTestId('threads-shell')).toBeInTheDocument();
    expect(screen.getByTestId('database-panel')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('indexing-activity-coordinator')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-section')).not.toHaveClass('hidden');
    expect(screen.getByTestId('context-explorer-page')).toBeInTheDocument();
    expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
    // The south/console panel is gone — file tabs now live inside the editor area
    // (the workspace tab host is rendered via contextExplorerPageContent in real apps).
    expect(screen.queryByTestId('ide-console-content')).not.toBeInTheDocument();
  });

  it('renders settings as a full-frame route without the agent shell', () => {
    renderComponent();

    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    expect(screen.getByTestId('agent-sidebar-shell')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-route')).toHaveClass('hidden');
    expect(screen.getByTestId('settings-route')).toBeInTheDocument();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('renders prompts as a full-frame route without the agent shell', () => {
    renderComponent();

    act(() => {
      mockHandlers.onNavigationClick('/prompts');
    });

    expect(screen.getByTestId('agent-sidebar-shell')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-route')).toHaveClass('hidden');
    expect(screen.getByTestId('prompts-route')).toBeInTheDocument();
    expect(screen.getByTestId('prompts-page')).toBeInTheDocument();
  });

  it('keeps settings mounted after first visit so local form state survives route switches', async () => {
    const user = userEvent.setup();

    function StatefulSettingsPage() {
      const [value, setValue] = useState('');

      return (
        <label>
          Settings input
          <input
            data-testid="settings-input"
            onChange={(event) => setValue(event.currentTarget.value)}
            value={value}
          />
        </label>
      );
    }

    renderComponent({
      settingsPageContent: <StatefulSettingsPage />,
    });

    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    await user.type(screen.getByTestId('settings-input'), 'persist me');

    act(() => {
      mockHandlers.onNavigationClick('/');
    });

    expect(screen.getByTestId('settings-route')).toHaveClass('hidden');

    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    expect(screen.getByTestId('settings-input')).toHaveValue('persist me');
  });

  it('debounces size-only explorer layout updates and keeps the latest size payload', () => {
    vi.useFakeTimers();
    renderComponent();

    const handlePanelLayoutChange = getRootPanelLayoutChange();

    act(() => {
      handlePanelLayoutChange({
        sizes: [30, 25, 15],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      });
      handlePanelLayoutChange({
        sizes: [35, 30, 10],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      });
    });

    expect(usePanelLayoutStore.getState().sizes).toEqual([25, 20, 20]);

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(usePanelLayoutStore.getState().sizes).toEqual([25, 20, 20]);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(usePanelLayoutStore.getState().sizes).toEqual([35, 30, 10]);
  });

  it('applies visibility toggles immediately even when no size debounce is pending', () => {
    renderComponent();

    const handlePanelLayoutChange = getRootPanelLayoutChange();

    act(() => {
      handlePanelLayoutChange({
        showConsole: true,
        showLeftPanel: true,
        showRightPanel: false,
      } as unknown as PanelLayoutState);
    });

    expect(usePanelLayoutStore.getState()).toMatchObject({
      showConsole: true,
      showLeftPanel: true,
      showRightPanel: false,
      sizes: [25, 20, 20],
    });
  });

  it('cancels a pending size update when a boolean layout change arrives', () => {
    vi.useFakeTimers();
    renderComponent();

    const handlePanelLayoutChange = getRootPanelLayoutChange();

    act(() => {
      handlePanelLayoutChange({
        sizes: [40, 30, 10],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      });
      handlePanelLayoutChange({
        showConsole: false,
        showLeftPanel: false,
        showRightPanel: false,
      } as unknown as PanelLayoutState);
      handlePanelLayoutChange({
        showConsole: false,
        showLeftPanel: false,
        showRightPanel: true,
      } as unknown as PanelLayoutState);
    });

    expect(usePanelLayoutStore.getState()).toMatchObject({
      showConsole: false,
      showLeftPanel: false,
      showRightPanel: true,
      sizes: [25, 20, 20],
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(usePanelLayoutStore.getState()).toMatchObject({
      showConsole: false,
      showLeftPanel: false,
      showRightPanel: true,
      sizes: [25, 20, 20],
    });
  });

  it('clears any pending debounce timer when the layout unmounts', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const view = renderComponent();
    const handlePanelLayoutChange = getRootPanelLayoutChange();

    act(() => {
      handlePanelLayoutChange({
        sizes: [45, 25, 10],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      });
    });

    view.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('mounts an empty prompts route shell when prompts content is omitted', () => {
    renderComponent({ promptsPageContent: undefined });

    act(() => {
      mockHandlers.onNavigationClick('/prompts');
    });

    const promptsRoute = screen.getByTestId('prompts-route');
    expect(promptsRoute).toBeInTheDocument();
    expect(promptsRoute).toBeEmptyDOMElement();

    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    expect(promptsRoute).toHaveClass('hidden');
  });
});
