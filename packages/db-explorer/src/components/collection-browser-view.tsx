/**
 * CollectionBrowserView Component
 *
 * Wrapper that connects the CollectionBrowser from @brainstrike/ui
 * to the database demo panel's data sources.
 *
 * Provides persistent state management for:
 * - Expanded/collapsed tree nodes
 * - Selected node
 * - Sort state (column and direction)
 * - Inspector panel collapsed state
 */

import type { EmbeddingSet, FileChunk, FileRecord } from '@brainstrike/db';
import {
  type BrowserNodeData,
  CollectionBrowser,
  type CollectionSortState,
  type CollectionTreeInput,
  NodeInspector,
} from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { useCollectionBrowserStore } from '../stores/collection-browser-store';

export interface CollectionBrowserViewProps {
  /** Embedding sets / collections */
  embeddingSets: EmbeddingSet[];
  /** File records */
  records: FileRecord[];
  /** File chunks */
  chunks: FileChunk[];
  /** Pending chunk IDs (being embedded) */
  pendingChunkIds?: Set<string>;
  /** Active collection ID */
  activeCollectionId: string | null;
  /** Loading state */
  isLoading?: boolean;
  /** Height of the browser */
  height?: number | string;
  /** Called when a file is selected */
  onFileSelect?: (fileId: string, file: FileRecord) => void;
  /** Called when a chunk is selected */
  onChunkSelect?: (chunkId: string, chunk: FileChunk) => void;
}

/**
 * Transform database data into CollectionTreeInput format
 */
function transformToTreeInput(
  embeddingSets: EmbeddingSet[],
  records: FileRecord[],
  chunks: FileChunk[],
  activeCollectionId: string | null,
  pendingChunkIds?: Set<string>
): CollectionTreeInput {
  // Filter to active collection only, or show all if none selected
  const filteredSets = activeCollectionId
    ? embeddingSets.filter((s) => s.id === activeCollectionId)
    : embeddingSets;

  const filteredRecords = activeCollectionId
    ? records.filter((r) => r.embeddingSetId === activeCollectionId)
    : records;

  const filteredChunks = activeCollectionId
    ? chunks.filter((c) => c.embeddingSetId === activeCollectionId)
    : chunks;

  return {
    collections: filteredSets.map((set) => {
      const collection: {
        id: string;
        name?: string;
        description?: string;
        modelId: string;
        dimensions: number;
      } = {
        id: set.id,
        modelId: set.modelId,
        dimensions: set.dimensions,
      };
      if (set.name) collection.name = set.name;
      if (set.description) collection.description = set.description;
      return collection;
    }),
    files: filteredRecords.map((record) => {
      const file: {
        id: string;
        name: string;
        path: string;
        size: number;
        embeddingSetId?: string;
        chunksCount?: number;
        processedAt?: string;
      } = {
        id: record.id,
        name: record.name,
        path: record.path,
        size: record.size,
      };
      if (record.embeddingSetId) file.embeddingSetId = record.embeddingSetId;
      if (record.chunksCount !== undefined) file.chunksCount = record.chunksCount;
      if (record.processedAt) file.processedAt = record.processedAt;
      return file;
    }),
    chunks: filteredChunks.map((chunk) => {
      const chunkItem: {
        id: string;
        fileRecordId: string;
        chunkIndex: number;
        content: string;
        tokenCount: number;
        embedding?: number[];
        embeddingSetId?: string;
      } = {
        id: chunk.id,
        fileRecordId: chunk.fileRecordId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
      };
      if (chunk.embedding && chunk.embedding.length > 0) chunkItem.embedding = chunk.embedding;
      if (chunk.embeddingSetId) chunkItem.embeddingSetId = chunk.embeddingSetId;
      return chunkItem;
    }),
    ...(pendingChunkIds ? { pendingChunkIds } : {}),
  };
}

/**
 * Build collection node data from the selected collection
 */
