/**
 * FilterBar Component
 *
 * A comprehensive filter bar for the Collection Browser that provides:
 * - Text search with clear button
 * - Node type filters (Collections, Files, Chunks, Embeddings)
 * - Embedding status filter dropdown
 * - Expand/Collapse all controls
 * - Result count display
 */

import {
  CheckCircle,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  CircleDot,
  Clock,
  File,
  FileText,
  FolderOpen,
  Loader2,
  Search,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Input } from '../input';
import { cn } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { FilterChip } from './filter-chip';
import type { CollectionNodeType, EmbeddingStatus, FilterBarProps } from './types';
import { EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';

/**
 * Icon mapping for node types
 */
const NodeTypeIcon: Record<CollectionNodeType, React.ReactNode> = {
  collection: <FolderOpen className="h-3 w-3" />,
  file: <File className="h-3 w-3" />,
  chunk: <FileText className="h-3 w-3" />,
  embedding: <Sparkles className="h-3 w-3" />,
};

/**
 * Icon mapping for embedding status
 */
const StatusIcon: Record<EmbeddingStatus | 'all', React.ReactNode> = {
  all: <CircleDot className="h-3 w-3" />,
  pending: <Clock className="h-3 w-3" />,
  processing: <Loader2 className="h-3 w-3 animate-spin" />,
  complete: <CheckCircle className="h-3 w-3" />,
  failed: <XCircle className="h-3 w-3" />,
  none: <Circle className="h-3 w-3" />,
};

/**
 * FilterBar - Comprehensive filtering controls for the Collection Browser
 *
 * @example
 * ```tsx
 * <FilterBar
 *   filters={filters}
 *   onFiltersChange={setFilters}
 *   onExpandAll={handleExpandAll}
 *   onCollapseAll={handleCollapseAll}
 *   resultCount={visibleNodes.length}
 *   totalCount={allNodes.length}
 * />
 * ```
 */
export const FilterBar = React.memo(function FilterBar({
  filters,
  onFiltersChange,
  onExpandAll,
  onCollapseAll,
  showExpandControls = true,
  className,
  resultCount,
  totalCount,
}: FilterBarProps) {
  // Handle search input change
  const handleSearchChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onFiltersChange({
        ...filters,
        searchQuery: e.target.value,
      });
    },
    [filters, onFiltersChange]
  );

  // Handle clearing search
  const handleClearSearch = React.useCallback(() => {
    onFiltersChange({
      ...filters,
      searchQuery: '',
    });
  }, [filters, onFiltersChange]);

  // Handle toggling a node type filter
  const handleToggleNodeType = React.useCallback(
    (nodeType: CollectionNodeType) => {
      const newNodeTypes = new Set(filters.nodeTypes);
      if (newNodeTypes.has(nodeType)) {
        // Don't allow deselecting all types
        if (newNodeTypes.size > 1) {
          newNodeTypes.delete(nodeType);
          onFiltersChange({
            ...filters,
            nodeTypes: newNodeTypes,
          });
        }
        // If size is 1, don't call onFiltersChange (can't deselect last type)
      } else {
        newNodeTypes.add(nodeType);
        onFiltersChange({
          ...filters,
          nodeTypes: newNodeTypes,
        });
      }
    },
    [filters, onFiltersChange]
  );

  // Handle selecting all node types
  const handleSelectAllNodeTypes = React.useCallback(() => {
    onFiltersChange({
      ...filters,
      nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
    });
  }, [filters, onFiltersChange]);

  // Handle embedding status change
  const handleStatusChange = React.useCallback(
    (value: string) => {
      onFiltersChange({
        ...filters,
        embeddingStatus: value as EmbeddingStatus | 'all',
      });
    },
    [filters, onFiltersChange]
  );

  // Check if all node types are selected
  const allNodeTypesSelected = filters.nodeTypes.size === 4;

  return (
    <div className={cn('flex flex-col gap-2 border-b bg-background p-2', className)}>
      {/* Row 1: Search and expand controls */}
      <div className="flex items-center gap-2">
        {/* Search Input */}
        <div className="relative flex-1">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-8 pr-8 pl-9 text-sm"
            data-testid="filter-search-input"
            onChange={handleSearchChange}
            placeholder="Search collections, files, chunks..."
            type="text"
            value={filters.searchQuery}
          />
          {filters.searchQuery && (
            <Button
              aria-label="Clear search"
              className="-translate-y-1/2 absolute top-1/2 right-1 h-6 w-6 hover:bg-transparent"
              onClick={handleClearSearch}
              size="icon"
              variant="ghost"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Expand/Collapse Controls */}
        {showExpandControls && (
          <div className="flex items-center gap-1">
            <Button
              aria-label="Expand all"
              className="h-8 w-8"
              onClick={onExpandAll}
              size="icon"
              title="Expand all"
              variant="ghost"
            >
              <ChevronsUpDown className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Collapse all"
              className="h-8 w-8"
              onClick={onCollapseAll}
              size="icon"
              title="Collapse all"
              variant="ghost"
            >
              <ChevronsDownUp className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Row 2: Filter chips and status dropdown */}
      <div className="flex items-center justify-between gap-2">
        {/* Node type filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* All button */}
          <FilterChip
            active={allNodeTypesSelected}
            label="All"
            onClick={handleSelectAllNodeTypes}
          />

          {/* Individual type chips */}
          {(Object.keys(NODE_TYPE_CONFIG) as CollectionNodeType[]).map((nodeType) => (
            <FilterChip
              active={filters.nodeTypes.has(nodeType)}
              icon={NodeTypeIcon[nodeType]}
              key={nodeType}
              label={NODE_TYPE_CONFIG[nodeType].pluralLabel}
              onClick={() => handleToggleNodeType(nodeType)}
            />
          ))}
        </div>

        {/* Status filter and result count */}
        <div className="flex items-center gap-2">
          {/* Embedding status dropdown */}
          <Select onValueChange={handleStatusChange} value={filters.embeddingStatus}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <div className="flex items-center gap-1.5">
                {StatusIcon[filters.embeddingStatus]}
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(EMBEDDING_STATUS_CONFIG) as (EmbeddingStatus | 'all')[]).map(
                (status) => (
                  <SelectItem className="text-xs" key={status} value={status}>
                    <div className="flex items-center gap-1.5">
                      <span className={EMBEDDING_STATUS_CONFIG[status].color}>
                        {StatusIcon[status]}
                      </span>
                      {EMBEDDING_STATUS_CONFIG[status].label}
                    </div>
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>

          {/* Result count */}
          {resultCount !== undefined && totalCount !== undefined && (
            <span className="whitespace-nowrap text-muted-foreground text-xs">
              {resultCount === totalCount
                ? `${totalCount} items`
                : `${resultCount} of ${totalCount}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

FilterBar.displayName = 'FilterBar';

export default FilterBar;
