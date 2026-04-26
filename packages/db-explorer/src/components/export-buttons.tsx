import { Button } from '@brainstrike/ui';
import { Archive, Brain, Download } from 'lucide-react';
import type { ExportButtonsProps } from '../types';

export function ExportButtons({
  counts,
  countsStatus = 'ready',
  exportHandlers,
}: ExportButtonsProps) {
  const countsPending = countsStatus === 'pending';
  return (
    <div className="flex gap-2 pt-2">
      <Button
        className="flex items-center gap-1"
        disabled={countsPending || counts.records === 0}
        onClick={exportHandlers.handleExportFiles}
        size="sm"
        variant="outline"
      >
        <Download className="h-3 w-3" />
        Files ({countsPending ? 'pending' : counts.records})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={countsPending || counts.chunks === 0}
        onClick={exportHandlers.handleExportChunks}
        size="sm"
        variant="outline"
      >
        <Download className="h-3 w-3" />
        Chunks ({countsPending ? 'pending' : counts.chunks})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={countsPending || counts.embeddings === 0}
        onClick={exportHandlers.handleExportEmbeddings}
        size="sm"
        variant="outline"
      >
        <Brain className="h-3 w-3" />
        Embeddings ({countsPending ? 'pending' : counts.embeddings})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={countsPending || (counts.records === 0 && counts.chunks === 0)}
        onClick={exportHandlers.handleExportAll}
        size="sm"
        variant="outline"
      >
        <Archive className="h-3 w-3" />
        All (ZIP)
      </Button>
    </div>
  );
}
