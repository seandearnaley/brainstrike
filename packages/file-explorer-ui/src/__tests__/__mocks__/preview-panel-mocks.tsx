import React from 'react';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

interface MockComponentProps extends Record<string, unknown> {
  children?: React.ReactNode;
}

interface MockTablePaginationProps extends MockComponentProps {
  currentPage: number;
  onPageChange: (page: number) => void;
  pageInfo?: string;
  pageSize?: number;
  totalItems?: number;
  totalPages: number;
}

interface MockTreeNode {
  data: unknown;
  depth: number;
  hasChildren: boolean;
  id: string;
  parentId: string | null;
  type: string;
}

interface MockTreeTableCellProps {
  depth: number;
  isExpanded: boolean;
  isHighlighted: boolean;
  isInContext: boolean;
  isSelected: boolean;
  node: MockTreeNode;
  rowIndex: number;
}

interface MockTreeTableColumn {
  cell: (props: MockTreeTableCellProps) => React.ReactNode;
  header?: React.ReactNode;
  id: string;
}

interface MockTreeTableProps extends MockComponentProps {
  ariaLabel?: string;
  className?: string;
  columns: MockTreeTableColumn[];
  expandedIds: Set<string>;
  nodes: MockTreeNode[];
  onToggleExpand: (nodeId: string) => void;
}

interface DropdownMenuRadioContextValue {
  onValueChange: ((value: string) => void) | undefined;
  value: string | undefined;
}

const DropdownMenuRadioContext = React.createContext<DropdownMenuRadioContextValue | null>(null);

interface UsePaginationOptions {
  pageSize?: number;
  totalItems: number;
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
  formatTokenCount: (tokens: number) => string;
  usePreviewPanelState: Mock;
}

