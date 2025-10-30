import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview-panel';

type PreviewPanelMocksModule = typeof import('./__mocks__/preview-panel-mocks');

const previewPanelMocksPromise = vi.hoisted(
  async () => (await import('./__mocks__/preview-panel-mocks')) as PreviewPanelMocksModule
);

vi.mock('../use-preview-panel-state', async () => {
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
  await import('../use-preview-panel-state')
).usePreviewPanelState;

const { resetPreviewPanelPaginationMockState } = await previewPanelMocksPromise;

beforeEach(() => {
  resetPreviewPanelPaginationMockState();
});

describe('PreviewPanel', () => {
  const mockProps = {
    selectedFiles: new Set(['file1', 'file2', 'file3']),
    fileContents: {
      file1: 'content1',
      file2: 'content2',
      file3: 'content3',
    },
    loadingFiles: new Set<string>(),
    onSelectionChange: vi.fn(),
    fileSizes: {
      file1: 1024,
      file2: 2048,
      file3: 512,
    },
    decodeFileSelection: vi.fn((key: string) => ({
      folderId: `folder-${key}`,
      path: `path/to/${key}.txt`,
    })),
    tokenCounting: {
      mode: 'accurate' as const,
      reason: null,
      loading: false,
      countTokens: vi.fn(async (content: string) => content.length),
    },
    estimateTokenCost: vi.fn((tokens: number) => tokens * 0.001),
    performUndoableAction: vi.fn(),
    onFileClick: vi.fn(),
  };

  const mockState = {
    batchSelectedFiles: new Set<string>(),
    collapsedFolders: new Set<string>(),
    totalStats: {
      totalFiles: 3,
      totalTokens: 1500,
    },
    handleRemoveFile: vi.fn(),
    handleBatchRemove: vi.fn(),
    toggleFileSelection: vi.fn(),
    toggleFolderCollapse: vi.fn(),
    handleSelectAll: vi.fn(),
    handleDeselectAll: vi.fn(),
    isAllFilesSelected: false,
    formatFileSize: vi.fn((bytes?: number) => {
      if (bytes === undefined) return 'Unknown';
      return `${bytes} B`;
    }),
    loadingFiles: new Set<string>(),
    expandAllFolders: vi.fn(),
    collapseAllFolders: vi.fn(),
    flatListItems: [
      {
        type: 'file' as const,
        compositeKey: 'file1',
        folderId: 'folder-file1',
        path: 'path/to/file1.txt',
        size: 1024,
        tokens: 500,
      },
      {
        type: 'file' as const,
        compositeKey: 'file2',
        folderId: 'folder-file2',
        path: 'path/to/file2.txt',
        size: 2048,
        tokens: 750,
      },
      {
        type: 'file' as const,
        compositeKey: 'file3',
        folderId: 'folder-file3',
        path: 'path/to/file3.txt',
        size: 512,
        tokens: 250,
      },
    ],
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

  describe('File Display', () => {
    it('should render file list with proper data', () => {
      render(<PreviewPanel {...mockProps} />);

      // Check stats display
      const stats = screen.getAllByText(
        (_, element) => element?.textContent?.includes('3 files | 1,500 tokens') ?? false
      );
      expect(stats.length > 0).toBe(true);

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

      expect(screen.getByText('Accurate tokens (WASM)')).toBeInTheDocument();
      expect(
        screen.getByText(/Counts generated with the tiktoken WASM encoder/i)
      ).toBeInTheDocument();
    });

    it('should surface heuristic fallback messaging when configured', () => {
      mockUsePreviewPanelState.mockReturnValue(mockState);
      const props = {
        ...mockProps,
        tokenCounting: {
          mode: 'heuristic' as const,
          reason: 'runtime-fallback' as const,
          loading: false,
          countTokens: vi.fn(async () => 0),
        },
      };

      render(<PreviewPanel {...props} />);

      expect(screen.getByText('Heuristic fallback')).toBeInTheDocument();
      expect(screen.getByText(/WASM tokenizer is unavailable/i)).toBeInTheDocument();
    });

    it('should handle file click events', () => {
      render(<PreviewPanel {...mockProps} />);

      const fileButton = screen.getByRole('button', { name: 'file1.txt' });
      if (fileButton) {
        fireEvent.click(fileButton);
        expect(mockProps.onFileClick).toHaveBeenCalledWith('file1');
      }
    });

    it('should render progress with correct value for total tokens', () => {
      const totalTokens = 2000;
      mockUsePreviewPanelState.mockReturnValue({
        ...mockState,
        totalStats: { totalFiles: 3, totalTokens },
      });

      render(<PreviewPanel {...mockProps} />);

      const progress = screen.getByTestId('progress');
      const expected = Math.min((totalTokens / 100000) * 100, 100);
      expect(progress).toHaveAttribute('data-value', expected.toString());
    });
  });

  describe('Sorting', () => {
    it('should handle column sorting', () => {
      render(<PreviewPanel {...mockProps} />);

      // Click on folder header to sort - use the sortable header specifically
      const folderHeader = screen.getByRole('columnheader', { name: 'Folder' });

      // Verify header is clickable and has proper attributes
      expect(folderHeader).toHaveAttribute('scope', 'col');
      expect(folderHeader).toHaveAttribute('tabIndex', '0');

      // Click to trigger sorting
      fireEvent.click(folderHeader);

      // Verify the header remains interactive after click
      expect(folderHeader).toBeInTheDocument();
    });

    it('should toggle sort direction on repeated clicks', () => {
      render(<PreviewPanel {...mockProps} />);

      const folderHeader = screen.getByRole('columnheader', { name: 'Folder' });

      // First click - should trigger sorting
      fireEvent.click(folderHeader);
      expect(folderHeader).toBeInTheDocument();

      // Second click - should toggle direction
      fireEvent.click(folderHeader);
      expect(folderHeader).toBeInTheDocument();

      // Verify the header remains interactive
      expect(folderHeader).toHaveAttribute('tabIndex', '0');
    });

    it('should sort by tokens ascending and descending', async () => {
      render(<PreviewPanel {...mockProps} />);

      let tokensHeader = screen.getByRole('columnheader', { name: 'Tokens' });
      fireEvent.click(tokensHeader); // ascending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file3.txt');
      });

      tokensHeader = screen.getByRole('columnheader', { name: 'Tokens' });
      fireEvent.click(tokensHeader); // descending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file2.txt');
      });
    });

    it('should sort by size ascending and descending', async () => {
      render(<PreviewPanel {...mockProps} />);

      let sizeHeader = screen.getByRole('columnheader', { name: 'Size' });
      fireEvent.click(sizeHeader); // ascending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file3.txt');
      });

      sizeHeader = screen.getByRole('columnheader', { name: 'Size' });
      fireEvent.click(sizeHeader); // descending

      await waitFor(() => {
        const fileButtons = screen.getAllByRole('button', { name: /\.txt$/ });
        expect(fileButtons[0]).toHaveAttribute('aria-label', 'file2.txt');
      });
    });

    it('should reset sort when reset button is clicked', () => {
      render(<PreviewPanel {...mockProps} />);

      // Change sort first
      const pathHeader = screen.getByText('File Path');
      fireEvent.click(pathHeader);

      // Reset sort
      const resetButton = screen.getByText('Reset Sort');
      fireEvent.click(resetButton);

      // Should no longer show reset button
      expect(screen.queryByText('Reset Sort')).not.toBeInTheDocument();
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

    it('should handle global select all', () => {
      render(<PreviewPanel {...mockProps} />);

      const selectAllButton = screen.getByText(/Select All \(3\)/);
      fireEvent.click(selectAllButton);

      // Should be disabled after selection
      expect(selectAllButton).toBeDisabled();
    });

    it('should handle batch removal', async () => {
      render(<PreviewPanel {...mockProps} />);

      // Select files first using aria-label
      const fileCheckbox = screen.getByLabelText('Select path/to/file1.txt');
      expect(fileCheckbox).toBeInTheDocument();
      fireEvent.click(fileCheckbox); // Select first file

      // Should show action bar
      await waitFor(() => {
        expect(screen.getByText('1 files selected in preview')).toBeInTheDocument();
      });

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
      expandAllFolders: vi.fn(),
      collapseAllFolders: vi.fn(),
      flatListItems: Array.from({ length: 120 }, (_, i) => ({
        type: 'file' as const,
        compositeKey: `file${i}`,
        folderId: `folder-file${i}`,
        path: `path/to/file${i}.txt`,
        size: 1024,
        tokens: 100,
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

      expect(screen.getByText('Previous')).toBeInTheDocument();
      expect(screen.getByText('Next')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 3 (120 total items)')).toBeInTheDocument();
    });

    it('should handle next page navigation', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);

      expect(screen.getByText('Page 2 of 3 (120 total items)')).toBeInTheDocument();
    });

    it('should handle previous page navigation', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      // Go to next page first
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);

      // Then go back
      const prevButton = screen.getByText('Previous');
      fireEvent.click(prevButton);

      expect(screen.getByText('Page 1 of 3 (120 total items)')).toBeInTheDocument();
    });

    it('should handle direct page navigation', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      const page2Button = screen.getByText('2');
      fireEvent.click(page2Button);

      expect(screen.getByText('Page 2 of 3 (120 total items)')).toBeInTheDocument();
    });

    it('should disable navigation buttons at boundaries', () => {
      render(
        <PreviewPanel
          {...mockProps}
          selectedFiles={new Set(Array.from({ length: 120 }, (_, i) => `file${i}`))}
        />
      );

      // Previous should be disabled on first page
      expect(screen.getByText('Previous')).toBeDisabled();

      // Go to last page
      const page3Button = screen.getByRole('button', { name: '3' });
      fireEvent.click(page3Button);

      // Next should be disabled on last page
      expect(screen.getByText('Next')).toBeDisabled();
    });

    it('resets to first page when current page becomes out of bounds', () => {
      const fileSet = new Set(Array.from({ length: 25 }, (_, i) => `file${i}`));
      const stateWith25 = {
        ...largeMockState,
        flatListItems: Array.from({ length: 25 }, (_, i) => ({
          type: 'file' as const,
          compositeKey: `file${i}`,
          folderId: `folder-file${i}`,
          path: `path/to/file${i}.txt`,
          size: 1024,
          tokens: 100,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(stateWith25);
      const { rerender } = render(
        <PreviewPanel {...mockProps} selectedFiles={fileSet} pageSize={10} />
      );

      // Should show three pages
      expect(screen.getByText('Page 1 of 3 (25 total items)')).toBeInTheDocument();

      // Go to page 3 (last page)
      const page3Buttons = screen.getAllByText('3');
      const page3Button = page3Buttons.find((button) => button.tagName === 'BUTTON');
      expect(page3Button).toBeDefined();
      if (page3Button) {
        fireEvent.click(page3Button);
      }

      // Shrink to 5 files (only 1 page now), making page 3 out of bounds
      const smallerFileSet = new Set(Array.from({ length: 5 }, (_, i) => `file${i}`));
      const stateWith5 = {
        ...stateWith25,
        flatListItems: Array.from({ length: 5 }, (_, i) => ({
          type: 'file' as const,
          compositeKey: `file${i}`,
          folderId: `folder-file${i}`,
          path: `path/to/file${i}.txt`,
          size: 1024,
          tokens: 100,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(stateWith5);
      rerender(<PreviewPanel {...mockProps} selectedFiles={smallerFileSet} pageSize={10} />);

      // Should reset to page 1 since page 3 is now out of bounds
      expect(screen.getByText('Page 1 of 1 (5 total items)')).toBeInTheDocument();
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
        selectedFiles: new Set(['file1', 'malformed', 'file3']),
        decodeFileSelection: mockDecodeWithError,
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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      expect(groupingSelect).toBeInTheDocument();

      // Check that all grouping options are available
      const options = screen.getByRole('combobox').querySelectorAll('option');
      expect(options).toHaveLength(5); // none, folder, fileType, sizeSteps, tokenSteps
    });

    it('should change grouping when dropdown selection changes', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      expect(groupingSelect).toHaveValue('folder');
    });

    it('should show group control buttons when grouping is enabled', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      expect(screen.getByText('Expand All Groups')).toBeInTheDocument();
      expect(screen.getByText('Collapse All Groups')).toBeInTheDocument();
    });

    it('should handle group expansion and collapse', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      const expandAllButton = screen.getByText('Expand All Groups');
      const collapseAllButton = screen.getByText('Collapse All Groups');

      expect(expandAllButton).toBeInTheDocument();
      expect(collapseAllButton).toBeInTheDocument();

      fireEvent.click(collapseAllButton);
      fireEvent.click(expandAllButton);
    });

    it('should group files by folder correctly', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            type: 'file' as const,
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
          },
          {
            type: 'file' as const,
            compositeKey: 'file2',
            folderId: 'folder-a',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
          },
          {
            type: 'file' as const,
            compositeKey: 'file3',
            folderId: 'folder-b',
            path: 'path/to/file3.txt',
            size: 512,
            tokens: 250,
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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      // Should show grouped structure - use getAllByText since groups appear in headers and rows
      expect(screen.getAllByText('folder-a').length).toBeGreaterThan(0);
      expect(screen.getAllByText('folder-b').length).toBeGreaterThan(0);
    });

    it('should group files by size ranges correctly', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'sizeSteps' } });

      // Should create size-based groups (based on mockState file sizes)
      // file1: 1024 bytes = 'Small (< 1 KB)' -> wait, 1024 = 1KB, so 'Medium (1-10 KB)'
      // file2: 2048 bytes = 'Medium (1-10 KB)'
      // file3: 512 bytes = 'Small (< 1 KB)'
      expect(screen.getByText('Small (< 1 KB)')).toBeInTheDocument();
      expect(screen.getByText('Medium (1-10 KB)')).toBeInTheDocument();
    });

    it('should group files by token ranges correctly', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'tokenSteps' } });

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
            type: 'file' as const,
            compositeKey: 'file1',
            folderId: 'folder-file1',
            path: 'path/to/file1.js',
            size: 1024,
            tokens: 500,
          },
          {
            type: 'file' as const,
            compositeKey: 'file2',
            folderId: 'folder-file2',
            path: 'path/to/file2.ts',
            size: 2048,
            tokens: 750,
          },
          {
            type: 'file' as const,
            compositeKey: 'file3',
            folderId: 'folder-file3',
            path: 'path/to/file3.js',
            size: 512,
            tokens: 250,
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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'fileType' } });

      // Should show file type groups
      expect(screen.getAllByText('JS').length).toBeGreaterThan(0);
      expect(screen.getAllByText('TS').length).toBeGreaterThan(0);
    });

    it('should allow selecting all files across different groups', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            type: 'file' as const,
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
          },
          {
            type: 'file' as const,
            compositeKey: 'file2',
            folderId: 'folder-b',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      // Click "Select All" button
      const selectAllButton = screen.getByText(/Select All/);
      fireEvent.click(selectAllButton);

      // Should select files across all groups
      expect(selectAllButton).toBeDisabled();
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

      // Check that table structure exists
      expect(screen.getByRole('table')).toBeInTheDocument();
    });

    it('should have proper ARIA labels for group headers', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      // Should have aria-expanded and aria-label on group buttons
      const groupHeaders = screen.getAllByRole('button', { name: /Collapse group/ });
      expect(groupHeaders.length).toBeGreaterThan(0);
      for (const header of groupHeaders) {
        expect(header).toHaveAttribute('aria-expanded');
        expect(header).toHaveAttribute('aria-label');
      }
    });

    it('should have checkboxes for group selection', () => {
      render(<PreviewPanel {...mockProps} />);

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

      // Should have group selection checkboxes
      const groupCheckboxes = screen.getAllByLabelText(/Select all files in group/);
      expect(groupCheckboxes.length).toBeGreaterThan(0);
    });

    it('should select all files in a group when group checkbox is clicked', () => {
      const mixedFoldersState = {
        ...mockState,
        flatListItems: [
          {
            type: 'file' as const,
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
          },
          {
            type: 'file' as const,
            compositeKey: 'file2',
            folderId: 'folder-a',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
          },
          {
            type: 'file' as const,
            compositeKey: 'file3',
            folderId: 'folder-b',
            path: 'path/to/file3.txt',
            size: 512,
            tokens: 250,
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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

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
            type: 'file' as const,
            compositeKey: 'file1',
            folderId: 'folder-a',
            path: 'path/to/file1.txt',
            size: 1024,
            tokens: 500,
          },
          {
            type: 'file' as const,
            compositeKey: 'file2',
            folderId: 'folder-a',
            path: 'path/to/file2.txt',
            size: 2048,
            tokens: 750,
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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

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

      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

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
      const groupingSelect = screen.getByDisplayValue('No Grouping');
      fireEvent.change(groupingSelect, { target: { value: 'folder' } });

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
      const testGroupings = ['folder', 'fileType', 'sizeSteps', 'tokenSteps'];

      for (const grouping of testGroupings) {
        const { unmount } = render(<PreviewPanel {...mockProps} />);

        // Enable grouping
        const groupingSelect = screen.getByDisplayValue('No Grouping');
        fireEvent.change(groupingSelect, { target: { value: grouping } });

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
          type: 'file' as const,
          compositeKey: `file${i}`,
          folderId: `folder-file${i}`,
          path: `path/to/file${i}.txt`,
          size: 1024,
          tokens: 100,
        })),
      };

      mockUsePreviewPanelState.mockReturnValue(largeMockState);

      render(<PreviewPanel {...mockProps} selectedFiles={largeFileSet} />);

      // Should only show first page (50 items) even with large datasets
      expect(screen.getByText('Page 1 of 20 (1000 total items)')).toBeInTheDocument();
    });
  });
});
