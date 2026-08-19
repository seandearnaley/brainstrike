import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTab, UseTabManagerReturn } from '../hooks/use-tab-manager';
import { createFileExplorerRefreshEvent } from '../shell/file-explorer-refresh-event';
import { planOpenFileRefresh } from '../shell/use-workspace-open-file-refresh';
import { WorkspaceTabsProvider } from '../shell/workspace-tabs-context';
import { __resetWorkspaceTabSelectionStoreForTests } from '../stores/workspace-tab-selection-store';
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

function Wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <FileExplorerTestWrapper>
      <WorkspaceTabsProvider apps={[]}>{children}</WorkspaceTabsProvider>
    </FileExplorerTestWrapper>
  );
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
  const reloadFileContents = vi.fn(async (compositeKeys: readonly string[]) => {
    clearFileContents([...compositeKeys]);
    await Promise.all(compositeKeys.map((compositeKey) => loadFileContent(compositeKey)));
  });
  const fileExplorerModule = await import('../shell/use-file-explorer-context');
  vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
    canLoadWithoutTree: false,
    clearFileContents,
    fileContents,
    fileTree: [],
    loadFileContent,
    loadingFiles: new Set<string>(),
    loadMultipleFileContents: vi.fn(),
    reloadFileContents,
    rootDirectoryHandle: null,
  } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);
  return { clearFileContents, loadFileContent, reloadFileContents };
}

describe('workspace tabs open-file refresh', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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
      expect(loadFileContent).toHaveBeenCalledExactlyOnceWith(rootAKey);
      expect(reloadFileContents).toHaveBeenCalledExactlyOnceWith([rootAKey]);
    });
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
