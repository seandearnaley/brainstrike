import React from 'react';
import { vi } from 'vitest';

interface MockComponentProps extends Record<string, unknown> {
  children?: React.ReactNode;
}

interface MockSortableHeaderProps extends MockComponentProps {
  title: string;
  onSort: (field: string) => void;
  field: string;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
}

interface MockTablePaginationProps extends MockComponentProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalItems?: number;
  pageInfo?: string;
  maxPageButtons?: number;
}

interface MockTableGroupHeaderProps extends MockComponentProps {
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
}

interface UsePaginationOptions {
  totalItems: number;
  pageSize?: number;
}

interface PaginationState {
  currentPage: number;
  prevTotalPages: number;
}

const INITIAL_PAGINATION_STATE: PaginationState = {
  currentPage: 0,
  prevTotalPages: 0,
};

let sharedPaginationState: PaginationState = { ...INITIAL_PAGINATION_STATE };

const updateSharedCurrentPage = (page: number) => {
  sharedPaginationState = {
    ...sharedPaginationState,
    currentPage: page,
  };
};

const updateSharedTotalPages = (totalPages: number) => {
  sharedPaginationState = {
    ...sharedPaginationState,
    prevTotalPages: totalPages,
  };
};

const clampPage = (page: number, totalPages: number) => {
  if (totalPages <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(page, totalPages - 1));
};

export const resetPreviewPanelPaginationMockState = () => {
  sharedPaginationState = { ...INITIAL_PAGINATION_STATE };
};

export const createUsePreviewPanelStateMock = () => ({
  usePreviewPanelState: vi.fn(),
  formatTokenCount: (tokens: number) => {
    if (tokens < 1000) {
      return tokens.toString();
    }
    if (tokens < 1000000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return `${(tokens / 1000000).toFixed(1)}M`;
  },
});

export const createUiModuleMock = () => ({
  Badge: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="badge" {...props}>
      {children}
    </div>
  ),
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: MockComponentProps & { onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} data-testid="button" {...props}>
      {children}
    </button>
  ),
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: MockComponentProps & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      data-testid="checkbox"
      {...props}
    />
  ),
  Progress: ({ value, ...props }: MockComponentProps & { value?: number }) => (
    <div data-testid="progress" data-value={value} {...props} />
  ),
  Popover: ({ children, open, ...props }: MockComponentProps & { open?: boolean }) => (
    <div data-testid="popover" data-open={open} {...props}>
      {children}
    </div>
  ),
  PopoverTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: MockComponentProps & { asChild?: boolean }) => (
    <div data-testid="popover-trigger" {...props}>
      {children}
    </div>
  ),
  PopoverContent: ({
    children,
    align,
    className,
    ...props
  }: MockComponentProps & { align?: string; className?: string }) => (
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
  }: MockSortableHeaderProps & { className?: string }) => {
    const [localSortField, setLocalSortField] = React.useState<string | undefined>(sortField);
    const [localSortDirection, setLocalSortDirection] = React.useState<'asc' | 'desc'>(
      sortDirection ?? 'asc'
    );

    const handleClick = () => {
      if (localSortField === field) {
        setLocalSortDirection((previous) => (previous === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection('asc');
      }
      onSort?.(field);
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleClick();
      }
    };

    return (
      <th
        aria-label={title}
        data-testid="sortable-header"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={className}
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
  }: MockTablePaginationProps) => {
    const getPageNumbers = () => {
      const maxButtons = maxPageButtons ?? 5;
      const halfMax = Math.floor(maxButtons / 2);

      if (totalPages <= maxButtons) {
        return Array.from({ length: totalPages }, (_, index) => index);
      }

      if (currentPage < halfMax) {
        return Array.from({ length: maxButtons }, (_, index) => index);
      }

      if (currentPage > totalPages - Math.ceil(maxButtons / 2) - 1) {
        return Array.from({ length: maxButtons }, (_, index) => totalPages - maxButtons + index);
      }

      const startPage = currentPage - halfMax;
      return Array.from({ length: maxButtons }, (_, index) => startPage + index);
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
          {getPageNumbers().map((pageNumber) => (
            <button
              key={pageNumber}
              type="button"
              onClick={() => onPageChange?.(pageNumber)}
              style={{ margin: '0 2px' }}
            >
              {pageNumber + 1}
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
    groupKey: _groupKey,
    isFullySelected: _isFullySelected,
    isPartiallySelected: _isPartiallySelected,
    isGroupSelected: _isGroupSelected,
    isIndeterminate: _isIndeterminate,
    filesInGroup: _filesInGroup,
    ...domProps
  }: MockTableGroupHeaderProps) => (
    <tr data-testid="table-group-header" {...domProps}>
      <td>
        <input
          type="checkbox"
          onChange={(event) => onSelectionChange?.(event.target.checked)}
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
});

export const createHooksModuleMock = () => {
  const reactModule = require('react') as typeof import('react');
  const { useState } = reactModule;

  return {
    usePagination: vi.fn((options: UsePaginationOptions) => {
      const pageSize = options.pageSize ?? 50;
      const totalPages = Math.ceil(options.totalItems / pageSize);

      if (totalPages !== sharedPaginationState.prevTotalPages) {
        if (sharedPaginationState.currentPage >= totalPages && totalPages > 0) {
          updateSharedCurrentPage(0);
        }
        updateSharedTotalPages(totalPages);
      }

      const [currentPage, setCurrentPage] = useState(sharedPaginationState.currentPage);

      if (currentPage !== sharedPaginationState.currentPage) {
        setCurrentPage(sharedPaginationState.currentPage);
      }

      const startIndex = currentPage * pageSize;
      const endIndex = Math.min(startIndex + pageSize, options.totalItems);

      const goToPage = vi.fn((page: number) => {
        const newPage = clampPage(page, totalPages);
        setCurrentPage(newPage);
        updateSharedCurrentPage(newPage);
      });

      const goToNextPage = vi.fn(() => {
        if (currentPage < totalPages - 1) {
          const newPage = currentPage + 1;
          setCurrentPage(newPage);
          updateSharedCurrentPage(newPage);
        }
      });

      const goToPreviousPage = vi.fn(() => {
        if (currentPage > 0) {
          const newPage = currentPage - 1;
          setCurrentPage(newPage);
          updateSharedCurrentPage(newPage);
        }
      });

      const resetToFirstPage = vi.fn(() => {
        setCurrentPage(0);
        updateSharedCurrentPage(0);
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
};

export const createLucideModuleMock = () => ({
  Columns3: () => <div data-testid="columns3" />,
  Download: () => <div data-testid="download" />,
  FileText: () => <div data-testid="file-text" />,
  FileX2: () => <div data-testid="file-x2" />,
  FolderOpen: () => <div data-testid="folder-open" />,
  Loader2: () => <div data-testid="loader" />,
  CheckCircle2: () => <div data-testid="check" />,
  AlertTriangle: () => <div data-testid="alert" />,
  MinusCircle: () => <div data-testid="minus" />,
});
