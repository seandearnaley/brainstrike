import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview-panel';

// Mock the use-preview-panel-state module with realistic implementation
vi.mock('../use-preview-panel-state', () => ({
  usePreviewPanelState: vi.fn(),
  formatTokenCount: (tokens: number) => {
    if (tokens < 1000) {
      return tokens.toString();
    }
    if (tokens < 1_000_000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  },
}));

const mockUsePreviewPanelState = vi.mocked(
  await import('../use-preview-panel-state')
).usePreviewPanelState;

interface TabsContextValue {
  value?: string;
  onValueChange?: (value: string) => void;
}

interface TabsProps {
  children: React.ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  [key: string]: unknown;
}

interface TabsTriggerProps {
  children: React.ReactNode;
  value: string;
  disabled?: boolean;
  onClick?: () => void;
  [key: string]: unknown;
}

interface TabsContentProps {
  children: React.ReactNode;
  value: string;
  forceMount?: boolean;
  [key: string]: unknown;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

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
    <button data-testid="button" disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  ScrollArea: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
    <div data-testid="scroll-area" {...props}>
      {children}
    </div>
  ),
  Input: ({
    ref,
    ...props
  }: {
    ref?: React.RefObject<HTMLInputElement | null>;
    [key: string]: unknown;
  }) => <input data-testid="input" ref={ref} {...props} />,
  Checkbox: ({ checked, onCheckedChange, ...props }: MockCheckboxProps) => (
    <input
      checked={checked}
      data-testid="checkbox"
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      type="checkbox"
      {...props}
    />
  ),
  Progress: ({ value, ...props }: MockProgressProps) => (
    <div data-testid="progress" data-value={value} {...props} />
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  }) => (
    <div data-testid="tooltip-trigger" {...props}>
      {children}
    </div>
  ),
  TooltipContent: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <div data-testid="tooltip-content" {...props}>
      {children}
    </div>
  ),
  Popover: ({
    children,
    open,
    onOpenChange: _onOpenChange,
    ...props
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    [key: string]: unknown;
  }) => (
    <div data-open={open} data-testid="popover" {...props}>
      {children}
    </div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    [key: string]: unknown;
  }) => (
    <div data-testid="popover-trigger" {...props}>
      {children}
    </div>
  ),
  PopoverContent: ({
    children,
    align,
    className,
    ...props
  }: {
    children: React.ReactNode;
    align?: string;
    className?: string;
    [key: string]: unknown;
  }) => (
    <div className={className} data-align={align} data-testid="popover-content" {...props}>
      {children}
    </div>
  ),
  useToast: () => ({ toast: () => {} }),
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
  }) => {
    const [localSortField, setLocalSortField] = React.useState<string | undefined>(sortField);
    const [localSortDirection, setLocalSortDirection] = React.useState<'asc' | 'desc'>(
      sortDirection || 'asc'
    );

    const handleClick = () => {
      if (localSortField === field) {
        setLocalSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection('asc');
      }
      onSort?.(field);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    };

    return (
      <th
        aria-label={title}
        className={className}
        data-testid="sortable-header"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        scope="col"
        tabIndex={0}
        {...domProps}
      >
        <div className="flex items-center gap-1">
          {title}
          {localSortField === field &&
            (localSortDirection === 'asc' ? (
              <div data-testid="arrow-up" />
            ) : (
              <div data-testid="arrow-down" />
            ))}
        </div>
      </th>
    );
  },
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
          disabled={currentPage === 0}
          onClick={() => onPageChange?.(currentPage - 1)}
          type="button"
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
              onClick={() => onPageChange?.(pageNum)}
              style={{ margin: '0 2px' }}
              type="button"
            >
              {pageNum + 1}
            </button>
          ))}
        </div>
        <button
          disabled={currentPage >= totalPages - 1}
          onClick={() => onPageChange?.(currentPage + 1)}
          type="button"
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
          aria-label={`Select all files in group ${groupLabel}`}
          onChange={(e) => onSelectionChange?.(e.target.checked)}
          type="checkbox"
        />
      </td>
      <td>
        <button
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand group ${groupLabel}` : `Collapse group ${groupLabel}`}
          onClick={onToggleCollapse}
          type="button"
        >
          {groupLabel}
        </button>
      </td>
    </tr>
  ),
  Tabs: ({ children, value, defaultValue, onValueChange, ...props }: TabsProps) => {
    const [internalValue, setInternalValue] = React.useState<string | undefined>(defaultValue);
    const isControlled = value !== undefined;
    const activeValue = isControlled ? value : internalValue;

    const handleValueChange = (nextValue: string) => {
      if (!isControlled) {
        setInternalValue(nextValue);
      }
      onValueChange?.(nextValue);
    };

    const contextValue: TabsContextValue =
      activeValue === undefined
        ? { onValueChange: handleValueChange }
        : { value: activeValue, onValueChange: handleValueChange };

    return (
      <TabsContext.Provider value={contextValue}>
        <div data-testid="tabs" {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
  TabsList: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
    <div data-testid="tabs-list" role="tablist" {...props}>
      {children}
    </div>
  ),
  TabsTrigger: ({ children, value, disabled, onClick, ...props }: TabsTriggerProps) => {
    const context = React.useContext(TabsContext);
    const isActive = context?.value === value;

    const handleClick = () => {
      context?.onValueChange?.(value);
      onClick?.();
    };

    return (
      <button
        aria-selected={isActive}
        data-state={isActive ? 'active' : 'inactive'}
        disabled={disabled}
        onClick={handleClick}
        role="tab"
        type="button"
        {...props}
      >
        {children}
      </button>
    );
  },
  TabsContent: ({ children, value, forceMount, ...props }: TabsContentProps) => {
    const context = React.useContext(TabsContext);
    const isActive = context?.value === value;

    if (!(isActive || forceMount)) {
      return null;
    }

    return (
      <div
        data-state={isActive ? 'active' : 'inactive'}
        hidden={!isActive}
        role="tabpanel"
        {...props}
      >
        {children}
      </div>
    );
  },
  // biome-ignore lint/style/useReactFunctionComponents: ErrorBoundary must be a class component
  ErrorBoundary: class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean }
  > {
    constructor(props: { children: React.ReactNode }) {
      super(props);
      this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
      return { hasError: true };
    }

    override render() {
      if (this.state.hasError) {
        return <div data-testid="error-boundary">Error occurred</div>;
      }
      return this.props.children;
    }
  },
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

      // Reset to first page when total pages decreases or current page is out of bounds
      // biome-ignore lint/plugin: Intentional state reset on bounds change - matches real hook behavior
      useEffect(() => {
        if (prevTotalPagesRef.current !== totalPages) {
          const prev = prevTotalPagesRef.current;
          prevTotalPagesRef.current = totalPages;
          if ((prev > totalPages || currentPage >= totalPages) && totalPages > 0) {
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
  Columns3: () => <div data-testid="columns3" />,
  Download: () => <div data-testid="download" />,
  FileText: () => <div data-testid="file-text" />,
  FileX2: () => <div data-testid="file-x2" />,
  FolderOpen: () => <div data-testid="folder-open" />,
  Loader2: () => <div data-testid="loader" />,
  CheckCircle2: () => <div data-testid="check-circle" />,
  AlertTriangle: () => <div data-testid="alert" />,
  MinusCircle: () => <div data-testid="minus" />,
  Pencil: () => <div data-testid="pencil" />,
  Check: () => <div data-testid="checkmark" />,
  X: () => <div data-testid="x" />,
  Target: () => <div data-testid="target" />,
  TreePine: () => <div data-testid="tree-pine" />,
  Layers: () => <div data-testid="layers" />,
  Files: () => <div data-testid="files" />,
  CheckSquare: () => <div data-testid="check-square" />,
  LayoutGrid: () => <div data-testid="layout-grid" />,
  RotateCcw: () => <div data-testid="rotate-ccw" />,
  Table: () => <div data-testid="table" />,
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
      folderId: `folder-${Math.floor(Number.parseInt(key.replace('file', ''), 10) / 10)}`,
      path: `path/to/folder${Math.floor(Number.parseInt(key.replace('file', ''), 10) / 10)}/${key}.txt`,
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
  });

  const createMockState = (fileCount = 100) => ({
    batchSelectedFiles: new Set<string>(),
    collapsedFolders: new Set<string>(),
    totalStats: {
      totalFiles: fileCount,
      totalTokens: fileCount * 200, // Realistic token count
      pendingCount: 0, // BST-153: No files pending by default
    },
    handleRemoveFile: vi.fn(),
    handleBatchRemove: vi.fn(),
    toggleFileSelection: vi.fn(),
    toggleFolderCollapse: vi.fn(),
    handleSelectAll: vi.fn(),
    handleDeselectAll: vi.fn(),
    isAllFilesSelected: false,
    formatFileSize: vi.fn((bytes?: number) => {
      if (bytes === undefined) {
        return 'Unknown';
      }
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
    expandAllFolders: vi.fn(),
    collapseAllFolders: vi.fn(),
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
      const runStats = screen.getAllByText((_, element) => {
        const text = element?.textContent ?? '';
        return text.includes('25 files') && text.includes('5,000 selected');
      });
      expect(runStats.length > 0).toBe(true);

      // Select multiple files using aria-labels - files are in folder0 for file1-file9
      const file1Checkbox = screen.getByLabelText('Select path/to/folder0/file1.txt');
      const file2Checkbox = screen.getByLabelText('Select path/to/folder0/file2.txt');
      const file3Checkbox = screen.getByLabelText('Select path/to/folder0/file3.txt');

      expect(file1Checkbox).toBeInTheDocument();
      expect(file2Checkbox).toBeInTheDocument();
      expect(file3Checkbox).toBeInTheDocument();

      act(() => {
        fireEvent.click(file1Checkbox);
        fireEvent.click(file2Checkbox);
        fireEvent.click(file3Checkbox);
      });

      // Verify selection UI appears
      await waitFor(() => {
        expect(screen.getByText(/files selected in preview/)).toBeInTheDocument();
      });

      // Perform batch removal
      const removeButton = screen.getByText('Remove Selected from Project');
      act(() => {
        fireEvent.click(removeButton);
      });

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
      act(() => {
        fireEvent.click(pathHeader);
      });

      // Verify sorting was triggered (header remains interactive)
      expect(pathHeader).toBeInTheDocument();

      // Navigate to next page
      const nextButton = screen.getByText('Next');
      act(() => {
        fireEvent.click(nextButton);
      });

      expect(screen.getByText('Page 2 of 3 (120 total items)')).toBeInTheDocument();

      // Change sort direction
      act(() => {
        fireEvent.click(pathHeader);
      });

      // Verify the header is still interactive after multiple clicks
      expect(pathHeader).toBeInTheDocument();

      // Reset sort should go back to page 1
      const resetButton = screen.getByText('Reset Sort');
      act(() => {
        fireEvent.click(resetButton);
      });

      expect(screen.getByText('Page 1 of 3 (120 total items)')).toBeInTheDocument();
    });

    it('should handle folder operations with large datasets', () => {
      const mockProps = createMockProps(200);
      const mockState = createMockState(200);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Select all files globally
      const selectAllButton = screen.getByTestId('select-all-button');
      act(() => {
        fireEvent.click(selectAllButton);
      });

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
      const mixedStats = screen.getAllByText((_, element) => {
        const text = element?.textContent ?? '';
        return text.includes('50 files') && text.includes('10,000 selected');
      });
      expect(mixedStats.length > 0).toBe(true);
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
    });

    it('should handle dynamic file set changes', async () => {
      const mockProps = createMockProps(10);
      const mockState = createMockState(10);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      const { rerender } = render(<PreviewPanel {...mockProps} />);

      const pagedStats = screen.getAllByText((_, element) => {
        const text = element?.textContent ?? '';
        return text.includes('10 files') && text.includes('2,000 selected');
      });
      expect(pagedStats.length > 0).toBe(true);

      // Simulate adding more files
      const newMockProps = createMockProps(20);
      const newMockState = createMockState(20);
      mockUsePreviewPanelState.mockReturnValue(newMockState);

      rerender(<PreviewPanel {...newMockProps} />);

      const reducedStats = screen.getAllByText((_, element) => {
        const text = element?.textContent ?? '';
        return text.includes('20 files') && text.includes('4,000 selected');
      });
      expect(reducedStats.length > 0).toBe(true);
    });

    it('should maintain state consistency during operations', async () => {
      const mockProps = createMockProps(75);
      const mockState = createMockState(75);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Go to page 2
      const nextButton = screen.getByText('Next');
      act(() => {
        fireEvent.click(nextButton);
      });

      expect(screen.getByText('Page 2 of 2 (75 total items)')).toBeInTheDocument();

      // Select files on page 2 - first file on page 2 would be file50
      const file50Checkbox = screen.getByLabelText('Select path/to/folder5/file50.txt');
      expect(file50Checkbox).toBeInTheDocument();
      act(() => {
        fireEvent.click(file50Checkbox);
      });

      // Should show selection bar
      await waitFor(() => {
        expect(screen.getByText(/files selected in preview/)).toBeInTheDocument();
      });

      // Clear selection
      const clearButton = screen.getByText('Clear Preview Selection');
      act(() => {
        fireEvent.click(clearButton);
      });

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
      act(() => {
        fireEvent.click(nextButton);
        fireEvent.click(nextButton);
      });
      // Verify we navigated away from page 1 to the last page (don't depend on exact text structure)
      await waitFor(() => {
        const pageInfo = screen.getByText(
          (_content, el) =>
            (el?.textContent?.startsWith('Page') ?? false) &&
            (el?.textContent?.includes('(120 total items)') ?? false)
        );
        expect(pageInfo.textContent).not.toContain('Page 1 of');
      });

      // Rerender with fewer files resulting in two pages
      const fewerProps = createMockProps(60);
      const fewerState = createMockState(60);
      mockUsePreviewPanelState.mockReturnValue(fewerState);

      act(() => {
        rerender(<PreviewPanel {...fewerProps} />);
      });

      // Assert via the pagination container to avoid brittle text-node matching
      await waitFor(() => {
        const pagination = screen.getByTestId('table-pagination');
        expect(pagination).toBeInTheDocument();
        const text = pagination.textContent ?? '';
        expect(text).toContain('Page 1 of 2');
        expect(text).toContain('(60 total items)');
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
      expect(folderHeader).toHaveAttribute('tabIndex', '0');

      act(() => {
        fireEvent.keyDown(folderHeader, { key: 'Enter' });
      });

      // Test space key
      act(() => {
        fireEvent.keyDown(folderHeader, { key: ' ' });
      });

      // Verify the header is interactive
      expect(folderHeader).toHaveAttribute('aria-label', 'Folder');

      // All interactive elements should have proper labels
      const selectAllCheckbox = screen.getByLabelText('Select all files on current page');
      expect(selectAllCheckbox).toHaveAttribute('aria-label', 'Select all files on current page');
    });
  });
});
