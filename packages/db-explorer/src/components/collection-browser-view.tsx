/**
 * CollectionBrowserView Component
 *
 * Wrapper that connects the CollectionBrowser from @brainstrike/ui
 * to the database demo panel's data sources.
 */

import type { EmbeddingSet, FileChunk, FileRecord } from '@brainstrike/db';
import {
  type BrowserNodeData,
  CollectionBrowser,
  type CollectionTreeInput,
  NodeInspector,
} from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';

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
  // State for selected node inspection
  const [selectedNodeType, setSelectedNodeType] = useState<string | null>(null);
  const [selectedNodeData, setSelectedNodeData] = useState<BrowserNodeData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // State for inspector collapse
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(false);

  const handleCollapseChange = useCallback((collapsed: boolean) => {
    setIsInspectorCollapsed(collapsed);
  }, []);

  // Transform data for CollectionBrowser
  const treeData = useMemo(
    () => transformToTreeInput(embeddingSets, records, chunks, activeCollectionId, pendingChunkIds),
    [embeddingSets, records, chunks, activeCollectionId, pendingChunkIds]
  );

  // Handle node selection
  const handleSelect = (nodeId: string, nodeType: string, data: BrowserNodeData) => {
    setSelectedNodeType(nodeType);
    setSelectedNodeData(data);

    // Extract the original ID (remove prefix like 'file-', 'chunk-', etc.)
    const originalId = nodeId.replace(/^(collection|file|chunk|embedding)-/, '');
    setSelectedNodeId(originalId);

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
  };

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
        />
      </div>

      {/* Inspector panel */}
      <NodeInspector
        nodeType={selectedNodeType}
        nodeData={selectedNodeData}
        {...(selectedNodeId ? { nodeId: selectedNodeId } : {})}
        width={280}
        isCollapsed={isInspectorCollapsed}
        onCollapseChange={handleCollapseChange}
      />
    </div>
  );
}

export default CollectionBrowserView;
