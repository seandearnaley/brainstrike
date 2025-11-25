/**
 * CollectionBrowser Component
 *
 * A unified hierarchical browser for collections, files, chunks, and embeddings.
 * Combines the TreeTable with FilterBar for a complete browsing experience.
 */

import { File, FileText, FolderOpen, Sparkles } from 'lucide-react';
import * as React from 'react';
import { Badge } from '../badge';
import { cn } from '../lib/utils';
import { TreeTable } from '../tree-table/tree-table';
import type { TreeNode, TreeTableColumn } from '../tree-table/types';
import type { BulkAction } from './bulk-action-bar';
import { BulkActionBar } from './bulk-action-bar';
import { FilterBar } from './filter-bar';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionBrowserFilters,
  CollectionData,
  CollectionNodeType,
  EmbeddingData,
  FileData,
} from './types';
import { DEFAULT_FILTERS, EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';
import type { CollectionTreeInput } from './use-collection-tree';
import { useCollectionTree } from './use-collection-tree';

/**
 * Props for the CollectionBrowser component
 */
export interface CollectionBrowserProps {
  /** Input data for the tree */
  data: CollectionTreeInput;
  /** Called when a node is selected */
  onSelect?: (nodeId: string, nodeType: string, data: BrowserNodeData) => void;
  /** Called when multiple nodes are selected */
  onMultiSelect?: (nodeIds: Set<string>) => void;
  /** Called when a node is double-clicked */
  onDoubleClick?: (nodeId: string, nodeType: string, data: BrowserNodeData) => void;
  /** Called when context menu is requested */
  onContextMenu?: (
    nodeId: string,
    nodeType: string,
    data: BrowserNodeData,
    event: React.MouseEvent
  ) => void;
  /** Initial filter state */
  initialFilters?: Partial<CollectionBrowserFilters>;
  /** Whether to show the filter bar */
  showFilterBar?: boolean;
  /** Height of the component */
  height?: number | string;
  /** Custom class name */
  className?: string;
  /** Whether to enable multi-select mode */
  multiSelectEnabled?: boolean;
  /** Loading state */
  isLoading?: boolean;
  /** Empty state message */
  emptyMessage?: string;
  /** Bulk actions for multi-select mode */
  bulkActions?: BulkAction[];
  /** Whether to show the bulk action bar when items are selected */
  showBulkActionBar?: boolean;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

/**
 * Get icon for node type
 */
function NodeIcon({ type }: { type: string }) {
  switch (type) {
    case 'collection':
      return <FolderOpen className={cn('h-4 w-4', NODE_TYPE_CONFIG.collection.color)} />;
    case 'file':
      return <File className={cn('h-4 w-4', NODE_TYPE_CONFIG.file.color)} />;
    case 'chunk':
      return <FileText className={cn('h-4 w-4', NODE_TYPE_CONFIG.chunk.color)} />;
    case 'embedding':
      return <Sparkles className={cn('h-4 w-4', NODE_TYPE_CONFIG.embedding.color)} />;
    default:
      return null;
  }
}

/**
 * Status badge component
 */
function StatusBadge({ status }: { status: string }) {
  const config = EMBEDDING_STATUS_CONFIG[status as keyof typeof EMBEDDING_STATUS_CONFIG];
  if (!config || status === 'all') return null;

  return (
    <Badge
      variant={
        status === 'complete' ? 'default' : status === 'failed' ? 'destructive' : 'secondary'
      }
      className="text-xs"
    >
      {config.label}
    </Badge>
  );
}

/**
 * Get display name and subtitle for a node
 */
function getNodeDisplayInfo(
  type: string,
  data: BrowserNodeData
): { displayName: string; subtitle: string } {
  switch (type) {
    case 'collection': {
      const collData = data as CollectionData;
      return {
        displayName: collData.name,
        subtitle: `${collData.fileCount} files • ${collData.chunkCount} chunks`,
      };
    }
    case 'file': {
      const fileData = data as FileData;
      return { displayName: fileData.name, subtitle: fileData.path };
    }
    case 'chunk': {
      const chunkData = data as ChunkData;
      const content = chunkData.content;
      return {
        displayName: `Chunk #${chunkData.index}`,
        subtitle: content.slice(0, 60) + (content.length > 60 ? '...' : ''),
      };
    }
    case 'embedding': {
      const embData = data as EmbeddingData;
      return { displayName: 'Vector', subtitle: `${embData.dimensions} dimensions` };
    }
    default:
      return { displayName: '', subtitle: '' };
  }
}

/**
 * CollectionBrowser - Unified hierarchical browser
 */
export function CollectionBrowser({
  data,
  onSelect,
  onMultiSelect,
  onDoubleClick,
  onContextMenu,
  initialFilters,
  showFilterBar = true,
  height = 600,
  className,
  multiSelectEnabled = false,
  isLoading = false,
  emptyMessage = 'No collections found. Import files to get started.',
  bulkActions = [],
  showBulkActionBar = true,
}: CollectionBrowserProps) {
  // Filter state
  const [filters, setFilters] = React.useState<CollectionBrowserFilters>(() => ({
    ...DEFAULT_FILTERS,
    nodeTypes: new Set(DEFAULT_FILTERS.nodeTypes),
    ...initialFilters,
  }));

  // Selection state
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [multiSelectedIds, setMultiSelectedIds] = React.useState<Set<string>>(new Set());

  // Expansion state
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

  // Build tree structure
  const {
    nodes,
    rootNodes,
    totalCount,
    filteredCount,
    getChildren,
    searchMatchIds,
    searchExpandIds,
  } = useCollectionTree({
    data,
    filters,
    expandedIds,
  });

  // Track previous search query to detect changes
  const prevSearchQuery = React.useRef(filters.searchQuery);

  // Auto-expand nodes when search query changes to reveal matches
  React.useEffect(() => {
    if (filters.searchQuery !== prevSearchQuery.current) {
      prevSearchQuery.current = filters.searchQuery;

      // If there's a search query, expand all nodes that contain matches
      if (filters.searchQuery && searchExpandIds.size > 0) {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          for (const id of searchExpandIds) {
            next.add(id);
          }
          return next;
        });
      }
    }
  }, [filters.searchQuery, searchExpandIds]);

  // Handle toggle expand
  const handleToggleExpand = React.useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // Handle expand all
  const handleExpandAll = React.useCallback(() => {
    const allExpandableIds = new Set<string>();
    function addExpandable(nodeId: string): void {
      const children = getChildren(nodeId);
      if (children.length > 0) {
        allExpandableIds.add(nodeId);
        for (const child of children) {
          addExpandable(child.id);
        }
      }
    }
    for (const root of rootNodes) {
      addExpandable(root.id);
    }
    setExpandedIds(allExpandableIds);
  }, [rootNodes, getChildren]);

  // Handle collapse all
  const handleCollapseAll = React.useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  // Handle selection
  const handleSelect = React.useCallback(
    (nodeId: string | null) => {
      setSelectedId(nodeId);
      if (nodeId) {
        const node = nodes.find((n) => n.id === nodeId);
        if (node && onSelect) {
          onSelect(nodeId, node.type, node.data);
        }
      }
    },
    [nodes, onSelect]
  );

  // Handle multi-select change
  const handleMultiSelectChange = React.useCallback(
    (newSelection: Set<string>) => {
      setMultiSelectedIds(newSelection);
      onMultiSelect?.(newSelection);
    },
    [onMultiSelect]
  );

  // Build map of node ID to node type for bulk actions
  const nodeTypeMap = React.useMemo(() => {
    const map = new Map<string, CollectionNodeType>();
    for (const node of nodes) {
      map.set(node.id, node.type as CollectionNodeType);
    }
    return map;
  }, [nodes]);

  // Handle clearing selection
  const handleClearSelection = React.useCallback(() => {
    setMultiSelectedIds(new Set());
    onMultiSelect?.(new Set());
  }, [onMultiSelect]);

  // Handle double-click
  const handleDoubleClick = React.useCallback(
    (nodeId: string, node: TreeNode<BrowserNodeData>) => {
      if (onDoubleClick) {
        onDoubleClick(nodeId, node.type, node.data);
      }
    },
    [onDoubleClick]
  );

  // Handle context menu
  const handleContextMenu = React.useCallback(
    (nodeId: string, node: TreeNode<BrowserNodeData>, event: React.MouseEvent) => {
      if (onContextMenu) {
        onContextMenu(nodeId, node.type, node.data, event);
      }
    },
    [onContextMenu]
  );

  // Define columns
  const columns: TreeTableColumn<BrowserNodeData>[] = React.useMemo(
    () => [
      {
        id: 'name',
        header: 'Name',
        width: '40%',
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          const { displayName, subtitle } = getNodeDisplayInfo(type, nodeData);

          return (
            <div className="flex items-center gap-2 min-w-0">
              <NodeIcon type={type} />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{displayName}</div>
                {subtitle && (
                  <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        width: '15%',
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return <StatusBadge status={(nodeData as FileData).embeddingStatus} />;
          }
          if (type === 'chunk') {
            return <StatusBadge status={(nodeData as ChunkData).embeddingStatus} />;
          }
          return null;
        },
      },
      {
        id: 'size',
        header: 'Size',
        width: '15%',
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (
              <span className="text-sm text-muted-foreground">
                {formatFileSize((nodeData as FileData).size)}
              </span>
            );
          }
          if (type === 'chunk') {
            return (
              <span className="text-sm text-muted-foreground">
                {(nodeData as ChunkData).tokenCount} tokens
              </span>
            );
          }
          if (type === 'embedding') {
            return (
              <span className="text-sm text-muted-foreground">
                {(nodeData as EmbeddingData).dimensions}d
              </span>
            );
          }
          if (type === 'collection') {
            return (
              <span className="text-sm text-muted-foreground">
                {(nodeData as CollectionData).embeddingCount} embeddings
              </span>
            );
          }
          return null;
        },
      },
      {
        id: 'meta',
        header: 'Info',
        width: '30%',
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'collection') {
            const collData = nodeData as CollectionData;
            return (
              <div className="text-xs text-muted-foreground">
                {collData.modelId} • {collData.dimensions}d
              </div>
            );
          }
          if (type === 'file') {
            const fileData = nodeData as FileData;
            return (
              <div className="text-xs text-muted-foreground">
                {fileData.chunkCount} chunks
                {fileData.embeddingProgress !== undefined && fileData.embeddingProgress < 100 && (
                  <span className="ml-2">({fileData.embeddingProgress}% embedded)</span>
                )}
              </div>
            );
          }
          return null;
        },
      },
    ],
    []
  );

  // Loading state
  if (isLoading) {
    return (
      <div
        className={cn('flex items-center justify-center bg-background', className)}
        style={{ height }}
      >
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col bg-background relative', className)} style={{ height }}>
      {showFilterBar && (
        <FilterBar
          filters={filters}
          onFiltersChange={setFilters}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          resultCount={filteredCount}
          totalCount={totalCount}
        />
      )}

      <div className="flex-1 overflow-hidden">
        <TreeTable
          nodes={nodes}
          columns={columns}
          expandedIds={expandedIds}
          onToggleExpand={handleToggleExpand}
          selectedId={selectedId}
          onSelect={handleSelect}
          selectionMode={multiSelectEnabled ? 'multi' : 'single'}
          {...(multiSelectEnabled
            ? {
                multiSelectedIds: multiSelectedIds,
                onMultiSelectChange: handleMultiSelectChange,
              }
            : {})}
          highlightedIds={searchMatchIds}
          onRowDoubleClick={handleDoubleClick}
          onRowContextMenu={handleContextMenu}
          emptyState={<div className="text-sm text-muted-foreground p-4">{emptyMessage}</div>}
          ariaLabel="Collection browser"
          rowHeight={48}
        />
      </div>

      {/* Bulk Action Bar - floating at the bottom when items are selected */}
      {multiSelectEnabled && showBulkActionBar && multiSelectedIds.size > 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
          <BulkActionBar
            selectedIds={multiSelectedIds}
            nodeTypes={nodeTypeMap}
            actions={bulkActions}
            onClearSelection={handleClearSelection}
          />
        </div>
      )}
    </div>
  );
}

CollectionBrowser.displayName = 'CollectionBrowser';

export default CollectionBrowser;
