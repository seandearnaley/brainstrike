import { INACCESSIBLE_CONTENT_PREFIX, type TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutGrid } from 'lucide-react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseTabManagerReturn } from '../hooks/use-tab-manager';
import type { WorkspaceApp } from '../shell/workspace-app';
import { WorkspaceTabHost } from '../shell/workspace-tab-host';
import { useEditorViewStateStore } from '../stores/editor-view-state-store';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../stores/tab-manager-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { FileExplorerTestWrapper } from './test-helpers';

// Mock the preview-panel surface (Context Explorer body) — same pattern as existing tests
vi.mock('../preview/preview-panel', () => ({
  PreviewPanel: vi.fn(() => <div data-testid="preview-panel">PreviewPanel</div>),
}));

// Mock useFileExplorer — minimal shape used by the host
vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    canLoadWithoutTree: false,
    fileContents: {},
    fileTree: [],
    loadFileContent: vi.fn(),
    loadingFiles: new Set<string>(),
    loadMultipleFileContents: vi.fn(),
    rootDirectoryHandle: null,
  })),
}));

vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(() => ({
    effectiveSelection: new Set<string>(),
    handleSelectionChange: vi.fn(),
    isRulesMode: false,
    selectedFilePaths: new Set<string>(),
    selectedFilesList: [],
    setSelectedFilesFromList: vi.fn(),
    wouldExceedSelectionLimit: vi.fn(() => false),
  })),
}));

vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...original,
    useTabFileRestoration: vi.fn(() => ({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>(),
    })),
  };
});

