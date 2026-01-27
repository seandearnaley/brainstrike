import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { Button } from './button';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 250, 500, 1000] as const;

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
}) {
  const [inputValue, setInputValue] = useState(String(currentPage + 1));

  // Sync input value when currentPage changes externally
  const displayPage = currentPage + 1;
  if (inputValue !== String(displayPage) && document.activeElement?.tagName !== 'INPUT') {
    setInputValue(String(displayPage));
  }

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

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleInputBlur = useCallback(() => {
    const parsed = Number.parseInt(inputValue, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      setInputValue(String(displayPage));
      return;
    }
    const clampedPage = Math.min(Math.max(parsed, 1), totalPages);
    setInputValue(String(clampedPage));
    onPageChange(clampedPage - 1);
  }, [inputValue, displayPage, totalPages, onPageChange]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        setInputValue(String(displayPage));
        e.currentTarget.blur();
      }
    },
    [displayPage]
  );

  const handlePageSizeChange = useCallback(
    (value: string) => {
      const newPageSize = Number.parseInt(value, 10);
      if (!Number.isNaN(newPageSize) && onPageSizeChange) {
        onPageSizeChange(newPageSize);
      }
    },
    [onPageSizeChange]
  );

  // Calculate item range for display
  const effectivePageSize = pageSize ?? pageSizeOptions[0] ?? 50;
  const startItem = totalItems === 0 ? 0 : currentPage * effectivePageSize + 1;
  const endItem = Math.min((currentPage + 1) * effectivePageSize, totalItems);

  if (totalPages <= 1 && !onPageSizeChange) {
    return null;
  }

  const isFirstPage = currentPage === 0;
  const isLastPage = currentPage === totalPages - 1 || totalPages === 0;

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center border-t bg-background px-3 py-1.5">
      {/* Left side: Page size selector */}
      <div className="flex items-center justify-start gap-2">
        {onPageSizeChange && pageSize !== undefined && (
          <>
            <span className="text-muted-foreground text-xs">Show</span>
            <Select onValueChange={handlePageSizeChange} value={String(pageSize)}>
              <SelectTrigger
                aria-label="Items per page"
                className="h-7 w-[80px] text-xs tabular-nums [&>svg]:h-3 [&>svg]:w-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem className="text-xs" key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>

      {/* Center: Navigation controls */}
      <div className="flex items-center justify-center gap-1">
        <Button
          aria-label="Go to first page"
          className="h-7 w-7 p-0"
          disabled={isFirstPage}
          onClick={goToFirstPage}
          size="sm"
          variant="ghost"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Go to previous page"
          className="h-7 w-7 p-0"
          disabled={isFirstPage}
          onClick={goToPreviousPage}
          size="sm"
          variant="ghost"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-1.5 px-1">
          <Input
            aria-label="Page number"
            className="h-7 w-14 px-2 text-center text-xs tabular-nums"
            max={totalPages}
            min={1}
            onBlur={handleInputBlur}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            type="number"
            value={inputValue}
          />
          <span className="min-w-[4rem] whitespace-nowrap text-muted-foreground text-xs tabular-nums">
            of {totalPages}
          </span>
        </div>

        <Button
          aria-label="Go to next page"
          className="h-7 w-7 p-0"
          disabled={isLastPage}
          onClick={goToNextPage}
          size="sm"
          variant="ghost"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Go to last page"
          className="h-7 w-7 p-0"
          disabled={isLastPage}
          onClick={goToLastPage}
          size="sm"
          variant="ghost"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Right side: Item range display */}
      <div className="flex justify-end text-muted-foreground text-xs tabular-nums">
        {showItemRange && totalItems > 0 && (
          <span>
            {startItem}-{endItem} of {totalItems.toLocaleString()}
            {pageInfo ? ` ${pageInfo}` : ''}
          </span>
        )}
        {showItemRange && totalItems === 0 && <span>No items</span>}
        {!showItemRange && pageInfo && <span>{pageInfo}</span>}
      </div>
    </div>
  );
});

TablePagination.displayName = 'TablePagination';
