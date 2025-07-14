import { Badge } from '@brainstrike/ui';
import type { SearchFunctionality } from '../types';

interface SearchViewProps {
  searchFunctionality: SearchFunctionality;
}

export function SearchView({ searchFunctionality }: SearchViewProps) {
  if (searchFunctionality.searchResults.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground">
        {searchFunctionality.searchQuery
          ? 'No matching chunks found. Try adjusting your search query or threshold.'
          : 'Enter a search query to find similar content.'}
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-full overflow-y-auto">
      {searchFunctionality.searchResults.map((result, index) => (
        <div key={result.chunk.id} className="border rounded p-3">
          <div className="flex justify-between items-start mb-2">
            <div className="flex gap-2">
              <Badge variant="default" className="text-xs">
                {(result.similarity * 100).toFixed(1)}% match
              </Badge>
              <Badge variant="outline" className="text-xs">
                {result.chunk.chunkType} #{result.chunk.chunkIndex}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {result.chunk.tokenCount} tokens
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground">#{index + 1}</div>
          </div>
          <div className="text-sm mb-2">
            {result.chunk.content.substring(0, 400)}
            {result.chunk.content.length > 400 && '...'}
          </div>
          <div className="text-xs text-muted-foreground">
            From: {result.fileRecord.name} • {result.fileRecord.path}
          </div>
        </div>
      ))}
    </div>
  );
}
