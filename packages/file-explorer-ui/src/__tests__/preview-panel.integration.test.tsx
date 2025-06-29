import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview-panel';

// Mock the use-preview-panel-state module with realistic implementation
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

// Mock UI components with more realistic behavior
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
  Popover: ({
    children,
    open,
    onOpenChange,
    ...props
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    [key: string]: unknown;
  }) => (
    <div data-testid="popover" data-open={open} {...props}>
      {children}
    </div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: { children: React.ReactNode; asChild?: boolean; [key: string]: unknown }) => (
    <div data-testid="popover-trigger" {...props}>
      {children}
    </div>
  ),
  PopoverContent: ({
    children,
    align,
    className,
    ...props
  }: { children: React.ReactNode; align?: string; className?: string; [key: string]: unknown }) => (
    <div data-testid="popover-content" data-align={align} className={className} {...props}>
      {children}
    </div>
  ),
  SortableTableHeader: ({
    title,
    onSort,
    field,
    sortField,
    sortDirection,
    className,
    ...domProps
  }: {
    title: string;
    onSort: (field: string) => void;
    field: string;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
    className?: string;
    [key: string]: unknown;
  }) => (
    <th
      data-testid="sortable-header"
      onClick={() => onSort?.(field)}
      className={className}
      scope="col"
      {...domProps}
    >
      {title}
    </th>
  ),
  TablePagination: ({
    currentPage,
    totalPages,
    onPageChange,
    totalItems,
    pageInfo,
    maxPageButtons,
    ...domProps
  }: {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    totalItems?: number;
    pageInfo?: string;
    maxPageButtons?: number;
    [key: string]: unknown;
  }) => {
    const getPageNumbers = () => {
      const maxButtons = maxPageButtons || 5;
      const halfMax = Math.floor(maxButtons / 2);

      if (totalPages <= maxButtons) {
        return Array.from({ length: totalPages }, (_, i) => i);
      }

      if (currentPage < halfMax) {
        return Array.from({ length: maxButtons }, (_, i) => i);
      }

      if (currentPage > totalPages - Math.ceil(maxButtons / 2) - 1) {
        return Array.from({ length: maxButtons }, (_, i) => totalPages - maxButtons + i);
      }

      const startPage = currentPage - halfMax;
      return Array.from({ length: maxButtons }, (_, i) => startPage + i);
    };

    return (
      <div data-testid="table-pagination" {...domProps}>
        <button
          type="button"
          onClick={() => onPageChange?.(currentPage - 1)}
          disabled={currentPage === 0}
        >
          Previous
        </button>
        <span>
          Page {currentPage + 1} of {totalPages}
          {pageInfo ? ` ${pageInfo}` : totalItems ? ` (${totalItems} total items)` : ''}
        </span>
        <div>
          {getPageNumbers().map((pageNum) => (
            <button
              key={pageNum}
              type="button"
              onClick={() => onPageChange?.(pageNum)}
              style={{ margin: '0 2px' }}
            >
              {pageNum + 1}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onPageChange?.(currentPage + 1)}
          disabled={currentPage >= totalPages - 1}
        >
          Next
        </button>
      </div>
    );
  },
  TableGroupHeader: ({
    groupLabel,
    onToggleCollapse,
    onSelectionChange,
    isCollapsed,
    isGroupSelected,
    isIndeterminate,
    filesInGroup,
    groupKey,
    isFullySelected,
    isPartiallySelected,
    ...domProps
  }: {
    groupLabel: string;
    onToggleCollapse: () => void;
    onSelectionChange: (selected: boolean) => void;
    isCollapsed?: boolean;
    isGroupSelected?: boolean;
    isIndeterminate?: boolean;
    filesInGroup?: number;
    groupKey?: string | number;
    isFullySelected?: boolean;
    isPartiallySelected?: boolean;
    [key: string]: unknown;
  }) => (
    <tr data-testid="table-group-header" {...domProps}>
      <td>
        <input
          type="checkbox"
          onChange={(e) => onSelectionChange?.(e.target.checked)}
          aria-label={`Select all files in group ${groupLabel}`}
        />
      </td>
      <td>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? `Expand group ${groupLabel}` : `Collapse group ${groupLabel}`}
          aria-expanded={!isCollapsed}
        >
          {groupLabel}
        </button>
      </td>
    </tr>
  ),
}));

