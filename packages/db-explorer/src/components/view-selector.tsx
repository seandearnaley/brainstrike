import { Button } from '@brainstrike/ui';
import { FolderTree } from 'lucide-react';
import type { ViewSelectorProps } from '../types';

export function ViewSelector({
  selectedView,
  setSelectedView,
  recordsCount,
  chunksCount,
}: ViewSelectorProps) {
  return (
    <div className="flex gap-2 pt-2 mb-3">
      <Button
        size="sm"
        variant={selectedView === 'browser' ? 'default' : 'outline'}
        onClick={() => setSelectedView('browser')}
        className="gap-1"
      >
        <FolderTree className="h-3.5 w-3.5" />
        Browser
      </Button>
      <Button
        size="sm"
        variant={selectedView === 'files' ? 'default' : 'outline'}
        onClick={() => setSelectedView('files')}
      >
        Files ({recordsCount})
      </Button>
      <Button
        size="sm"
        variant={selectedView === 'chunks' ? 'default' : 'outline'}
        onClick={() => setSelectedView('chunks')}
      >
        Chunks ({chunksCount})
      </Button>
      <Button
        size="sm"
        variant={selectedView === 'search' ? 'default' : 'outline'}
        onClick={() => setSelectedView('search')}
      >
        Search
      </Button>
    </div>
  );
}
