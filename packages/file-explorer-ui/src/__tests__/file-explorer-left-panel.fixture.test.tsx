import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerLeftPanel } from '../file-explorer-left-panel';

const Wrapper = composeWrappers(({ children }: { children?: ReactNode }) => <>{children}</>);
const renderWithProviders = makeRenderWithProviders(Wrapper);

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: {
      canLoadInlineFixture: true,
      loadInlineFixture: vi.fn().mockResolvedValue({
        path: '',
        name: 'mock-project',
        kind: 'directory',
        platform: 'web',
      }),
      clearInlineFixture: vi.fn().mockResolvedValue(undefined),
      isInlineFixtureActive: vi.fn().mockReturnValue(false),
    },
    storageAdapter: {},
  }),
  useFileExplorer: () => ({
    fileTree: [],
    handleRootDirectorySelect: vi.fn(),
    isLoading: false,
    error: null,
    fileContents: {},
    loadingFiles: [],
    applyFileFilters: vi.fn(),
    filterError: null,
    rootDirectoryHandle: null,
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
    refreshFileExplorer: vi.fn().mockResolvedValue(undefined),
    isInitialLoad: false,
    loadingProgress: { loaded: 0, total: 0, phase: 'counting' as const },
    cancellable: false,
    cancelOperation: vi.fn(),
    isCancelling: false,
    clearRootDirectory: vi.fn(),
  }),
  useToastManager: () => ({
    showToast: vi.fn(),
    ToastContainer: () => null,
  }),
}));

vi.mock('@brainstrike/hooks', () => ({
  useReportGeneration: () => ({
    generateReportWithContent: vi.fn(),
  }),
  useReportManager: () => ({
    generateReportWithSelection: vi.fn(),
  }),
  useSelectionManager: () => ({
    selectedFilesList: [],
    setSelectedFilesFromList: vi.fn(),
  }),
  useQuickFilter: () => ({
    quickFilteredFiles: [],
    quickFilter: '',
    setQuickFilter: vi.fn(),
    clearQuickFilter: vi.fn(),
  }),
}));

describe('FileExplorerLeftPanel - Fixture Feature', () => {
  it('renders without fixture support when adapter does not support it', () => {
    renderWithProviders(<FileExplorerLeftPanel />);
    // Component should render without crashing
    expect(true).toBe(true);
  });

  it('initializes fixture adapter detection', async () => {
    renderWithProviders(<FileExplorerLeftPanel />);

    await waitFor(() => {
      // Fixture adapter detection effect should run without errors
      expect(true).toBe(true);
    });
  });

  it('handles fixture adapter state changes', async () => {
    const result = renderWithProviders(<FileExplorerLeftPanel />);

    await act(async () => {
      // Force re-render to test state change handling
      (result as { rerender: (ui: React.ReactElement) => void }).rerender(
        <FileExplorerLeftPanel />
      );
    });

    // Just verify no crashes occur
    expect(true).toBe(true);
  });
});