function buildCollectionData(
  collectionId: string,
  embeddingSets: EmbeddingSet[],
  records: FileRecord[],
  chunks: FileChunk[]
): BrowserNodeData | null {
  const set = embeddingSets.find((s) => s.id === collectionId);
  if (!set) return null;
  const collFiles = records.filter((r) => r.embeddingSetId === set.id);
  const collChunks = chunks.filter((c) => c.embeddingSetId === set.id);
  return {
    name: set.name ?? `Collection ${set.id.slice(0, 8)}`,
    modelId: set.modelId,
    dimensions: set.dimensions,
    fileCount: collFiles.length,
    chunkCount: collChunks.length,
    embeddingCount: collChunks.filter((c) => c.embedding && c.embedding.length > 0).length,
  };
}

/**
 * Build file node data from the selected file
 */
function buildFileData(
  fileId: string,
  records: FileRecord[],
  chunks: FileChunk[]
): BrowserNodeData | null {
  const file = records.find((r) => r.id === fileId);
  if (!file) return null;
  const fileChunks = chunks.filter((c) => c.fileRecordId === file.id);
  const embeddedChunks = fileChunks.filter((c) => c.embedding && c.embedding.length > 0);
  const hasAllEmbeddings = embeddedChunks.length === fileChunks.length;
  const hasSomeEmbeddings = embeddedChunks.length > 0;
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    chunkCount: fileChunks.length,
    embeddingStatus: hasAllEmbeddings ? 'complete' : hasSomeEmbeddings ? 'pending' : 'none',
    embeddingProgress:
      fileChunks.length > 0 ? Math.round((embeddedChunks.length / fileChunks.length) * 100) : 0,
  };
}

/**
 * Build chunk node data from the selected chunk
 */
function buildChunkData(chunkId: string, chunks: FileChunk[]): BrowserNodeData | null {
  const chunk = chunks.find((c) => c.id === chunkId);
  if (!chunk) return null;
  return {
    index: chunk.chunkIndex,
    content: chunk.content,
    tokenCount: chunk.tokenCount,
    embeddingStatus: chunk.embedding && chunk.embedding.length > 0 ? 'complete' : 'none',
  };
}

/**
 * Build embedding node data from the selected chunk
 */
function buildEmbeddingData(chunkId: string, chunks: FileChunk[]): BrowserNodeData | null {
  const chunk = chunks.find((c) => c.id === chunkId);
  if (!chunk || !chunk.embedding) return null;
  return {
    vectorId: chunk.id,
    dimensions: chunk.embedding.length,
  };
}

/**
 * Build selected node data based on node type
 */
function buildSelectedNodeData(
  nodeType: string,
  nodeId: string,
  embeddingSets: EmbeddingSet[],
  records: FileRecord[],
  chunks: FileChunk[]
): BrowserNodeData | null {
  switch (nodeType) {
    case 'collection':
      return buildCollectionData(nodeId, embeddingSets, records, chunks);
    case 'file':
      return buildFileData(nodeId, records, chunks);
    case 'chunk':
      return buildChunkData(nodeId, chunks);
    case 'embedding':
      return buildEmbeddingData(nodeId, chunks);
    default:
      return null;
  }
}

/**
 * CollectionBrowserView - Connects CollectionBrowser to database data
 */
