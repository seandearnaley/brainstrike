import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerMiddlePanel } from '../file-explorer-middle-panel';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

let previewSnapshot: Set<string>;
// biome-ignore lint/suspicious/noVar: var required for vi.mock hoisting - let creates temporal dead zone
var previewPanelMock: ReturnType<typeof vi.fn> | undefined;
interface MockPreviewPanelProps {
  onSelectionChange: (files: Set<string>) => void;
  performUndoableAction: (
    key: string,
    itemKey: string,
    opts: {
      actionName: string;
      itemDescription: string;
      getStateSnapshot: () => Set<string>;
      onUndo: (key: string, snapshot: Set<string>) => void;
    }
  ) => void;
}

vi.mock('../preview-panel', () => {
  previewPanelMock = vi.fn(
    ({
      onSelectionChange,
      performUndoableAction,
      onFileClick,
    }: MockPreviewPanelProps & { onFileClick?: (key: string) => void }) => {
      previewSnapshot = new Set(['file']);

      const handleClick = () => {
        performUndoableAction('file', 'file', {
          actionName: 'removed',
          itemDescription: 'removed file',
          getStateSnapshot: () => previewSnapshot,
          onUndo: vi.fn(),
        });
        onSelectionChange(previewSnapshot);
      };

      const handleFileClickTrigger = () => {
        if (onFileClick) {
          onFileClick('test-file-key');
        }
      };

      return (
        <div data-testid="preview">
          Preview
          <button data-testid="trigger" onClick={handleClick} type="button">
            trigger
          </button>
          <button data-testid="file-click-trigger" onClick={handleFileClickTrigger} type="button">
            file-click
          </button>
        </div>
      );
    }
  );

  return {
    PreviewPanel: previewPanelMock,
  };
});

vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();

  return {
    ...actual,
    FileExplorerHeader: () => <div data-testid="header">Header</div>,
    FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(),
}));
vi.mock('../use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(),
}));
vi.mock('@brainstrike/hooks', () => ({
  useEventCallback: <TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult) =>
    callback,
  usePagination: vi.fn(() => ({
    currentPage: 0,
    totalPages: 1,
    startIndex: 0,
    endIndex: 50,
    goToPage: vi.fn(),
    goToNextPage: vi.fn(),
    goToPreviousPage: vi.fn(),
    resetToFirstPage: vi.fn(),
    isFirstPage: true,
    isLastPage: true,
  })),
  useReportGeneration: vi.fn(() => ({ generateContextWithContent: vi.fn() })),
  useReportManager: vi.fn(() => ({
    handleDownloadContext: vi.fn(),
    handleCopyContext: vi.fn(),
  })),
}));
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useIdeFileEditor: vi.fn(() => ({ openFileInTab: vi.fn() })),
    useUndoableAction: vi.fn(() => ({ performUndoableAction: vi.fn() })),
  };
});

import type { IFileNode } from '@brainstrike/types';
import { useIdeFileEditor, useUndoableAction } from '@brainstrike/ui';
import * as utilsModule from '@brainstrike/utils';
import * as textTokenCountModule from '../hooks/use-text-token-count';
import { useFileExplorer } from '../use-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';

let performUndoableActionMock: ReturnType<typeof vi.fn>;
let handleSelectionChangeMock: ReturnType<typeof vi.fn>;

