/**
 * The two flat list panes of the chunk/embedding inspector, split out of
 * `chunk-inspector-section.tsx` so that file owns selection/loading state and
 * these own only rendering.
 */

import type { ContextTarget } from '@brainstrike/context-actions';
import { Button } from '@brainstrike/ui';
import { AlertTriangle, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import type { DrawerChunkSummary } from './collection-debug-queries';
import { deriveChunkEmbeddingStatus, deriveFileEmbeddingStatus } from './drawer-model';
import { StatusDot } from './drawer-primitives';
import { chunkRowToTarget, fileRowToTarget } from './drawer-targets';

export type ClaimTarget = (target: ContextTarget, element: HTMLElement) => void;

export interface DrawerFileEntry {
  chunksCount: number;
  chunksProcessed: boolean;
  createdAt: string;
  embeddedChunksCount: number;
  id: string;
  name: string;
  path: string;
  size: number;
}

const ROW_BASE =
  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const ROW_IDLE = 'hover:bg-muted/60';
const ROW_SELECTED = 'bg-primary/10 text-foreground';
const PANE_LABEL = 'font-medium text-[10px] text-muted-foreground uppercase tracking-wide';

function PagerButtons({
  atEnd,
  atStart,
  label,
  onNext,
  onPrevious,
}: {
  atEnd: boolean;
  atStart: boolean;
  label: string;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <>
      <Button
        aria-label={`Previous ${label} page`}
        className="size-6 p-0"
        disabled={atStart}
        onClick={onPrevious}
        size="sm"
        variant="ghost"
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <Button
        aria-label={`Next ${label} page`}
        className="size-6 p-0"
        disabled={atEnd}
        onClick={onNext}
        size="sm"
        variant="ghost"
      >
        <ChevronRight className="size-3.5" />
      </Button>
    </>
  );
}

export function FileListPane({
  activeCollectionId,
  files,
  onClaimTarget,
  onSelectFile,
  page,
  selectedFileId,
  setPage,
  totalPages,
}: {
  activeCollectionId: string | null;
  files: readonly DrawerFileEntry[];
  onClaimTarget: ClaimTarget;
  onSelectFile: (fileId: string) => void;
  page: number;
  selectedFileId: string | null;
  setPage: (page: number) => void;
  totalPages: number;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={PANE_LABEL}>Files</span>
        <span className="flex items-center gap-1">
          <PagerButtons
            atEnd={page + 1 >= totalPages}
            atStart={page <= 0}
            label="file"
            onNext={() => setPage(page + 1)}
            onPrevious={() => setPage(page - 1)}
          />
        </span>
      </div>
      <ul className="max-h-48 overflow-y-auto" data-testid="collection-debug-file-list">
        {files.length === 0 ? (
          <li className="px-2 py-1 text-muted-foreground text-xs">
            {activeCollectionId
              ? 'No files in this page.'
              : 'Select a collection to list its files.'}
          </li>
        ) : null}
        {files.map((file) => (
          <li key={file.id}>
            <button
              aria-pressed={selectedFileId === file.id}
              className={`${ROW_BASE} ${selectedFileId === file.id ? ROW_SELECTED : ROW_IDLE}`}
              onClick={() => onSelectFile(file.id)}
              onContextMenu={(event) =>
                onClaimTarget(
                  fileRowToTarget({ id: file.id, name: file.name, path: file.path }),
                  event.currentTarget
                )
              }
              type="button"
            >
              <StatusDot status={deriveFileEmbeddingStatus(file)} />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {file.embeddedChunksCount}/{file.chunksCount}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChunkListPane({
  chunks,
  error,
  hasSelectedFile,
  loading,
  onClaimTarget,
  onSelectChunk,
  page,
  pageCount,
  rangeEnd,
  rangeStart,
  selectedChunkId,
  setPage,
  total,
}: {
  chunks: readonly DrawerChunkSummary[];
  error: string | null;
  hasSelectedFile: boolean;
  loading: boolean;
  onClaimTarget: ClaimTarget;
  onSelectChunk: (chunkId: string) => void;
  page: number;
  pageCount: number;
  rangeEnd: number;
  rangeStart: number;
  selectedChunkId: string | null;
  setPage: (page: number) => void;
  total: number;
}) {
  const idle = !(loading || error);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={PANE_LABEL}>Chunks</span>
        {chunks.length > 0 ? (
          <span className="flex items-center gap-1">
            {/* The visible range is the truncation notice: a 300-chunk file
                must never look complete because 50 rows fit on screen. */}
            <span
              className="font-mono text-[10px] text-muted-foreground"
              data-testid="collection-debug-chunk-range"
            >
              {rangeStart}–{rangeEnd} of {total}
            </span>
            <PagerButtons
              atEnd={page + 1 >= pageCount}
              atStart={page <= 0}
              label="chunk"
              onNext={() => setPage(page + 1)}
              onPrevious={() => setPage(page - 1)}
            />
          </span>
        ) : null}
      </div>

      {error ? (
        <div
          className="flex items-start gap-1.5 px-2 py-1 text-destructive text-xs"
          data-testid="collection-debug-chunks-error"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      ) : null}
      {loading ? (
        <div className="px-2 py-1 text-muted-foreground text-xs" role="status">
          Loading chunks…
        </div>
      ) : null}
      {idle && !hasSelectedFile ? (
        <div className="px-2 py-1 text-muted-foreground text-xs">
          Select a file to list its chunks.
        </div>
      ) : null}
      {idle && hasSelectedFile && chunks.length === 0 ? (
        <div className="px-2 py-1 text-muted-foreground text-xs">This file has no chunks yet.</div>
      ) : null}

      <ul className="max-h-48 overflow-y-auto" data-testid="collection-debug-chunk-list">
        {chunks.map((chunk) => (
          <li key={chunk.id}>
            <button
              aria-pressed={selectedChunkId === chunk.id}
              className={`${ROW_BASE} ${selectedChunkId === chunk.id ? ROW_SELECTED : ROW_IDLE}`}
              onClick={() => onSelectChunk(chunk.id)}
              onContextMenu={(event) =>
                onClaimTarget(
                  chunkRowToTarget({ content: chunk.content, id: chunk.id }),
                  event.currentTarget
                )
              }
              type="button"
            >
              <StatusDot status={deriveChunkEmbeddingStatus(chunk)} />
              <FileText aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-mono text-[10px]">#{chunk.chunkIndex}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {chunk.content.slice(0, 80)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {chunk.embeddingDimensions > 0 ? `${chunk.embeddingDimensions}d` : 'no vec'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
