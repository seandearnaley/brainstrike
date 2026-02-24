import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './button';
import { useResizeObserver } from './hooks/use-resize-observer';
import { Input } from './input';
import { cn } from './lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500, 1000] as const;
/** Fallback page size when no options are available */
const DEFAULT_FALLBACK_PAGE_SIZE = 50;
const COMPACT_PAGINATION_BREAKPOINT = 640;
const MINI_PAGINATION_BREAKPOINT = 500;
const PAGINATION_DENSITY_HYSTERESIS_PX = 20;

type PaginationDensity = 'auto' | 'full' | 'compact' | 'mini';
type ResolvedPaginationDensity = Exclude<PaginationDensity, 'auto'>;

function resolveAutoPaginationDensity(
  containerWidth: number | null,
  currentDensity: ResolvedPaginationDensity
): ResolvedPaginationDensity {
  // Tests and initial renders can report zero width; default to full until we get real dimensions.
  if (containerWidth === null || containerWidth <= 0 || !Number.isFinite(containerWidth)) {
    return currentDensity;
  }
  if (currentDensity === 'mini') {
    if (containerWidth <= MINI_PAGINATION_BREAKPOINT + PAGINATION_DENSITY_HYSTERESIS_PX) {
      return 'mini';
    }
    return containerWidth <= COMPACT_PAGINATION_BREAKPOINT ? 'compact' : 'full';
  }
  if (currentDensity === 'compact') {
    if (containerWidth <= MINI_PAGINATION_BREAKPOINT) {
      return 'mini';
    }
    if (containerWidth <= COMPACT_PAGINATION_BREAKPOINT + PAGINATION_DENSITY_HYSTERESIS_PX) {
      return 'compact';
    }
    return 'full';
  }
  if (containerWidth <= MINI_PAGINATION_BREAKPOINT) {
    return 'mini';
  }
  if (containerWidth <= COMPACT_PAGINATION_BREAKPOINT) {
    return 'compact';
  }
  return 'full';
}

function resolvePaginationDensity(
  density: PaginationDensity,
  containerWidth: number | null,
  currentDensity: ResolvedPaginationDensity
): ResolvedPaginationDensity {
  if (density !== 'auto') {
    return density;
  }
  return resolveAutoPaginationDensity(containerWidth, currentDensity);
}

function resolvePageSizeSelectWidthClass(density: ResolvedPaginationDensity): string {
  switch (density) {
    case 'compact':
      return 'w-[72px]';
    case 'mini':
      return 'w-[64px]';
    default:
      return 'w-[80px]';
  }
}

function formatRangeSummary(args: {
  showItemRange: boolean;
  pageInfo: string | undefined;
  totalItems: number;
  resolvedDensity: ResolvedPaginationDensity;
  startItem: number;
  endItem: number;
}): string {
  if (!args.showItemRange) {
    return args.pageInfo ?? '';
  }
  if (args.totalItems === 0) {
    return 'No items';
  }
  const formattedTotalItems = args.totalItems.toLocaleString();
  if (args.resolvedDensity === 'compact') {
    return `${args.startItem}-${args.endItem}/${formattedTotalItems}`;
  }
  return `${args.startItem}-${args.endItem} of ${formattedTotalItems}${args.pageInfo ? ` ${args.pageInfo}` : ''}`;
}

interface PageSizeControlProps {
  onPageSizeChange: ((value: string) => void) | undefined;
  pageSize: number | undefined;
  actualPageSizeOptions: readonly number[];
  isCompactDensity: boolean;
  resolvedDensity: ResolvedPaginationDensity;
}

