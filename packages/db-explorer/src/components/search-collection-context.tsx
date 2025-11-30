import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { FileText, Info } from 'lucide-react';

type SearchCollectionContextProps = {
  collectionName: string;
  documentCount?: number | undefined;
};

/**
 * Displays the active collection context for the Search tab
 *
 * Shows which collection is being searched and how many documents are available.
 * Provides contextual help about what "searching in a collection" means.
 */
export function SearchCollectionContext({
  collectionName,
  documentCount,
}: SearchCollectionContextProps) {
  return (
    <div className="flex items-center gap-2 px-1 py-2">
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Searching in:</span>
        <Badge className="font-semibold text-xs" variant="default">
          {collectionName}
        </Badge>

        {documentCount !== undefined && (
          <span className="text-muted-foreground text-xs">
            • {documentCount.toLocaleString()} document{documentCount === 1 ? '' : 's'} indexed
          </span>
        )}

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 cursor-help text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p className="text-sm">
                <strong>Search Collections</strong> let you organize files by AI model and purpose.
                Only files indexed in <strong>{collectionName}</strong> will appear in search
                results.
              </p>
              <p className="mt-2 text-sm">
                💡 Tip: Use the Files tab to see which files are searchable in this collection, or
                switch collections using the selector above.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}
