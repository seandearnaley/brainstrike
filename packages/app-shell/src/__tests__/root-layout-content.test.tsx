import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { PanelLayoutState } from '@brainstrike/ui';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { use, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererLongTaskTelemetry } from '../diagnostics/renderer-long-task-telemetry';
import { RootLayoutContent } from '../root-layout-content';
import type { NavigationItem } from '../types';
import { RootsContext } from '../use-delegated-conversation-root';
import { createRecentLongTaskEntryList } from './long-task-entry-list-test-support';

vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  useDbProviderError: () => null,
  usePGliteDatabase: () => null,
}));

vi.mock('@brainstrike/file-explorer-hooks', async () => {
  const { createContext } = await import('react');
  return {
    AdaptersContext: createContext(null),
    useAdapters: () => ({
      fileSystemAdapter: null,
      storageAdapter: new MemoryStorageAdapter(),
    }),
  };
});

interface CapturedWorkspaceApp {
  readonly id: string;
  readonly label: string;
  readonly render: () => React.ReactNode;
}
let capturedWorkspaceApps: readonly CapturedWorkspaceApp[] = [];

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  CANVAS_APP_ID: 'canvas',
  CHANGES_APP_ID: 'changes',
  CONTEXT_EXPLORER_APP_ID: 'context-explorer',
  ContextExplorerAppBody: () => <div data-testid="context-explorer-app-body" />,
  ExplorerContextExportAction: () => null,
  FileExplorerPanel: () => <div data-testid="file-explorer-panel" />,
  FileSystemProvider: ({ children }: { children: React.ReactNode }) => children,
  RootDataDeletionProvider: ({ children }: { children: React.ReactNode }) => children,
  TERMINAL_APP_ID: 'terminal',
  useFileSystem: () => ({
    rootDirectoryHandle: null,
  }),
  // The real strip/body/provider are exercised in file-explorer-ui's own
  // suite; here we only assert the REGISTRY the shell passes down and that
  // each app body renders through the workspace body slot.
  WorkspaceBody: () => (
    <div data-testid="workspace-body-stub">
      {capturedWorkspaceApps.map((app) => (
        <div data-app-id={app.id} key={app.id}>
          {app.render()}
        </div>
      ))}
    </div>
  ),
  WorkspaceOpenFileBridge: () => null,
  WorkspaceTabStrip: () => <div data-testid="workspace-tab-strip-stub" />,
  WorkspaceTabsProvider: ({
    apps,
    children,
  }: {
    apps: readonly CapturedWorkspaceApp[];
    children: React.ReactNode;
  }) => {
    capturedWorkspaceApps = apps;
    return <>{children}</>;
  },
}));

// The provider above is a pass-through stub with no tabs context, so the
// workspace chord registration (covered in tab-chords/__tests__) is stubbed too.
vi.mock('../tab-chords/workspace-tab-chords', () => ({
  WorkspaceTabChords: () => null,
}));

vi.mock('@brainstrike/file-explorer-ui/tree', () => ({
  FileTreeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-tree-provider">{children}</div>
  ),
}));

const mockHandlers = {
  ideLayoutProps: [] as Array<{
    panelConstraints: { mainContentMinSize?: string; rightPanelMinSize?: string } | undefined;
    panelIdPrefix: string | undefined;
  }>,
  navigationPaths: [] as string[],
  onNavigationClick: (_path: string) => {},
  onOpenSettings: () => {},
  panelLayoutChanges: [] as Array<(state: PanelLayoutState) => void>,
  promptManagerSuspended: false,
  promptManagerSuspense: new Promise<never>(() => {}),
};

vi.mock('../app-layout', () => ({
  AppLayout: ({
    children,
    config,
    currentPath,
    onNavigationClick,
    onOpenSettings,
  }: {
    children: React.ReactNode;
    config: { navigationItems: ReadonlyArray<{ path: string }> };
    currentPath: string;
    onNavigationClick: (path: string) => void;
    onOpenSettings: () => void;
  }) => {
    mockHandlers.navigationPaths = config.navigationItems.map((item) => item.path);
    mockHandlers.onNavigationClick = onNavigationClick;
    mockHandlers.onOpenSettings = onOpenSettings;
    return (
      <div data-current-path={currentPath} data-testid="app-layout">
        {children}
      </div>
    );
  },
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    IdeLayout: ({
      children,
      leftPanelContent,
      rightPanelContent,
      rightPanelChrome,
      consoleContent,
      panelConstraints,
      panelIdPrefix,
    }: {
      children: React.ReactNode;
      leftPanelContent?: React.ReactNode;
      rightPanelContent?: React.ReactNode;
      rightPanelChrome?: { headerContent?: React.ReactNode };
      consoleContent?: React.ReactNode;
      panelConstraints?: { mainContentMinSize?: string; rightPanelMinSize?: string };
      panelIdPrefix?: string;
    }) => {
      mockHandlers.ideLayoutProps.push({ panelConstraints, panelIdPrefix });
      return (
        <div data-testid="ide-layout">
          {rightPanelChrome?.headerContent ? (
            <div data-testid="ide-right-panel-header-slot">{rightPanelChrome.headerContent}</div>
          ) : null}
          {leftPanelContent}
          {children}
          {rightPanelContent}
          {consoleContent && <div data-testid="ide-console-content">{consoleContent}</div>}
        </div>
      );
    },
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
  };
});

