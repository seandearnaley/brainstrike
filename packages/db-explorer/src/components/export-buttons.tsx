import { Button } from '@brainstrike/ui';
import { Archive, Brain, Download } from 'lucide-react';
import type { ExportButtonsProps } from '../types';

export function ExportButtons({ records, chunks, exportHandlers }: ExportButtonsProps) {
  return (
    <div className="flex gap-2 pt-2">
      <Button
        className="flex items-center gap-1"
        disabled={records.length === 0}
        onClick={exportHandlers.handleExportFiles}
        size="sm"
        variant="outline"
      >
        <Download className="h-3 w-3" />
        Files ({records.length})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={chunks.length === 0}
        onClick={exportHandlers.handleExportChunks}
        size="sm"
        variant="outline"
      >
        <Download className="h-3 w-3" />
        Chunks ({chunks.length})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={chunks.filter((c) => c.embedding).length === 0}
        onClick={exportHandlers.handleExportEmbeddings}
        size="sm"
        variant="outline"
      >
        <Brain className="h-3 w-3" />
        Embeddings ({chunks.filter((c) => c.embedding).length})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={records.length === 0 && chunks.length === 0}
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
