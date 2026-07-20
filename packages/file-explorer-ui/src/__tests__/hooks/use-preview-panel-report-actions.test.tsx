import type { DirectoryHandle } from '@brainstrike/file-system';
import { renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreviewPanelReportActions } from '../../preview/use-preview-panel-report-actions';
import type { useFileExplorerStoreContext } from '../../shell/file-explorer-provider';

type Store = ReturnType<typeof useFileExplorerStoreContext>;

const mockUseReportGeneration = vi.fn();
const mockUseReportManager = vi.fn();
const mockFileSystemAdapter = {};
const mockToast = vi.fn();
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ fileSystemAdapter: mockFileSystemAdapter }),
  useToastManager: () => ({ toast: mockToast }),
}));

vi.mock('@brainstrike/hooks', () => ({
  useEventCallback: <TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult) =>
    callback,
  useReportGeneration: (args: unknown) => mockUseReportGeneration(args),
  useReportManager: (args: unknown) => mockUseReportManager(args),
}));

const createWrapper = () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return Wrapper;
};

const createMockStore = (initialContents: Record<string, string>) => {
  let fileContents = initialContents;

  const store = ((_: unknown) => {}) as unknown as Store;
  (store as unknown as { getState: () => { fileContents: Record<string, string> } }).getState =
    () => ({ fileContents });

  return {
    setFileContents: (next: Record<string, string>) => {
      fileContents = next;
    },
    store,
  };
};