function PageSizeControl({
  onPageSizeChange,
  pageSize,
  actualPageSizeOptions,
  isCompactDensity,
  resolvedDensity,
}: PageSizeControlProps): React.ReactNode {
  if (!(onPageSizeChange && pageSize !== undefined)) {
    return null;
  }

  return (
    <>
      {!isCompactDensity && <span className="text-muted-foreground text-xs">Show</span>}
      <Select onValueChange={onPageSizeChange} value={String(pageSize)}>
        <SelectTrigger
          aria-label="Items per page"
          className={cn(
            'h-7 text-xs tabular-nums [&>svg]:h-3 [&>svg]:w-3',
            resolvePageSizeSelectWidthClass(resolvedDensity)
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {actualPageSizeOptions.map((size) => (
            <SelectItem className="text-xs" key={size} value={String(size)}>
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

interface NavigationControlsProps {
  isMiniDensity: boolean;
  isCompactDensity: boolean;
  isFirstPage: boolean;
  isLastPage: boolean;
  totalPages: number;
  totalItems: number;
  inputValue: string;
  onGoToFirstPage: () => void;
  onGoToPreviousPage: () => void;
  onGoToNextPage: () => void;
  onGoToLastPage: () => void;
  onInputBlur: () => void;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInputFocus: () => void;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

function NavigationControls({
  isMiniDensity,
  isCompactDensity,
  isFirstPage,
  isLastPage,
  totalPages,
  totalItems,
  inputValue,
  onGoToFirstPage,
  onGoToPreviousPage,
  onGoToNextPage,
  onGoToLastPage,
  onInputBlur,
  onInputChange,
  onInputFocus,
  onInputKeyDown,
}: NavigationControlsProps): React.ReactNode {
  return (
    <div className="flex shrink-0 items-center justify-center gap-1">
      {!isMiniDensity && (
        <Button
          aria-label="Go to first page"
          className="h-7 w-7 p-0"
          disabled={isFirstPage}
          onClick={onGoToFirstPage}
          size="sm"
          variant="ghost"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
      )}
      <Button
        aria-label="Go to previous page"
        className="h-7 w-7 p-0"
        disabled={isFirstPage}
        onClick={onGoToPreviousPage}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className={cn('flex items-center gap-1 px-1', isMiniDensity && 'px-0.5')}>
        <Input
          aria-label="Page number"
          className={cn(
            'h-7 px-2 text-center text-xs tabular-nums',
            isMiniDensity ? 'w-11 px-1.5' : isCompactDensity ? 'w-12' : 'w-14'
          )}
          disabled={totalPages === 0}
          max={totalPages}
          min={1}
          onBlur={onInputBlur}
          onChange={onInputChange}
          onFocus={onInputFocus}
          onKeyDown={onInputKeyDown}
          type="number"
          value={inputValue}
        />
        <span
          className={cn(
            'whitespace-nowrap text-muted-foreground text-xs tabular-nums',
            isMiniDensity ? 'min-w-0' : 'min-w-[4rem]'
          )}
        >
          {isMiniDensity ? `/${totalPages}` : `of ${totalPages}`}
        </span>
      </div>

      <Button
        aria-label="Go to next page"
        className="h-7 w-7 p-0"
        disabled={isLastPage}
        onClick={onGoToNextPage}
        size="sm"
        variant="ghost"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      {!isMiniDensity && (
        <Button
          aria-label="Go to last page"
          className="h-7 w-7 p-0"
          disabled={isLastPage}
          onClick={onGoToLastPage}
          size="sm"
          variant="ghost"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      )}
      <span className="sr-only">
        {totalItems === 0 ? 'No items available' : `${totalItems.toLocaleString()} total items`}
      </span>
    </div>
  );
}

interface RangeSummaryProps {
  shouldRenderRangeSummary: boolean;
  rangeSummary: string;
}

function RangeSummary({
  shouldRenderRangeSummary,
  rangeSummary,
}: RangeSummaryProps): React.ReactNode {
  if (!shouldRenderRangeSummary) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-1 justify-end text-muted-foreground text-xs tabular-nums">
      <span className="truncate" title={rangeSummary}>
        {rangeSummary}
      </span>
    </div>
  );
}

interface TablePaginationProps {
  /** Current page index (0-based) */
  currentPage: number;
  /** Total number of pages */
  totalPages: number;
  /** Total number of items across all pages */
  totalItems: number;
  /** Callback when page changes */
  onPageChange: (page: number) => void;
  /** Optional additional page info text */
  pageInfo?: string;
  /** Current page size (items per page) */
  pageSize?: number;
  /** Callback when page size changes */
  onPageSizeChange?: (pageSize: number) => void;
  /** Available page size options */
  pageSizeOptions?: readonly number[];
  /** Whether to show the item range display (e.g., "Showing 1-50 of 500") */
  showItemRange?: boolean;
  /** Pagination density. Use `auto` to adapt to container width. */
  density?: PaginationDensity;
}

export const TablePagination = memo<TablePaginationProps>(function TablePaginationComponent({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
  pageInfo,
  pageSize,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  showItemRange = true,
  density = 'auto',
}) {
  // Track focus state to determine whether to show user input or synced value
  const [isFocused, setIsFocused] = useState(false);
  const [editValue, setEditValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [autoDensity, setAutoDensity] = useState<ResolvedPaginationDensity>('full');
  const displayPage = currentPage + 1;

  // When focused, show user's edit; when not focused, always show current page
  const inputValue = isFocused ? editValue : String(displayPage);

  const goToFirstPage = useCallback(() => {
    onPageChange(0);
  }, [onPageChange]);

  const goToPreviousPage = useCallback(() => {
    onPageChange(Math.max(currentPage - 1, 0));
  }, [currentPage, onPageChange]);

  const goToNextPage = useCallback(() => {
    if (totalPages > 0) {
      onPageChange(Math.min(currentPage + 1, totalPages - 1));
    }
  }, [currentPage, totalPages, onPageChange]);

  const goToLastPage = useCallback(() => {
    if (totalPages > 0) {
      onPageChange(totalPages - 1);
    }
  }, [totalPages, onPageChange]);

  const handleInputFocus = useCallback(() => {
    setIsFocused(true);
    setEditValue(String(displayPage));
  }, [displayPage]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  const handleInputBlur = useCallback(() => {
    const parsed = Number.parseInt(editValue, 10);
    setIsFocused(false);
    if (Number.isNaN(parsed) || parsed < 1) {
      // Reset to current page on invalid input so next focus shows correct value
      setEditValue(String(displayPage));
      return;
    }
    const clampedPage = Math.min(Math.max(parsed, 1), totalPages);
    if (clampedPage !== displayPage) {
      onPageChange(clampedPage - 1);
    }
  }, [editValue, displayPage, totalPages, onPageChange]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setIsFocused(false);
      e.currentTarget.blur();
    }
  }, []);

  const handlePageSizeChange = useCallback(
    (value: string) => {
      const newPageSize = Number.parseInt(value, 10);
      if (!Number.isNaN(newPageSize) && onPageSizeChange) {
        onPageSizeChange(newPageSize);
      }
    },
    [onPageSizeChange]
  );

  // Ensure we have valid page size options (fallback to defaults if empty array passed)
  const actualPageSizeOptions =
    pageSizeOptions.length > 0 ? pageSizeOptions : DEFAULT_PAGE_SIZE_OPTIONS;

  // Calculate item range for display
  const effectivePageSize = pageSize ?? actualPageSizeOptions[0] ?? DEFAULT_FALLBACK_PAGE_SIZE;
  const startItem = totalItems === 0 ? 0 : currentPage * effectivePageSize + 1;
  const endItem = Math.min((currentPage + 1) * effectivePageSize, totalItems);

  const handleContainerResize = useCallback((entry: ResizeObserverEntry) => {
    const width = entry.contentRect.width;
    if (!Number.isFinite(width) || width <= 0) {
      return;
    }
    setContainerWidth((previousWidth) => (previousWidth === width ? previousWidth : width));
  }, []);

  const shouldHide = totalPages <= 1 && !onPageSizeChange;
  useResizeObserver(containerRef, handleContainerResize, {
    disabled: density !== 'auto' || shouldHide,
  });

  const isFirstPage = currentPage === 0;
  const isLastPage = currentPage === totalPages - 1 || totalPages === 0;
  const resolvedDensity = useMemo(
    () => resolvePaginationDensity(density, containerWidth, autoDensity),
    [density, containerWidth, autoDensity]
  );
  useEffect(() => {
    if (density !== 'auto' || resolvedDensity === autoDensity) {
      return;
    }
    setAutoDensity(resolvedDensity);
  }, [density, resolvedDensity, autoDensity]);

  const isCompactDensity = resolvedDensity !== 'full';
  const isMiniDensity = resolvedDensity === 'mini';
  const shouldRenderRangeSummary = !isMiniDensity && (showItemRange || pageInfo !== undefined);
  const rangeSummary = useMemo(
    () =>
      formatRangeSummary({
        showItemRange,
        pageInfo,
        totalItems,
        resolvedDensity,
        startItem,
        endItem,
      }),
    [showItemRange, pageInfo, totalItems, resolvedDensity, startItem, endItem]
  );

  if (shouldHide) {
    return null;
  }

  return (
    <div
      className="flex w-full min-w-0 max-w-full items-center gap-2 border-t bg-background px-3 py-1.5"
      ref={containerRef}
    >
      {/* Left side: Page size selector */}
      <div className="flex min-w-0 flex-1 items-center justify-start gap-1">
        <PageSizeControl
          actualPageSizeOptions={actualPageSizeOptions}
          isCompactDensity={isCompactDensity}
          onPageSizeChange={onPageSizeChange ? handlePageSizeChange : undefined}
          pageSize={pageSize}
          resolvedDensity={resolvedDensity}
        />
      </div>

      {/* Center: Navigation controls */}
      <NavigationControls
        inputValue={inputValue}
        isCompactDensity={isCompactDensity}
        isFirstPage={isFirstPage}
        isLastPage={isLastPage}
        isMiniDensity={isMiniDensity}
        onGoToFirstPage={goToFirstPage}
        onGoToLastPage={goToLastPage}
        onGoToNextPage={goToNextPage}
        onGoToPreviousPage={goToPreviousPage}
        onInputBlur={handleInputBlur}
        onInputChange={handleInputChange}
        onInputFocus={handleInputFocus}
        onInputKeyDown={handleInputKeyDown}
        totalItems={totalItems}
        totalPages={totalPages}
      />

      {/* Right side: Item range display */}
      <RangeSummary
        rangeSummary={rangeSummary}
        shouldRenderRangeSummary={shouldRenderRangeSummary}
      />
    </div>
  );
});

TablePagination.displayName = 'TablePagination';
