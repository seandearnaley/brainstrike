import { clearPersistentUiStateWithResult } from '@brainstrike/app-state/factory-reset';
import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContentLoadAuthority } from '../file-content-load-authority-context';
import { useFileContentLoadAuthority } from '../file-content-load-authority-context';
import { useWorkspaceTabs, type WorkspaceTabsValue } from '../shell/use-workspace-tabs';
import { WorkspaceTabsProvider } from '../shell/workspace-tabs-context';
import { useTabManagerStore } from '../stores/tab-manager-store';
import { __resetWorkspaceTabSelectionStoreForTests } from '../stores/workspace-tab-selection-store';
import { FileExplorerTestWrapper } from './test-helpers';

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    canLoadWithoutTree: false,
    fileContentErrors: new Map<string, Error>(),
    fileContents: {},
    fileTree: [],
    loadFileContent: vi.fn().mockResolvedValue(undefined),
    loadingFiles: new Set<string>(),
    reloadFileContents: vi.fn().mockResolvedValue(undefined),
    rootDescriptors: {},
    rootDirectoryHandle: null,
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

let authority: FileContentLoadAuthority | null = null;
let workspaceTabs: WorkspaceTabsValue | null = null;

function Probe(): null {
  authority = useFileContentLoadAuthority();
  workspaceTabs = useWorkspaceTabs();
  return null;
}

function openTab(index: number): string {
  const compositeKey = `folder-a|@|src/file-${index}.ts`;
  useTabManagerStore.getState().openTab(`src/file-${index}.ts`, compositeKey, compositeKey);
  return compositeKey;
}

function renderHarness(): void {
  render(
    <FileExplorerTestWrapper>
      <WorkspaceTabsProvider apps={[]}>
        <Probe />
      </WorkspaceTabsProvider>
    </FileExplorerTestWrapper>
  );
}

function recordErrors(compositeKeys: readonly string[]): void {
  const currentAuthority = authority;
  if (!currentAuthority) {
    throw new Error('Expected file-content authority probe');
  }
  currentAuthority.recordErrors(
    compositeKeys.map((compositeKey) => ({
      compositeKey,
      error: new Error(`failed:${compositeKey}`),
      expectedGeneration: currentAuthority.currentGeneration(compositeKey),
    }))
  );
}

function getWorkspaceTabs(): WorkspaceTabsValue {
  if (!workspaceTabs) {
    throw new Error('Expected workspace tabs probe');
  }
  return workspaceTabs;
}

function getAuthority(): FileContentLoadAuthority {
  if (!authority) {
    throw new Error('Expected file-content authority probe');
  }
  return authority;
}

describe('workspace tab file-content error ownership', () => {
  beforeEach(() => {
    authority = null;
    workspaceTabs = null;
    useTabManagerStore.getState().clearTabs();
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('prunes a terminal error when its single file tab closes', async () => {
    const firstKey = openTab(1);
    const secondKey = openTab(2);
    renderHarness();
    act(() => recordErrors([firstKey, secondKey]));
    expect([...getAuthority().getErrorsSnapshot().keys()]).toEqual([firstKey, secondKey]);

    act(() => getWorkspaceTabs().onCloseFileTab(firstKey));

    await waitFor(() => {
      expect([...getAuthority().getErrorsSnapshot().keys()]).toEqual([secondKey]);
    });
  });

  it('prunes every retired key after bulk close operations', async () => {
    const firstKey = openTab(1);
    const secondKey = openTab(2);
    const thirdKey = openTab(3);
    renderHarness();
    act(() => recordErrors([firstKey, secondKey, thirdKey]));

    act(() => getWorkspaceTabs().onCloseOtherFileTabs(secondKey));
    await waitFor(() => {
      expect([...getAuthority().getErrorsSnapshot().keys()]).toEqual([secondKey]);
    });

    act(() => recordErrors([firstKey, thirdKey]));
    expect([...getAuthority().getErrorsSnapshot().keys()]).toEqual([secondKey]);

    act(() => getWorkspaceTabs().onCloseAllFileTabs());
    await waitFor(() => {
      expect(getAuthority().getErrorsSnapshot().size).toBe(0);
    });
  });

  it('retains errors only for the twenty open tabs instead of evicted keys', () => {
    const allKeys = Array.from({ length: 21 }, (_, index) => openTab(index + 1));
    const evictedKey = allKeys[0];
    renderHarness();

    act(() => recordErrors(allKeys));

    const retainedErrors = getAuthority().getErrorsSnapshot();
    expect(retainedErrors.size).toBe(20);
    expect(retainedErrors.has(evictedKey ?? '')).toBe(false);
    expect([...retainedErrors.keys()]).toEqual(allKeys.slice(1));
  });

  it('clears retained open-tab errors during factory reset', async () => {
    const compositeKey = openTab(1);
    renderHarness();
    act(() => recordErrors([compositeKey]));
    expect(getAuthority().getErrorsSnapshot().has(compositeKey)).toBe(true);

    await act(async () => {
      const result = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
      expect(result.success).toBe(true);
    });

    expect(getAuthority().getErrorsSnapshot().size).toBe(0);
  });
});
