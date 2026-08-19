import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseTabManagerReturn } from '../hooks/use-tab-manager';
import { createFileExplorerRefreshEvent } from '../shell/file-explorer-refresh-event';
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
    const tabModule = await import('../hooks/use-tab-manager');
    vi.spyOn(tabModule, 'useTabManager').mockReturnValue({
      activeTabId: null,
      clearTabs: vi.fn(),
      closeTab: vi.fn(),
      openTab: vi.fn(),
      setActiveTab: vi.fn(),
      setTabError: vi.fn(),
      setTabLoading: vi.fn(),
      tabs: [
        {
          compositeKey: rootAKey,
          content: null,
          id: rootAKey,
          isLoading: false,
          path: 'src/index.ts',
        },
        {
          compositeKey: rootBKey,
          content: null,
          id: rootBKey,
          isLoading: false,
          path: 'src/index.ts',
        },
      ],
      updateTabContent: vi.fn(),
    });

    const clearFileContents = vi.fn();
    const loadFileContent = vi.fn().mockResolvedValue(undefined);
    const fileExplorerModule = await import('../shell/use-file-explorer-context');
    vi.mocked(fileExplorerModule.useFileExplorer).mockReturnValue({
      canLoadWithoutTree: false,
      clearFileContents,
      fileContents: {
        [rootAKey]: 'stale root A content',
        [rootBKey]: 'root B content',
      },
      fileTree: [],
      loadFileContent,
      loadingFiles: new Set<string>(),
      loadMultipleFileContents: vi.fn(),
      rootDirectoryHandle: null,
    } as unknown as ReturnType<typeof fileExplorerModule.useFileExplorer>);

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
    });
  });
});
