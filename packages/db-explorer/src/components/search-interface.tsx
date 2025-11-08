import { Button, Input, Label } from '@brainstrike/ui';
import { Search } from 'lucide-react';
import type { SearchInterfaceProps } from '../types';
import { SearchCollectionContext } from './search-collection-context';

export function SearchInterface({
  searchFunctionality,
  activeCollection,
  documentCount,
}: SearchInterfaceProps) {
  return (
    <div className="mt-4 space-y-2">
      {/* Collection Context */}
      {activeCollection && (
        <SearchCollectionContext
          collectionName={activeCollection.name}
          documentCount={documentCount}
        />
      )}

      {/* Search Input */}
      <div className="flex gap-2">
        <Input
          placeholder="Search in file chunks..."
          value={searchFunctionality.searchQuery}
          onChange={(e) => searchFunctionality.setSearchQuery(e.target.value)}
          className="flex-1 h-8 text-xs"
          onKeyDown={(e) => e.key === 'Enter' && searchFunctionality.handleSearch()}
        />
        <Button
          size="sm"
          onClick={searchFunctionality.handleSearch}
          disabled={searchFunctionality.searching || !searchFunctionality.searchQuery.trim()}
          className="flex items-center gap-1"
        >
          <Search className="h-3 w-3" />
          {searchFunctionality.searching ? 'Searching...' : 'Search'}
        </Button>
      </div>

      {/* Threshold Control */}
      <div className="flex items-center gap-2 text-xs">
        <Label>Threshold:</Label>
        <Input
          type="number"
          value={searchFunctionality.searchThreshold}
          onChange={(e) => searchFunctionality.setSearchThreshold(Number(e.target.value))}
          className="w-20 h-6"
          min="0"
          max="1"
          step="0.1"
        />
      </div>
    </div>
  );
}
