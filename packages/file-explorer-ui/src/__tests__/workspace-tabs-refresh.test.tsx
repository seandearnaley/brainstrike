import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useCallback, useLayoutEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTab, UseTabManagerReturn } from '../hooks/use-tab-manager';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { createFileExplorerRefreshEvent } from '../shell/file-explorer-refresh-event';
import {
  planOpenFileRefresh,
  useWorkspaceOpenFileRefresh,
} from '../shell/use-workspace-open-file-refresh';
import { WorkspaceBody } from '../shell/workspace-body';
import { WorkspaceTabsProvider } from '../shell/workspace-tabs-context';
import { useFileTabPaneStore } from '../stores/file-tab-pane-store';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '../stores/workspace-tab-selection-store';
import { stubMatchMedia } from './setup/stub-match-media';
import { FileExplorerTestWrapper } from './test-helpers';

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(),
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

let capturedFileExplorerStore: ReturnType<typeof useFileExplorerStoreContext> | null = null;

function CaptureFileExplorerStore(): null {
  capturedFileExplorerStore = useFileExplorerStoreContext();
  return null;
}

function Wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <FileExplorerTestWrapper>
      <CaptureFileExplorerStore />
      <WorkspaceTabsProvider apps={[]}>{children}</WorkspaceTabsProvider>
    </FileExplorerTestWrapper>
  );
}

function makeCommitPhaseWrapper(emit: () => void) {
  return function CommitPhaseWrapper({ children }: { readonly children: ReactNode }) {
    useLayoutEffect(() => {
      emit();
    });
    return children;
  };
}

function fileTab(compositeKey: string, path: string): FileTab {
  return { compositeKey, content: null, id: compositeKey, isLoading: false, path };
}

async function configureTabs(tabs: readonly FileTab[]): Promise<void> {
  const tabModule = await import('../hooks/use-tab-manager');
  vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
    activeTabId: null,
    clearTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    setTabError: vi.fn(),
    setTabLoading: vi.fn(),
    tabs: [...tabs],
    updateTabContent: vi.fn(),
  });
}

async function configureFileExplorer(fileContents: Record<string, string>) {
  const clearFileContents = vi.fn();
  const loadFileContent = vi.fn().mockResolvedValue(undefined);
  const reloadFileContents = vi.fn(
    async (compositeKeys: readonly string[], intent: 'background' | 'interactive') => {
      clearFileContents([...compositeKeys]);
      await Promise.all(compositeKeys.map((compositeKey) => loadFileContent(compositeKey, intent)));
    }
  );
  const fileExplorerModule = await import('../shell/use-file-explorer-context');
  vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
    canLoadWithoutTree: false,
    clearFileContents,
    fileContentErrors: new Map<string, Error>(),
    fileContents,
    fileTree: [],
    loadFileContent,
    loadingFiles: new Set<string>(),
    loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
    reloadFileContents,
    rootDirectoryHandle: null,
  } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);
  return { clearFileContents, loadFileContent, reloadFileContents };
}

