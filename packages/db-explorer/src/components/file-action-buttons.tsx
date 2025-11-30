import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { RefreshCw, Zap } from 'lucide-react';
import type { FileCollectionStatus } from '../types/file-collection-status';

type FileActionButtonsProps = {
  status: FileCollectionStatus;
  /** Handler for making file searchable - if undefined, button is disabled */
  onMakeSearchable?: ((fileId: string) => void) | undefined;
  /** Handler for re-indexing file - if undefined, button is disabled */
  onReindex?: ((fileId: string) => void) | undefined;
};

/**
 * Action buttons for file collection operations
 *
 * Shows:
 * - "Make Searchable" for files not in active collection
 * - "Re-index" for files already in active collection
 *
 * Note: In PR6, these buttons are disabled with tooltips explaining the feature
 * is coming in a future PR. The handlers will be implemented in brainstrike-8e62.
 *
 * @param status - File collection status
 * @param onMakeSearchable - Optional handler for making file searchable
 * @param onReindex - Optional handler for re-indexing file
 */
export function FileActionButtons({ status, onMakeSearchable, onReindex }: FileActionButtonsProps) {
  const makeSearchableDisabled = !onMakeSearchable;
  const reindexDisabled = !(onReindex && status.searchableInActive);

  // Show "Make Searchable" for files not in active collection
  if (!status.searchableInActive && status.totalChunksCount > 0) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Make file searchable in active collection"
              disabled={makeSearchableDisabled}
              onClick={() => onMakeSearchable?.(status.fileId)}
              size="sm"
              variant="outline"
            >
              <Zap className="mr-1 h-3 w-3" />
              Make Searchable
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">
              {makeSearchableDisabled
                ? 'Coming soon: Add this file to your active collection so you can search it. This feature will be available in an upcoming release.'
                : 'Index this file in your active collection to make it searchable.'}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Show "Re-index" for files already in active collection
  if (status.searchableInActive) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Re-index file in active collection"
              disabled={reindexDisabled}
              onClick={() => onReindex?.(status.fileId)}
              size="sm"
              variant="outline"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Re-index
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-xs">
              {reindexDisabled
                ? 'Coming soon: Re-generate embeddings for this file with the current collection settings. Useful if the file content has changed.'
                : 'Re-generate embeddings for this file in your active collection.'}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return null;
}