export function CollectionBrowserView({
  embeddingSets,
  records,
  chunks,
  pendingChunkIds,
  activeCollectionId,
  isLoading = false,
  height = 500,
  onFileSelect,
  onChunkSelect,
}: CollectionBrowserViewProps) {
  // Use persistent store for all UI state
  const {
    expandedIds,
    selectedId,
    sortState,
    isInspectorCollapsed,
    setExpandedIds,
    setSelectedId,
    setSortState,
    setInspectorCollapsed,
  } = useCollectionBrowserStore();

  // Convert expanded IDs array to Set for CollectionBrowser
  const expandedIdsSet = useMemo(() => new Set(expandedIds), [expandedIds]);

  // State for selected node inspection (derived from store selectedId)
  const { selectedNodeType, selectedNodeId } = useMemo(() => {
    if (!selectedId) {
      return { selectedNodeType: null, selectedNodeId: null };
    }
    // Parse the node ID to determine type and original ID
    const prefixMatch = selectedId.match(/^(collection|file|chunk|embedding)-(.+)$/);
    if (!prefixMatch) {
      return { selectedNodeType: null, selectedNodeId: null };
    }
    const [, nodeType, originalId] = prefixMatch;
    return {
      selectedNodeType: nodeType,
      selectedNodeId: originalId,
    };
  }, [selectedId]);

  // Build selected node data based on node type
  const actualSelectedNodeData = useMemo((): BrowserNodeData | null => {
    if (!selectedId || !selectedNodeType || !selectedNodeId) return null;

    return buildSelectedNodeData(selectedNodeType, selectedNodeId, embeddingSets, records, chunks);
  }, [selectedId, selectedNodeType, selectedNodeId, embeddingSets, records, chunks]);

  // Handle expansion state changes
  const handleExpandedIdsChange = useCallback(
    (ids: Set<string>) => {
      setExpandedIds(Array.from(ids));
    },
    [setExpandedIds]
  );

  // Handle selection changes
  const handleSelectedIdChange = useCallback(
    (id: string | null) => {
      setSelectedId(id);
    },
    [setSelectedId]
  );

  // Handle sort changes
  const handleSortChange = useCallback(
    (newSortState: CollectionSortState | null) => {
      setSortState(newSortState);
    },
    [setSortState]
  );

  // Handle inspector collapse
  const handleCollapseChange = useCallback(
    (collapsed: boolean) => {
      setInspectorCollapsed(collapsed);
    },
    [setInspectorCollapsed]
  );

  // Transform data for CollectionBrowser
  const treeData = useMemo(
    () => transformToTreeInput(embeddingSets, records, chunks, activeCollectionId, pendingChunkIds),
    [embeddingSets, records, chunks, activeCollectionId, pendingChunkIds]
  );

  // Handle node selection - stores the ID and calls external handlers
  const handleSelect = useCallback(
    (nodeId: string, nodeType: string, _data: BrowserNodeData) => {
      // Store the full prefixed ID in the store
      setSelectedId(nodeId);

      // Extract the original ID (remove prefix like 'file-', 'chunk-', etc.)
      const originalId = nodeId.replace(/^(collection|file|chunk|embedding)-/, '');

      // Call specific handlers based on node type
      if (nodeType === 'file' && onFileSelect) {
        const file = records.find((r) => r.id === originalId);
        if (file) {
          onFileSelect(originalId, file);
        }
      } else if (nodeType === 'chunk' && onChunkSelect) {
        const chunk = chunks.find((c) => c.id === originalId);
        if (chunk) {
          onChunkSelect(originalId, chunk);
        }
      }
    },
    [setSelectedId, records, chunks, onFileSelect, onChunkSelect]
  );

  // Empty state message
  const emptyMessage = activeCollectionId
    ? 'No files in this collection. Import files to get started.'
    : 'Select a collection to view its contents.';

  return (
    <div className="flex h-full" style={{ height }}>
      {/* Main browser */}
      <div className="flex-1 min-w-0">
        <CollectionBrowser
          data={treeData}
          onSelect={handleSelect}
          isLoading={isLoading}
          emptyMessage={emptyMessage}
          height="100%"
          className="h-full"
          expandedIds={expandedIdsSet}
          onExpandedIdsChange={handleExpandedIdsChange}
          selectedId={selectedId}
          onSelectedIdChange={handleSelectedIdChange}
          {...(sortState ? { sortState } : {})}
          onSortChange={handleSortChange}
        />
      </div>

      {/* Inspector panel */}
      <NodeInspector
        nodeType={selectedNodeType ?? null}
        nodeData={actualSelectedNodeData}
        {...(selectedNodeId ? { nodeId: selectedNodeId } : {})}
        width={280}
        isCollapsed={isInspectorCollapsed}
        onCollapseChange={handleCollapseChange}
      />
    </div>
  );
}

export default CollectionBrowserView;
