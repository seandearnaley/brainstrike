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

interface ExportDropdownProps extends ExportButtonsProps {
  collapseLabelAtNarrowWidth?: boolean;
}

export function ExportDropdown({
  counts,
  countsStatus = 'ready',
  exportHandlers,
  collapseLabelAtNarrowWidth = false,
}: ExportDropdownProps) {
  const countsPending = countsStatus === 'pending';
  const hasFiles = counts.records > 0;
  const hasChunks = counts.chunks > 0;
  const hasEmbeddings = counts.embeddings > 0;
  const hasAnyData = hasFiles || hasChunks;
  const triggerLabel = countsPending ? 'Export pending' : 'Export';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={triggerLabel}
          className={`flex h-7 items-center gap-1.5 ${
            collapseLabelAtNarrowWidth ? '@[420px]:min-w-28 @[420px]:px-3 px-2' : ''
          }`}
          disabled={countsPending || !hasAnyData}
          size="sm"
          variant="outline"
        >
          <FileDown className="h-3.5 w-3.5" />
          <span className={collapseLabelAtNarrowWidth ? '@[420px]:inline hidden' : undefined}>
            {triggerLabel}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-xs">Export Data</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={countsPending || !hasFiles}
          onClick={exportHandlers.handleExportFiles}
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Files</span>
          <span className="text-muted-foreground text-xs">
            {countsPending ? 'pending' : counts.records}
          </span>
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={countsPending || !hasChunks}
          onClick={exportHandlers.handleExportChunks}
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Chunks</span>
          <span className="text-muted-foreground text-xs">
            {countsPending ? 'pending' : counts.chunks}
          </span>
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={countsPending || !hasEmbeddings}
          onClick={exportHandlers.handleExportEmbeddings}
        >
          <Brain className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">Embeddings</span>
          <span className="text-muted-foreground text-xs">
            {countsPending ? 'pending' : counts.embeddings}
          </span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="cursor-pointer"
          disabled={countsPending || !hasAnyData}
          onClick={() => void exportHandlers.handleExportAll()}
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          <span className="flex-1">All (ZIP)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
