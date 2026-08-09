/**
 * Flat file list -> chunks on demand -> NodeInspector.
 *
 * No tree: the retired Collection Browser's `use-collection-tree` machinery is
 * gone and must not come back. Files come from the page the panel's live query
 * already holds; chunks are fetched one-shot for the selected file only.
 */

import type { ContextTarget } from '@brainstrike/context-actions';
import { type BrowserNodeData, Button, NodeInspector } from '@brainstrike/ui';
import { AlertTriangle, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDatabaseDemoStore } from '../../stores/database-demo-store';
import { type DrawerChunkSummary, loadChunksForFile } from './collection-debug-queries';
import { deriveChunkEmbeddingStatus, deriveFileEmbeddingStatus } from './drawer-model';
import { DrawerSection, StatusDot } from './drawer-primitives';
import type { CollectionDebugDrawerProps } from './drawer-props';
import { chunkRowToTarget, fileRowToTarget } from './drawer-targets';

type ClaimTarget = (target: ContextTarget, element: HTMLElement) => void;

interface ChunkInspectorSectionProps
  extends Pick<CollectionDebugDrawerProps, 'database' | 'recordPagination' | 'records'> {
  readonly onClaimTarget: ClaimTarget;
}

interface DrawerFileEntry {
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

export function ChunkInspectorSection({
  database,
  onClaimTarget,
  recordPagination,
  records,
}: ChunkInspectorSectionProps) {
  const recordPage = useDatabaseDemoStore((s) => s.recordPage);
  const setRecordPage = useDatabaseDemoStore((s) => s.setRecordPage);

  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [chunks, setChunks] = useState<readonly DrawerChunkSummary[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunksError, setChunksError] = useState<string | null>(null);

  const files = useMemo<DrawerFileEntry[]>(
    () =>
      records.map((record) => ({
        chunksCount: record.chunksCount ?? 0,
        chunksProcessed: Boolean(record.chunksProcessedAt),
        createdAt: record.createdAt,
        embeddedChunksCount: record.embeddedChunksCount ?? 0,
        id: record.id,
        name: record.name,
        path: record.path,
        size: record.size,
      })),
    [records]
  );

  const selectedFile = useMemo(
    () => files.find((file) => file.id === selectedFileId) ?? null,
    [files, selectedFileId]
  );

  // Load chunks for whichever file is selected. One-shot per selection — the
  // drawer never subscribes.
  useEffect(() => {
    if (!selectedFileId) {
      setChunks([]);
      setChunksError(null);
      return;
    }
    let cancelled = false;
    setChunksLoading(true);
    setChunksError(null);
    loadChunksForFile(database, selectedFileId)
      .then((rows) => {
        if (!cancelled) {
          setChunks(rows);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setChunks([]);
          setChunksError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChunksLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [database, selectedFileId]);

  const handleSelectFile = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    setSelectedChunkId(null);
  }, []);

  const selectedChunk = useMemo(
    () => chunks.find((chunk) => chunk.id === selectedChunkId) ?? null,
    [chunks, selectedChunkId]
  );

  const inspected = useMemo<{
    data: BrowserNodeData | null;
    id: string | undefined;
    type: string | null;
  }>(() => {
    if (selectedChunk) {
      return {
        data: {
          content: selectedChunk.content,
          embeddingStatus: deriveChunkEmbeddingStatus(selectedChunk),
          index: selectedChunk.chunkIndex,
          metadata: {
            chunkId: selectedChunk.id,
            embeddingDimensions: selectedChunk.embeddingDimensions,
            hasEmbedding: selectedChunk.hasEmbedding,
          },
          tokenCount: selectedChunk.tokenCount,
        },
        id: selectedChunk.id,
        type: 'chunk',
      };
    }
    if (selectedFile) {
      return {
        data: {
          chunkCount: selectedFile.chunksCount,
          embeddingStatus: deriveFileEmbeddingStatus(selectedFile),
          importedAt: new Date(selectedFile.createdAt),
          name: selectedFile.name,
          path: selectedFile.path,
          size: selectedFile.size,
        },
        id: selectedFile.id,
        type: 'file',
      };
    }
    return { data: null, id: undefined, type: null };
  }, [selectedChunk, selectedFile]);

  return (
    <DrawerSection
      subtitle={`Page ${recordPagination.currentPage + 1} of ${Math.max(1, recordPagination.totalPages)} · ${recordPagination.totalRecords} file(s)`}
      testId="collection-debug-inspector"
      title="Chunks & embeddings"
    >
      <div className="grid @[720px]/debug-drawer:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_260px] grid-cols-1 gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
              Files
            </span>
            <span className="flex items-center gap-1">
              <Button
                aria-label="Previous file page"
                className="size-6 p-0"
                disabled={recordPage <= 0}
                onClick={() => setRecordPage(recordPage - 1)}
                size="sm"
                variant="ghost"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <Button
                aria-label="Next file page"
                className="size-6 p-0"
                disabled={recordPage + 1 >= recordPagination.totalPages}
                onClick={() => setRecordPage(recordPage + 1)}
                size="sm"
                variant="ghost"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </span>
          </div>
          <ul className="max-h-48 overflow-y-auto" data-testid="collection-debug-file-list">
            {files.length === 0 ? (
              <li className="px-2 py-1 text-muted-foreground text-xs">No files in this page.</li>
            ) : null}
            {files.map((file) => {
              const status = deriveFileEmbeddingStatus(file);
              return (
                <li key={file.id}>
                  <button
                    aria-pressed={selectedFileId === file.id}
                    className={`${ROW_BASE} ${selectedFileId === file.id ? ROW_SELECTED : ROW_IDLE}`}
                    onClick={() => handleSelectFile(file.id)}
                    onContextMenu={(event) =>
                      onClaimTarget(
                        fileRowToTarget({ id: file.id, name: file.name, path: file.path }),
                        event.currentTarget
                      )
                    }
                    type="button"
                  >
                    <StatusDot status={status} />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {file.embeddedChunksCount}/{file.chunksCount}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="min-w-0">
          <div className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            Chunks
          </div>
          {chunksError ? (
            <div
              className="flex items-start gap-1.5 px-2 py-1 text-destructive text-xs"
              data-testid="collection-debug-chunks-error"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-all">{chunksError}</span>
            </div>
          ) : null}
          {chunksLoading ? (
            <div className="px-2 py-1 text-muted-foreground text-xs" role="status">
              Loading chunks…
            </div>
          ) : null}
          {!(chunksLoading || chunksError) && selectedFileId === null ? (
            <div className="px-2 py-1 text-muted-foreground text-xs">
              Select a file to list its chunks.
            </div>
          ) : null}
          {!(chunksLoading || chunksError) && selectedFileId !== null && chunks.length === 0 ? (
            <div className="px-2 py-1 text-muted-foreground text-xs">
              This file has no chunks yet.
            </div>
          ) : null}
          <ul className="max-h-48 overflow-y-auto" data-testid="collection-debug-chunk-list">
            {chunks.map((chunk) => (
              <li key={chunk.id}>
                <button
                  aria-pressed={selectedChunkId === chunk.id}
                  className={`${ROW_BASE} ${selectedChunkId === chunk.id ? ROW_SELECTED : ROW_IDLE}`}
                  onClick={() => setSelectedChunkId(chunk.id)}
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

        <div className="min-h-[12rem]" data-testid="collection-debug-node-inspector">
          <NodeInspector
            nodeData={inspected.data}
            nodeType={inspected.type}
            {...(inspected.id === undefined ? {} : { nodeId: inspected.id })}
          />
        </div>
      </div>
    </DrawerSection>
  );
}
