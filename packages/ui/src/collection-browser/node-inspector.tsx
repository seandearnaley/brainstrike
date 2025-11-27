/**
 * NodeInspector Component
 *
 * A right sidebar panel that displays detailed information about
 * the currently selected node in the Collection Browser.
 */

import {
  Brain,
  Calendar,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  FolderOpen,
  Hash,
  Info,
  Sparkles,
  Tag,
} from 'lucide-react';
import type * as React from 'react';
import { Badge } from '../badge';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { ScrollArea } from '../scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';
import type {
  BrowserNodeData,
  ChunkData,
  CollectionData,
  EmbeddingData,
  EmbeddingStatus,
  FileData,
} from './types';
import { EMBEDDING_STATUS_CONFIG, NODE_TYPE_CONFIG } from './types';

/**
 * Props for the NodeInspector component
 */
export interface NodeInspectorProps {
  /** The type of the selected node */
  nodeType: string | null;
  /** The data of the selected node */
  nodeData: BrowserNodeData | null;
  /** Original ID of the selected node (without prefix) */
  nodeId?: string;
  /** Actions to render for this node */
  actions?: React.ReactNode;
  /** Custom class name */
  className?: string;
  /** Width of the panel when expanded */
  width?: number | string;
  /** Whether the panel is collapsed */
  isCollapsed?: boolean;
  /** Called when collapse state should change */
  onCollapseChange?: (collapsed: boolean) => void;
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
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Property row component for consistent styling
 */
function PropertyRow({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {Icon && <Icon className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium break-all">{value}</div>
      </div>
    </div>
  );
}

/**
 * Status badge for embedding status
 */
function EmbeddingStatusBadge({ status }: { status: EmbeddingStatus }) {
  const config = EMBEDDING_STATUS_CONFIG[status];
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
 * Inspector content for Collection nodes
 */
function CollectionInspector({ data }: { data: CollectionData }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Name" value={data.name} icon={FolderOpen} />
        {data.description && (
          <PropertyRow label="Description" value={data.description} icon={Info} />
        )}
      </div>

      <div className="border-t pt-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground mb-2">Statistics</div>
        <PropertyRow label="Files" value={data.fileCount.toLocaleString()} icon={File} />
        <PropertyRow label="Chunks" value={data.chunkCount.toLocaleString()} icon={FileText} />
        <PropertyRow
          label="Embeddings"
          value={data.embeddingCount.toLocaleString()}
          icon={Sparkles}
        />
      </div>

      <div className="border-t pt-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground mb-2">Model</div>
        <PropertyRow label="Model ID" value={data.modelId} icon={Brain} />
        <PropertyRow label="Dimensions" value={`${data.dimensions}d`} icon={Hash} />
      </div>

      {data.createdAt && (
        <div className="border-t pt-3 space-y-1">
          <PropertyRow label="Created" value={formatDate(data.createdAt)} icon={Calendar} />
          {data.updatedAt && (
            <PropertyRow label="Updated" value={formatDate(data.updatedAt)} icon={Calendar} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inspector content for File nodes
 */
function FileInspector({ data }: { data: FileData }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Name" value={data.name} icon={File} />
        <PropertyRow
          label="Path"
          value={<span className="font-mono text-xs break-all">{data.path}</span>}
        />
      </div>

      <div className="border-t pt-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground mb-2">File Info</div>
        <PropertyRow label="Size" value={formatFileSize(data.size)} />
        {data.mimeType && <PropertyRow label="Type" value={data.mimeType} />}
        <PropertyRow label="Chunks" value={data.chunkCount.toLocaleString()} icon={FileText} />
      </div>

      <div className="border-t pt-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground mb-2">Embedding Status</div>
        <div className="flex items-center gap-2">
          <EmbeddingStatusBadge status={data.embeddingStatus} />
          {data.embeddingProgress !== undefined && data.embeddingProgress < 100 && (
            <span className="text-xs text-muted-foreground">({data.embeddingProgress}%)</span>
          )}
        </div>
      </div>

      {data.importedAt && (
        <div className="border-t pt-3 space-y-1">
          <PropertyRow label="Imported" value={formatDate(data.importedAt)} icon={Calendar} />
        </div>
      )}
    </div>
  );
}

/**
 * Inspector content for Chunk nodes
 */
function ChunkInspector({ data }: { data: ChunkData }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <PropertyRow label="Chunk Index" value={`#${data.index}`} icon={Hash} />
        <PropertyRow label="Token Count" value={data.tokenCount.toLocaleString()} icon={Tag} />
      </div>

      <div className="border-t pt-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground mb-2">Embedding Status</div>
        <EmbeddingStatusBadge status={data.embeddingStatus} />
      </div>

      <div className="border-t pt-3">
        <div className="text-xs font-medium text-muted-foreground mb-1">Content</div>
        <div className="relative w-full">
          <div className="h-24 overflow-y-auto overflow-x-hidden border rounded bg-muted/30 p-2">
            <div className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
              {data.content}
            </div>
          </div>
        </div>
      </div>

      {data.metadata && Object.keys(data.metadata).length > 0 && (
        <div className="border-t pt-3">
          <div className="text-xs font-medium text-muted-foreground mb-1">Metadata</div>
          <div className="relative w-full">
            <div className="max-h-20 overflow-y-auto overflow-x-hidden border rounded bg-muted/30 p-2">
              <div className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
                {JSON.stringify(data.metadata, null, 2)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inspector content for Embedding nodes
 */
function EmbeddingInspector({ data }: { data: EmbeddingData }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Vector ID" value={data.vectorId} icon={Sparkles} />
        <PropertyRow label="Dimensions" value={`${data.dimensions}d`} icon={Hash} />
      </div>

      {data.similarity !== undefined && (
        <div className="border-t pt-3 space-y-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">Search Result</div>
          <PropertyRow label="Similarity" value={`${(data.similarity * 100).toFixed(2)}%`} />
        </div>
      )}

      {data.metadata && Object.keys(data.metadata).length > 0 && (
        <div className="border-t pt-3">
          <div className="text-xs font-medium text-muted-foreground mb-1">Metadata</div>
          <div className="relative w-full">
            <div className="max-h-20 overflow-y-auto overflow-x-hidden border rounded bg-muted/30 p-2">
              <div className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
                {JSON.stringify(data.metadata, null, 2)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Get icon for node type
 */
function getNodeTypeIcon(type: string) {
  switch (type) {
    case 'collection':
      return FolderOpen;
    case 'file':
      return File;
    case 'chunk':
      return FileText;
    case 'embedding':
      return Sparkles;
    default:
      return Info;
  }
}

/** Collapsed width constant */
const COLLAPSED_WIDTH = 40;

/**
 * Collapse toggle button component
 */
function CollapseToggleButton({
  isCollapsed,
  onToggle,
}: {
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onToggle}
            aria-label={isCollapsed ? 'Expand inspector' : 'Collapse inspector'}
          >
            {isCollapsed ? (
              <ChevronLeft className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {isCollapsed ? 'Expand inspector' : 'Collapse inspector'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Render the appropriate inspector content based on node type
 */
function InspectorContent({ nodeType, nodeData }: { nodeType: string; nodeData: BrowserNodeData }) {
  switch (nodeType) {
    case 'collection':
      return <CollectionInspector data={nodeData as CollectionData} />;
    case 'file':
      return <FileInspector data={nodeData as FileData} />;
    case 'chunk':
      return <ChunkInspector data={nodeData as ChunkData} />;
    case 'embedding':
      return <EmbeddingInspector data={nodeData as EmbeddingData} />;
    default:
      return null;
  }
}

/**
 * Collapsed state view
 */
function CollapsedView({
  className,
  nodeType,
  nodeData,
  onToggle,
}: {
  className?: string | undefined;
  nodeType: string | null;
  nodeData: BrowserNodeData | null;
  onToggle: () => void;
}) {
  const TypeIcon = nodeType ? getNodeTypeIcon(nodeType) : Info;
  const typeConfig = nodeType ? NODE_TYPE_CONFIG[nodeType as keyof typeof NODE_TYPE_CONFIG] : null;

  return (
    <div
      className={cn('flex flex-col items-center h-full bg-muted/20 border-l', className)}
      style={{ width: COLLAPSED_WIDTH }}
    >
      <div className="p-1 border-b w-full flex justify-center">
        <CollapseToggleButton isCollapsed onToggle={onToggle} />
      </div>
      {nodeType && nodeData && (
        <div className="flex-1 flex flex-col items-center justify-center">
          <TypeIcon className={cn('h-5 w-5', typeConfig?.color ?? 'text-muted-foreground')} />
        </div>
      )}
    </div>
  );
}

/**
 * Empty state view (no selection)
 */
function EmptyView({
  className,
  width,
  onToggle,
}: {
  className?: string | undefined;
  width: number | string;
  onToggle: () => void;
}) {
  return (
    <div className={cn('flex flex-col h-full bg-muted/20 border-l', className)} style={{ width }}>
      <div className="flex items-center justify-between p-2 border-b">
        <span className="text-sm text-muted-foreground">Inspector</span>
        <CollapseToggleButton isCollapsed={false} onToggle={onToggle} />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center">
        <Info className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Select an item to view details</p>
      </div>
    </div>
  );
}

/**
 * NodeInspector - Right sidebar panel for viewing node details
 */
export function NodeInspector({
  nodeType,
  nodeData,
  nodeId,
  actions,
  className,
  width = 300,
  isCollapsed = false,
  onCollapseChange,
}: NodeInspectorProps) {
  const handleToggle = () => onCollapseChange?.(!isCollapsed);

  if (isCollapsed) {
    return (
      <CollapsedView
        className={className}
        nodeType={nodeType}
        nodeData={nodeData}
        onToggle={handleToggle}
      />
    );
  }

  if (!nodeType || !nodeData) {
    return <EmptyView className={className} width={width} onToggle={handleToggle} />;
  }

  const TypeIcon = getNodeTypeIcon(nodeType);
  const typeConfig = NODE_TYPE_CONFIG[nodeType as keyof typeof NODE_TYPE_CONFIG];

  return (
    <div className={cn('flex flex-col h-full bg-background border-l', className)} style={{ width }}>
      <div className="flex items-center gap-2 p-3 border-b">
        <TypeIcon className={cn('h-5 w-5', typeConfig?.color ?? 'text-muted-foreground')} />
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">{typeConfig?.label ?? 'Item'} Details</div>
          {nodeId && (
            <div className="text-xs text-muted-foreground font-mono truncate">{nodeId}</div>
          )}
        </div>
        <CollapseToggleButton isCollapsed={false} onToggle={handleToggle} />
      </div>

      <ScrollArea className="flex-1 [&>[data-radix-scroll-area-viewport]]:!overflow-x-hidden">
        <div className="p-3 overflow-hidden">
          <InspectorContent nodeType={nodeType} nodeData={nodeData} />
        </div>
      </ScrollArea>

      {actions && <div className="p-3 border-t">{actions}</div>}
    </div>
  );
}

NodeInspector.displayName = 'NodeInspector';

export default NodeInspector;
