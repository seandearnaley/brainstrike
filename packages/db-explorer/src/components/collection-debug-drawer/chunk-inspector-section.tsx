/**
 * Flat file list -> chunks on demand -> NodeInspector.
 *
 * No tree: the retired Collection Browser's `use-collection-tree` machinery is
 * gone and must not come back. Files come from the page the panel's live query
 * already holds; chunks are fetched one-shot for the selected file only.
 */

import { type BrowserNodeData, NodeInspector } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDatabaseDemoStore } from '../../stores/database-demo-store';
import {
  DRAWER_CHUNK_PAGE_SIZE,
  type DrawerChunkSummary,
  loadChunksForFile,
} from './collection-debug-queries';
import { deriveChunkEmbeddingStatus, deriveFileEmbeddingStatus } from './drawer-model';
import { DrawerSection } from './drawer-primitives';
import type { CollectionDebugDrawerProps } from './drawer-props';
import {
  ChunkListPane,
  type ClaimTarget,
  type DrawerFileEntry,
  FileListPane,
} from './inspector-list-panels';

interface ChunkInspectorSectionProps
  extends Pick<
    CollectionDebugDrawerProps,
    'activeCollectionId' | 'database' | 'recordPagination' | 'records'
  > {
  readonly onClaimTarget: ClaimTarget;
}

export function ChunkInspectorSection({
  activeCollectionId,
  database,
  onClaimTarget,
  recordPagination,
  records,
}: ChunkInspectorSectionProps) {
  const recordPage = useDatabaseDemoStore((s) => s.recordPage);
  const setRecordPage = useDatabaseDemoStore((s) => s.setRecordPage);

  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [chunkPage, setChunkPage] = useState(0);
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
    if (!(selectedFileId && activeCollectionId)) {
      setChunks([]);
      setChunksError(null);
      return;
    }
    let cancelled = false;
    setChunksLoading(true);
    setChunksError(null);
    loadChunksForFile(database, selectedFileId, activeCollectionId, chunkPage)
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
  }, [activeCollectionId, chunkPage, database, selectedFileId]);

  const handleSelectFile = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    setSelectedChunkId(null);
    setChunkPage(0);
  }, []);

  /**
   * Chunk paging bounds. The total comes from the file row the panel already
   * holds, so a file larger than one chunk page reports its real size instead
   * of showing 50 rows that look like the whole file.
   */
  const chunkTotal = selectedFile?.chunksCount ?? 0;
  const chunkPageCount = Math.max(1, Math.ceil(chunkTotal / DRAWER_CHUNK_PAGE_SIZE));
  const chunkRangeStart = chunkPage * DRAWER_CHUNK_PAGE_SIZE + 1;
  const chunkRangeEnd = chunkPage * DRAWER_CHUNK_PAGE_SIZE + chunks.length;

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
        <FileListPane
          activeCollectionId={activeCollectionId}
          files={files}
          onClaimTarget={onClaimTarget}
          onSelectFile={handleSelectFile}
          page={recordPage}
          selectedFileId={selectedFileId}
          setPage={setRecordPage}
          totalPages={recordPagination.totalPages}
        />

        <ChunkListPane
          chunks={chunks}
          error={chunksError}
          hasSelectedFile={selectedFileId !== null}
          loading={chunksLoading}
          onClaimTarget={onClaimTarget}
          onSelectChunk={setSelectedChunkId}
          page={chunkPage}
          pageCount={chunkPageCount}
          rangeEnd={chunkRangeEnd}
          rangeStart={chunkRangeStart}
          selectedChunkId={selectedChunkId}
          setPage={setChunkPage}
          total={chunkTotal}
        />

        {/* Fixed height rather than a stretched grid cell: the inspector's own
            empty state fills its container, and an unbounded cell let it
            dominate the drawer in the narrow single-column layout. */}
        <div className="h-48 self-start" data-testid="collection-debug-node-inspector">
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
