import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';
import type { FileCollectionStatus } from '../types/file-collection-status';
import { formatDate } from '../utils/format';

interface FileStatusBadgeProps {
  activeCollectionName: string;
  status: FileCollectionStatus;
}

/**
 * Formats relative time from ISO string
 */
function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) {
    return 'just now';
  }
  if (diffMins < 60) {
    return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  }

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }

  return formatDate(isoString);
}

/**
 * Sub-component displaying searchable file status
 */
function SearchableStatusDisplay({ status }: { status: FileCollectionStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className="text-xs" variant="default">
        <CheckCircle className="mr-1 h-3 w-3" />
        Searchable in this collection
      </Badge>

      {status.searchableChunksCount > 0 && (
        <span className="text-muted-foreground text-xs">
          {status.searchableChunksCount} chunk{status.searchableChunksCount === 1 ? '' : 's'}
        </span>
      )}

      {status.lastIndexedAt && (
        <span className="text-muted-foreground text-xs">
          • Last indexed {formatRelativeTime(status.lastIndexedAt)}
        </span>
      )}

      {status.otherCollectionsCount > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge className="cursor-help text-xs" variant="outline">
                <Info className="mr-1 h-3 w-3" />
                Also in {status.otherCollectionsCount} other collection
                {status.otherCollectionsCount === 1 ? '' : 's'}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">
                This file has been indexed in {status.otherCollectionsCount} other collection
                {status.otherCollectionsCount === 1 ? '' : 's'}. You can search for it there too.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

/**
 * Sub-component displaying not searchable file status
 */
function NotSearchableStatusDisplay({
  status,
  activeCollectionName,
}: {
  status: FileCollectionStatus;
  activeCollectionName: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className="text-xs" variant="secondary">
        <AlertCircle className="mr-1 h-3 w-3" />
        Not yet searchable
      </Badge>

      {status.totalChunksCount > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-muted-foreground text-xs">
                {status.totalChunksCount} chunk{status.totalChunksCount === 1 ? '' : 's'} created •
                Needs indexing
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">
                This file has been split into {status.totalChunksCount} chunk
                {status.totalChunksCount === 1 ? '' : 's'}, but they haven&apos;t been indexed with
                embeddings yet. Use &quot;Make Searchable&quot; to index them in{' '}
                {activeCollectionName}.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

/**
 * Badge component showing file's searchability status in the active collection
 *
 * Displays:
 * - ✅ Searchable: File has embeddings in active collection
 * - ⚠️ Not searchable: File has chunks but no embeddings in active collection
 * - Additional info: chunk counts, other collections, last indexed time
 *
 * @param status - File collection status data
 * @param activeCollectionName - Name of the active collection for display
 */
export function FileStatusBadge({ status, activeCollectionName }: FileStatusBadgeProps) {
  if (status.searchableInActive) {
    return <SearchableStatusDisplay status={status} />;
  }

  return <NotSearchableStatusDisplay activeCollectionName={activeCollectionName} status={status} />;
}
