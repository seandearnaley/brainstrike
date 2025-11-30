import { memo } from 'react';
import { Button } from './button';

type TablePaginationProps = {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  pageInfo?: string;
  maxPageButtons?: number;
};

export const TablePagination = memo<TablePaginationProps>(function TablePaginationComponent({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
  pageInfo,
  maxPageButtons = 5,
}) {
  const goToNextPage = () => {
    if (totalPages > 0) {
      onPageChange(Math.min(currentPage + 1, totalPages - 1));
    }
  };

  const goToPreviousPage = () => {
    onPageChange(Math.max(currentPage - 1, 0));
  };

  const getPageNumbers = () => {
    const halfMax = Math.floor(maxPageButtons / 2);

    if (totalPages <= maxPageButtons) {
      return Array.from({ length: totalPages }, (_, i) => i);
    }

    if (currentPage < halfMax) {
      return Array.from({ length: maxPageButtons }, (_, i) => i);
    }

    if (currentPage > totalPages - Math.ceil(maxPageButtons / 2) - 1) {
      return Array.from({ length: maxPageButtons }, (_, i) => totalPages - maxPageButtons + i);
    }

    const startPage = currentPage - halfMax;
    return Array.from({ length: maxPageButtons }, (_, i) => startPage + i);
  };

  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="flex items-center justify-between border-t bg-background p-3">
      <div className="flex items-center gap-4 text-muted-foreground text-sm">
        <span>
          Page {currentPage + 1} of {totalPages}
          {pageInfo ? ` ${pageInfo}` : ` (${totalItems} total items)`}
        </span>
      </div>
      <div className="flex items-center space-x-2">
        <Button disabled={currentPage === 0} onClick={goToPreviousPage} size="sm" variant="outline">
          Previous
        </Button>
        <div className="flex items-center space-x-1">
          {getPageNumbers().map((pageNum) => (
            <Button
              className="h-8 w-8 p-0"
              key={pageNum}
              onClick={() => onPageChange(pageNum)}
              size="sm"
              variant={pageNum === currentPage ? 'default' : 'outline'}
            >
              {pageNum + 1}
            </Button>
          ))}
        </div>
        <Button
          disabled={currentPage === totalPages - 1}
          onClick={goToNextPage}
          size="sm"
          variant="outline"
        >
          Next
        </Button>
      </div>
    </div>
  );
});

TablePagination.displayName = 'TablePagination';
