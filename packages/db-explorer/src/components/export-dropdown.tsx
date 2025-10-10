import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { Archive, Brain, ChevronDown, Download, FileDown } from 'lucide-react';
import type { ExportButtonsProps } from '../types';

export function ExportDropdown({ records, chunks, exportHandlers }: ExportButtonsProps) {
  const embeddings = chunks.filter((c) => c.embedding);
  const hasFiles = records.length > 0;
  const hasChunks = chunks.length > 0;
  const hasEmbeddings = embeddings.length > 0;
  const hasAnyData = hasFiles || hasChunks;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasAnyData}
          className="flex items-center gap-1.5"
        >
          <FileDown className="h-3.5 w-3.5" />
          Export
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-xs">Export Data</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={exportHandlers.handleExportFiles}
          disabled={!hasFiles}
          className="cursor-pointer"
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Files</span>
          <span className="text-xs text-muted-foreground">{records.length}</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={exportHandlers.handleExportChunks}
          disabled={!hasChunks}
          className="cursor-pointer"
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Chunks</span>
          <span className="text-xs text-muted-foreground">{chunks.length}</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={exportHandlers.handleExportEmbeddings}
          disabled={!hasEmbeddings}
          className="cursor-pointer"
        >
          <Brain className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Embeddings</span>
          <span className="text-xs text-muted-foreground">{embeddings.length}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => void exportHandlers.handleExportAll()}
          disabled={!hasAnyData}
          className="cursor-pointer"
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">All (ZIP)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