async function configureRejectedFileExplorer(
  compositeKey: string,
  loadError: Error
): Promise<{
  readonly loadFileContent: ReturnType<typeof vi.fn>;
  readonly reloadFileContents: ReturnType<typeof vi.fn>;
}> {
  const loadFileContent = vi.fn().mockRejectedValue(loadError);
  const loadingFiles = new Set<string>();
  const reloadFileContents = vi.fn();
  let reloadAttempt = 0;
  const fileExplorerModule = await import('../shell/use-file-explorer-context');
  vi.mocked(fileExplorerModule.useFileExplorer).mockImplementation(() => {
    const [fileContents, setFileContents] = useState<Record<string, string>>({
      [compositeKey]: 'stale content before refresh',
    });
    const [fileContentErrors, setFileContentErrors] = useState<ReadonlyMap<string, Error>>(
      new Map()
    );
    const rejectLoad = useCallback(
      async (compositeKeys: readonly string[]): Promise<void> => {
        reloadAttempt += 1;
        setFileContents((previous) => {
          const next = { ...previous };
          for (const key of compositeKeys) {
            delete next[key];
          }
          return next;
        });
        setFileContentErrors((previous) => {
          const next = new Map(previous);
          for (const key of compositeKeys) {
            next.delete(key);
          }
          return next;
        });
        if (reloadAttempt === 1) {
          setFileContentErrors((previous) => {
            const next = new Map(previous);
            for (const key of compositeKeys) {
              next.set(key, loadError);
            }
            return next;
          });
          throw loadError;
        }
        setFileContents((previous) => ({
          ...previous,
          [compositeKey]: 'fresh content after retry',
        }));
      },
      [loadError, compositeKey]
    );
    reloadFileContents.mockImplementation(rejectLoad);
    return {
      canLoadWithoutTree: true,
      clearFileContents: vi.fn(),
      fileContentErrors,
      fileContents,
      fileTree: [],
      loadFileContent,
      loadingFiles,
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      reloadFileContents,
      rootDescriptors: {},
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>;
  });
  return { loadFileContent, reloadFileContents };
}

describe('workspace tabs open-file refresh', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedFileExplorerStore = null;
    __resetWorkspaceTabSelectionStoreForTests();

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

  it('retries a restored tab after its durable root descriptor arrives asynchronously', async () => {
    const compositeKey = 'late-root|@|src/restored.ts';
    await configureTabs([fileTab(compositeKey, 'src/restored.ts')]);
    useWorkspaceTabSelectionStore.getState().selectFile(compositeKey);
    const restorationModule = await import('@brainstrike/file-explorer-hooks');
    vi.mocked(restorationModule.useTabFileRestoration).mockReturnValue({
      getStatusMessage: () => null,
      isRestoring: false,
      needsUserAction: () => false,
      requestTabPermission: vi.fn().mockResolvedValue(true),
      restoreTabs: vi.fn().mockResolvedValue(undefined),
      tabStatuses: new Map<string, TabFileStatus>(),
    });
    const loadFileContent = vi.fn().mockResolvedValue(undefined);
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: true,
      clearFileContents: vi.fn(),
      fileContentErrors: new Map<string, Error>(),
      fileContents: {},
      fileTree: [],
      loadFileContent,
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
      reloadFileContents: vi.fn().mockResolvedValue(undefined),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

    render(<div />, { wrapper: Wrapper });
    expect(loadFileContent).not.toHaveBeenCalled();
    if (!capturedFileExplorerStore) {
      throw new Error('File Explorer store was not captured');
    }

    act(() => {
      capturedFileExplorerStore
        ?.getState()
        .setActiveRoots([{ displayName: 'workspace', path: '/workspace', rootId: 'late-root' }]);
    });

    await waitFor(() => expect(loadFileContent).toHaveBeenCalledTimes(1));
    expect(loadFileContent).toHaveBeenCalledWith(compositeKey, 'interactive');
  });

  it('reloads only the matching root-scoped cached open tab after a modified-file refresh', async () => {
    const rootAKey = 'root-a|@|src/index.ts';
    const rootBKey = 'root-b|@|src/index.ts';
    await configureTabs([fileTab(rootAKey, 'src/index.ts'), fileTab(rootBKey, 'src/index.ts')]);
    const { clearFileContents, loadFileContent, reloadFileContents } = await configureFileExplorer({
      [rootAKey]: 'stale root A content',
      [rootBKey]: 'root B content',
    });

    render(<div />, { wrapper: Wrapper });

    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: '/workspace/a/src/index.ts', type: 'modified' }],
              rootId: 'root-a',
              rootPath: '/workspace/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });

    await waitFor(() => {
      expect(clearFileContents).toHaveBeenCalledExactlyOnceWith([rootAKey]);
      expect(loadFileContent).toHaveBeenCalledExactlyOnceWith(rootAKey, 'background');
      expect(reloadFileContents).toHaveBeenCalledExactlyOnceWith([rootAKey], 'background');
    });
  });

  it('routes commit-phase refresh events through the latest tabs and reload callback', () => {
    const previousTab = fileTab('root-a|@|previous.ts', 'previous.ts');
    const currentTab = fileTab('root-a|@|current.ts', 'current.ts');
    const previousReload = vi.fn().mockResolvedValue(undefined);
    const currentReload = vi.fn().mockResolvedValue(undefined);
    let armed = false;
    const emit = (): void => {
      if (!armed) {
        return;
      }
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: '/workspace/a/current.ts', type: 'modified' }],
              rootId: 'root-a',
              rootPath: '/workspace/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    };

    const { rerender } = renderHook(
      ({ reloadFileContents, tabs }) => useWorkspaceOpenFileRefresh({ reloadFileContents, tabs }),
      {
        initialProps: { reloadFileContents: previousReload, tabs: [previousTab] },
        wrapper: makeCommitPhaseWrapper(emit),
      }
    );

    armed = true;
    rerender({ reloadFileContents: currentReload, tabs: [currentTab] });

    expect(previousReload).not.toHaveBeenCalled();
    expect(currentReload).toHaveBeenCalledExactlyOnceWith([currentTab.compositeKey], 'background');
  });

  it('strips a relative web root prefix without crossing same-named durable roots', () => {
    const rootA = fileTab('root-a|@|src/index.ts', 'src/index.ts');
    const rootB = fileTab('root-b|@|src/index.ts', 'src/index.ts');

    const plan = planOpenFileRefresh([rootA, rootB], {
      roots: [
        {
          changes: [{ kind: 'file', path: 'project/src/index.ts', type: 'modified' }],
          rootId: 'root-a',
          rootPath: 'project',
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(plan.keysToReload).toEqual([rootA.compositeKey]);
  });

  it('reloads every open tab in only the durable root named by a full refresh', () => {
    const rootAIndex = fileTab('root-a|@|src/index.ts', 'src/index.ts');
    const rootAReadme = fileTab('root-a|@|README.md', 'README.md');
    const rootBIndex = fileTab('root-b|@|src/index.ts', 'src/index.ts');

    const plan = planOpenFileRefresh([rootAIndex, rootAReadme, rootBIndex], {
      roots: [{ changes: [], rootId: 'root-a', rootPath: '/workspace/same-name' }],
      scope: 'full',
      source: 'watcher',
    });

    expect(plan.keysToReload).toEqual([rootAIndex.compositeKey, rootAReadme.compositeKey]);
  });

  it('reloads every open tab when manual full refresh uses the canonical empty-root broadcast', () => {
    const rootA = fileTab('root-a|@|src/index.ts', 'src/index.ts');
    const rootB = fileTab('root-b|@|README.md', 'README.md');

    const plan = planOpenFileRefresh([rootA, rootB], {
      roots: [],
      scope: 'full',
      source: 'manual',
    });

    expect(plan.keysToReload).toEqual([rootA.compositeKey, rootB.compositeKey]);
  });

  it.each([
    {
      changePath: 'c:/repo/src/index.ts',
      rootPath: 'C:\\Repo',
      tabPath: 'C:\\REPO\\Src\\Index.ts',
      title: 'drive-rooted',
    },
    {
      changePath: '//SERVER/SHARE/REPO/SRC/index.ts',
      rootPath: '\\\\Server\\Share\\Repo',
      tabPath: '\\\\server\\share\\repo\\src\\Index.ts',
      title: 'UNC',
    },
  ])('uses case-insensitive $title root/path identity', ({ changePath, rootPath, tabPath }) => {
    const tab = fileTab('root-a|@|src/index.ts', tabPath);

    const plan = planOpenFileRefresh([tab], {
      roots: [
        {
          changes: [{ kind: 'file', path: changePath, type: 'modified' }],
          rootId: 'root-a',
          rootPath,
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(plan.keysToReload).toEqual([tab.compositeKey]);
  });

  it('preserves a Windows drive root while matching paths case-insensitively', () => {
    const tab = fileTab('root-a|@|C:\\SRC\\Index.ts', 'C:\\SRC\\Index.ts');

    const plan = planOpenFileRefresh([tab], {
      roots: [
        {
          changes: [{ kind: 'file', path: 'c:/src/index.ts', type: 'modified' }],
          rootId: 'root-a',
          rootPath: 'C:\\',
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(plan.keysToReload).toEqual([tab.compositeKey]);
  });

  it('reloads an open descendant after its containing directory is removed', () => {
    const deleted = fileTab('root-a|@|src/deleted/file.ts', 'src/deleted/file.ts');
    const retained = fileTab('root-a|@|src/retained.ts', 'src/retained.ts');

    const plan = planOpenFileRefresh([deleted, retained], {
      roots: [
        {
          changes: [{ kind: 'directory', path: '/workspace/a/src/deleted', type: 'removed' }],
          rootId: 'root-a',
          rootPath: '/workspace/a',
        },
      ],
      scope: 'incremental',
      source: 'watcher',
    });

    expect(plan.keysToReload).toEqual([deleted.compositeKey]);
  });

  it('renders a terminal content error after an open-tab refresh rejects', async () => {
    stubMatchMedia();
    const compositeKey = 'root-a|@|src/rejected.ts';
    const tab = fileTab(compositeKey, 'src/rejected.ts');
    const loadError = new Error('read worker rejected');
    await configureTabs([tab]);
    const { loadFileContent, reloadFileContents } = await configureRejectedFileExplorer(
      compositeKey,
      loadError
    );
    useWorkspaceTabSelectionStore.getState().selectFile(tab.id);
    useFileTabPaneStore.getState().hydratePanes({
      [compositeKey]: { expandedPaths: [], open: false, widthPct: 30 },
    });

    render(<WorkspaceBody />, { wrapper: Wrapper });
    expect(screen.getByText('stale content before refresh')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: '/workspace/a/src/rejected.ts', type: 'modified' }],
              rootId: 'root-a',
              rootPath: '/workspace/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });

    await waitFor(() =>
      expect(reloadFileContents).toHaveBeenCalledWith([compositeKey], 'background')
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAccessibleName('File content unavailable');
    expect(alert).toHaveTextContent('Brainstrike could not load this file.');
    expect(alert).toHaveTextContent('src/rejected.ts');
    expect(alert).toHaveTextContent('The file read failed.');
    expect(alert).not.toHaveTextContent('read worker rejected');
    fireEvent.click(screen.getByRole('button', { name: 'Retry file content' }));
    await waitFor(() => expect(reloadFileContents).toHaveBeenCalledTimes(2));
    expect(reloadFileContents).toHaveBeenLastCalledWith([compositeKey], 'interactive');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByText('Restoring…')).not.toBeInTheDocument();
    expect(loadFileContent).not.toHaveBeenCalled();
  });

  it('stops reloading after the workspace tabs provider unmounts', async () => {
    const compositeKey = 'root-a|@|src/index.ts';
    await configureTabs([fileTab(compositeKey, 'src/index.ts')]);
    const { reloadFileContents } = await configureFileExplorer({
      [compositeKey]: 'cached content',
    });
    const view = render(<div />, { wrapper: Wrapper });
    view.unmount();

    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: '/workspace/a/src/index.ts', type: 'modified' }],
              rootId: 'root-a',
              rootPath: '/workspace/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });

    expect(reloadFileContents).not.toHaveBeenCalled();
  });
});
