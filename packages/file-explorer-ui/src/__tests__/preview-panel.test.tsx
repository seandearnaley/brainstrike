import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview-panel';

// Mock the use-preview-panel-state module
vi.mock('../use-preview-panel-state', () => ({
  usePreviewPanelState: vi.fn(),
  formatTokenCount: (tokens: number) => {
    if (tokens < 1000) return tokens.toString();
    if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1000000).toFixed(1)}M`;
  },
}));

const mockUsePreviewPanelState = vi.mocked(
  await import('../use-preview-panel-state')
).usePreviewPanelState;

// Mock UI component types
interface MockBadgeProps {
  children: React.ReactNode;
  [key: string]: unknown;
}

interface MockButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  [key: string]: unknown;
}

interface MockCheckboxProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  [key: string]: unknown;
}

interface MockProgressProps {
  value?: number;
  [key: string]: unknown;
}

// Mock UI components
vi.mock('@brainstrike/ui', () => ({
  Badge: ({ children, ...props }: MockBadgeProps) => (
    <div data-testid="badge" {...props}>
      {children}
    </div>
  ),
  Button: ({ children, onClick, disabled, ...props }: MockButtonProps) => (
    <button onClick={onClick} disabled={disabled} data-testid="button" {...props}>
      {children}
    </button>
  ),
  Checkbox: ({ checked, onCheckedChange, ...props }: MockCheckboxProps) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      data-testid="checkbox"
      {...props}
    />
  ),
  Progress: ({ value, ...props }: MockProgressProps) => (
    <div data-testid="progress" data-value={value} {...props} />
  ),
}));

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  ArrowDown: () => <div data-testid="arrow-down" />,
  ArrowUp: () => <div data-testid="arrow-up" />,
  FileX2: () => <div data-testid="file-x2" />,
  FolderOpen: () => <div data-testid="folder-open" />,
}));

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
    countTokensHeuristic: vi.fn((content: string) => content.length * 4),
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
    expandAllFolders: vi.fn(),
    collapseAllFolders: vi.fn(),
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
      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '3 files | 1,500 tokens';
        })
      ).toBeInTheDocument();

      // Check files are displayed
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
      expect(screen.getByText('file2.txt')).toBeInTheDocument();
      expect(screen.getByText('file3.txt')).toBeInTheDocument();

      // Check folder IDs are displayed
      expect(screen.getByText('folder-file1')).toBeInTheDocument();
      expect(screen.getByText('folder-file2')).toBeInTheDocument();
      expect(screen.getByText('folder-file3')).toBeInTheDocument();
    });

    it('should handle file click events', () => {
      render(<PreviewPanel {...mockProps} />);

      const fileButton = screen.getByRole('button', { name: 'file1.txt' });
      if (fileButton) {
        fireEvent.click(fileButton);
        expect(mockProps.onFileClick).toHaveBeenCalledWith('file1');
      }
    });
  });

  describe('Sorting', () => {
    it('should handle column sorting', () => {
      render(<PreviewPanel {...mockProps} />);

      // Click on folder header to sort
      const folderHeader = screen.getByText('Folder');
      fireEvent.click(folderHeader);

      // Should display sort indicator
      expect(screen.getAllByTestId('arrow-up').length).toBeGreaterThan(0);
    });

    it('should toggle sort direction on repeated clicks', () => {
      render(<PreviewPanel {...mockProps} />);

      const folderHeader = screen.getByText('Folder');

      // First click - ascending
      fireEvent.click(folderHeader);
      expect(screen.getAllByTestId('arrow-up').length).toBeGreaterThan(0);

      // Second click - descending
      fireEvent.click(folderHeader);
      expect(screen.getAllByTestId('arrow-down').length).toBeGreaterThan(0);
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

      const checkboxes = screen.getAllByTestId('checkbox');
      const firstFileCheckbox = checkboxes[1]; // Skip the "select all" checkbox
      expect(firstFileCheckbox).toBeInTheDocument();

      fireEvent.click(firstFileCheckbox);

      // Should update selection state (tested through internal state)
      expect(firstFileCheckbox).toBeChecked();
    });

    it('should handle select all on current page', () => {
      render(<PreviewPanel {...mockProps} />);

      const selectAllCheckbox = screen.getAllByTestId('checkbox')[0];
      expect(selectAllCheckbox).toBeInTheDocument();
      fireEvent.click(selectAllCheckbox);

      // All file checkboxes should be checked
      const checkboxes = screen.getAllByTestId('checkbox');
      for (const checkbox of checkboxes.slice(1)) {
        expect(checkbox).toBeChecked();
      }
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

      // Select files first
      const checkboxes = screen.getAllByTestId('checkbox');
      expect(checkboxes[1]).toBeInTheDocument();
      fireEvent.click(checkboxes[1]); // Select first file

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
      expect(screen.getByText('Page 1 of 3 (120 total files)')).toBeInTheDocument();
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

      expect(screen.getByText('Page 2 of 3 (120 total files)')).toBeInTheDocument();
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

      expect(screen.getByText('Page 1 of 3 (120 total files)')).toBeInTheDocument();
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

      expect(screen.getByText('Page 2 of 3 (120 total files)')).toBeInTheDocument();
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
  });

  describe('Folder Controls', () => {
    it('should handle expand all folders', () => {
      render(<PreviewPanel {...mockProps} />);

      // Look for button with Expand text instead of title
      const expandButton = screen.getByText('Expand');
      fireEvent.click(expandButton);

      expect(mockState.expandAllFolders).toHaveBeenCalled();
    });

    it('should handle collapse all folders', () => {
      render(<PreviewPanel {...mockProps} />);

      // Look for button with Collapse text instead of title
      const collapseButton = screen.getByText('Collapse');
      fireEvent.click(collapseButton);

      expect(mockState.collapseAllFolders).toHaveBeenCalled();
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

      const folderHeader = screen.getByText('Folder');

      // Test Enter key
      fireEvent.keyDown(folderHeader, { key: 'Enter' });
      expect(screen.getByTestId('arrow-up')).toBeInTheDocument();

      // Test Space key
      fireEvent.keyDown(folderHeader, { key: ' ' });
      // Use getAllByTestId since there might be multiple arrow-down icons (in buttons and sort indicators)
      const arrowDownElements = screen.getAllByTestId('arrow-down');
      expect(arrowDownElements.length).toBeGreaterThan(0);
    });

    it('should have proper table structure', () => {
      render(<PreviewPanel {...mockProps} />);

      // Check that we have table headers (the actual scope attribute is set in the real component)
      const headers = screen.getAllByRole('columnheader');
      expect(headers.length).toBeGreaterThan(0);

      // Check that table structure exists
      expect(screen.getByRole('table')).toBeInTheDocument();
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

      const startTime = performance.now();
      render(<PreviewPanel {...mockProps} selectedFiles={largeFileSet} />);
      const endTime = performance.now();

      // Should render within reasonable time (less than 100ms)
      expect(endTime - startTime).toBeLessThan(100);

      // Should only show first page (50 items)
      expect(screen.getByText('Page 1 of 20 (1000 total files)')).toBeInTheDocument();
    });
  });
});
