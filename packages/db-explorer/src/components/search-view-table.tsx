import { Badge, DataTable, type DataTableColumn } from '@brainstrike/ui';
import { useMemo } from 'react';
import type { SearchFunctionality } from '../types';

interface SearchViewTableProps {
  searchFunctionality: SearchFunctionality;
  activeCollectionName?: string | undefined;
}

export function SearchViewTable({
  searchFunctionality,
  activeCollectionName,
}: SearchViewTableProps) {
  const { searchResults, hasSearched, searchQuery } = searchFunctionality;

  const columns = useMemo<DataTableColumn<(typeof searchResults)[0]>[]>(
    () => [
      {
        id: 'rank',
        header: '#',
        cell: ({ rowIndex }) => (
          <span className="text-xs text-muted-foreground">#{rowIndex + 1}</span>
        ),
        className: 'w-12',
      },
      {
        id: 'similarity',
        header: 'Match',
        cell: ({ row }) => (
          <Badge variant="default" className="text-xs font-semibold">
            {(row.similarity * 100).toFixed(1)}%
          </Badge>
        ),
        sortable: true,
        accessorFn: (row) => row.similarity,
        className: 'w-20',
      },
      {
        id: 'chunk',
        header: 'Chunk',
        cell: ({ row }) => (
          <div className="flex gap-2">
            <Badge variant="outline" className="text-xs">
              {row.chunk.chunkType} #{row.chunk.chunkIndex}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {row.chunk.tokenCount} tokens
            </Badge>
          </div>
        ),
        className: 'w-48',
      },
      {
        id: 'content',
        header: 'Content',
        cell: ({ row }) => (
          <div className="text-sm">
            {row.chunk.content.substring(0, 200)}
            {row.chunk.content.length > 200 && '...'}
          </div>
        ),
      },
      {
        id: 'file',
        header: 'Source File',
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground space-y-1">
            <div className="font-medium">{row.fileRecord.name}</div>
            <div className="opacity-70">{row.fileRecord.path}</div>
            {activeCollectionName && (
              <div className="flex items-center gap-1 mt-1">
                <Badge variant="outline" className="text-xs">
                  {activeCollectionName}
                </Badge>
              </div>
            )}
          </div>
        ),
        className: 'w-64',
      },
    ],
    [activeCollectionName]
  );

  return (
    <DataTable
      columns={columns}
      data={searchResults}
      getRowId={(row) => row.chunk.id}
      maxHeight="400px"
      pagination={{
        enabled: true,
        pageSize: 25,
      }}
      emptyState={
        <div className="text-center space-y-3 py-6">
          {hasSearched || searchQuery ? (
            <>
              <div className="text-sm font-medium">No matching chunks found</div>
              <div className="text-sm text-muted-foreground space-y-2">
                <div className="font-semibold">💡 Not finding what you need?</div>
                <div className="text-left max-w-md mx-auto space-y-1">
                  <div>• Try adjusting your search query or lowering the threshold</div>
                  <div>• Check the Files tab to see which files are indexed in this collection</div>
                  <div>• Switch to a different collection using the selector above</div>
                  <div>• Make sure your files have been processed with embeddings</div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium">
                Enter a search query to find similar content
              </div>
              <div className="text-sm text-muted-foreground">
                Semantic search helps you find content by meaning, not just keywords
              </div>
            </>
          )}
        </div>
      }
    />
  );
}
