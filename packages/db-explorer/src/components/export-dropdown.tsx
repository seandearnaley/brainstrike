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

export function ExportDropdown({ counts, exportHandlers }: ExportButtonsProps) {
  const hasFiles = counts.records > 0;
  const hasChunks = counts.chunks > 0;
  const hasEmbeddings = counts.embeddings > 0;
  const hasAnyData = hasFiles || hasChunks;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="flex items-center gap-1.5"
          disabled={!hasAnyData}
          size="sm"
          variant="outline"
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
          className="cursor-pointer"
          disabled={!hasFiles}
          onClick={exportHandlers.handleExportFiles}
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Files</span>
          <span className="text-muted-foreground text-xs">{counts.records}</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={!hasChunks}
          onClick={exportHandlers.handleExportChunks}
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Chunks</span>
          <span className="text-muted-foreground text-xs">{counts.chunks}</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={!hasEmbeddings}
          onClick={exportHandlers.handleExportEmbeddings}
        >
          <Brain className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Embeddings</span>
          <span className="text-muted-foreground text-xs">{counts.embeddings}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={!hasAnyData}
          onClick={() => void exportHandlers.handleExportAll()}
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">All (ZIP)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