describe('FileExplorerMiddlePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useFileExplorer).mockReturnValue({
      fileTree: [],
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      handleRootDirectorySelect: vi.fn(),
      isLoading: false,
      error: null,
      rootDirectoryHandle: {
        path: '/root',
        name: 'root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      refreshFileExplorer: vi.fn(),
      applyFileFilters: vi.fn().mockReturnValue([]),
      filterError: null,
      isInitialLoad: false,
      clearFileContents: vi.fn(),
      loadingProgress: null,
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
      clearRootDirectory: vi.fn(),
      loadingPaths: new Set<string>(),
      loadChildren: vi.fn(),
      refreshDirectory: vi.fn(),
      expandAllProgressively: vi.fn(),
      cancelExpandAll: vi.fn(),
      isExpandingAll: false,
      expandAllProgress: null,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
      cancelChildLoading: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
      canLoadWithoutTree: false,
      selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelRecursiveSelect: vi.fn(),
      isLoadingForSelection: false,
      loadingPathForSelection: null,
      selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelSelectAll: vi.fn(),
      isLoadingForSelectAll: false,
    });

    handleSelectionChangeMock = vi.fn();
    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>(['folder|@|test-file']),
      selectedFilesList: ['folder|@|test-file'],
      setSelectedFilesFromList: vi.fn(),
      handleSelectionChange: handleSelectionChangeMock,
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    performUndoableActionMock = vi.fn();

    vi.mocked(useUndoableAction).mockReturnValue({
      performUndoableAction: performUndoableActionMock,
      clearUndoTimeout: vi.fn(),
    } as unknown as ReturnType<typeof useUndoableAction>);
  });

  it('renders header and preview panel', async () => {
    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    expect(await screen.findByTestId('header')).toBeInTheDocument();
    expect(await screen.findByTestId('preview')).toBeInTheDocument();
  });

  it('calls selection change when interacting with the component', async () => {
    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    // The component should be rendered with the preview panel
    expect(await screen.findByTestId('preview')).toBeInTheDocument();

    // Verify that the mock was called with the correct props
    expect(previewPanelMock).toHaveBeenCalled();
    expect(handleSelectionChangeMock).toBeDefined();
    expect(performUndoableActionMock).toBeDefined();
  });

  it('calls performUndoableAction when preview panel triggers action', async () => {
    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    const trigger = await screen.findByTestId('trigger');
    act(() => {
      trigger.click();
    });

    expect(performUndoableActionMock).toHaveBeenCalled();
  });

  it('handles file click when openFileInTab is available', async () => {
    const openFileInTabMock = vi.fn();
    vi.mocked(useIdeFileEditor).mockReturnValue({
      openFileInTab: openFileInTabMock,
      registerOpenFileInTab: vi.fn(),
    });

    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    const fileClickTrigger = await screen.findByTestId('file-click-trigger');
    act(() => {
      fileClickTrigger.click();
    });

    expect(openFileInTabMock).toHaveBeenCalledWith('test-file-key');
  });

  it('handles file click when openFileInTab is not available', async () => {
    vi.mocked(useIdeFileEditor).mockReturnValue({
      openFileInTab: undefined,
      registerOpenFileInTab: vi.fn(),
    });

    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    const fileClickTrigger = await screen.findByTestId('file-click-trigger');
    act(() => {
      fileClickTrigger.click();
    });

    // Should not crash when openFileInTab is undefined
    expect(await screen.findByTestId('header')).toBeInTheDocument();
  });

  it('uses the unfiltered tree for the initial tree token count', async () => {
    const filteredTree: IFileNode[] = [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'main.ts',
            path: 'src/main.ts',
            type: 'file',
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
      },
    ];
    const unfilteredTree: IFileNode[] = [
      ...filteredTree,
      {
        name: 'docs',
        path: 'docs',
        type: 'directory',
        handle: {} as FileSystemDirectoryHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        children: [
          {
            name: 'readme.md',
            path: 'docs/readme.md',
            type: 'file',
            handle: {} as FileSystemFileHandle,
            depth: 1,
            selectionState: 'unchecked',
            rootFolderId: 'root',
          },
        ],
      },
    ];
    const fullTreeText = 'full-tree-text';
    const generateProjectTreeTextSpy = vi
      .spyOn(utilsModule, 'generateProjectTreeText')
      .mockReturnValue(fullTreeText);
    const useTextTokenCountSpy = vi
      .spyOn(textTokenCountModule, 'useTextTokenCount')
      .mockReturnValue({ tokenCount: 321, loading: false });

    vi.mocked(useFileExplorer).mockReturnValue({
      fileTree: filteredTree,
      unfilteredFileTree: unfilteredTree,
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      handleRootDirectorySelect: vi.fn(),
      isLoading: false,
      error: null,
      rootDirectoryHandle: {
        path: '/root',
        name: 'root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      refreshFileExplorer: vi.fn(),
      applyFileFilters: vi.fn().mockReturnValue([]),
      filterError: null,
      isInitialLoad: false,
      clearFileContents: vi.fn(),
      loadingProgress: null,
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
      clearRootDirectory: vi.fn(),
      loadingPaths: new Set<string>(),
      loadChildren: vi.fn(),
      refreshDirectory: vi.fn(),
      expandAllProgressively: vi.fn(),
      cancelExpandAll: vi.fn(),
      isExpandingAll: false,
      expandAllProgress: null,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
      cancelChildLoading: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
      canLoadWithoutTree: false,
      selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelRecursiveSelect: vi.fn(),
      isLoadingForSelection: false,
      loadingPathForSelection: null,
      selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelSelectAll: vi.fn(),
      isLoadingForSelectAll: false,
    });

    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    expect(await screen.findByTestId('preview')).toBeInTheDocument();
    expect(generateProjectTreeTextSpy).toHaveBeenCalledWith(
      unfilteredTree,
      [],
      [],
      false,
      expect.any(Number)
    );
    expect(useTextTokenCountSpy).toHaveBeenCalledWith({
      text: fullTreeText,
      enabled: true,
    });

    const lastCallProps = (
      previewPanelMock as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1)?.[0] as
      | {
          projectTreeTokenCount?: number;
          projectTreeUsesViewFilters?: boolean;
        }
      | undefined;

    expect(lastCallProps?.projectTreeTokenCount).toBe(321);
    expect(lastCallProps?.projectTreeUsesViewFilters).toBe(false);

    generateProjectTreeTextSpy.mockRestore();
    useTextTokenCountSpy.mockRestore();
  });

  it('passes fileSizes to preview panel based on file tree metadata', async () => {
    const compositeKey = 'root|@|test-file';
    const fileTree: IFileNode[] = [
      {
        name: 'test-file',
        path: 'test-file',
        type: 'file',
        handle: {} as FileSystemFileHandle,
        depth: 0,
        selectionState: 'unchecked',
        rootFolderId: 'root',
        size: 2048,
      },
    ];

    vi.mocked(useFileExplorer).mockReturnValue({
      fileTree,
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
      loadMultipleFileContents: vi.fn(),
      handleRootDirectorySelect: vi.fn(),
      isLoading: false,
      error: null,
      rootDirectoryHandle: {
        path: '/root',
        name: 'root',
        kind: 'directory',
        platform: 'web' as const,
        _internal: {} as FileSystemDirectoryHandle,
      },
      isFileSystemAccessSupported: vi.fn().mockReturnValue({ supported: true, reason: '' }),
      refreshFileExplorer: vi.fn(),
      applyFileFilters: vi.fn().mockReturnValue([]),
      filterError: null,
      isInitialLoad: false,
      clearFileContents: vi.fn(),
      loadingProgress: null,
      cancellable: false,
      cancelOperation: vi.fn(),
      isCancelling: false,
      clearRootDirectory: vi.fn(),
      loadingPaths: new Set<string>(),
      loadChildren: vi.fn(),
      refreshDirectory: vi.fn(),
      expandAllProgressively: vi.fn(),
      cancelExpandAll: vi.fn(),
      isExpandingAll: false,
      expandAllProgress: null,
      isRestoringExpandedPaths: false,
      restorationProgress: null,
      cancelChildLoading: vi.fn(),
      setRootDirectoryHandle: vi.fn(),
      setAccessLoading: vi.fn(),
      canLoadWithoutTree: false,
      selectFolderRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelRecursiveSelect: vi.fn(),
      isLoadingForSelection: false,
      loadingPathForSelection: null,
      selectAllRecursively: vi.fn().mockResolvedValue({ success: true, filePaths: [] }),
      cancelSelectAll: vi.fn(),
      isLoadingForSelectAll: false,
    });

    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>([compositeKey]),
      selectedFilesList: [compositeKey],
      setSelectedFilesFromList: vi.fn(),
      handleSelectionChange: handleSelectionChangeMock,
      wouldExceedSelectionLimit: vi.fn(),
    } as unknown as ReturnType<typeof useSelectionManager>);

    act(() => {
      renderWithProviders(<FileExplorerMiddlePanel />);
    });

    expect(await screen.findByTestId('preview')).toBeInTheDocument();

    expect(previewPanelMock).toHaveBeenCalled();
    const lastCallProps = (
      previewPanelMock as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1)?.[0] as { fileSizes?: Record<string, number> } | undefined;

    expect(lastCallProps?.fileSizes).toEqual({ [compositeKey]: 2048 });
  });
});
