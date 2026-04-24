/**
 * useCollectionBrowserColumns
 *
 * Extracts the column definitions for CollectionBrowser into a dedicated hook
 * to keep the main component focused on behavior and layout.
 */

import {
  CheckCircle2,
  Circle,
  Clock3,
  File,
  FileText,
  FolderOpen,
  Layers,
  Loader2,
  Sparkles,
  XCircle,
} from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';
import { Progress } from '../progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';
import type { TreeTableColumn } from '../tree-table/types';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionData,
  EmbeddingData,
  EmbeddingStatus,
  FileData,
} from './types';
import { EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';
import { getNodeDisplayInfo } from './utils';

/**
 * Get icon for node type
 */
function NodeIcon({ type }: { type: string }) {
  if (type === 'collection') {
    return <FolderOpen className={cn('h-4 w-4', NODE_TYPE_CONFIG.collection.color)} />;
  }
  if (type === 'file') {
    return <File className={cn('h-4 w-4', NODE_TYPE_CONFIG.file.color)} />;
  }
  if (type === 'chunk') {
    return <FileText className={cn('h-4 w-4', NODE_TYPE_CONFIG.chunk.color)} />;
  }
  if (type === 'embedding') {
    return <Sparkles className={cn('h-4 w-4', NODE_TYPE_CONFIG.embedding.color)} />;
  }
  if (type === 'group') {
    return <Layers className="h-4 w-4 text-muted-foreground" />;
  }
  return null;
}

function EmbeddingStatusIcon({ status }: { status: EmbeddingStatus }): React.ReactElement {
  const config = EMBEDDING_STATUS_CONFIG[status];
  const iconClassName = cn('h-3.5 w-3.5', config.color, status === 'processing' && 'animate-spin');
  const icon =
    status === 'complete' ? (
      <CheckCircle2 className={iconClassName} />
    ) : status === 'failed' ? (
      <XCircle className={iconClassName} />
    ) : status === 'processing' ? (
      <Loader2 className={iconClassName} />
    ) : status === 'pending' ? (
      <Clock3 className={iconClassName} />
    ) : (
      <Circle className={iconClassName} />
    );

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={`${config.label} embedding status`}
            className="inline-flex size-6 items-center justify-center rounded-sm"
            role="img"
          >
            {icon}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{config.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

interface UseCollectionBrowserColumnsOptions {
  semanticMatchIds: Set<string>;
  showScoreColumn: boolean;
  similarityScores: Map<string, number>;
}

export function useCollectionBrowserColumns({
  showScoreColumn,
  similarityScores,
  semanticMatchIds,
}: UseCollectionBrowserColumnsOptions): TreeTableColumn<BrowserNodeData>[] {
  const baseColumns: TreeTableColumn<BrowserNodeData>[] = React.useMemo(
    () => [
      {
        id: 'name',
        header: 'Name',
        width: showScoreColumn ? '34%' : '48%',
        minWidth: 150,
        sortable: true,
        accessorFn: (node) => getNodeDisplayInfo(node.type, node.data).displayName.toLowerCase(),
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          const { displayName, subtitle } = getNodeDisplayInfo(type, nodeData);
          const subtitleTooltip = type === 'file' ? (nodeData as FileData).path : subtitle;

          return (
            <TooltipProvider delayDuration={300}>
              <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
                <NodeIcon type={type} />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="cursor-default truncate font-medium">{displayName}</div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs" side="top">
                      {displayName}
                    </TooltipContent>
                  </Tooltip>
                  {subtitle && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="cursor-default truncate text-muted-foreground text-xs">
                          {subtitle}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        className="max-w-md break-all font-mono text-xs"
                        side="bottom"
                      >
                        {subtitleTooltip}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            </TooltipProvider>
          );
        },
      },
      {
        id: 'status',
        header: (
          <>
            <span className="sr-only">Status</span>
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          </>
        ),
        headerContentClassName: 'justify-center',
        width: 44,
        minWidth: 44,
        maxWidth: 44,
        sortable: true,
        accessorFn: (node) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (nodeData as FileData).embeddingStatus;
          }
          if (type === 'chunk') {
            return (nodeData as ChunkData).embeddingStatus;
          }
          return '';
        },
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return <EmbeddingStatusIcon status={(nodeData as FileData).embeddingStatus} />;
          }
          if (type === 'chunk') {
            return <EmbeddingStatusIcon status={(nodeData as ChunkData).embeddingStatus} />;
          }
          return null;
        },
      },
      {
        id: 'size',
        header: 'Size',
        width: showScoreColumn ? '5.5rem' : '6rem',
        minWidth: 72,
        sortable: true,
        accessorFn: (node) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (nodeData as FileData).size;
          }
          if (type === 'chunk') {
            return (nodeData as ChunkData).tokenCount;
          }
          if (type === 'embedding') {
            return (nodeData as EmbeddingData).dimensions;
          }
          if (type === 'collection') {
            return (nodeData as CollectionData).embeddingCount;
          }
          return 0;
        },
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'file') {
            return (
              <span className="text-muted-foreground text-sm">
                {formatFileSize((nodeData as FileData).size)}
              </span>
            );
          }
          if (type === 'chunk') {
            return (
              <span className="text-muted-foreground text-sm">
                {(nodeData as ChunkData).tokenCount} tokens
              </span>
            );
          }
          if (type === 'embedding') {
            return (
              <span className="text-muted-foreground text-sm">
                {(nodeData as EmbeddingData).dimensions}d
              </span>
            );
          }
          if (type === 'collection') {
            return (
              <span className="text-muted-foreground text-sm">
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
        width: showScoreColumn ? '16%' : 'auto',
        sortable: false,
        cell: ({ node }) => {
          const { data: nodeData, type } = node;
          if (type === 'collection') {
            const collData = nodeData as CollectionData;
            return (
              <div
                className="truncate text-muted-foreground text-xs"
                title={`${collData.modelId} • ${collData.dimensions}d`}
              >
                {collData.modelId} • {collData.dimensions}d
              </div>
            );
          }
          if (type === 'file') {
            const fileData = nodeData as FileData;
            const text =
              fileData.embeddingProgress !== undefined && fileData.embeddingProgress < 100
                ? `${fileData.chunkCount} chunks (${fileData.embeddingProgress}%)`
                : `${fileData.chunkCount} chunks`;
            return (
              <div className="truncate text-muted-foreground text-xs" title={text}>
                {text}
              </div>
            );
          }
          return null;
        },
      },
    ],
    [showScoreColumn]
  );

  const scoreColumn: TreeTableColumn<BrowserNodeData> = React.useMemo(
    () => ({
      id: 'score',
      header: 'Score',
      width: '20%',
      minWidth: 100,
      sortable: true,
      accessorFn: (node) => similarityScores.get(node.id) ?? 0,
      cell: ({ node }) => {
        const score = similarityScores.get(node.id);

        if (score === undefined) {
          return <span className="text-muted-foreground/50 text-xs">—</span>;
        }

        const percentage = Math.round(score * 100);
        const isDirectMatch = semanticMatchIds.has(node.id);

        return (
          <div className="flex items-center gap-2">
            <Progress
              aria-label="Semantic match score"
              className={cn('h-2 w-12 flex-shrink-0', isDirectMatch ? 'bg-primary/20' : 'bg-muted')}
              value={percentage}
            />
            <span
              className={cn(
                'whitespace-nowrap font-mono text-xs tabular-nums',
                isDirectMatch ? 'font-medium text-primary' : 'text-muted-foreground'
              )}
            >
              {percentage}%
            </span>
          </div>
        );
      },
    }),
    [similarityScores, semanticMatchIds]
  );

  return React.useMemo(() => {
    if (showScoreColumn) {
      return [...baseColumns.slice(0, 1), scoreColumn, ...baseColumns.slice(1)].filter(
        (col): col is TreeTableColumn<BrowserNodeData> => col !== undefined
      );
    }
    return baseColumns;
  }, [baseColumns, scoreColumn, showScoreColumn]);
}
