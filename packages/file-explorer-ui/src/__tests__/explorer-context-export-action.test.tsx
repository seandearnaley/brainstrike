import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  copy: vi.fn(async () => ({ ok: true as const })),
  download: vi.fn(async () => ({ ok: true as boolean })),
  explorer: {
    excludeFilters: [] as string[],
    folderSummaryThreshold: 5,
    includeFilters: [] as string[],
    includeProjectTree: true,
    setFolderSummaryThreshold: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    useRegex: false,
  },
  exportInput: undefined as unknown,
  /** The focused root's own selection; in query mode it leaves out the other roots. */
  focused: new Set<string>(),
  /** The whole forest's selection: what the selection bar counts. */
  selected: new Set<string>(),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ storageAdapter: {} }),
}));
vi.mock('../utils/persist-file-explorer-state', () => ({
  persistFileExplorerStateImmediately: vi.fn(async () => undefined),
}));
vi.mock('../shell/file-explorer-provider', () => ({
  useFileExplorerStoreContext: () => ({ getState: () => ({}) }),
  useFileExplorerStoreSelector: <T,>(selector: (s: typeof state.explorer) => T): T =>
    selector(state.explorer),
}));
vi.mock('../shell/use-file-explorer-context', () => ({
  useFileExplorer: () => ({
    fileContents: {},
    loadMultipleFileContents: vi.fn(),
    rootDirectoryHandle: null,
  }),
}));
vi.mock('../shell/use-selection-manager-context', () => ({
  useSelectionManager: () => ({
    forestSelection: state.selected,
    selectedCount: state.selected.size,
    selectedFilePaths: state.focused,
  }),
}));
vi.mock('../shell/use-context-export-actions', () => ({
  useContextExportActions: (input: unknown) => {
    state.exportInput = input;
    return { handleCopyContext: state.copy, handleDownloadContext: state.download };
  },
}));

import { ExplorerContextExportAction } from '../shell/explorer-context-export-action';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';

beforeEach(() => {
  // Query mode on the focused root: its own set leaves out the other root's file.
  state.focused = new Set(['root|@|a.ts']);
  state.selected = new Set(['root|@|a.ts', 'other|@|b.ts']);
  state.copy.mockClear();
  state.download.mockClear();
  state.download.mockResolvedValue({ ok: true });
  state.explorer.includeProjectTree = true;
  state.explorer.setIncludeProjectTree.mockClear();
  vi.mocked(persistFileExplorerStateImmediately).mockClear();
});

describe('ExplorerContextExportAction', () => {
  it('is disabled without a selection', () => {
    state.selected = new Set();
    render(<ExplorerContextExportAction />);
    expect(screen.getByTestId('explorer-export-trigger')).toBeDisabled();
  });

  it("exports every root's selected files whole, and closes once the export succeeds", async () => {
    render(<ExplorerContextExportAction />);
    fireEvent.click(screen.getByTestId('explorer-export-trigger'));
    expect(screen.getByText('Export the contents of 2 files')).toBeInTheDocument();
    expect(state.exportInput).toMatchObject({
      includeProjectTree: true,
      selectedFiles: state.selected,
    });
    fireEvent.click(screen.getByTestId('explorer-export-download'));
    await waitFor(() =>
      expect(state.download).toHaveBeenCalledExactlyOnceWith({
        projectTreeUsesViewFilters: false,
        selectedLineRangesByFile: {},
      })
    );
    await waitFor(() => expect(screen.queryByTestId('explorer-export-download')).toBeNull());
  });

  it('stays open when an export fails, so it can be retried', async () => {
    state.download.mockResolvedValue({ ok: false });
    render(<ExplorerContextExportAction />);
    fireEvent.click(screen.getByTestId('explorer-export-trigger'));
    fireEvent.click(screen.getByTestId('explorer-export-download'));
    await waitFor(() => expect(state.download).toHaveBeenCalledOnce());
    expect(screen.getByTestId('explorer-export-download')).toBeEnabled();
  });

  it('carries the project-tree options, and persists the tree choice', () => {
    render(<ExplorerContextExportAction />);
    fireEvent.click(screen.getByTestId('explorer-export-trigger'));
    expect(screen.getByLabelText('Tree detail:')).toHaveValue(5);
    fireEvent.click(screen.getByTestId('explorer-export-include-tree'));
    expect(state.explorer.setIncludeProjectTree).toHaveBeenCalledWith(false);
    expect(persistFileExplorerStateImmediately).toHaveBeenCalledOnce();
  });
});
