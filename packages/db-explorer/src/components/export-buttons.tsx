import { Button } from '@brainstrike/ui';
import { Archive, Brain, Download } from 'lucide-react';
import type { ExportButtonsProps } from '../types';

export function ExportButtons({ counts, exportHandlers }: ExportButtonsProps) {
  return (
    <div className="flex gap-2 pt-2">
      <Button
        className="flex items-center gap-1"
        disabled={counts.records === 0}
        onClick={exportHandlers.handleExportFiles}
        size="sm"
        variant="outline"
      >
        <Download className="h-3 w-3" />
        Files ({counts.records})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={counts.chunks === 0}
        onClick={exportHandlers.handleExportChunks}
        size="sm"
        variant="outline"
      >
        <Download className="h-3 w-3" />
        Chunks ({counts.chunks})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={counts.embeddings === 0}
        onClick={exportHandlers.handleExportEmbeddings}
        size="sm"
        variant="outline"
      >
        <Brain className="h-3 w-3" />
        Embeddings ({counts.embeddings})
      </Button>
      <Button
        className="flex items-center gap-1"
        disabled={counts.records === 0 && counts.chunks === 0}
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
