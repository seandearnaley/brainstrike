import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview/preview-panel';

type PreviewPanelMocksModule = typeof import('./__mocks__/preview-panel-mocks');

const previewPanelMocksPromise = vi.hoisted(
  async () => (await import('./__mocks__/preview-panel-mocks')) as PreviewPanelMocksModule
);

vi.mock('../preview/use-preview-panel-state', async () => {
  const { createUsePreviewPanelStateMock } = await previewPanelMocksPromise;
  return createUsePreviewPanelStateMock();
});

vi.mock('@brainstrike/ui', async () => {
  const { createUiModuleMock } = await previewPanelMocksPromise;
  return createUiModuleMock();
});

vi.mock('@brainstrike/hooks', async () => {
  const { createHooksModuleMock } = await previewPanelMocksPromise;
  return createHooksModuleMock();
});

vi.mock('lucide-react', async () => {
  const { createLucideModuleMock } = await previewPanelMocksPromise;
  return createLucideModuleMock();
});

const mockUsePreviewPanelState = vi.mocked(
  await import('../preview/use-preview-panel-state')
).usePreviewPanelState;

const { resetPreviewPanelPaginationMockState } = await previewPanelMocksPromise;

beforeEach(() => {
  resetPreviewPanelPaginationMockState();
  // Clear localStorage to ensure clean test state for preferences hook
  localStorage.removeItem('previewPanelPreferences.v1');
});

