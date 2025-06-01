import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerMiddlePanel } from '../file-explorer-middle-panel';
import { FileExplorerTestWrapper } from './test-helpers';

vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  return {
    ...actual,
    FileExplorerHeader: () => <div data-testid="header">Header</div>,
    PreviewPanel: () => <div data-testid="preview">Preview</div>,
    FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../unified-file-explorer-context', () => ({
  useUnifiedFileExplorer: vi.fn(),
}));
vi.mock('../use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(),
}));
vi.mock('@brainstrike/hooks', () => ({
  useUndoableAction: vi.fn(() => ({ performUndoableAction: vi.fn() })),
}));

import { useUnifiedFileExplorer } from '../unified-file-explorer-context';
import { useSelectionManager } from '../use-selection-manager-context';

describe('FileExplorerMiddlePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useUnifiedFileExplorer).mockReturnValue({
      fileTree: [],
      fileContents: {},
      loadingFiles: new Set<string>(),
      loadFileContent: vi.fn(),
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
    });

    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(),
    });
  });

  it('renders header and preview panel', async () => {
    render(<FileExplorerMiddlePanel />, { wrapper: FileExplorerTestWrapper });

    expect(await screen.findByTestId('header')).toBeInTheDocument();
    expect(await screen.findByTestId('preview')).toBeInTheDocument();
  });
});
