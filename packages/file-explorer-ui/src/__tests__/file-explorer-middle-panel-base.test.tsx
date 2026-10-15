import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { ContextExportOutcome } from '@brainstrike/hooks';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextExportOptions } from '../context-export-options';
import type { PreviewPanel } from '../preview/preview-panel';
import { FileExplorerMiddlePanelBase } from '../shell/file-explorer-middle-panel-base';

const mocks = vi.hoisted(() => {
  const previewProps = { current: null as ComponentProps<typeof PreviewPanel> | null };
  const reportActionsInput = {
    current: null as null | {
      loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
    },
  };
  const storeState = {
    excludeFilters: ['dist/**'],
    folderSummaryThreshold: 25,
    includeFilters: ['src/**'],
    includeProjectTree: false,
    tokenBudget: 1000,
    useRegex: false,
  };
  return {
    copyContext: vi.fn<(options?: ContextExportOptions) => Promise<ContextExportOutcome>>(
      async () => ({ ok: true })
    ),
    downloadContext: vi.fn<(options?: ContextExportOptions) => Promise<ContextExportOutcome>>(
      async () => ({ ok: true })
    ),
    loadMultipleFileContents: vi.fn(async () => {}),
    performUndoableAction: vi.fn(),
    persistFileExplorerStateImmediately: vi.fn(async () => {}),
    previewProps,
    reportActionsInput,
    selectedFilePaths: new Set<string>(),
    setFolderSummaryThreshold: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setSelectedFilesFromList: vi.fn(),
    setTokenBudget: vi.fn(),
    storeState,
  };
});

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ storageAdapter: { kind: 'memory' } }),
}));

vi.mock('@brainstrike/ui', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  useUndoableAction: () => ({ performUndoableAction: mocks.performUndoableAction }),
}));

vi.mock('../file-explorer-error-boundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../indexing/use-token-counting', () => ({
  useTokenCounting: () => ({ countTokens: vi.fn() }),
}));

vi.mock('../indexing/use-text-token-count', () => ({
  useTextTokenCount: () => ({ loading: false, tokenCount: 12 }),
}));

vi.mock('../shell/use-context-export-actions', () => ({
  useContextExportActions: (input: {
    loadMultipleFileContents: (compositeKeys: string[]) => Promise<void>;
  }) => {
    mocks.reportActionsInput.current = input;
    return {
      handleCopyContext: mocks.copyContext,
      handleDownloadContext: mocks.downloadContext,
    };
  },
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
  const getStoreState = () => ({
    ...mocks.storeState,
    setFolderSummaryThreshold: mocks.setFolderSummaryThreshold,
    setIncludeProjectTree: mocks.setIncludeProjectTree,
    setTokenBudget: mocks.setTokenBudget,
  });

  return {
    useFileExplorerStoreContext: () => ({ getState: getStoreState }),
    useFileExplorerStoreSelector: <T,>(selector: (state: ReturnType<typeof getStoreState>) => T) =>
      selector(getStoreState()),
  };
});

const selectedFileKey = encodeFileSelection('root', 'src/a.ts');

vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: () => ({
    fileContents: { [selectedFileKey]: 'const a = 1;' },
    fileTree: [
      {
        depth: 1,
        name: 'a.ts',
        path: 'src/a.ts',
        rootFolderId: 'root',
        size: 123,
        type: 'file',
      },
    ],
    loadingFiles: new Set<string>(),
    loadMultipleFileContents: mocks.loadMultipleFileContents,
    rootDirectoryHandle: { name: 'workspace', path: '/workspace' },
    unfilteredFileTree: [
      {
        depth: 1,
        name: 'a.ts',
        path: 'src/a.ts',
        rootFolderId: 'root',
        size: 123,
        type: 'file',
      },
    ],
  }),
}));

vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: () => ({
    selectedFilePaths: mocks.selectedFilePaths,
    setSelectedFilesFromList: mocks.setSelectedFilesFromList,
  }),
}));

