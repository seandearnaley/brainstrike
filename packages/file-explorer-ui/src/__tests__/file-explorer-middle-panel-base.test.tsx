import { encodeFileSelection } from '@brainstrike/utils';
import { act, render, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewPanel } from '../preview/preview-panel';
import { FileExplorerMiddlePanelBase } from '../shell/file-explorer-middle-panel-base';

const mocks = vi.hoisted(() => {
  const previewProps = { current: null as ComponentProps<typeof PreviewPanel> | null };
  return {
    copyContext: vi.fn(async () => {}),
    downloadContext: vi.fn(async () => {}),
    handleSelectionChange: vi.fn(),
    loadMultipleFileContents: vi.fn(async () => {}),
    openFileInTab: vi.fn(),
    performUndoableAction: vi.fn(),
    persistFileExplorerStateImmediately: vi.fn(async () => {}),
    previewProps,
    setFolderSummaryThreshold: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setTokenBudget: vi.fn(),
  };
});

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ storageAdapter: { kind: 'memory' } }),
}));

vi.mock('@brainstrike/ui', () => ({
  useIdeFileEditor: () => ({ openFileInTab: mocks.openFileInTab }),
  useUndoableAction: () => ({ performUndoableAction: mocks.performUndoableAction }),
}));

vi.mock('../file-explorer-error-boundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../indexing/use-token-counting', () => ({
  useTokenCounting: () => ({ countTokens: vi.fn() }),
}));

vi.mock('../indexing/use-text-token-count', () => ({
  useTextTokenCount: () => ({ tokenCount: 12, loading: false }),
}));

vi.mock('../preview/use-preview-panel-report-actions', () => ({
  usePreviewPanelReportActions: () => ({
    handleCopyContext: mocks.copyContext,
    handleDownloadContext: mocks.downloadContext,
  }),
}));

vi.mock('../preview/preview-panel', () => ({
  PreviewPanel: (props: ComponentProps<typeof PreviewPanel>) => {
    mocks.previewProps.current = props;
    return <div data-testid="preview-panel" />;
  },
}));

vi.mock('../utils/persist-file-explorer-state', () => ({
  persistFileExplorerStateImmediately: mocks.persistFileExplorerStateImmediately,
}));

vi.mock('../shell/file-explorer-provider', () => {
  const storeState = {
    tokenBudget: 1000,
    setTokenBudget: mocks.setTokenBudget,
    includeProjectTree: false,
    setIncludeProjectTree: mocks.setIncludeProjectTree,
    includeFilters: ['src/**'],
    excludeFilters: ['dist/**'],
    useRegex: false,
    folderSummaryThreshold: 25,
    setFolderSummaryThreshold: mocks.setFolderSummaryThreshold,
  };

  return {
    useFileExplorerStoreContext: () => ({ getState: () => storeState }),
    useFileExplorerStoreSelector: <T,>(selector: (state: typeof storeState) => T) =>
      selector(storeState),
  };
});

const selectedFileKey = encodeFileSelection('root', 'src/a.ts');

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: () => ({
    fileContents: { [selectedFileKey]: 'const a = 1;' },
    loadingFiles: new Set<string>(),
    fileTree: [
      {
        type: 'file',
        name: 'a.ts',
        path: 'src/a.ts',
        rootFolderId: 'root',
        size: 123,
        depth: 1,
      },
    ],
    unfilteredFileTree: [
      {
        type: 'file',
        name: 'a.ts',
        path: 'src/a.ts',
        rootFolderId: 'root',
        size: 123,
        depth: 1,
      },
    ],
    rootDirectoryHandle: { path: '/workspace', name: 'workspace' },
    loadMultipleFileContents: mocks.loadMultipleFileContents,
  }),
}));

vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: () => ({
    selectedFilePaths: new Set([selectedFileKey, 'not-a-selection']),
    handleSelectionChange: mocks.handleSelectionChange,
  }),
}));

describe('FileExplorerMiddlePanelBase', () => {
  beforeEach(() => {
    mocks.copyContext.mockClear();
    mocks.downloadContext.mockClear();
    mocks.handleSelectionChange.mockClear();
    mocks.loadMultipleFileContents.mockClear();
    mocks.openFileInTab.mockClear();
    mocks.performUndoableAction.mockClear();
    mocks.persistFileExplorerStateImmediately.mockClear();
    mocks.previewProps.current = null;
    mocks.setFolderSummaryThreshold.mockClear();
    mocks.setIncludeProjectTree.mockClear();
    mocks.setTokenBudget.mockClear();
  });

  it('adapts preview panel callbacks to shell services', async () => {
    render(<FileExplorerMiddlePanelBase estimateTokenCost={(tokens) => tokens / 1000} />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    expect(props.fileSizes).toEqual({ [selectedFileKey]: 123 });
    expect(props.projectTreeTokenCount).toBe(12);
    expect(props.estimateTokenCost?.(2000)).toBe(2);

    props.onIncludeProjectTreeChange?.(true);
    expect(mocks.setIncludeProjectTree).toHaveBeenCalledWith(true);
    await waitFor(() => expect(mocks.persistFileExplorerStateImmediately).toHaveBeenCalledTimes(1));

    props.onFileClick?.(selectedFileKey);
    expect(mocks.openFileInTab).toHaveBeenCalledWith(selectedFileKey);

    props.onRequestFileContent?.(selectedFileKey);
    props.onRequestFileContent?.('root::src/b.ts');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.loadMultipleFileContents).toHaveBeenCalledWith([
      selectedFileKey,
      'root::src/b.ts',
    ]);

    const undoSnapshot = new Set([selectedFileKey]);
    const onUndo = vi.fn();
    props.performUndoableAction('remove-selection', selectedFileKey, {
      actionName: 'Remove file',
      itemDescription: 'src/a.ts',
      getStateSnapshot: () => undoSnapshot,
      onUndo,
    });
    expect(mocks.performUndoableAction).toHaveBeenCalledWith(
      'remove-selection',
      undoSnapshot,
      expect.objectContaining({
        actionName: 'Remove file',
        itemDescription: 'src/a.ts',
      })
    );
    const undoOptions = mocks.performUndoableAction.mock.calls[0]?.[2];
    undoOptions?.onUndo(null, undoSnapshot);
    expect(onUndo).toHaveBeenCalledWith('remove-selection', undoSnapshot);

    const exportOptions = {
      projectTreeUsesViewFilters: false,
      selectedLineRangesByFile: {},
      useTapestryRanges: false,
    };
    props.onDownloadContext?.(exportOptions);
    props.onCopyContext?.(exportOptions);
    expect(mocks.downloadContext).toHaveBeenCalledWith(exportOptions);
    expect(mocks.copyContext).toHaveBeenCalledWith(exportOptions);
  });
});