describe('WorkspaceTabHost', () => {
  let useTabFileRestoration: typeof import('@brainstrike/file-explorer-hooks').useTabFileRestoration;

  beforeAll(async () => {
    const restorationModule = await import('@brainstrike/file-explorer-hooks');
    useTabFileRestoration = restorationModule.useTabFileRestoration;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceTabSelectionStoreForTests();

    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab: vi.fn(),
    });
    vi.spyOn(uiModule, 'useUndoableAction').mockReturnValue({
      clearUndoTimeout: vi.fn(),
      performUndoableAction: vi.fn(),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    const empty: UseTabManagerReturn = {
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [],
      updateTabContent: vi.fn(),
    };
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue(empty);
  });

  afterEach(() => {
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('renders Context Explorer as a pinned tab and shows its body by default', async () => {
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // Pinned app tab
    const explorerTab = await screen.findByRole('tab', { name: /context explorer/i });
    expect(explorerTab).toBeInTheDocument();
    expect(explorerTab).toHaveAttribute('aria-selected', 'true');

    // Body: the preview panel
    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
  });

  it('does not show a "console" / south panel — file tabs live above the preview', async () => {
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // The legacy console / south "Show File Editor" affordance must not exist
    expect(screen.queryByRole('button', { name: /show file editor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close file editor/i })).not.toBeInTheDocument();
  });

  it('renders a file tab when one is open and switches to it on click', async () => {
    const user = userEvent.setup();
    const setActiveTab = vi.fn();
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab,
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: 'export const x = 1;\n',
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // Context Explorer is selected by default
    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();

    // File tab visible in the strip
    const fileTab = await screen.findByRole('tab', { name: /index\.ts/i });
    expect(fileTab).toBeInTheDocument();
    expect(fileTab).toHaveAttribute('aria-selected', 'false');

    await user.click(fileTab);

    // Tab manager active tab updated and workspace mode switched to file
    expect(setActiveTab).toHaveBeenCalledWith('folderA|@|src/index.ts');
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/index.ts',
      });
    });
  });

  it('does not let a resolved permission prompt override a newer tab selection', async () => {
    const user = userEvent.setup();
    const setActiveTab = vi.fn();
    let resolvePermission: ((granted: boolean) => void) | undefined;
    const requestTabPermission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        })
    );
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission,
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        ['folderA|@|src/a.ts', { compositeKey: 'folderA|@|src/a.ts', status: 'needs-permission' }],
      ]),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab,
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/a.ts',
          content: null,
          id: 'folderA|@|src/a.ts',
          isLoading: false,
          path: 'src/a.ts',
        },
        {
          compositeKey: 'folderA|@|src/b.ts',
          content: null,
          id: 'folderA|@|src/b.ts',
          isLoading: false,
          path: 'src/b.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await user.click(await screen.findByRole('tab', { name: /a\.ts/i }));
    await user.click(await screen.findByRole('tab', { name: /b\.ts/i }));

    expect(setActiveTab).toHaveBeenCalledWith('folderA|@|src/b.ts');
    await act(async () => {
      resolvePermission?.(true);
      await Promise.resolve();
    });

    expect(setActiveTab).not.toHaveBeenCalledWith('folderA|@|src/a.ts');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/b.ts',
    });
  });

  it('uses the current selection when restoration closes a stale tab', async () => {
    let closeRestoredTab: ((tabId: string) => void) | undefined;
    vi.mocked(useTabFileRestoration).mockImplementation((_tabs, onCloseTab) => {
      closeRestoredTab = onCloseTab;
      return {
        getStatusMessage: () => null,
        isRestoring: false,
        needsUserAction: () => false,
        requestTabPermission: vi.fn().mockResolvedValue(true),
        restoreTabs: vi.fn().mockResolvedValue(undefined),
        tabStatuses: new Map<string, TabFileStatus>(),
      };
    });

    const closeTab = vi.fn(() => null);
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/a.ts',
      clearTabs: vi.fn(),
      closeTab,
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/a.ts',
          content: null,
          id: 'folderA|@|src/a.ts',
          isLoading: false,
          path: 'src/a.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/a.ts');
    act(() => {
      closeRestoredTab?.('folderA|@|src/a.ts');
    });

    expect(closeTab).toHaveBeenCalledWith('folderA|@|src/a.ts');
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'context-explorer',
      kind: 'app',
    });
  });

  it('clicking the Context Explorer tab swaps back to the preview body', async () => {
    const user = userEvent.setup();
    // Start in file mode
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/index.ts',
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: { 'folderA|@|src/index.ts': 'export const file = "content";' },
      fileTree: [],
      loadFileContent: vi.fn(),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    // File mode body — preview panel hidden
    await screen.findByText(/export const file/);
    expect(screen.queryByTestId('preview-panel')).not.toBeInTheDocument();

    const explorerTab = await screen.findByRole('tab', { name: /context explorer/i });
    await user.click(explorerTab);

    expect(await screen.findByTestId('preview-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });
  });

  it('renders active file content through the shared CodeSurface viewer', async () => {
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/index.ts',
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: { 'folderA|@|src/index.ts': 'export const file = "content";' },
      fileTree: [],
      loadFileContent: vi.fn(),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    const surface = await screen.findByTestId('file-code-surface');
    expect(surface).toHaveAttribute('data-language', 'TypeScript');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(surface).toHaveTextContent('export const file = "content";');
    expect(surface.querySelector('.cm-lineNumbers')).toBeInTheDocument();
    expect(screen.queryByText('export const file = "content";', { selector: 'pre' })).toBeNull();
  });

  it('consumes the one-shot target line after the opening render so switching away and back does not re-scroll to it', async () => {
    // Regression test for a real remount, not merely a rerender of the same
    // instance: CodeSurface is keyed on `tab.compositeKey` in WorkspaceBody, so
    // switching to another tab and back forces a fresh CodeSurface instance
    // whose mount effect re-reads whatever `initialLine` prop it is given. The
    // fix must clear the store's one-shot target after the opening render so
    // that fresh instance receives `undefined`, not the stale line.
    const user = userEvent.setup();
    const indexKey = 'folderA|@|src/index.ts';
    const otherKey = 'folderA|@|src/other.ts';

    useEditorViewStateStore.getState().setTarget(indexKey, { line: 42 });
    useWorkspaceTabSelectionStore.getState().selectFile(indexKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: indexKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: indexKey,
          content: null,
          id: indexKey,
          isLoading: false,
          path: 'src/index.ts',
        },
        {
          compositeKey: otherKey,
          content: null,
          id: otherKey,
          isLoading: false,
          path: 'src/other.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: {
        [indexKey]: 'export const file = "content";',
        [otherKey]: 'export const other = true;',
      },
      fileTree: [],
      loadFileContent: vi.fn(),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    const uiModule = await import('@brainstrike/ui');
    const OriginalCodeSurface = uiModule.CodeSurface;
    let indexSurfaceInitialLines: (number | undefined)[] = [];
    vi.spyOn(uiModule, 'CodeSurface').mockImplementation((props) => {
      if (props.path === 'src/index.ts') {
        indexSurfaceInitialLines.push(props.initialLine);
      }
      return <OriginalCodeSurface {...props} />;
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await screen.findByTestId('file-code-surface');
    // Opening render is line-targeted...
    expect(indexSurfaceInitialLines[0]).toBe(42);
    // ...and the one-shot target is consumed right after (not left dangling for
    // a future remount to pick up).
    await waitFor(() =>
      expect(useEditorViewStateStore.getState().getTarget(indexKey)).toBeUndefined()
    );

    indexSurfaceInitialLines = [];

    // Switch to the other tab, then back — CodeSurface for index.ts unmounts
    // (key changes away from indexKey) and later remounts (key changes back).
    // CodeMirror splits line text across nested spans, so assert via
    // `toHaveTextContent` (aggregated textContent) rather than `findByText`
    // (which requires a single element's own text to match).
    await user.click(await screen.findByRole('tab', { name: /other\.ts/i }));
    await waitFor(() => {
      expect(screen.getByTestId('file-code-surface')).toHaveTextContent(
        'export const other = true;'
      );
    });

    await user.click(await screen.findByRole('tab', { name: /index\.ts/i }));
    await waitFor(() => {
      expect(screen.getByTestId('file-code-surface')).toHaveTextContent(
        'export const file = "content";'
      );
    });

    // The remounted surface must NOT receive the stale target line again.
    expect(indexSurfaceInitialLines.length).toBeGreaterThan(0);
    expect(indexSurfaceInitialLines.every((line) => line === undefined)).toBe(true);
  });

  it('passes a one-shot chunk selection range to CodeSurface as initialSelection', async () => {
    const indexKey = 'folderA|@|src/index.ts';
    useEditorViewStateStore
      .getState()
      .setTarget(indexKey, { line: 8, selection: { endLine: 12, startLine: 8 } });
    useWorkspaceTabSelectionStore.getState().selectFile(indexKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: indexKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: indexKey,
          content: null,
          id: indexKey,
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: { [indexKey]: 'export const file = "content";' },
      fileTree: [],
      loadFileContent: vi.fn(),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    const uiModule = await import('@brainstrike/ui');
    const OriginalCodeSurface = uiModule.CodeSurface;
    const capturedSelections: ({ startLine: number; endLine: number } | undefined)[] = [];
    vi.spyOn(uiModule, 'CodeSurface').mockImplementation((props) => {
      if (props.path === 'src/index.ts') {
        capturedSelections.push(props.initialSelection);
      }
      return <OriginalCodeSurface {...props} />;
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await screen.findByTestId('file-code-surface');
    expect(capturedSelections[0]).toEqual({ endLine: 12, startLine: 8 });
    // Consumed after the opening render, like the line target.
    await waitFor(() =>
      expect(useEditorViewStateStore.getState().getTarget(indexKey)).toBeUndefined()
    );
  });

  it('shows "Restoring..." for a persisted tab while restoration is pending — not "File not found"', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: 'folderA|@|src/index.ts',
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          content: null,
          id: 'folderA|@|src/index.ts',
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    // Restoration still in progress (no status emitted yet, isRestoring true)
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => 'Restoring...',
      isRestoring: true,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map(),
    });

    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/index.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText(/restoring/i)).toBeInTheDocument();
    expect(screen.queryByText(/file not found or unable to load/i)).not.toBeInTheDocument();
  });

  it('closing the active file tab hops to the next sibling tab, not back to Context Explorer', async () => {
    // Use the REAL tab-manager store so closeTab's successor logic actually runs and we
    // verify the workspace selection consumes the store's authoritative activeTabId.
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
    useTabManagerStore.getState().setActiveTab('folderA|@|src/b.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/b.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    const closeButton = await screen.findByRole('button', { name: /close b\.ts/i });
    await user.click(closeButton);

    // tab-manager-store's closeTab moves activeTabId to the row that took the closed position
    await waitFor(() => {
      expect(useTabManagerStore.getState().activeTabId).toBe('folderA|@|src/c.ts');
    });
    // Workspace selection mirrors that — not Context Explorer
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        kind: 'file',
        tabId: 'folderA|@|src/c.ts',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('closing the last file tab falls back to Context Explorer', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/only.ts', 'folderA|@|src/only.ts', 'folderA|@|src/only.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/only.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    const closeButton = await screen.findByRole('button', { name: /close only\.ts/i });
    await user.click(closeButton);

    await waitFor(() => {
      expect(useTabManagerStore.getState().activeTabId).toBeNull();
    });
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('"Close All Tabs" overflow action clears every file tab and routes to Context Explorer', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();

    const user = userEvent.setup();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/b.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await user.click(await screen.findByRole('button', { name: /more tab actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /close all tabs/i }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs).toEqual([]);
    });
    // Workspace selection routes back to Context Explorer when the active tab vanishes.
    await waitFor(() => {
      expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
        appId: 'context-explorer',
        kind: 'app',
      });
    });

    __resetTabManagerStoreForTests();
  });

  it('"Close All Tabs" is disabled when no file tabs are open', async () => {
    const user = userEvent.setup();
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    await user.click(await screen.findByRole('button', { name: /more tab actions/i }));
    const closeAll = await screen.findByRole('menuitem', { name: /close all tabs/i });
    expect(closeAll).toHaveAttribute('aria-disabled', 'true');
  });

  it('right-clicking an inactive file tab can close it without activating it', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/c.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs.map((tab) => tab.id)).toEqual([
        'folderA|@|src/a.ts',
        'folderA|@|src/c.ts',
      ]);
    });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/c.ts',
    });
  });

  it('right-click Close Others uses the clicked tab as the atomic retained target', async () => {
    const tabModule = await import('../hooks/use-tab-manager');
    vi.mocked(tabModule.useTabManager).mockRestore();
    __resetTabManagerStoreForTests();
    const store = useTabManagerStore.getState();
    store.openTab('src/a.ts', 'folderA|@|src/a.ts', 'folderA|@|src/a.ts');
    store.openTab('src/b.ts', 'folderA|@|src/b.ts', 'folderA|@|src/b.ts');
    store.openTab('src/c.ts', 'folderA|@|src/c.ts', 'folderA|@|src/c.ts');
    useWorkspaceTabSelectionStore.getState().selectFile('folderA|@|src/c.ts');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /b\.ts/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

    await waitFor(() => {
      expect(useTabManagerStore.getState().tabs.map((tab) => tab.id)).toEqual([
        'folderA|@|src/b.ts',
      ]);
    });
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      kind: 'file',
      tabId: 'folderA|@|src/b.ts',
    });
  });

  it('does not invent a context menu for pinned workspace app tabs', async () => {
    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    fireEvent.contextMenu(await screen.findByRole('tab', { name: /context explorer/i }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('registers openFileInTab and loads newly opened file content once', async () => {
    let registeredOpenFile: ((compositeKey: string) => void) | undefined;
    const registerOpenFileInTab = vi.fn((callback: (compositeKey: string) => void) => {
      registeredOpenFile = callback;
    });
    const uiModule = await import('@brainstrike/ui');
    vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
      openFileInTab: vi.fn(),
      registerOpenFileInTab,
    });

    const openTab = vi.fn();
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab,
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [],
      updateTabContent: vi.fn(),
    });

    const loadFileContent = vi.fn();
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: {},
      fileTree: [],
      loadFileContent,
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    if (!registeredOpenFile) {
      throw new Error('Expected openFileInTab registration');
    }
    const openFileInTab = registeredOpenFile;

    act(() => {
      openFileInTab('folderA|@|src/new.ts');
      openFileInTab('malformed-key');
    });

    expect(openTab).toHaveBeenCalledWith(
      'src/new.ts',
      'folderA|@|src/new.ts',
      'folderA|@|src/new.ts'
    );
    expect(loadFileContent).toHaveBeenCalledTimes(1);
    expect(loadFileContent).toHaveBeenCalledWith('folderA|@|src/new.ts');
  });

  it('renders missing app fallback for an unknown persisted app selection', async () => {
    useWorkspaceTabSelectionStore.getState().selectApp('missing-app');

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText('App unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('No registered workspace app matches the saved selection.')
    ).toBeInTheDocument();
  });

  it('renders permission-required restoration status without auto-loading content', async () => {
    const compositeKey = 'folderA|@|src/locked.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => 'Permission was denied',
      isRestoring: false,
      needsUserAction: () => true,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        [
          compositeKey,
          {
            compositeKey,
            error: 'Permission was denied',
            status: 'needs-permission',
          },
        ],
      ]),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: compositeKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey,
          content: null,
          id: compositeKey,
          isLoading: false,
          path: 'src/locked.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const loadFileContent = vi.fn();
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: {},
      fileTree: [{ path: 'src/locked.ts' }],
      loadFileContent,
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText('File Access Required')).toBeInTheDocument();
    expect(screen.getByText('Permission was denied')).toBeInTheDocument();
    expect(loadFileContent).not.toHaveBeenCalled();
  });

  it('renders not-found restoration status with the decoded file path', async () => {
    const compositeKey = 'folderA|@|src/missing.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    vi.mocked(useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => 'File disappeared',
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>([
        [
          compositeKey,
          {
            compositeKey,
            error: 'File disappeared',
            status: 'not-found',
          },
        ],
      ]),
    });

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: compositeKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey,
          content: null,
          id: compositeKey,
          isLoading: false,
          path: 'src/missing.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText('File Not Found')).toBeInTheDocument();
    expect(screen.getByText('src/missing.ts')).toBeInTheDocument();
    expect(screen.getByText('File disappeared')).toBeInTheDocument();
  });

  it('renders inaccessible file content as a browser permission message', async () => {
    const compositeKey = 'folderA|@|src/locked.ts';
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);

    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: compositeKey,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey,
          content: null,
          id: compositeKey,
          isLoading: false,
          path: 'src/locked.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const inaccessibleContent = `${INACCESSIBLE_CONTENT_PREFIX} permission required`;
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      fileContents: { [compositeKey]: inaccessibleContent },
      fileTree: [],
      loadFileContent: vi.fn(),
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost />
      </FileExplorerTestWrapper>
    );

    expect(await screen.findByText(inaccessibleContent)).toBeInTheDocument();
    expect(screen.getByText(/please open the folder again/i)).toBeInTheDocument();
  });

  it('accepts an extensible apps list — additional pinned apps render in tab order', async () => {
    const customApp: WorkspaceApp = {
      icon: LayoutGrid,
      id: 'demo-app',
      label: 'Demo App',
      render: () => <div data-testid="demo-app-body">Demo body</div>,
    };

    render(
      <FileExplorerTestWrapper>
        <WorkspaceTabHost extraApps={[customApp]} />
      </FileExplorerTestWrapper>
    );

    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAccessibleName(/context explorer/i);
    expect(tabs[1]).toHaveAccessibleName(/demo app/i);
  });
});