// Mock hooks with React state
vi.mock('@brainstrike/hooks', () => {
  const { useState, useEffect, useRef } = require('react');

  return {
    usePagination: vi.fn((options: { totalItems: number; pageSize?: number }) => {
      const pageSize = options.pageSize || 50;
      const totalPages = Math.ceil(options.totalItems / pageSize);
      const [currentPage, setCurrentPage] = useState(0);
      const prevTotalPagesRef = useRef(totalPages);

      // Reset to first page when total pages changes and current page is out of bounds
      useEffect(() => {
        if (prevTotalPagesRef.current !== totalPages) {
          prevTotalPagesRef.current = totalPages;
          if (currentPage >= totalPages && totalPages > 0) {
            setCurrentPage(0);
          }
        }
      }, [currentPage, totalPages]);

      const startIndex = currentPage * pageSize;
      const endIndex = Math.min(startIndex + pageSize, options.totalItems);

      const goToPage = vi.fn((page: number) => {
        setCurrentPage(Math.max(0, Math.min(page, totalPages - 1)));
      });

      const goToNextPage = vi.fn(() => {
        setCurrentPage((prev: number) => (prev < totalPages - 1 ? prev + 1 : prev));
      });

      const goToPreviousPage = vi.fn(() => {
        setCurrentPage((prev: number) => (prev > 0 ? prev - 1 : prev));
      });

      const resetToFirstPage = vi.fn(() => {
        setCurrentPage(0);
      });

      return {
        currentPage,
        totalPages,
        startIndex,
        endIndex,
        goToPage,
        goToNextPage,
        goToPreviousPage,
        resetToFirstPage,
        isFirstPage: currentPage === 0,
        isLastPage: currentPage >= totalPages - 1 || totalPages <= 1,
      };
    }),
  };
});

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  ArrowDown: () => <div data-testid="arrow-down" />,
  ArrowUp: () => <div data-testid="arrow-up" />,
  Columns3: () => <div data-testid="columns3" />,
  FileX2: () => <div data-testid="file-x2" />,
  FolderOpen: () => <div data-testid="folder-open" />,
}));

