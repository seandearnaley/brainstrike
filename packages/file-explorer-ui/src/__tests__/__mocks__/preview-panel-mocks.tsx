import React from 'react';
import type { Mock } from 'vitest';
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
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
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

interface TabsContextValue {
  value?: string;
  onValueChange?: (value: string) => void;
}

type TabsProps = MockComponentProps & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

type TabsTriggerProps = MockComponentProps & {
  value: string;
  disabled?: boolean;
  onClick?: () => void;
};

type TabsContentProps = MockComponentProps & {
  value: string;
  forceMount?: boolean;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

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

interface UsePreviewPanelStateMockReturn {
  usePreviewPanelState: Mock;
  formatTokenCount: (tokens: number) => string;
}

export const createUsePreviewPanelStateMock = (): UsePreviewPanelStateMockReturn => ({
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
});

export const createUiModuleMock = () => ({
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(' '),
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
    <button data-testid="button" disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  // biome-ignore lint/style/useReactFunctionComponents: ErrorBoundary must be a class component
  ErrorBoundary: class ErrorBoundary extends React.Component<
    MockComponentProps,
    { hasError: boolean }
  > {
    constructor(props: MockComponentProps) {
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
  Input: ({
    ref,
    ...props
  }: MockComponentProps & { ref?: React.RefObject<HTMLInputElement | null> }) => (
    <input data-testid="input" ref={ref} {...props} />
  ),
  TooltipProvider: ({ children }: MockComponentProps) => <>{children}</>,
  Tooltip: ({ children }: MockComponentProps) => <>{children}</>,
  TooltipTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: MockComponentProps & { asChild?: boolean }) => (
    <div data-testid="tooltip-trigger" {...props}>
      {children}
    </div>
  ),
  TooltipContent: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="tooltip-content" {...props}>
      {children}
    </div>
  ),
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: MockComponentProps & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
    <input
      checked={Boolean(checked)}
      data-testid="checkbox"
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
      {...props}
    />
  ),
  LightweightCheckbox: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: MockComponentProps & {
    checked?: boolean | 'indeterminate';
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      aria-checked={checked === 'indeterminate' ? 'mixed' : Boolean(checked)}
      checked={checked === true}
      data-testid="lightweight-checkbox"
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
      {...props}
    />
  ),
  Switch: ({
    checked,
    id,
    onCheckedChange,
    ...props
  }: MockComponentProps & {
    checked?: boolean;
    id?: string;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      aria-checked={Boolean(checked)}
      checked={Boolean(checked)}
      data-testid="switch"
      id={id}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      role="switch"
      type="checkbox"
      {...props}
    />
  ),
  Label: ({
    children,
    htmlFor,
    ...props
  }: MockComponentProps & { htmlFor?: string | undefined }) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  Progress: ({ value, ...props }: MockComponentProps & { value?: number }) => (
    <div data-testid="progress" data-value={value} {...props} />
  ),
  EmptyState: ({
    title,
    description,
    icon,
  }: {
    title: string;
    description?: string;
    icon?: React.ReactNode;
  }) => (
    <div data-testid="empty-state">
      {icon && <div data-testid="empty-state-icon">{icon}</div>}
      {title && <h3>{title}</h3>}
      {description && <p>{description}</p>}
    </div>
  ),
  Popover: ({
    children,
    open,
    onOpenChange: _onOpenChange,
    ...props
  }: MockComponentProps & { open?: boolean; onOpenChange?: (open: boolean) => void }) => (
    <div data-open={open} data-testid="popover" {...props}>
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
    <div className={className} data-align={align} data-testid="popover-content" {...props}>
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
    pageSize = 50,
    onPageSizeChange,
    ...domProps
  }: MockTablePaginationProps) => {
    // Calculate item range
    const startItem = totalItems === 0 ? 0 : currentPage * pageSize + 1;
    const endItem = Math.min((currentPage + 1) * pageSize, totalItems ?? 0);

    return (
      <div data-testid="table-pagination" {...domProps}>
        {onPageSizeChange && (
          <span>
            Show{' '}
            <select
              aria-label="Items per page"
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              value={pageSize}
            >
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </span>
        )}
        <button
          aria-label="Go to first page"
          disabled={currentPage === 0}
          onClick={() => onPageChange?.(0)}
          type="button"
        >
          ⏮
        </button>
        <button
          aria-label="Go to previous page"
          disabled={currentPage === 0}
          onClick={() => onPageChange?.(currentPage - 1)}
          type="button"
        >
          ◀
        </button>
        <input
          aria-label="Page number"
          max={totalPages}
          min={1}
          onChange={(e) => {
            const val = Number.parseInt(e.target.value, 10);
            if (!Number.isNaN(val) && val >= 1 && val <= totalPages) {
              onPageChange?.(val - 1); // Convert to 0-indexed
            }
          }}
          type="number"
          value={currentPage + 1}
        />
        <span data-testid="page-info">of {totalPages}</span>
        <button
          aria-label="Go to next page"
          disabled={currentPage >= totalPages - 1}
          onClick={() => onPageChange?.(currentPage + 1)}
          type="button"
        >
          ▶
        </button>
        <button
          aria-label="Go to last page"
          disabled={currentPage >= totalPages - 1}
          onClick={() => onPageChange?.(totalPages - 1)}
          type="button"
        >
          ⏭
        </button>
        <span data-testid="item-range">
          {totalItems ? `${startItem}-${endItem} of ${totalItems}` : 'No items'}
          {pageInfo ? ` ${pageInfo}` : ''}
        </span>
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
          aria-label={`Select all files in group ${groupLabel}`}
          onChange={(event) => onSelectionChange?.(event.target.checked)}
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
  TabsList: ({ children, ...props }: MockComponentProps) => (
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
  useToast: () => ({ toast: () => {} }),
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
  Maximize2: () => <div data-testid="maximize" />,
  Minimize2: () => <div data-testid="minimize" />,
  RefreshCw: () => <div data-testid="refresh-cw" />,
  RotateCcw: () => <div data-testid="rotate-ccw" />,
  Sparkles: () => <div data-testid="sparkles" />,
  Table: () => <div data-testid="table" />,
});