export const createUsePreviewPanelStateMock = (): UsePreviewPanelStateMockReturn => ({
  formatTokenCount: (tokens: number) => {
    if (tokens < 1000) {
      return tokens.toString();
    }
    if (tokens < 1_000_000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  },
  usePreviewPanelState: vi.fn(),
});

/**
 * Mocked `@brainstrike/ui`. Layout CONSTANTS come from the real module via
 * `importActual` rather than being re-spelled here — a mock that hardcodes
 * `pb-20` would keep passing after the real constant changed.
 */
export const createUiModuleMock = async () => ({
  ...(await vi.importActual<{ SELECTION_BAR_SCROLL_PADDING: string }>(
    '@brainstrike/ui/selection-bar-layout'
  )),
  ActionContextMenu: ({ children }: MockComponentProps) => <>{children}</>,
  Badge: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="badge" {...props}>
      {children}
    </div>
  ),
  BulkActionBar: ({
    actions,
    clearButtonAriaLabel,
    clearButtonLabel,
    compact: _compact,
    nodeTypes: _nodeTypes,
    onClearSelection,
    selectedIds,
    summarySubtext: _summarySubtext,
    summarySubtextTitle: _summarySubtextTitle,
    summaryText,
    ...props
  }: MockComponentProps & {
    actions?: Array<{ id: string; label: string; onAction?: () => void }>;
    clearButtonAriaLabel?: string;
    clearButtonLabel?: string;
    compact?: boolean;
    nodeTypes?: Map<string, string>;
    onClearSelection?: () => void;
    selectedIds?: Set<string>;
    summarySubtext?: string | null;
    summarySubtextTitle?: string;
    summaryText?: string;
  }) => {
    if (!selectedIds || selectedIds.size === 0) {
      return null;
    }

    return (
      <div data-testid="bulk-action-bar" {...props}>
        <span>{summaryText ?? `${selectedIds.size} selected`}</span>
        {actions?.map((action) => (
          <button key={action.id} onClick={action.onAction} type="button">
            {action.label}
          </button>
        ))}
        <button
          aria-label={clearButtonAriaLabel ?? 'Clear selection'}
          onClick={onClearSelection}
          type="button"
        >
          {clearButtonLabel ?? 'Clear'}
        </button>
      </div>
    );
  },
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
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: MockComponentProps & {
    checked?: boolean | 'indeterminate';
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      aria-checked={checked === 'indeterminate' ? 'mixed' : Boolean(checked)}
      checked={checked === true}
      data-testid="checkbox"
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
      {...props}
    />
  ),
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(' '),
  DropdownMenu: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="dropdown-menu" {...props}>
      {children}
    </div>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
    ...props
  }: MockComponentProps & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      aria-checked={Boolean(checked)}
      onClick={() => onCheckedChange?.(!checked)}
      role="menuitemcheckbox"
      type="button"
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuContent: ({
    children,
    align,
    className,
    ...props
  }: MockComponentProps & { align?: string; className?: string }) => (
    <div className={className} data-align={align} data-testid="dropdown-menu-content" {...props}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: MockComponentProps & { onSelect?: () => void }) => (
    <button onClick={onSelect} role="menuitem" type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: MockComponentProps) => (
    <div {...props}>{children}</div>
  ),
  DropdownMenuRadioGroup: ({
    children,
    onValueChange,
    value,
    ...props
  }: MockComponentProps & { onValueChange?: (value: string) => void; value?: string }) => (
    <DropdownMenuRadioContext.Provider value={{ onValueChange, value }}>
      <div data-testid="dropdown-menu-radio-group" {...props}>
        {children}
      </div>
    </DropdownMenuRadioContext.Provider>
  ),
  DropdownMenuRadioItem: ({
    children,
    value,
    ...props
  }: MockComponentProps & { value: string }) => {
    const context = React.use(DropdownMenuRadioContext);
    return (
      <button
        aria-checked={context?.value === value}
        data-testid={`dropdown-menu-radio-item-${value}`}
        onClick={() => context?.onValueChange?.(value)}
        role="menuitemradio"
        type="button"
        {...props}
      >
        {children}
      </button>
    );
  },
  DropdownMenuSeparator: (props: MockComponentProps) => <hr {...props} />,
  DropdownMenuTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: MockComponentProps & { asChild?: boolean }) => (
    <div data-testid="dropdown-menu-trigger" {...props}>
      {children}
    </div>
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
  Label: ({
    children,
    htmlFor,
    ...props
  }: MockComponentProps & { htmlFor?: string | undefined }) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
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
  PopoverTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: MockComponentProps & { asChild?: boolean }) => (
    <div data-testid="popover-trigger" {...props}>
      {children}
    </div>
  ),
  Progress: ({ value, ...props }: MockComponentProps & { value?: number }) => (
    <div data-testid="progress" data-value={value} {...props} />
  ),
  SelectionActionBarOverlay: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="selection-action-overlay" {...props}>
      {children}
    </div>
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
  TablePagination: ({
    currentPage,
    totalPages,
    onPageChange,
    totalItems,
    pageInfo,
    pageSize = 50,
    ...domProps
  }: MockTablePaginationProps) => {
    // Calculate item range
    const startItem = totalItems === 0 ? 0 : currentPage * pageSize + 1;
    const endItem = Math.min((currentPage + 1) * pageSize, totalItems ?? 0);

    return (
      <div data-testid="table-pagination" {...domProps}>
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
  Tooltip: ({ children }: MockComponentProps) => <>{children}</>,
  TooltipContent: ({ children, ...props }: MockComponentProps) => (
    <div data-testid="tooltip-content" {...props}>
      {children}
    </div>
  ),
  TooltipProvider: ({ children }: MockComponentProps) => <>{children}</>,
  TooltipTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: MockComponentProps & { asChild?: boolean }) => (
    <div data-testid="tooltip-trigger" {...props}>
      {children}
    </div>
  ),
  TreeTable: ({
    ariaLabel,
    className,
    columns,
    nodes,
    expandedIds,
    onToggleExpand,
  }: MockTreeTableProps) => (
    <div aria-label={ariaLabel} className={className} role="treegrid">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col">
                {column.header ?? column.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes
            .filter((node) => node.parentId === null || expandedIds.has(node.parentId))
            .map((node, rowIndex) => {
              const isExpanded = expandedIds.has(node.id);
              return (
                <tr data-node-id={node.id} key={node.id}>
                  {columns.map((column, columnIndex) => (
                    <td key={column.id}>
                      {columnIndex === 0 && node.hasChildren && (
                        <button
                          aria-label={isExpanded ? 'Collapse' : 'Expand'}
                          onClick={() => onToggleExpand(node.id)}
                          type="button"
                        >
                          {isExpanded ? '▼' : '▶'}
                        </button>
                      )}
                      {column.cell({
                        depth: node.depth,
                        isExpanded,
                        isHighlighted: false,
                        isInContext: false,
                        isSelected: false,
                        node,
                        rowIndex,
                      })}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  ),
  useContextMenuTarget: () => {
    const [target, setTargetState] = React.useState<unknown>(null);
    const targetRef = React.useRef<unknown>(null);
    const setTarget = React.useCallback((nextTarget: unknown) => {
      targetRef.current = nextTarget;
      setTargetState(nextTarget);
    }, []);
    return { setTarget, target, targetRef };
  },
  useToast: () => ({ toast: () => {} }),
});

export const createHooksModuleMock = () => {
  const reactModule = require('react') as typeof import('react');
  const { useState } = reactModule;

  return {
    useEventCallback: <TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult) =>
      callback,
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
        endIndex,
        goToNextPage,
        goToPage,
        goToPreviousPage,
        isFirstPage: currentPage === 0,
        isLastPage: currentPage >= totalPages - 1 || totalPages <= 1,
        resetToFirstPage,
        startIndex,
        totalPages,
      };
    }),
  };
};

export const createLucideModuleMock = () => ({
  AlertTriangle: () => <div data-testid="alert" />,
  ArrowLeft: () => <div data-testid="arrow-left" />,
  Check: () => <div data-testid="checkmark" />,
  CheckCircle2: () => <div data-testid="check-circle" />,
  CheckSquare: () => <div data-testid="check-square" />,
  ChevronDown: () => <div data-testid="chevron-down" />,
  ChevronRight: () => <div data-testid="chevron-right" />,
  ChevronsDownUp: () => <div data-testid="chevrons-down-up" />,
  ChevronsUpDown: () => <div data-testid="chevrons-up-down" />,
  ChevronUp: () => <div data-testid="chevron-up" />,
  Columns3: () => <div data-testid="columns3" />,
  Download: () => <div data-testid="download" />,
  Files: () => <div data-testid="files" />,
  FileText: () => <div data-testid="file-text" />,
  FileX2: () => <div data-testid="file-x2" />,
  FolderOpen: () => <div data-testid="folder-open" />,
  GripVertical: () => <div data-testid="grip-vertical" />,
  Group: () => <div data-testid="group" />,
  Layers: () => <div data-testid="layers" />,
  LayoutGrid: () => <div data-testid="layout-grid" />,
  ListChecks: () => <div data-testid="list-checks" />,
  Loader2: () => <div data-testid="loader" />,
  Maximize2: () => <div data-testid="maximize" />,
  Minimize2: () => <div data-testid="minimize" />,
  MinusCircle: () => <div data-testid="minus" />,
  MoreHorizontal: () => <div data-testid="more-horizontal" />,
  Pencil: () => <div data-testid="pencil" />,
  RefreshCw: () => <div data-testid="refresh-cw" />,
  RotateCcw: () => <div data-testid="rotate-ccw" />,
  ScanSearch: () => <div data-testid="scan-search" />,
  Sparkles: () => <div data-testid="sparkles" />,
  Table: () => <div data-testid="table" />,
  Target: () => <div data-testid="target" />,
  TreePine: () => <div data-testid="tree-pine" />,
  X: () => <div data-testid="x" />,
  ZoomIn: () => <div data-testid="zoom-in" />,
  ZoomOut: () => <div data-testid="zoom-out" />,
});
