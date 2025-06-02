import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerMiddlePanel } from '../file-explorer-middle-panel';
import { FileExplorerTestWrapper } from './test-helpers';

let previewSnapshot: Set<string>;
// biome-ignore lint/style/noVar: var required for hoisted mock assignment
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

vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();

  previewPanelMock = vi.fn(
    ({ onSelectionChange, performUndoableAction }: MockPreviewPanelProps) => {
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

      return (
        <div data-testid="preview">
          Preview
          <button type="button" data-testid="trigger" onClick={handleClick}>
            trigger
          </button>
        </div>
      );
    }
  );

  return {
    ...actual,
    FileExplorerHeader: () => <div data-testid="header">Header</div>,
    VirtualizedPreviewPanel: previewPanelMock,
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
  useUndoableAction: vi.fn(() => ({ performUndoableAction: vi.fn() })),
}));

import { useUndoableAction } from '@brainstrike/hooks';
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

    handleSelectionChangeMock = vi.fn();
    vi.mocked(useSelectionManager).mockReturnValue({
      selectedFilePaths: new Set<string>(),
      handleSelectionChange: handleSelectionChangeMock,
      wouldExceedSelectionLimit: vi.fn(),
    });

    performUndoableActionMock = vi.fn();

    vi.mocked(useUndoableAction).mockReturnValue({
      performUndoableAction: performUndoableActionMock,
      clearUndoTimeout: vi.fn(),
    });
  });

  it('renders header and preview panel', async () => {
    render(<FileExplorerMiddlePanel />, { wrapper: FileExplorerTestWrapper });

    expect(await screen.findByTestId('header')).toBeInTheDocument();
    expect(await screen.findByTestId('preview')).toBeInTheDocument();
  });

  it('triggers undoable action with correct snapshot and selection handler', async () => {
    render(<FileExplorerMiddlePanel />, { wrapper: FileExplorerTestWrapper });

    const trigger = await screen.findByTestId('trigger');
    await userEvent.click(trigger);

    expect(performUndoableActionMock).toHaveBeenCalledWith(
      'file',
      previewSnapshot,
      expect.objectContaining({
        actionName: 'removed',
        itemDescription: 'removed file',
      })
    );

    expect(handleSelectionChangeMock).toHaveBeenCalledWith(previewSnapshot);
  });
});