describe('FileExplorerMiddlePanelBase', () => {
  beforeEach(() => {
    mocks.storeState.excludeFilters = ['dist/**'];
    mocks.storeState.includeFilters = ['src/**'];
    mocks.storeState.useRegex = false;
    mocks.copyContext.mockClear();
    mocks.copyContext.mockResolvedValue({ ok: true });
    mocks.downloadContext.mockClear();
    mocks.downloadContext.mockResolvedValue({ ok: true });
    mocks.setSelectedFilesFromList.mockClear();
    mocks.loadMultipleFileContents.mockClear();
    mocks.performUndoableAction.mockClear();
    mocks.persistFileExplorerStateImmediately.mockClear();
    mocks.previewProps.current = null;
    mocks.reportActionsInput.current = null;
    mocks.selectedFilePaths = new Set([selectedFileKey, 'not-a-selection']);
    mocks.setFolderSummaryThreshold.mockClear();
    mocks.setIncludeProjectTree.mockClear();
    mocks.setTokenBudget.mockClear();
  });

  it('keeps invalid project-tree regexes in-band as a visible validation result', async () => {
    mocks.storeState.includeFilters = ['[abc'];
    mocks.storeState.useRegex = true;

    render(<FileExplorerMiddlePanelBase />);
    const initialProps = mocks.previewProps.current;
    if (!initialProps) {
      throw new Error('PreviewPanel props were not captured');
    }

    await act(async () => {
      initialProps.onProjectTreeUsesViewFiltersChange?.(true);
    });

    const updatedProps = mocks.previewProps.current as
      | (ComponentProps<typeof PreviewPanel> & { projectTreeValidationError?: string })
      | null;
    expect(updatedProps?.projectTreeValidationError).toBe(
      'Invalid regular expression pattern: [abc'
    );
  });

  it('adapts preview panel callbacks to shell services', async () => {
    render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    expect(props.fileSizes).toEqual({ [selectedFileKey]: 123 });
    expect(props.projectTreeTokenCount).toBe(12);

    props.onIncludeProjectTreeChange?.(true);
    expect(mocks.setIncludeProjectTree).toHaveBeenCalledWith(true);
    await waitFor(() => expect(mocks.persistFileExplorerStateImmediately).toHaveBeenCalledTimes(1));

    props.onRequestFileContent?.(selectedFileKey);
    props.onRequestFileContent?.('root::src/b.ts');
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.loadMultipleFileContents).toHaveBeenCalledWith(
      [selectedFileKey, 'root::src/b.ts'],
      'background'
    );

    const undoSnapshot = new Set([selectedFileKey]);
    const onUndo = vi.fn();
    props.performUndoableAction('remove-selection', selectedFileKey, {
      actionName: 'Remove file',
      getStateSnapshot: () => undoSnapshot,
      itemDescription: 'src/a.ts',
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
    };
    props.onDownloadContext?.(exportOptions);
    props.onCopyContext?.(exportOptions);
    expect(mocks.downloadContext).toHaveBeenCalledWith(exportOptions);
    expect(mocks.copyContext).toHaveBeenCalledWith(exportOptions);

    // Phase 6 cross-root: the preview's onSelectionChange writes the remaining
    // UNION back through setSelectedFilesFromList (the per-root partitioner),
    // NOT the raw core.handleSelectionChange that funnels every root's keys
    // into the focused root's top-level set.
    const remaining = new Set([selectedFileKey, 'other-root|@|src/x.ts']);
    props.onSelectionChange?.(remaining);
    expect(mocks.setSelectedFilesFromList).toHaveBeenCalledWith([...remaining]);
  });

  it('renders a selection-scoped terminal failure and retries preview content', async () => {
    mocks.loadMultipleFileContents
      .mockRejectedValueOnce(new Error('worker internals must stay private'))
      .mockResolvedValueOnce(undefined);
    render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    props.onRequestFileContent?.(selectedFileKey);
    const alert = await screen.findByRole('alert', { name: 'Preview content unavailable' });
    expect(alert).toHaveTextContent('1 selected file could not be loaded.');
    expect(alert).not.toHaveTextContent('worker internals must stay private');

    fireEvent.click(screen.getByRole('button', { name: 'Retry preview content' }));
    await waitFor(() => expect(mocks.loadMultipleFileContents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole('alert', { name: 'Preview content unavailable' })
      ).not.toBeInTheDocument()
    );
  });

  it('keeps a real preview failure visible across value-equivalent multi-root selection sets', async () => {
    mocks.loadMultipleFileContents.mockRejectedValueOnce(new Error('preview failed'));
    const view = render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    props.onRequestFileContent?.(selectedFileKey);
    expect(
      await screen.findByRole('alert', { name: 'Preview content unavailable' })
    ).toBeInTheDocument();

    mocks.selectedFilePaths = new Set([...mocks.selectedFilePaths]);
    view.rerender(<FileExplorerMiddlePanelBase />);

    expect(screen.getByRole('alert', { name: 'Preview content unavailable' })).toBeInTheDocument();
  });

  it('retries the exact failed copy operation and original export options', async () => {
    const exportOptions = {
      projectTreeUsesViewFilters: true,
      selectedLineRangesByFile: {
        [selectedFileKey]: [
          { color: 'blue', endLine: 8, id: 'range-a', isActive: true, startLine: 3 },
        ],
      },
    };
    mocks.copyContext
      .mockResolvedValueOnce({ ok: false, reason: 'generation-failed', retryable: true })
      .mockResolvedValueOnce({ ok: true });
    render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    props.onCopyContext?.(exportOptions);
    const alert = await screen.findByRole('alert', { name: 'Context copy failed' });
    expect(alert).toHaveTextContent('copy');
    expect(screen.queryByRole('button', { name: 'Retry preview content' })).not.toBeInTheDocument();

    exportOptions.projectTreeUsesViewFilters = false;
    exportOptions.selectedLineRangesByFile[selectedFileKey]?.push({
      color: 'red',
      endLine: 21,
      id: 'mutated-after-click',
      isActive: true,
      startLine: 13,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry context copy' }));
    await waitFor(() => expect(mocks.copyContext).toHaveBeenCalledTimes(2));
    expect(mocks.copyContext).toHaveBeenNthCalledWith(2, {
      projectTreeUsesViewFilters: true,
      selectedLineRangesByFile: {
        [selectedFileKey]: [
          { color: 'blue', endLine: 8, id: 'range-a', isActive: true, startLine: 3 },
        ],
      },
    });
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: 'Context copy failed' })).not.toBeInTheDocument()
    );
  });

  it('keeps nested report content loading owned by the copy operation', async () => {
    mocks.loadMultipleFileContents
      .mockRejectedValueOnce(new Error('nested missing content failed'))
      .mockResolvedValueOnce(undefined);
    mocks.copyContext.mockImplementation(async () => {
      const reportActionsInput = mocks.reportActionsInput.current;
      if (!reportActionsInput) {
        throw new Error('Report action input was not captured');
      }
      try {
        await reportActionsInput.loadMultipleFileContents([selectedFileKey]);
        return { ok: true } as const;
      } catch {
        return { ok: false, reason: 'generation-failed', retryable: true } as const;
      }
    });
    render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    props.onCopyContext?.({ projectTreeUsesViewFilters: false, selectedLineRangesByFile: {} });
    expect(await screen.findByRole('alert', { name: 'Context copy failed' })).toBeInTheDocument();
    expect(
      screen.queryByRole('alert', { name: 'Preview content unavailable' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry context copy' }));
    await waitFor(() => expect(mocks.copyContext).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.loadMultipleFileContents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: 'Context copy failed' })).not.toBeInTheDocument()
    );
  });

  it('labels a download delivery failure and retry control precisely', async () => {
    mocks.downloadContext.mockResolvedValueOnce({
      ok: false,
      reason: 'action-failed',
      retryable: true,
    });
    render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }

    props.onDownloadContext?.({ projectTreeUsesViewFilters: false, selectedLineRangesByFile: {} });
    const alert = await screen.findByRole('alert', { name: 'Context download failed' });
    expect(alert).toHaveTextContent('could not be saved');
    expect(screen.getByRole('button', { name: 'Retry context download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry context copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry preview content' })).not.toBeInTheDocument();
  });

  it('labels download failure accurately and fences its retry after selection changes', async () => {
    let settleDownload:
      | ((outcome: { ok: false; reason: 'action-failed'; retryable: true }) => void)
      | undefined;
    mocks.downloadContext.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          settleDownload = resolve;
        })
    );
    const view = render(<FileExplorerMiddlePanelBase />);
    const props = mocks.previewProps.current;
    if (!props) {
      throw new Error('PreviewPanel props were not captured');
    }
    const exportOptions = {
      projectTreeUsesViewFilters: false,
      selectedLineRangesByFile: {},
    };

    props.onDownloadContext?.(exportOptions);
    mocks.selectedFilePaths = new Set(['other-root|@|src/other.ts']);
    view.rerender(<FileExplorerMiddlePanelBase />);
    await act(async () => {
      settleDownload?.({ ok: false, reason: 'action-failed', retryable: true });
      await Promise.resolve();
    });

    expect(
      screen.queryByRole('alert', { name: 'Context download failed' })
    ).not.toBeInTheDocument();
    expect(mocks.downloadContext).toHaveBeenCalledExactlyOnceWith(exportOptions);
  });
});