vi.mock('@brainstrike/vector-management', () => ({
  EmbeddingRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  IndexingActivityCoordinator: () => <div data-testid="indexing-activity-coordinator" />,
  SearchEmbedderProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../background-indexing/workspace-collection-sync-provider', () => ({
  WorkspaceCollectionSyncProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../assistant-chat-panel', () => ({
  AssistantChatPanel: () => {
    const roots = use(RootsContext);
    return <div data-has-root-owner={roots !== null} data-testid="assistant-chat-shell" />;
  },
  AssistantProviderStatusProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// The palette host pulls in the DB, theme, and command registry; this
// layout-routing test mocks it the same way it mocks every other child panel.
vi.mock('../command-palette-host', () => ({
  CommandPaletteHost: () => <div data-testid="command-palette-host" />,
}));

// The quick-open host pulls in the file-explorer store, DB live query, and the
// file-open seam; mock it the same way as the command palette host.
vi.mock('../quick-open-host', () => ({
  QuickOpenHost: () => <div data-testid="quick-open-host" />,
}));

// The workspace-connect host pulls in the file-system context and the desktop
// bridge; mock it the same way as the command palette and quick-open hosts.
vi.mock('../workspace-connect/workspace-connect-host', () => ({
  WorkspaceConnectHost: () => <div data-testid="workspace-connect-host" />,
}));

// The coordinator binds real stores + PGlite; this layout-routing suite mocks
// it like every other child surface.
vi.mock('../thread-workspace/thread-workspace-coordinator', () => ({
  ThreadWorkspaceCoordinator: () => null,
}));

vi.mock('../agent-sidebar-panel', () => ({
  AgentSidebarPanel: ({
    threadsContent,
    databaseContent,
    promptsContent,
  }: {
    threadsContent: React.ReactNode;
    databaseContent: React.ReactNode;
    promptsContent: React.ReactNode | ((isActive: boolean) => React.ReactNode);
  }) => {
    const [promptsActive, setPromptsActive] = useState(false);
    return (
      <div data-testid="agent-sidebar-shell">
        <button onClick={() => setPromptsActive(true)} type="button">
          Select Prompts tab
        </button>
        <div data-testid="threads-tab-content">{threadsContent}</div>
        <div data-testid="database-tab-content">{databaseContent}</div>
        <div data-testid="prompts-tab-content">
          {typeof promptsContent === 'function' ? promptsContent(promptsActive) : promptsContent}
        </div>
      </div>
    );
  },
}));

vi.mock('../connected-prompt-manager-lazy', () => ({
  ConnectedPromptManagerLazy: ({
    loadEmbeddingQueue,
    suggestionsEnabled,
  }: {
    loadEmbeddingQueue: (() => Promise<unknown>) | null;
    suggestionsEnabled?: boolean;
  }) => {
    if (mockHandlers.promptManagerSuspended) {
      throw mockHandlers.promptManagerSuspense;
    }
    return (
      <div
        data-has-embedding-queue={loadEmbeddingQueue ? 'true' : 'false'}
        data-suggestions-enabled={suggestionsEnabled ? 'true' : 'false'}
        data-testid="connected-prompt-manager"
      />
    );
  },
}));

vi.mock('../threads-panel', () => ({
  ThreadsPanel: () => <div data-testid="threads-shell" />,
}));

vi.mock('../database-panel', () => ({
  DatabasePanel: () => <div data-testid="database-panel" />,
}));

describe('RootLayoutContent', () => {
  beforeEach(() => {
    rendererLongTaskTelemetry.reset();
    mockHandlers.navigationPaths = [];
    mockHandlers.onNavigationClick = vi.fn();
    mockHandlers.onOpenSettings = vi.fn();
    mockHandlers.ideLayoutProps = [];
    mockHandlers.panelLayoutChanges = [];
    mockHandlers.promptManagerSuspended = false;
    usePanelLayoutStore.setState({
      activeTab: 'explorer',
      showConsole: false,
      showLeftPanel: true,
      showRightPanel: false,
      sizes: [25, 20, 20],
    });
  });

  afterEach(() => {
    rendererLongTaskTelemetry.reset();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  const navigationItems: NavigationItem[] = [
    { icon: () => <div />, name: 'Context Explorer', path: '/' },
    { icon: () => <div />, name: 'Settings', path: '/settings' },
  ];

  const renderComponent = (
    overrides: Partial<React.ComponentProps<typeof RootLayoutContent>> = {}
  ) =>
    render(
      <RootLayoutContent
        navigationItems={navigationItems}
        settingsPageContent={<div data-testid="settings-page">Settings</div>}
        {...overrides}
      />
    );

  const getRootPanelLayoutChange = () => {
    // One layout: the Files app is the explorer itself, with no nested layout (BST-2018).
    expect(mockHandlers.panelLayoutChanges).toHaveLength(1);
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
    expect(screen.getByTestId('connected-prompt-manager')).toBeInTheDocument();
    expect(screen.getByTestId('connected-prompt-manager')).toBe(
      screen.getByTestId('prompts-tab-content').firstElementChild
    );
    expect(screen.getByTestId('connected-prompt-manager')).toHaveAttribute(
      'data-suggestions-enabled',
      'false'
    );
    expect(screen.getByTestId('assistant-chat-shell')).toHaveAttribute(
      'data-has-root-owner',
      'true'
    );
    expect(screen.getByTestId('indexing-activity-coordinator')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-section')).not.toHaveClass('hidden');
    // The Files app body is the explorer itself, with no nested layout (BST-2018).
    expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
    expect(
      mockHandlers.ideLayoutProps.some(({ panelIdPrefix }) => panelIdPrefix === 'context-explorer')
    ).toBe(false);
    // The south/console panel is gone — file tabs now live inside the editor area.
    expect(screen.queryByTestId('ide-console-content')).not.toBeInTheDocument();
  });

  it('keeps one long-task observer while reading current route and feature-flag context', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);

    const view = renderComponent({
      gitPageContent: <div data-testid="git-page">Git</div>,
    });
    expect(rendererLongTaskTelemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'unavailable',
    });
    view.rerender(
      <RootLayoutContent
        diagnosticFeatureFlags={['diagnostics-v2']}
        gitPageContent={<div data-testid="git-page">Git</div>}
        navigationItems={navigationItems}
        settingsPageContent={<div data-testid="settings-page">Settings</div>}
      />
    );
    expect(rendererLongTaskTelemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'available',
      sampleCount: 0,
    });
    act(() => {
      mockHandlers.onNavigationClick('/git');
    });

    expect(callbacks).toHaveLength(1);
    const callback = callbacks[0];
    if (!callback) {
      throw new Error('Expected the renderer long-task observer callback.');
    }
    act(() => {
      callback(createRecentLongTaskEntryList([{ duration: 90 }]), {} as PerformanceObserver);
    });

    expect(rendererLongTaskTelemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'available',
      featureFlags: [{ count: 1, flag: 'diagnostics-v2' }],
      routes: [{ count: 1, route: 'git' }],
    });

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('forwards the app embedding queue loader to the prompt workbench', () => {
    const loadEmbeddingQueue = vi.fn(async () => ({ id: 'queue' }) as unknown as QueueAdapter);
    renderComponent({ loadEmbeddingQueue });

    expect(screen.getByTestId('connected-prompt-manager')).toHaveAttribute(
      'data-has-embedding-queue',
      'true'
    );
  });

  it('shows a stable prompt-workbench fallback while the lazy panel graph loads', () => {
    mockHandlers.promptManagerSuspended = true;

    renderComponent();

    expect(screen.getByTestId('prompt-workbench-lazy-fallback')).toHaveTextContent(
      'Opening Prompt Workbench…'
    );
    expect(screen.queryByTestId('connected-prompt-manager')).not.toBeInTheDocument();
  });

  it('routes settings as a full shell tab that replaces the explorer surface (BST-1668)', () => {
    renderComponent();

    // Not mounted until first opened, same as every other keep-mounted route.
    expect(screen.queryByTestId('settings-route')).not.toBeInTheDocument();

    act(() => {
      mockHandlers.onOpenSettings();
    });

    const settingsRoute = screen.getByTestId('settings-route');
    expect(settingsRoute).not.toHaveClass('hidden');
    expect(settingsRoute).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    // A tab, not an overlay: nothing is layered, and the explorer is hidden
    // underneath exactly like it is behind git/notes/browser.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('explorer-route')).toHaveClass('hidden');
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-current-path', '/settings');
  });

  it('selects the settings route when an existing caller sets the settings tab', () => {
    renderComponent();

    act(() => {
      usePanelLayoutStore.getState().setActiveTab('settings');
    });

    expect(screen.getByTestId('settings-route')).not.toHaveClass('hidden');
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-route')).toHaveClass('hidden');
  });

  it('reaches settings from the nav rail like git and notes', () => {
    renderComponent();

    act(() => {
      mockHandlers.onNavigationClick('/settings');
    });

    expect(usePanelLayoutStore.getState().activeTab).toBe('settings');
    expect(screen.getByTestId('settings-route')).not.toHaveClass('hidden');
  });

  it('keeps the settings nav item in the rail, ordered after every other route', () => {
    renderComponent({
      navigationItems: [
        { icon: () => <div />, name: 'Context Explorer', path: '/' },
        { icon: () => <div />, name: 'Settings', path: '/settings' },
        { icon: () => <div />, name: 'Notes', path: '/notes' },
      ],
    });

    // The wrappers append capability-gated routes AFTER the shared list, so
    // the shell owns the rule that Settings is the last rail item.
    expect(mockHandlers.navigationPaths).toEqual(['/', '/notes', '/settings']);
  });

  it('refuses a navigation list without the settings rail item instead of hiding Settings', () => {
    // The shell always mounts the settings route, so a wrapper that forgot the
    // `/settings` item would leave the route reachable only through the
    // profile menu / ⌘K with no rail affordance — a silent degradation. Fail
    // loudly at mount instead.
    expect(() =>
      renderComponent({
        navigationItems: [{ icon: () => <div />, name: 'Context Explorer', path: '/' }],
      })
    ).toThrow(/\/settings/);
  });

  it('switches between settings and another shell tab without unmounting either', () => {
    usePanelLayoutStore.setState({ activeTab: 'git' });
    renderComponent({ gitPageContent: <div data-testid="git-page">Git</div> });

    act(() => {
      usePanelLayoutStore.getState().openSettings();
    });
    expect(screen.getByTestId('settings-route')).not.toHaveClass('hidden');
    expect(screen.getByTestId('git-route')).toHaveClass('hidden');

    act(() => {
      mockHandlers.onNavigationClick('/git');
    });

    expect(usePanelLayoutStore.getState().activeTab).toBe('git');
    expect(screen.getByTestId('git-route')).not.toHaveClass('hidden');
    // Keep-mounted contract, same as notes: hidden, not gone.
    const settingsRoute = screen.getByTestId('settings-route');
    expect(settingsRoute).toHaveClass('hidden');
    expect(settingsRoute).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
  });

  it('mounts the notes route when the notes nav item is selected', () => {
    renderComponent({ notesPageContent: <div data-testid="notes-page">Notes</div> });

    // Lazily mounted: not in the DOM until the tab is first opened.
    expect(screen.queryByTestId('notes-route')).not.toBeInTheDocument();

    act(() => {
      mockHandlers.onNavigationClick('/notes');
    });

    const notesRoute = screen.getByTestId('notes-route');
    expect(notesRoute).not.toHaveClass('hidden');
    expect(notesRoute).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByTestId('notes-page')).toBeInTheDocument();
  });

  it('keeps the notes route mounted but hidden after switching to another tab', () => {
    renderComponent({ notesPageContent: <div data-testid="notes-page">Notes</div> });

    act(() => {
      mockHandlers.onNavigationClick('/notes');
    });
    act(() => {
      mockHandlers.onNavigationClick('/');
    });

    // Keep-mounted contract: the vault surface only toggles hidden so
    // watchers, scan state, and scroll position survive tab switches.
    const notesRoute = screen.getByTestId('notes-route');
    expect(notesRoute).toBeInTheDocument();
    expect(notesRoute).toHaveClass('hidden');
    expect(notesRoute).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('notes-page')).toBeInTheDocument();
    expect(screen.getByTestId('explorer-route')).not.toHaveClass('hidden');
  });

  it('renders no notes route when notesPageContent is absent', () => {
    renderComponent();

    act(() => {
      mockHandlers.onNavigationClick('/notes');
    });

    expect(screen.queryByTestId('notes-route')).not.toBeInTheDocument();
  });

  it('disables prompt suggestions on every hidden outer route without unmounting prompts', async () => {
    const user = userEvent.setup();
    renderComponent({
      gitPageContent: <div>Git</div>,
      notesPageContent: <div>Notes</div>,
    });

    await user.click(screen.getByRole('button', { name: 'Select Prompts tab' }));
    const promptManager = screen.getByTestId('connected-prompt-manager');
    expect(promptManager).toHaveAttribute('data-suggestions-enabled', 'true');

    for (const path of ['/git', '/notes']) {
      act(() => {
        mockHandlers.onNavigationClick(path);
      });

      expect(screen.getByTestId('explorer-route')).toHaveClass('hidden');
      expect(screen.getByTestId('connected-prompt-manager')).toBe(promptManager);
      expect(promptManager).toHaveAttribute('data-suggestions-enabled', 'false');

      act(() => {
        mockHandlers.onNavigationClick('/');
      });

      expect(screen.getByTestId('explorer-route')).not.toHaveClass('hidden');
      expect(screen.getByTestId('connected-prompt-manager')).toBe(promptManager);
      expect(promptManager).toHaveAttribute('data-suggestions-enabled', 'true');
    }
  });

  it('preserves settings page state across leaving and returning to the tab', async () => {
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

    await act(async () => {
      mockHandlers.onOpenSettings();
    });

    await user.type(screen.getByTestId('settings-input'), 'persist me');

    act(() => {
      mockHandlers.onNavigationClick('/');
    });
    expect(screen.getByTestId('settings-route')).toHaveClass('hidden');
    expect(screen.getByTestId('explorer-route')).not.toHaveClass('hidden');

    await act(async () => mockHandlers.onOpenSettings());

    // The modal unmounted its content on close; a keep-mounted route keeps
    // in-progress edits exactly like the git/notes surfaces do.
    expect(screen.getByTestId('settings-route')).not.toHaveClass('hidden');
    expect(screen.getByTestId('settings-input')).toHaveValue('persist me');
  });

  it('debounces size-only explorer layout updates and keeps the latest size payload', () => {
    vi.useFakeTimers();
    renderComponent();

    const handlePanelLayoutChange = getRootPanelLayoutChange();

    act(() => {
      handlePanelLayoutChange({
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
        sizes: [30, 25, 15],
      });
      handlePanelLayoutChange({
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
        sizes: [35, 30, 10],
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
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
        sizes: [40, 30, 10],
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
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
        sizes: [45, 25, 10],
      });
    });

    view.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('registers Changes as a workspace app (not a nav-rail route) when changesPageContent is present', () => {
    renderComponent({ changesPageContent: <div data-testid="changes-page">Changes</div> });

    // No nav-rail item and no top-level KeepMountedRoute for Changes —
    // it registers as a workspace app tab (BST-1258).
    expect(screen.queryByTestId('changes-route')).not.toBeInTheDocument();
    expect(capturedWorkspaceApps.map((app) => app.id)).toEqual(['context-explorer', 'changes']);
    // The registry renders each app body through the workspace body slot.
    expect(screen.getByTestId('changes-page')).toBeInTheDocument();
  });

  it('registers the full desktop registry in canonical order with the Files label', () => {
    renderComponent({
      canvasPanelContent: <div data-testid="canvas-page">Canvas</div>,
      changesPageContent: <div data-testid="changes-page">Changes</div>,
    });

    expect(capturedWorkspaceApps.map((app) => app.id)).toEqual([
      'context-explorer',
      'changes',
      'canvas',
    ]);
    expect(capturedWorkspaceApps.map((app) => app.label)).toEqual(['Files', 'Changes', 'Canvas']);
    expect(screen.getByTestId('canvas-page')).toBeInTheDocument();
    // The Files app body is the explorer itself.
    expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
    // The strip renders in the panel header slot (workspaceHeaderContent).
    expect(screen.getByTestId('workspace-tab-strip-stub')).toBeInTheDocument();
  });

  it('registers only the Files app when optional surfaces are absent (capability gate)', () => {
    renderComponent();

    expect(capturedWorkspaceApps.map((app) => app.id)).toEqual(['context-explorer']);
    expect(capturedWorkspaceApps[0]?.label).toBe('Files');
    expect(screen.getByTestId('file-explorer-panel')).toBeInTheDocument();
  });
});
