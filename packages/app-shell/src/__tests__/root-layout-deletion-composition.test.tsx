import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell/file-system-provider';
import { type DirectoryHandle, MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { PanelLayoutState } from '@brainstrike/ui';
import { act, render, screen } from '@testing-library/react';
import type React from 'react';
import { use, useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rendererLongTaskTelemetry } from '../diagnostics/renderer-long-task-telemetry';
import { RootLayoutContent } from '../root-layout-content';
import { RootsContext } from '../use-delegated-conversation-root';

vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  useDbProviderError: () => null,
  usePGliteDatabase: () => null,
}));

interface CapturedWorkspaceApp {
  readonly id: string;
  readonly label: string;
  readonly render: () => React.ReactNode;
}
let capturedWorkspaceApps: readonly CapturedWorkspaceApp[] = [];

vi.mock('@brainstrike/file-explorer-ui/shell', async () => {
  const { FileExplorerProvider } = await import(
    '@brainstrike/file-explorer-ui/shell/file-explorer-provider'
  );
  const { FileSystemProvider, useFileSystem } = await import(
    '@brainstrike/file-explorer-ui/shell/file-system-provider'
  );
  const { RootDataDeletionProvider } = await import(
    '@brainstrike/file-explorer-ui/shell/root-data-deletion-context'
  );
  return {
    CANVAS_APP_ID: 'canvas',
    CHANGES_APP_ID: 'changes',
    CONTEXT_EXPLORER_APP_ID: 'context-explorer',
    ContextExplorerAppBody: () => <div data-testid="context-explorer-app-body" />,
    ExplorerContextExportAction: () => null,
    FileExplorerPanel: () => <div data-testid="file-explorer-panel" />,
    FileExplorerProvider,
    FileSystemProvider,
    RootDataDeletionProvider,
    TERMINAL_APP_ID: 'terminal',
    useFileSystem,
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
  };
});

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

// The root, app layout, shared filesystem instance and deletion context remain real.
// These chrome modules do not participate in the destructive transition.
vi.mock('@brainstrike/app-state/hooks/use-database-status-sync', () => ({
  useDatabaseStatusSync: () => {},
}));
vi.mock('../hooks/use-model-migration-notices', () => ({ useModelMigrationNotices: () => {} }));
vi.mock('../account-menu', () => ({ AccountMenu: () => null }));
vi.mock('../app-reload/app-reload-strip', () => ({ AppReloadStrip: () => null }));
vi.mock('../database-integrity/database-integrity-notice', () => ({
  DatabaseIntegrityNotice: () => null,
}));
vi.mock('../status-items/database-status-item', () => ({ DatabaseStatusItem: () => null }));
vi.mock('../status-items/diagnostics-status-item', () => ({ DiagnosticsStatusItem: () => null }));
vi.mock('../status-items/indexing-status-item', () => ({ IndexingStatusItem: () => null }));
vi.mock('../status-items/workspace-root-status-item', () => ({
  WorkspaceRootStatusItem: () => null,
}));
vi.mock('@brainstrike/settings-ui/components/global-download-indicator', () => ({
  GlobalDownloadIndicator: () => null,
}));

const consumers = new Map<string, ReturnType<typeof useFileSystem>>();
function RootConsumer({ name }: { readonly name: string }) {
  const fs = useFileSystem();
  useLayoutEffect(() => {
    consumers.set(name, fs);
  }, [name, fs]);
  return <output data-testid={name}>{fs.rootDirectoryHandles.length}</output>;
}
function consumer(name = 'first') {
  const fs = consumers.get(name);
  if (!fs) {
    throw new Error('Shared filesystem consumer was not mounted.');
  }
  return fs;
}

beforeEach(() => {
  consumers.clear();
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
  vi.restoreAllMocks();
});

async function mountRoot(deleteRootData: (rootId: string) => Promise<void>) {
  const events: string[] = [];
  class RootAdapter extends MockFileSystemAdapter {
    readonly removeRoot = vi.fn(async (_rootId: string) => {
      events.push('disconnect');
    });
  }
  const adapter = new RootAdapter();
  const storage = new MemoryStorageAdapter();
  const handle: DirectoryHandle = {
    kind: 'directory',
    name: 'mock-root',
    path: 'mock-root',
    platform: 'web',
  } as DirectoryHandle;
  vi.spyOn(adapter, 'requestDirectoryAccess').mockResolvedValue(handle);
  render(
    <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
      <RootLayoutContent
        // Any workspace app body sits inside the root layout's deletion context.
        changesPageContent={
          <>
            <RootConsumer name="first" />
            <RootConsumer name="second" />
          </>
        }
        deleteRootData={deleteRootData}
        navigationItems={[
          { icon: () => <div />, name: 'Context Explorer', path: '/' },
          { icon: () => <div />, name: 'Settings', path: '/settings' },
        ]}
        settingsPageContent={<div>Settings</div>}
      />
    </AdaptersProvider>
  );
  await screen.findByTestId('first');
  await act(async () => {
    await consumer().selectRootDirectory();
  });
  const rootId = consumer().rootDirectoryHandle?.rootId;
  if (!rootId) {
    throw new Error('The actual shared filesystem did not admit a root.');
  }
  expect(consumer()).toBe(consumer('second'));
  expect(consumer().rootDirectoryHandles).toHaveLength(1);
  return { adapter, events, rootId };
}

it('injects deletion above the singleton filesystem and joins the callback before disconnect', async () => {
  const released = Promise.withResolvers<void>();
  const deletion = vi.fn(async (_rootId: string) => {
    await released.promise;
  });
  const f = await mountRoot(deletion);
  let removing: Promise<void> | undefined;
  try {
    await act(async () => {
      removing = consumer().removeRootDirectory(f.rootId, { deleteData: true });
      await Promise.resolve();
    });
    expect(deletion).toHaveBeenCalledExactlyOnceWith(f.rootId);
    expect(f.adapter.removeRoot).not.toHaveBeenCalled();
    expect(consumer().rootDirectoryHandles).toHaveLength(1);
    released.resolve();
    await act(async () => {
      await removing;
    });
    expect(f.adapter.removeRoot).toHaveBeenCalledExactlyOnceWith(f.rootId);
    expect(consumer().rootDirectoryHandles).toHaveLength(0);
    expect(consumer()).toBe(consumer('second'));
  } finally {
    released.resolve();
    await act(async () => {
      await removing;
    });
  }
});

it('keeps the same shared root connected when the supplied deletion callback rejects', async () => {
  const cause = new Error('owned deletion failed');
  const deletion = vi.fn(async (_rootId: string) => {
    throw cause;
  });
  const f = await mountRoot(deletion);
  await act(async () => {
    await consumer().removeRootDirectory(f.rootId, { deleteData: true });
  });
  expect(deletion).toHaveBeenCalledExactlyOnceWith(f.rootId);
  expect(f.adapter.removeRoot).not.toHaveBeenCalled();
  expect(consumer().rootDirectoryHandles).toHaveLength(1);
  expect(consumer()).toBe(consumer('second'));
});
