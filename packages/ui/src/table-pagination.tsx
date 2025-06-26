import { memo } from 'react';
import { Button } from './button';

interface TablePaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  pageInfo?: string;
  maxPageButtons?: number;
}

export const TablePagination = memo<TablePaginationProps>(function TablePaginationComponent({
  currentPage,
  totalPages,
  totalItems,
  onPageChange,
  pageInfo,
  maxPageButtons = 5,
}) {
  const goToNextPage = () => {
    onPageChange(Math.min(currentPage + 1, totalPages - 1));
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
    <div className="flex items-center justify-between p-3 border-t bg-background">
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>
          Page {currentPage + 1} of {totalPages}
          {pageInfo ? ` ${pageInfo}` : ` (${totalItems} total items)`}
        </span>
      </div>
      <div className="flex items-center space-x-2">
        <Button variant="outline" size="sm" onClick={goToPreviousPage} disabled={currentPage === 0}>
          Previous
        </Button>
        <div className="flex items-center space-x-1">
          {getPageNumbers().map((pageNum) => (
            <Button
              key={pageNum}
              variant={pageNum === currentPage ? 'default' : 'outline'}
              size="sm"
              onClick={() => onPageChange(pageNum)}
              className="w-8 h-8 p-0"
            >
              {pageNum + 1}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={goToNextPage}
          disabled={currentPage === totalPages - 1}
        >
          Next
        </Button>
      </div>
    </div>
  );
});

TablePagination.displayName = 'TablePagination';
