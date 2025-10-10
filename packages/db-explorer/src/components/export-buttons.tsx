import { Button } from '@brainstrike/ui';
import { Archive, Brain, Download } from 'lucide-react';
import type { ExportButtonsProps } from '../types';

export function ExportButtons({ records, chunks, exportHandlers }: ExportButtonsProps) {
  return (
    <div className="flex gap-2 pt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportFiles}
        disabled={records.length === 0}
        className="flex items-center gap-1"
      >
        <Download className="h-3 w-3" />
        Files ({records.length})
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportChunks}
        disabled={chunks.length === 0}
        className="flex items-center gap-1"
      >
        <Download className="h-3 w-3" />
        Chunks ({chunks.length})
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportEmbeddings}
        disabled={chunks.filter((c) => c.embedding).length === 0}
        className="flex items-center gap-1"
      >
        <Brain className="h-3 w-3" />
        Embeddings ({chunks.filter((c) => c.embedding).length})
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={exportHandlers.handleExportAll}
        disabled={records.length === 0 && chunks.length === 0}
        className="flex items-center gap-1"
      >
        <Archive className="h-3 w-3" />
        All (ZIP)
      </Button>
    </div>
  );
}