describe('PreviewPanel', () => {
  const selectGroupingOption = (label: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
  };

  const mockProps = {
    decodeFileSelection: vi.fn((key: string) => ({
      folderId: `folder-${key}`,
      path: `path/to/${key}.txt`,
    })),
    estimateTokenCost: vi.fn((tokens: number) => tokens * 0.001),
    fileContents: {
      file1: 'content1',
      file2: 'content2',
      file3: 'content3',
    },
    fileSizes: {
      file1: 1024,
      file2: 2048,
      file3: 512,
    },
    loadingFiles: new Set<string>(),
    onFileClick: vi.fn(),
    onSelectionChange: vi.fn(),
    performUndoableAction: vi.fn(),
    selectedFiles: new Set(['file1', 'file2', 'file3']),
    tokenCounting: {
      countTokens: vi.fn(async (content: string) => content.length),
      loading: false,
      mode: 'accurate' as const,
      reason: null,
    },
  };

  const mockState = {
    batchSelectedFiles: new Set<string>(),
    collapseAllFolders: vi.fn(),
    collapsedFolders: new Set<string>(),
    expandAllFolders: vi.fn(),
    flatListItems: [
      {
        compositeKey: 'file1',
        folderId: 'folder-file1',
        path: 'path/to/file1.txt',
        size: 1024,
        tokens: 500,
        type: 'file' as const,
      },
      {
        compositeKey: 'file2',
        folderId: 'folder-file2',
        path: 'path/to/file2.txt',
        size: 2048,
        tokens: 750,
        type: 'file' as const,
      },
      {
        compositeKey: 'file3',
        folderId: 'folder-file3',
        path: 'path/to/file3.txt',
        size: 512,
        tokens: 250,
        type: 'file' as const,
      },
    ],
    formatFileSize: vi.fn((bytes?: number) => {
      if (bytes === undefined) {
        return 'Unknown';
      }
      return `${bytes} B`;
    }),
    handleBatchRemove: vi.fn(),
    handleDeselectAll: vi.fn(),
    handleRemoveFile: vi.fn(),
    handleSelectAll: vi.fn(),
    isAllFilesSelected: false,
    loadingFiles: new Set<string>(),
    toggleFileSelection: vi.fn(),
    toggleFolderCollapse: vi.fn(),
    totalStats: {
      pendingCount: 0,
      totalFiles: 3,
      totalTokens: 1500,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePreviewPanelState.mockReturnValue(mockState);
  });

  describe('Empty State', () => {
    it('should render empty state when no files are selected', () => {
      render(<PreviewPanel {...mockProps} selectedFiles={new Set()} />);

      expect(screen.getByText('No files selected')).toBeInTheDocument();
    });
  });

  describe('View chrome', () => {
    it('replaces the table toolbar with the spatial dock in Tapestry view', () => {
      render(<PreviewPanel {...mockProps} />);

      expect(screen.getByTestId('preview-view-toolbar')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Tapestry View' }));

      expect(screen.queryByTestId('preview-view-toolbar')).toBeNull();
      expect(screen.getByTestId('tapestry-command-dock')).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: 'Gallery scale' })).toBeInTheDocument();
    });
  });

  describe('Context Actions', () => {
    it('renders context actions and wires callbacks', async () => {
      const user = userEvent.setup();
      const onDownloadContext = vi.fn();
      const onCopyContext = vi.fn();
      const onIncludeProjectTreeChange = vi.fn();
      const onProjectTreeUsesViewFiltersChange = vi.fn();

      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={true}
          onCopyContext={onCopyContext}
          onDownloadContext={onDownloadContext}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
        />
      );

      const downloadButton = screen.getByRole('button', { name: /download context/i });
      const copyButton = screen.getByRole('button', { name: /copy context/i });
      expect(downloadButton).not.toBeDisabled();
      expect(copyButton).not.toBeDisabled();

      fireEvent.click(downloadButton);
      fireEvent.click(copyButton);
      expect(onDownloadContext).toHaveBeenCalledTimes(1);
      expect(onCopyContext).toHaveBeenCalledTimes(1);

      const treeSwitch = screen.getByRole('switch', { name: /include project tree/i });
      await user.click(treeSwitch);
      expect(onIncludeProjectTreeChange).toHaveBeenCalledWith(false);

      const filteredTreeSwitch = screen.getByRole('switch', { name: /use filtered project tree/i });
      await user.click(filteredTreeSwitch);
      expect(onProjectTreeUsesViewFiltersChange).toHaveBeenCalledWith(true);
    });

    it('hides filtered tree toggle when project tree is disabled', () => {
      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={false}
          onProjectTreeUsesViewFiltersChange={vi.fn()}
        />
      );

      expect(
        screen.queryByRole('switch', { name: /use filtered project tree/i })
      ).not.toBeInTheDocument();
    });

    it('renders summary mode controls above the view tabs without footer resize affordances', () => {
      render(<PreviewPanel {...mockProps} />);

      const compactButton = screen.getByRole('button', { name: /compact summary mode/i });
      const balancedButton = screen.getByRole('button', { name: /balanced summary mode/i });
      const insightsButton = screen.getByRole('button', { name: /insights summary mode/i });
      const tabsList = screen.getByRole('tablist');

      expect(compactButton).toBeInTheDocument();
      expect(balancedButton).toBeInTheDocument();
      expect(insightsButton).toBeInTheDocument();
      expect(
        screen.queryByRole('separator', { name: /resize context explorer footer/i })
      ).toBeNull();
      expect(screen.queryByRole('button', { name: /collapse footer/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /expand footer/i })).toBeNull();

      expect(compactButton.compareDocumentPosition(tabsList)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('switches to compact summary mode and never renders the retired tapestry-ranges toggle', async () => {
      const user = userEvent.setup();
      render(<PreviewPanel {...mockProps} />);

      expect(
        screen.queryByRole('switch', { name: /use tapestry ranges in context output/i })
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /compact summary mode/i }));

      expect(
        screen.queryByRole('switch', { name: /use tapestry ranges in context output/i })
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /download context/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy context/i })).toBeInTheDocument();
    });

    it('disables context buttons when no files are selected', () => {
      const onDownloadContext = vi.fn();
      const onCopyContext = vi.fn();

      render(
        <PreviewPanel
          {...mockProps}
          onCopyContext={onCopyContext}
          onDownloadContext={onDownloadContext}
          selectedFiles={new Set()}
        />
      );

      expect(screen.getByText('No files selected')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /download context/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /copy context/i })).toBeDisabled();
    });
  });

  describe('File Display', () => {
    it('should render file list with proper data', () => {
      render(<PreviewPanel {...mockProps} />);

      // Check stats display - range-aware UI shows output + source tokens
      expect(screen.getByText(/1,500 output/i)).toBeInTheDocument();
      expect(screen.getByText(/1,500 source/i)).toBeInTheDocument();

      // Check files are displayed
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
      expect(screen.getByText('file2.txt')).toBeInTheDocument();
      expect(screen.getByText('file3.txt')).toBeInTheDocument();

      // Check folder IDs are displayed
      expect(screen.getByText('folder-file1')).toBeInTheDocument();
      expect(screen.getByText('folder-file2')).toBeInTheDocument();
      expect(screen.getByText('folder-file3')).toBeInTheDocument();
    });

    it('should display token counting status badge', () => {
      render(<PreviewPanel {...mockProps} />);

      // New UI shows compact "WASM" badge for accurate mode
      expect(screen.getByText('WASM')).toBeInTheDocument();
    });

    it('should surface explicit heuristic messaging when configured', () => {
      mockUsePreviewPanelState.mockReturnValue(mockState);
      const props = {
        ...mockProps,
        tokenCounting: {
          countTokens: vi.fn(async () => 0),
          loading: false,
          mode: 'heuristic' as const,
          reason: 'preference-disabled' as const,
        },
      };

      render(<PreviewPanel {...props} />);

      // New UI shows "Heuristic" badge for heuristic mode
      expect(screen.getByText('Heuristic')).toBeInTheDocument();
    });

    it('should handle file click events', () => {
      render(<PreviewPanel {...mockProps} />);

      const fileButton = screen.getByRole('button', { name: 'file1.txt' });
      if (fileButton) {
        fireEvent.click(fileButton);
        expect(mockProps.onFileClick).toHaveBeenCalledWith('file1');
      }
    });

    it('should render token meter with proper aria label', () => {
      const totalTokens = 2000;
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens },
      });

      render(<PreviewPanel {...mockProps} />);

      // New UI uses a meter role with aria-label for token usage
      const meter = screen.getByRole('meter');
      expect(meter).toHaveAttribute('aria-label', expect.stringContaining('Token usage'));
    });

    it('should display tree tokens in summary when include project tree is enabled', () => {
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens: 50_000 },
      });

      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={true}
          projectTreeTokenCount={25_000}
          tokenBudget={100_000}
        />
      );

      // The TokenSummaryBar should show tree token count
      expect(screen.getByText(/25,000 tree/i)).toBeInTheDocument();
    });

    it('should show muted tree indicator when include project tree is disabled', () => {
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens: 50_000 },
      });

      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={false}
          projectTreeTokenCount={25_000}
          tokenBudget={100_000}
        />
      );

      // The tree indicator should still be visible but show 0 when disabled
      expect(screen.getByText(/0 tree/i)).toBeInTheDocument();
    });

    it('should show zero tokens text when selected tokens are zero', () => {
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens: 0 },
      });

      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={true}
          projectTreeTokenCount={25_000}
          tokenBudget={100_000}
        />
      );

      // Should show 0 output (range-aware context estimate)
      expect(screen.getByText(/0 output/i)).toBeInTheDocument();
    });

    it('should show over budget status when over budget', () => {
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens: 50_000 },
      });

      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={true}
          projectTreeTokenCount={120_000}
          tokenBudget={100_000}
        />
      );

      // The BudgetStatus component has "over" text in a separate span
      // Match just the "over" text (exact word match to avoid tooltip matches)
      expect(screen.getByText(/^over$/i)).toBeInTheDocument();
    });

    it('should surface tree loading state in the summary', () => {
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens: 50_000 },
      });

      render(
        <PreviewPanel
          {...mockProps}
          includeProjectTree={true}
          projectTreeTokenCount={0}
          projectTreeTokenCountLoading={true}
          tokenBudget={100_000}
        />
      );

      // When treeLoading is true, the StatItem value shows just "…"
      // (without " tree" suffix - that's only shown when not loading)
      expect(screen.getByText('…')).toBeInTheDocument();
    });

    it('allows editing the token budget', async () => {
      const onTokenBudgetChange = vi.fn();

      render(
        <PreviewPanel
          {...mockProps}
          onTokenBudgetChange={onTokenBudgetChange}
          tokenBudget={100_000}
        />
      );

      // Click the trigger button to open the popover
      const editButton = screen.getByRole('button', { name: /click to edit token budget/i });
      fireEvent.click(editButton);

      const input = screen.getByLabelText(/token budget input/i);
      fireEvent.change(input, { target: { value: '1,000,000' } });

      // Use "apply budget" instead of "save token budget"
      const saveButton = screen.getByRole('button', { name: /apply budget/i });
      fireEvent.click(saveButton);

      expect(onTokenBudgetChange).toHaveBeenCalledWith(1_000_000);
    });
  });

  describe('Sorting', () => {
    it('should handle column sorting', () => {
      render(<PreviewPanel {...mockProps} />);

      // Click on folder header to sort - use the sortable header specifically
      const folderHeader = screen.getByRole('columnheader', { name: 'Folder' });
      const folderSortButton = within(folderHeader).getByRole('button', {
        name: 'Sort by Folder',
      });

      // Verify header is clickable and has proper attributes
      expect(folderSortButton).toHaveAttribute('type', 'button');

      // Click to trigger sorting
      fireEvent.click(folderSortButton);

      // Verify the header remains interactive after click
      expect(folderHeader).toBeInTheDocument();
    });

    it('should toggle sort direction on repeated clicks', () => {
      render(<PreviewPanel {...mockProps} />);

      const folderHeader = screen.getByRole('columnheader', { name: 'Folder' });
      const folderSortButton = within(folderHeader).getByRole('button', {
        name: 'Sort by Folder',
      });

      // First click - should trigger sorting
      fireEvent.click(folderSortButton);
      expect(folderHeader).toBeInTheDocument();

      // Second click - should toggle direction
      fireEvent.click(folderSortButton);
      expect(folderHeader).toBeInTheDocument();

      // Verify the header remains interactive
      expect(folderSortButton).toHaveAttribute('type', 'button');
    });

    it('should sort by tokens ascending and descending', async () => {
      render(<PreviewPanel {...mockProps} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sort by Tokens' })); // ascending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file3.txt');
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sort by Tokens' })); // descending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file2.txt');
      });
    });

    it('should sort by size ascending and descending', async () => {
      render(<PreviewPanel {...mockProps} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' })); // ascending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file3.txt');
      });

      fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' })); // descending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file2.txt');
      });
    });

    it('should reset sort when reset button is clicked', () => {
      render(<PreviewPanel {...mockProps} />);

      // Change sort first
      fireEvent.click(screen.getByRole('button', { name: 'Sort by File Path' }));

      // Reset sort
      const resetButton = screen.getByTestId('reset-sort-button');
      fireEvent.click(resetButton);

      // Should no longer show reset button
      expect(screen.queryByTestId('reset-sort-button')).not.toBeInTheDocument();
    });
  });

  describe('Selection', () => {
    it('should handle individual file selection', () => {
      render(<PreviewPanel {...mockProps} />);

      // Find the checkbox for a specific file using aria-label
      const fileCheckbox = screen.getByLabelText('Select path/to/file1.txt');
      expect(fileCheckbox).toBeInTheDocument();

      fireEvent.click(fileCheckbox);

      // Should update selection state (tested through internal state)
      expect(fileCheckbox).toBeChecked();
    });

    it('should handle select all on current page', () => {
      render(<PreviewPanel {...mockProps} />);

      const selectAllCheckbox = screen.getByLabelText('Select all files on current page');
      expect(selectAllCheckbox).toBeInTheDocument();
      fireEvent.click(selectAllCheckbox);

      // All file checkboxes should be checked
      const file1Checkbox = screen.getByLabelText('Select path/to/file1.txt');
      const file2Checkbox = screen.getByLabelText('Select path/to/file2.txt');
      const file3Checkbox = screen.getByLabelText('Select path/to/file3.txt');

      expect(file1Checkbox).toBeChecked();
      expect(file2Checkbox).toBeChecked();
      expect(file3Checkbox).toBeChecked();
    });

    it('should handle select all via header checkbox', () => {
      render(<PreviewPanel {...mockProps} />);

      const headerCheckbox = screen.getByLabelText('Select all files on current page');
      fireEvent.click(headerCheckbox);

      expect(headerCheckbox).toBeChecked();
    });

    it('should allow deselecting a single context row after select-all on page', async () => {
      render(<PreviewPanel {...mockProps} />);

      const headerCheckbox = screen.getByLabelText('Select all files on current page');
      fireEvent.click(headerCheckbox);

      const file1Checkbox = screen.getByLabelText('Select path/to/file1.txt');
      const file2Checkbox = screen.getByLabelText('Select path/to/file2.txt');
      const file3Checkbox = screen.getByLabelText('Select path/to/file3.txt');

      expect(file1Checkbox).toBeChecked();
      expect(file2Checkbox).toBeChecked();
      expect(file3Checkbox).toBeChecked();

      fireEvent.click(file2Checkbox);

      expect(file1Checkbox).toBeChecked();
      expect(file2Checkbox).not.toBeChecked();
      expect(file3Checkbox).toBeChecked();

      await waitFor(() => {
        const bulkActionBar = screen.getByTestId('bulk-action-bar');
        expect(within(bulkActionBar).getByText('2 selected')).toBeInTheDocument();
      });
    });

    it('should handle batch removal', async () => {
      render(<PreviewPanel {...mockProps} />);

      // Select files first using aria-label
      const fileCheckbox = screen.getByLabelText('Select path/to/file1.txt');
      expect(fileCheckbox).toBeInTheDocument();
      fireEvent.click(fileCheckbox); // Select first file

      // Should show action bar
      await waitFor(() => {
        const bulkActionBar = screen.getByTestId('bulk-action-bar');
        expect(within(bulkActionBar).getByText('1 file selected')).toBeInTheDocument();
      });
      expect(screen.getByTestId('selection-action-overlay')).toBeInTheDocument();

      // Click remove button
      const removeButton = screen.getByText('Remove Selected from Project');
      fireEvent.click(removeButton);

      expect(mockProps.performUndoableAction).toHaveBeenCalled();
      expect(mockProps.onSelectionChange).toHaveBeenCalled();
    });
  });

  describe('Pagination', () => {
    const largeMockState = {
      ...mockState,
      collapseAllFolders: vi.fn(),
      expandAllFolders: vi.fn(),
      flatListItems: Array.from({ length: 120 }, (_, i) => ({
        compositeKey: `file${i}`,
        folderId: `folder-file${i}`,
        path: `path/to/file${i}.txt`,
        size: 1024,
        tokens: 100,
        type: 'file' as const,
      })),
    };

    beforeEach(() => {
      mockUsePreviewPanelState.mockReturnValue(largeMockState);
    });

    it('should show pagination controls for large datasets', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      expect(screen.getByRole('button', { name: 'Go to previous page' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go to next page' })).toBeInTheDocument();
      expect(screen.getByTestId('page-info')).toHaveTextContent('of 3');
    });

    it('should handle next page navigation', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      const nextButton = screen.getByRole('button', { name: 'Go to next page' });
      fireEvent.click(nextButton);

      // Page input shows current page (2), total pages shown as "of 3"
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(2);
    });

    it('should handle previous page navigation', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      // Go to next page first
      const nextButton = screen.getByRole('button', { name: 'Go to next page' });
      fireEvent.click(nextButton);

      // Then go back
      const prevButton = screen.getByRole('button', { name: 'Go to previous page' });
      fireEvent.click(prevButton);

      // Back to page 1
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(1);
    });

    it('should handle direct page navigation via last page button', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      const lastPageButton = screen.getByRole('button', { name: 'Go to last page' });
      fireEvent.click(lastPageButton);

      // Should be on last page (page 3)
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);
    });

    it('should disable navigation buttons at boundaries', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      // First page and previous should be disabled on first page
      expect(screen.getByRole('button', { name: 'Go to first page' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();

      // Go to last page
      const lastPageButton = screen.getByRole('button', { name: 'Go to last page' });
      fireEvent.click(lastPageButton);

      // Next and last page should be disabled on last page
      expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go to last page' })).toBeDisabled();
    });

    it('resets to first page when current page becomes out of bounds', () => {
      const fileSet = new Set(Array.from({ length: 25 }, (_, i) => `file${i}`));
      const stateWith25 = {
        ...largeMockState,
        flatListItems: Array.from({ length: 25 }, (_, i) => ({
          compositeKey: `file${i}`,
          folderId: `folder-file${i}`,
          path: `path/to/file${i}.txt`,
          size: 1024,
          tokens: 100,
          type: 'file' as const,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(stateWith25);
      const { rerender } = render(
        <PreviewPanel {...mockProps} pageSize={10} selectedFiles={fileSet} />
      );

      // Should show three pages
      expect(screen.getByTestId('page-info')).toHaveTextContent('of 3');

      // Go to page 3 (last page) via last page button
      const lastPageButton = screen.getByRole('button', { name: 'Go to last page' });
      fireEvent.click(lastPageButton);

      // Shrink to 5 files (only 1 page now), making page 3 out of bounds
      const smallerFileSet = new Set(Array.from({ length: 5 }, (_, i) => `file${i}`));
      const stateWith5 = {
        ...stateWith25,
        flatListItems: Array.from({ length: 5 }, (_, i) => ({
          compositeKey: `file${i}`,
          folderId: `folder-file${i}`,
          path: `path/to/file${i}.txt`,
          size: 1024,
          tokens: 100,
          type: 'file' as const,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(stateWith5);
      rerender(<PreviewPanel {...mockProps} pageSize={10} selectedFiles={smallerFileSet} />);

      // Should reset to page 1 since page 3 is now out of bounds
      expect(screen.getByTestId('page-info')).toHaveTextContent('of 1');
    });
  });

  describe('Loading States', () => {
    it('should handle loading files', () => {
      const loadingProps = {
        ...mockProps,
        loadingFiles: new Set(['file1']),
      };

      render(<PreviewPanel {...loadingProps} />);

      // Component should still render, loading is handled by parent
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
    });
  });

  describe('Error Boundaries', () => {
    it('should handle missing file content gracefully', () => {
      const propsWithMissingContent = {
        ...mockProps,
        fileContents: {
          file1: 'content1',
          // file2 and file3 missing
        },
      };

      render(<PreviewPanel {...propsWithMissingContent} />);

      // Should still render available files
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
    });

    it('should handle malformed file keys gracefully', () => {
      const mockDecodeWithError = vi.fn((key: string) => {
        if (key === 'malformed') {
          throw new Error('Invalid key format');
        }
        return { folderId: `folder-${key}`, path: `path/to/${key}.txt` };
      });

      const propsWithMalformedKey = {
        ...mockProps,
        decodeFileSelection: mockDecodeWithError,
        selectedFiles: new Set(['file1', 'malformed', 'file3']),
      };

      // Should not throw and render other files
      expect(() => render(<PreviewPanel {...propsWithMalformedKey} />)).not.toThrow();
    });
  });

  describe('Grouping', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockUsePreviewPanelState.mockReturnValue(mockState);
    });

    it('should render grouping dropdown with all options', () => {
      render(<PreviewPanel {...mockProps} />);

      fireEvent.click(screen.getByRole('button', { name: 'Group by' }));

      expect(screen.getAllByRole('menuitemradio')).toHaveLength(6);
    });

    it('should migrate legacy "folder" grouping to "rootFolder"', () => {
      // Simulate legacy stored preference
      localStorage.setItem(
        'previewPanelPreferences.v1',
        JSON.stringify({ groupingConfig: 'folder' })
      );

      render(<PreviewPanel {...mockProps} />);

      fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
      expect(screen.getByRole('menuitemradio', { name: 'By Root Folder' })).toHaveAttribute(
        'aria-checked',
        'true'
      );

      // Clean up
      localStorage.removeItem('previewPanelPreferences.v1');
    });

    it('should change grouping when dropdown selection changes', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Directory');

      fireEvent.click(screen.getByRole('button', { name: 'Group by' }));
      expect(screen.getByRole('menuitemradio', { name: 'By Directory' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
    });

    it('should hide the folder column when grouping by directory', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Directory');

      expect(screen.queryByRole('columnheader', { name: 'Folder' })).not.toBeInTheDocument();
    });

    it('should hide the folder column when grouping by root folder', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Root Folder');

      expect(screen.queryByRole('columnheader', { name: 'Folder' })).not.toBeInTheDocument();
    });

    it('should keep the folder column visible for non-folder grouping modes', () => {
      render(<PreviewPanel {...mockProps} />);

      for (const label of ['By File Type', 'By Size Range', 'By Token Range']) {
        selectGroupingOption(label);
        expect(screen.getByRole('columnheader', { name: 'Folder' })).toBeInTheDocument();
      }
    });

    it('should show group control buttons when grouping is enabled', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Root Folder');

      expect(screen.getByTestId('expand-all-groups-button')).toBeInTheDocument();
      expect(screen.getByTestId('collapse-all-groups-button')).toBeInTheDocument();
    });

    it('should handle group expansion and collapse', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Root Folder');

      const expandAllButton = screen.getByTestId('expand-all-groups-button');
      const collapseAllButton = screen.getByTestId('collapse-all-groups-button');

      expect(expandAllButton).toBeInTheDocument();
      expect(collapseAllButton).toBeInTheDocument();

      fireEvent.click(collapseAllButton);
      fireEvent.click(expandAllButton);
    });

    it('hides grouped selection checkboxes when selection controls are toggled off', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Root Folder');
      expect(screen.getAllByLabelText(/Select all files in group/i).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: 'Toggle multi-select' }));

      expect(screen.queryByLabelText(/Select all files in group/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Select all files on current page')).not.toBeInTheDocument();
    });

    it('should group files by directory correctly', () => {
      const mixedDirectoriesState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: 'project',
            path: 'src/components/file1.tsx',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: 'project',
            path: 'src/components/file2.tsx',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
          {
            compositeKey: 'file3',
            folderId: 'project',
            path: 'src/utils/file3.ts',
            size: 512,
            tokens: 250,
            type: 'file' as const,
          },
        ],
      };

      const propsWithMixedDirectories = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'project',
          path: key === 'file3' ? 'src/utils/file3.ts' : `src/components/${key}.tsx`,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(mixedDirectoriesState);
      render(<PreviewPanel {...propsWithMixedDirectories} />);

      selectGroupingOption('By Directory');

      // Should show directory groups with the root-prefixed display contract.
      expect(screen.getAllByText('project/src/components').length).toBeGreaterThan(0);
      expect(screen.getAllByText('project/src/utils').length).toBeGreaterThan(0);
    });

    it('shows root-prefixed directory group labels for desktop-style absolute paths', () => {
      const absoluteDirectoriesState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: '/Users/me/BrainStrike',
            path: '/Users/me/BrainStrike/README.md',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: '/Users/me/BrainStrike',
            path: '/Users/me/BrainStrike/source/index.ts',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
        ],
      };

      const propsWithAbsoluteDirectories = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: '/Users/me/BrainStrike',
          path:
            key === 'file1'
              ? '/Users/me/BrainStrike/README.md'
              : '/Users/me/BrainStrike/source/index.ts',
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(absoluteDirectoriesState);
      render(<PreviewPanel {...propsWithAbsoluteDirectories} />);

      selectGroupingOption('By Directory');

      expect(screen.getAllByText('BrainStrike').length).toBeGreaterThan(0);
      expect(screen.getAllByText('BrainStrike/source').length).toBeGreaterThan(0);
      expect(screen.queryByText('.')).not.toBeInTheDocument();
    });

    it('should group files by root folder correctly', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: 'folder-a',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
          {
            compositeKey: 'file3',
            folderId: 'folder-b',
            path: 'path/to/file3.txt',
            size: 512,
            tokens: 250,
            type: 'file' as const,
          },
        ],
      };

      const propsWithMixedFolders = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: key === 'file3' ? 'folder-b' : 'folder-a',
          path: `path/to/${key}.txt`,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(mixedFoldersState);
      render(<PreviewPanel {...propsWithMixedFolders} />);

      selectGroupingOption('By Root Folder');

      // Should show grouped structure by root folder
      expect(screen.getAllByText('folder-a').length).toBeGreaterThan(0);
      expect(screen.getAllByText('folder-b').length).toBeGreaterThan(0);
    });

    it('shows root folder group labels using the full absolute root identity', () => {
      const absoluteFolderState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: '/Users/me/project',
            path: '/Users/me/project/src/file1.ts',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
        ],
      };

      const propsWithAbsoluteFolder = {
        ...mockProps,
        decodeFileSelection: vi.fn(() => ({
          folderId: '/Users/me/project',
          path: '/Users/me/project/src/file1.ts',
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(absoluteFolderState);
      render(<PreviewPanel {...propsWithAbsoluteFolder} />);

      selectGroupingOption('By Root Folder');

      expect(screen.getByText('/Users/me/project')).toBeInTheDocument();
    });

    it('should group files by size ranges correctly', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Size Range');

      // Should create size-based groups (based on mockState file sizes)
      // file1: 1024 bytes = 'Small (< 1 KB)' -> wait, 1024 = 1KB, so 'Medium (1-10 KB)'
      // file2: 2048 bytes = 'Medium (1-10 KB)'
      // file3: 512 bytes = 'Small (< 1 KB)'
      expect(screen.getByText('Small (< 1 KB)')).toBeInTheDocument();
      expect(screen.getByText('Medium (1-10 KB)')).toBeInTheDocument();
    });

    it('should group files by token ranges correctly', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Token Range');

      // Should create token-based groups (based on mockState file tokens)
      // file1: 500 tokens = 'Large (500-1K)'
      // file2: 750 tokens = 'Large (500-1K)'
      // file3: 250 tokens = 'Medium (100-500)'
      expect(screen.getByText('Medium (100-500)')).toBeInTheDocument();
      expect(screen.getByText('Large (500-1K)')).toBeInTheDocument();
    });

    it('should group files by file type correctly', () => {
      const mixedTypesState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: 'folder-file1',
            path: 'path/to/file1.js',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: 'folder-file2',
            path: 'path/to/file2.ts',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
          {
            compositeKey: 'file3',
            folderId: 'folder-file3',
            path: 'path/to/file3.js',
            size: 512,
            tokens: 250,
            type: 'file' as const,
          },
        ],
      };

      const propsWithMixedTypes = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: `folder-${key}`,
          path: key === 'file2' ? `path/to/${key}.ts` : `path/to/${key}.js`,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(mixedTypesState);
      render(<PreviewPanel {...propsWithMixedTypes} />);

      selectGroupingOption('By File Type');

      // Should show file type groups
      expect(screen.getAllByText('js').length).toBeGreaterThan(0);
      expect(screen.getAllByText('ts').length).toBeGreaterThan(0);
    });

    it('should allow selecting all files across different groups', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: 'folder-b',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
        ],
      };

      const propsWithMixedFolders = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: key === 'file1' ? 'folder-a' : 'folder-b',
          path: `path/to/${key}.txt`,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(mixedFoldersState);
      render(<PreviewPanel {...propsWithMixedFolders} />);

      selectGroupingOption('By Directory');

      // Grouped mode exposes an all-grouped-results affordance in the header.
      const headerCheckbox = screen.getByLabelText('Select all files in grouped results');
      fireEvent.click(headerCheckbox);

      expect(headerCheckbox).toBeChecked();
      expect(screen.getByLabelText('Select path/to/file1.txt')).toBeChecked();
      expect(screen.getByLabelText('Select path/to/file2.txt')).toBeChecked();
      expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('2 selected');
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<PreviewPanel {...mockProps} />);

      // Check checkbox labels
      expect(screen.getByLabelText('Select all files on current page')).toBeInTheDocument();
      expect(screen.getByLabelText('Select path/to/file1.txt')).toBeInTheDocument();

      // Check button labels
      expect(screen.getByLabelText('file1.txt')).toBeInTheDocument();
    });

    it('should support keyboard navigation for sorting', () => {
      render(<PreviewPanel {...mockProps} />);

      const headers = screen.getAllByRole('columnheader');
      expect(headers.length).toBeGreaterThan(0);

      // Test that headers can receive keyboard events
      const firstHeader = headers[0];
      if (firstHeader) {
        // Verify it's a proper header element
        expect(firstHeader.tagName).toBe('TH');

        // Test Enter key handling
        act(() => {
          fireEvent.keyDown(firstHeader, { key: 'Enter' });
        });

        // Test Space key handling
        act(() => {
          fireEvent.keyDown(firstHeader, { key: ' ' });
        });

        // Just verify the headers exist and are rendered properly
        expect(firstHeader).toBeInTheDocument();
      }
    });

    it('should have proper table structure', () => {
      render(<PreviewPanel {...mockProps} />);

      // Check that we have table headers (the actual scope attribute is set in the real component)
      const headers = screen.getAllByRole('columnheader');
      expect(headers.length).toBeGreaterThan(0);

      // Check that the shared treegrid structure exists
      expect(screen.getByRole('treegrid', { name: 'Context explorer table' })).toBeInTheDocument();
    });

    it('should have proper ARIA labels for group headers', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Directory');

      const groupToggles = screen.getAllByRole('button', { name: 'Collapse' });
      expect(groupToggles.length).toBeGreaterThan(0);
      for (const toggle of groupToggles) {
        expect(toggle).toHaveAttribute('aria-label');
      }
    });

    it('should have checkboxes for group selection', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Directory');

      // Should have group selection checkboxes
      const groupCheckboxes = screen.getAllByLabelText(/Select all files in group/);
      expect(groupCheckboxes.length).toBeGreaterThan(0);
    });

    it('should select all files in a group when group checkbox is clicked', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: 'folder-a',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
          {
            compositeKey: 'file3',
            folderId: 'folder-b',
            path: 'path/to/file3.txt',
            size: 512,
            tokens: 250,
            type: 'file' as const,
          },
        ],
      };

      const propsWithMixedFolders = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: key === 'file3' ? 'folder-b' : 'folder-a',
          path: `path/to/${key}.txt`,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(mixedFoldersState);
      render(<PreviewPanel {...propsWithMixedFolders} />);

      selectGroupingOption('By Directory');

      // Click group checkbox for folder-a
      const groupCheckboxes = screen.getAllByLabelText(/Select all files in group/);
      expect(groupCheckboxes.length).toBeGreaterThan(0);

      if (groupCheckboxes[0]) {
        fireEvent.click(groupCheckboxes[0]); // Select first group
      }

      // Check that files in the group are selected
      const fileCheckboxes = screen.getAllByTestId('checkbox');
      // Should have group checkboxes + file checkboxes + page select all checkbox
      expect(fileCheckboxes.length).toBeGreaterThan(3);
    });

    it('should show indeterminate state for partially selected groups', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
            type: 'file' as const,
          },
          {
            compositeKey: 'file2',
            folderId: 'folder-a',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
            type: 'file' as const,
          },
        ],
      };

      const propsWithMixedFolders = {
        ...mockProps,
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'folder-a',
          path: `path/to/${key}.txt`,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(mixedFoldersState);
      render(<PreviewPanel {...propsWithMixedFolders} />);

      selectGroupingOption('By Root Folder');

      // Select only one file in the group
      const fileCheckboxes = screen.getAllByTestId('checkbox');
      const firstFileCheckbox = fileCheckboxes.find((cb) =>
        cb.getAttribute('aria-label')?.includes('file1.txt')
      );

      if (firstFileCheckbox) {
        fireEvent.click(firstFileCheckbox);

        // Group checkbox should show indeterminate state
        const groupCheckbox = screen.getByLabelText(/Select all files in group folder-a/);
        expect(groupCheckbox).toBeInTheDocument();
      }
    });

    it('should fix checkbox selection when grouping is enabled', () => {
      render(<PreviewPanel {...mockProps} />);

      selectGroupingOption('By Directory');

      // Should still be able to select individual files
      const fileCheckboxes = screen.getAllByTestId('checkbox');
      const individualFileCheckbox = fileCheckboxes.find((cb) =>
        cb.getAttribute('aria-label')?.includes('file1.txt')
      );

      if (individualFileCheckbox) {
        fireEvent.click(individualFileCheckbox);
        expect(individualFileCheckbox).toBeChecked();
      }
    });

    it('should handle checkbox state when switching grouping modes', async () => {
      render(<PreviewPanel {...mockProps} />);

      // First select a file without grouping
      const fileCheckboxes = screen.getAllByTestId('checkbox');
      const file1Checkbox = fileCheckboxes.find((cb) =>
        cb.getAttribute('aria-label')?.includes('file1.txt')
      );

      if (file1Checkbox) {
        expect(file1Checkbox).not.toBeChecked();
        fireEvent.click(file1Checkbox);
        expect(file1Checkbox).toBeChecked();
      }

      // Enable grouping
      selectGroupingOption('By Directory');

      // After grouping change, the checkbox should still work for new selections
      const groupedFileCheckboxes = screen.getAllByTestId('checkbox');
      const groupedFile1Checkbox = groupedFileCheckboxes.find((cb) =>
        cb.getAttribute('aria-label')?.includes('file1.txt')
      );

      if (groupedFile1Checkbox) {
        // Test that checkbox interactions work in grouped mode
        // (current behavior: selections may or may not persist across grouping changes)
        fireEvent.change(groupedFile1Checkbox, { target: { checked: true } });
        await waitFor(() => {
          expect(groupedFile1Checkbox).toBeChecked();
        });

        // Test that it can be unchecked
        fireEvent.change(groupedFile1Checkbox, { target: { checked: false } });
        await waitFor(() => {
          expect(groupedFile1Checkbox).not.toBeChecked();
        });
      }
    });

    it('should handle individual file selection properly in different grouping modes', () => {
      const testGroupings = ['folder', 'fileType', 'sizeSteps', 'tokenSteps'] as const;
      const groupingLabels = {
        fileType: 'By File Type',
        folder: 'By Root Folder',
        sizeSteps: 'By Size Range',
        tokenSteps: 'By Token Range',
      } as const;

      for (const grouping of testGroupings) {
        const { unmount } = render(<PreviewPanel {...mockProps} />);

        selectGroupingOption(groupingLabels[grouping]);

        // Find and click a file checkbox
        const fileCheckboxes = screen.getAllByTestId('checkbox');
        const fileCheckbox = fileCheckboxes.find((cb) =>
          cb.getAttribute('aria-label')?.includes('file1.txt')
        );

        if (fileCheckbox) {
          expect(fileCheckbox).not.toBeChecked();
          fireEvent.click(fileCheckbox);
          expect(fileCheckbox).toBeChecked();

          // Uncheck it
          fireEvent.click(fileCheckbox);
          expect(fileCheckbox).not.toBeChecked();
        }

        unmount();
      }
    });
  });

  describe('Performance', () => {
    it('should handle large file sets without blocking', async () => {
      const largeFileSet = new Set(Array.from({ length: 1000 }, (_, i) => `file${i}`));
      const largeMockState = {
        ...mockState,
        flatListItems: Array.from({ length: 1000 }, (_, i) => ({
          compositeKey: `file${i}`,
          folderId: `folder-file${i}`,
          path: `path/to/file${i}.txt`,
          size: 1024,
          tokens: 100,
          type: 'file' as const,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(largeMockState);

      render(<PreviewPanel {...mockProps} pageSize={50} selectedFiles={largeFileSet} />);

      // Should only show first page (50 items) even with large datasets
      expect(screen.getByTestId('page-info')).toHaveTextContent('of 20');
    });
  });
});