describe('PreviewPanel Integration Tests', () => {
  const createMockProps = (fileCount = 100) => ({
    selectedFiles: new Set(Array.from({ length: fileCount }, (_, i) => `file${i}`)),
    fileContents: Object.fromEntries(
      Array.from({ length: fileCount }, (_, i) => [`file${i}`, `content of file ${i}`.repeat(10)])
    ),
    loadingFiles: new Set<string>(),
    onSelectionChange: vi.fn(),
    fileSizes: Object.fromEntries(
      Array.from({ length: fileCount }, (_, i) => [`file${i}`, 1024 + i * 100])
    ),
    decodeFileSelection: vi.fn((key: string) => ({
      folderId: `folder-${Math.floor(Number.parseInt(key.replace('file', '')) / 10)}`,
      path: `path/to/folder${Math.floor(Number.parseInt(key.replace('file', '')) / 10)}/${key}.txt`,
    })),
    countTokensHeuristic: vi.fn((content: string) => content.length * 4),
    estimateTokenCost: vi.fn((tokens: number) => tokens * 0.001),
    performUndoableAction: vi.fn(),
    onFileClick: vi.fn(),
  });

  const createMockState = (fileCount = 100) => ({
    batchSelectedFiles: new Set<string>(),
    collapsedFolders: new Set<string>(),
    totalStats: {
      totalFiles: fileCount,
      totalTokens: fileCount * 200, // Realistic token count
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
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let unitIndex = 0;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      return `${size.toFixed(1)} ${units[unitIndex]}`;
    }),
    loadingFiles: new Set<string>(),
    flatListItems: Array.from({ length: fileCount }, (_, i) => ({
      type: 'file' as const,
      compositeKey: `file${i}`,
      folderId: `folder-${Math.floor(i / 10)}`,
      path: `path/to/folder${Math.floor(i / 10)}/file${i}.txt`,
      size: 1024 + i * 100,
      tokens: 200 + i * 5,
    })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Complete File Explorer Workflow', () => {
    it('should handle complete file selection and removal workflow', async () => {
      const mockProps = createMockProps(25);
      const mockState = createMockState(25);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Verify initial state
      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '25 files | 5,000 tokens';
        })
      ).toBeInTheDocument();

      // Select multiple files using aria-labels - files are in folder0 for file1-file9
      const file1Checkbox = screen.getByLabelText('Select path/to/folder0/file1.txt');
      const file2Checkbox = screen.getByLabelText('Select path/to/folder0/file2.txt');
      const file3Checkbox = screen.getByLabelText('Select path/to/folder0/file3.txt');

      expect(file1Checkbox).toBeInTheDocument();
      expect(file2Checkbox).toBeInTheDocument();
      expect(file3Checkbox).toBeInTheDocument();

      fireEvent.click(file1Checkbox); // Select first file
      fireEvent.click(file2Checkbox); // Select second file
      fireEvent.click(file3Checkbox); // Select third file

      // Verify selection UI appears
      await waitFor(() => {
        expect(screen.getByText(/files selected in preview/)).toBeInTheDocument();
      });

      // Perform batch removal
      const removeButton = screen.getByText('Remove Selected from Project');
      fireEvent.click(removeButton);

      // Verify removal actions were called
      expect(mockProps.performUndoableAction).toHaveBeenCalledWith(
        'batch-remove',
        'batch-remove',
        expect.objectContaining({
          actionName: 'Files removed',
          itemDescription: expect.stringContaining('files from selection'),
        })
      );
      expect(mockProps.onSelectionChange).toHaveBeenCalled();
    });

    it('should handle sorting and pagination together', () => {
      const mockProps = createMockProps(120);
      const mockState = createMockState(120);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Verify pagination is shown
      expect(screen.getByText('Page 1 of 3 (120 total items)')).toBeInTheDocument();

      // Sort by file path
      const pathHeader = screen.getByText('File Path');
      fireEvent.click(pathHeader);

      // Verify sort indicator appears somewhere after clicking
      expect(screen.getAllByTestId('arrow-up').length).toBeGreaterThan(0);

      // Navigate to next page
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);

      expect(screen.getByText('Page 2 of 3 (120 total items)')).toBeInTheDocument();

      // Change sort direction
      fireEvent.click(pathHeader);
      expect(screen.getAllByTestId('arrow-down').length).toBeGreaterThan(0);

      // Reset sort should go back to page 1
      const resetButton = screen.getByText('Reset Sort');
      fireEvent.click(resetButton);

      expect(screen.getByText('Page 1 of 3 (120 total items)')).toBeInTheDocument();
    });

    it('should handle folder operations with large datasets', () => {
      const mockProps = createMockProps(200);
      const mockState = createMockState(200);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Expand all folders
      const expandButton = screen.getByTitle('Expand all folders');
      fireEvent.click(expandButton);
      expect(mockState.expandAllFolders).toHaveBeenCalled();

      // Collapse all folders
      const collapseButton = screen.getByTitle('Collapse all folders');
      fireEvent.click(collapseButton);
      expect(mockState.collapseAllFolders).toHaveBeenCalled();

      // Select all files globally
      const selectAllButton = screen.getByText(/Select All \(200\)/);
      fireEvent.click(selectAllButton);

      // Should be disabled after selection
      expect(selectAllButton).toBeDisabled();
    });
  });

  describe('Performance with Large Datasets', () => {
    it('should render large datasets efficiently', () => {
      const mockProps = createMockProps(1000);
      const mockState = createMockState(1000);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Should show pagination for large datasets
      expect(screen.getByText('Page 1 of 20 (1000 total items)')).toBeInTheDocument();

      // Should only render first page items (performance optimization)
      expect(screen.getByText('file0.txt')).toBeInTheDocument();
      expect(screen.queryByText('file60.txt')).not.toBeInTheDocument(); // Beyond first page
    });

    it('should handle rapid pagination without performance issues', () => {
      const mockProps = createMockProps(500);
      const mockState = createMockState(500);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Rapidly navigate through pages
      const nextButton = screen.getByText('Next');
      for (let i = 0; i < 5; i++) {
        fireEvent.click(nextButton);
      }

      // Should handle rapid navigation correctly
      expect(screen.getByText('Page 6 of 10 (500 total items)')).toBeInTheDocument();
    });
  });

  describe('Error Recovery and Edge Cases', () => {
    it('should handle mixed loading and error states', () => {
      const mockProps = createMockProps(50);
      mockProps.loadingFiles = new Set(['file1', 'file2']);
      mockProps.fileContents = {
        ...mockProps.fileContents,
        file3: 'File not accessible: Permission denied',
        file4: 'Binary file detected',
      };

      const mockState = createMockState(50);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Should still render successfully with mixed states
      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '50 files | 10,000 tokens';
        })
      ).toBeInTheDocument();
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
    });

    it('should handle dynamic file set changes', async () => {
      const mockProps = createMockProps(10);
      const mockState = createMockState(10);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      const { rerender } = render(<PreviewPanel {...mockProps} />);

      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '10 files | 2,000 tokens';
        })
      ).toBeInTheDocument();

      // Simulate adding more files
      const newMockProps = createMockProps(20);
      const newMockState = createMockState(20);
      mockUsePreviewPanelState.mockReturnValue(newMockState);

      rerender(<PreviewPanel {...newMockProps} />);

      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '20 files | 4,000 tokens';
        })
      ).toBeInTheDocument();
    });

    it('should maintain state consistency during operations', async () => {
      const mockProps = createMockProps(75);
      const mockState = createMockState(75);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Go to page 2
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);

      expect(screen.getByText('Page 2 of 2 (75 total items)')).toBeInTheDocument();

      // Select files on page 2 - first file on page 2 would be file50
      const file50Checkbox = screen.getByLabelText('Select path/to/folder5/file50.txt');
      expect(file50Checkbox).toBeInTheDocument();
      fireEvent.click(file50Checkbox);

      // Should show selection bar
      await waitFor(() => {
        expect(screen.getByText(/files selected in preview/)).toBeInTheDocument();
      });

      // Clear selection
      const clearButton = screen.getByText('Clear Preview Selection');
      fireEvent.click(clearButton);

      // Selection bar should disappear
      await waitFor(() => {
        expect(screen.queryByText(/files selected in preview/)).not.toBeInTheDocument();
      });
    });

    it('should reset to first page when total pages decrease', async () => {
      const mockProps = createMockProps(120);
      const mockState = createMockState(120);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      const { rerender } = render(<PreviewPanel {...mockProps} />);

      // Navigate to the last page
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);
      fireEvent.click(nextButton);
      expect(screen.getByText('Page 3 of 3 (120 total items)')).toBeInTheDocument();

      // Rerender with fewer files resulting in two pages
      const fewerProps = createMockProps(60);
      const fewerState = createMockState(60);
      mockUsePreviewPanelState.mockReturnValue(fewerState);

      rerender(<PreviewPanel {...fewerProps} />);

      await waitFor(() => {
        expect(screen.getByText('Page 1 of 2 (60 total items)')).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility Integration', () => {
    it('should maintain accessibility during complex interactions', () => {
      const mockProps = createMockProps(30);
      const mockState = createMockState(30);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Test keyboard navigation through sorting
      const headers = screen.getAllByRole('columnheader');
      for (const header of headers) {
        expect(header).toHaveAttribute('scope', 'col');
      }

      // Test keyboard sorting
      const folderHeader = screen.getByRole('columnheader', { name: 'Folder' });
      fireEvent.keyDown(folderHeader, { key: 'Enter' });
      expect(screen.getAllByTestId('arrow-up').length).toBeGreaterThan(0);

      // Test space key
      fireEvent.keyDown(folderHeader, { key: ' ' });
      expect(screen.getAllByTestId('arrow-down').length).toBeGreaterThan(0);

      // All interactive elements should have proper labels
      const selectAllCheckbox = screen.getByLabelText('Select all files on current page');
      expect(selectAllCheckbox).toHaveAttribute('aria-label', 'Select all files on current page');
    });
  });
});