describe('usePreviewPanelReportActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const generateContextWithContent = vi.fn();
    mockUseReportGeneration.mockReturnValue({
      generateContextWithContent,
    });
    mockUseReportManager.mockReturnValue({
      handleCopyContext: vi.fn(),
      handleDownloadContext: vi.fn(),
    });
  });

  it('returns download/copy handlers that delegate to useReportManager', async () => {
    const generateContextWithContent = vi.fn(async () => 'report');
    const handleDownloadContext = vi.fn();
    const handleCopyContext = vi.fn();

    mockUseReportGeneration.mockReturnValue({
      generateContextWithContent,
    });
    mockUseReportManager.mockReturnValue({
      handleCopyContext,
      handleDownloadContext,
    });

    const { store } = createMockStore({});

    const { result } = renderHook(
      () =>
        usePreviewPanelReportActions({
          excludeFilters: [],
          fileContents: {},
          folderSummaryThreshold: 0,
          includeFilters: [],
          includeProjectTree: false,
          loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
          rootDirectoryHandle: null,
          selectedFiles: new Set(['file-a']),
          store,
          useRegex: false,
        }),
      { wrapper: createWrapper() }
    );

    await result.current.handleDownloadContext();
    await result.current.handleCopyContext();

    expect(handleDownloadContext).toHaveBeenCalledTimes(1);
    expect(handleCopyContext).toHaveBeenCalledTimes(1);
  });

  it('passes expected parameters to useReportGeneration and useReportManager', () => {
    const generateContextWithContent = vi.fn(async () => 'report');
    mockUseReportGeneration.mockReturnValue({
      generateContextWithContent,
    });

    const { store } = createMockStore({ fileA: 'content' });
    const loadMultipleFileContents = vi.fn().mockResolvedValue(undefined);

    renderHook(
      () =>
        usePreviewPanelReportActions({
          excludeFilters: ['exclude'],
          fileContents: { fileA: 'content' },
          folderSummaryThreshold: 42,
          includeFilters: ['include'],
          includeProjectTree: true,
          loadMultipleFileContents,
          rootDirectoryHandle: null,
          selectedFiles: new Set(['fileA', 'fileB']),
          store,
          useRegex: true,
        }),
      { wrapper: createWrapper() }
    );

    expect(mockUseReportGeneration).toHaveBeenCalledTimes(1);
    const reportGenerationArgs = mockUseReportGeneration.mock.calls[0]?.[0] as {
      selectedFiles: Set<string>;
      fileContents: Record<string, string>;
      rootDirectoryHandle: DirectoryHandle | FileSystemDirectoryHandle | undefined;
      fileSystemAdapter: unknown;
      includeFilters: string[];
      excludeFilters: string[];
      useRegex: boolean;
      includeProjectTree: boolean;
      projectTreeUsesViewFilters: boolean;
      folderSummaryThreshold: number;
      loadMissingContent?: (compositeKeys: string[]) => Promise<void>;
      getFileContents?: () => Record<string, string>;
    };

    expect(reportGenerationArgs.selectedFiles).toEqual(new Set(['fileA', 'fileB']));
    expect(reportGenerationArgs.fileContents).toEqual({ fileA: 'content' });
    expect(reportGenerationArgs.rootDirectoryHandle).toBeUndefined();
    expect(reportGenerationArgs.fileSystemAdapter).toBe(mockFileSystemAdapter);
    expect(reportGenerationArgs.includeFilters).toEqual(['include']);
    expect(reportGenerationArgs.excludeFilters).toEqual(['exclude']);
    expect(reportGenerationArgs.useRegex).toBe(true);
    expect(reportGenerationArgs.includeProjectTree).toBe(true);
    expect(reportGenerationArgs.projectTreeUsesViewFilters).toBe(false);
    expect(reportGenerationArgs.folderSummaryThreshold).toBe(42);
    expect(reportGenerationArgs.loadMissingContent).toBe(loadMultipleFileContents);
    expect(reportGenerationArgs.getFileContents).toEqual(expect.any(Function));

    expect(mockUseReportManager).toHaveBeenCalledTimes(1);
    const reportManagerArgs = mockUseReportManager.mock.calls[0]?.[0] as {
      rootDirectoryHandle: DirectoryHandle | FileSystemDirectoryHandle | null;
      generateContextWithContent: () => Promise<string>;
      toast: unknown;
    };

    expect(reportManagerArgs.rootDirectoryHandle).toBeNull();
    expect(reportManagerArgs.generateContextWithContent).toBe(generateContextWithContent);
    expect(reportManagerArgs.toast).toBe(mockToast);
  });

  it('memoizes getFileContents by store and returns fresh state', () => {
    const { store, setFileContents } = createMockStore({ fileA: 'initial' });

    const { rerender } = renderHook(
      (props: {
        store: Store;
        selectedFiles: Set<string>;
        fileContents: Record<string, string>;
        rootDirectoryHandle: DirectoryHandle | null;
        includeProjectTree: boolean;
      }) =>
        usePreviewPanelReportActions({
          excludeFilters: [],
          fileContents: props.fileContents,
          folderSummaryThreshold: 0,
          includeFilters: [],
          includeProjectTree: props.includeProjectTree,
          loadMultipleFileContents: vi.fn().mockResolvedValue(undefined),
          rootDirectoryHandle: props.rootDirectoryHandle,
          selectedFiles: props.selectedFiles,
          store: props.store,
          useRegex: false,
        }),
      {
        initialProps: {
          fileContents: { fileA: 'initial' },
          includeProjectTree: false,
          rootDirectoryHandle: null,
          selectedFiles: new Set(['fileA']),
          store,
        },
        wrapper: createWrapper(),
      }
    );

    const getFileContentsFirst = (
      mockUseReportGeneration.mock.calls[0]?.[0] as
        | {
            getFileContents?: () => Record<string, string>;
          }
        | undefined
    )?.getFileContents;
    expect(getFileContentsFirst).toEqual(expect.any(Function));

    setFileContents({ fileA: 'updated', fileB: 'new' });
    expect(getFileContentsFirst?.()).toEqual({ fileA: 'updated', fileB: 'new' });

    rerender({
      fileContents: { fileA: 'initial' },
      includeProjectTree: true,
      rootDirectoryHandle: null,
      selectedFiles: new Set(['fileA', 'fileB']),
      store,
    });

    const getFileContentsSecond = (
      mockUseReportGeneration.mock.calls[1]?.[0] as
        | {
            getFileContents?: () => Record<string, string>;
          }
        | undefined
    )?.getFileContents;

    expect(getFileContentsSecond).toBe(getFileContentsFirst);
  });
});
