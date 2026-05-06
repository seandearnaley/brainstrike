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
  /** Actions to render for this node */
  actions?: React.ReactNode;
  /** Custom class name */
  className?: string;
  /** Whether the panel is collapsed */
  isCollapsed?: boolean;
  /** The data of the selected node */
  nodeData: BrowserNodeData | null;
  /** Original ID of the selected node (without prefix) */
  nodeId?: string;
  /** The type of the selected node */
  nodeType: string | null;
  /** Called when collapse state should change */
  onCollapseChange?: (collapsed: boolean) => void;
  /** Width of the panel when expanded (optional, defaults to 100%) */
  width?: number | string;
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
      {Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="break-all font-medium text-sm">{value}</div>
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
      className="text-xs"
      variant={
        status === 'complete' ? 'default' : status === 'failed' ? 'destructive' : 'secondary'
      }
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
        <PropertyRow icon={FolderOpen} label="Name" value={data.name} />
        {data.description && (
          <PropertyRow icon={Info} label="Description" value={data.description} />
        )}
      </div>

      <div className="space-y-1 border-t pt-3">
        <div className="mb-2 font-medium text-muted-foreground text-xs">Statistics</div>
        <PropertyRow icon={File} label="Files" value={data.fileCount.toLocaleString()} />
        <PropertyRow icon={FileText} label="Chunks" value={data.chunkCount.toLocaleString()} />
        <PropertyRow
          icon={Sparkles}
          label="Embeddings"
          value={data.embeddingCount.toLocaleString()}
        />
      </div>

      <div className="space-y-1 border-t pt-3">
        <div className="mb-2 font-medium text-muted-foreground text-xs">Model</div>
        <PropertyRow icon={Brain} label="Model ID" value={data.modelId} />
        <PropertyRow icon={Hash} label="Dimensions" value={`${data.dimensions}d`} />
      </div>

      {data.createdAt && (
        <div className="space-y-1 border-t pt-3">
          <PropertyRow icon={Calendar} label="Created" value={formatDate(data.createdAt)} />
          {data.updatedAt && (
            <PropertyRow icon={Calendar} label="Updated" value={formatDate(data.updatedAt)} />
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
        <PropertyRow icon={File} label="Name" value={data.name} />
        <PropertyRow
          label="Path"
          value={<span className="break-all font-mono text-xs">{data.path}</span>}
        />
      </div>

      <div className="space-y-1 border-t pt-3">
        <div className="mb-2 font-medium text-muted-foreground text-xs">File Info</div>
        <PropertyRow label="Size" value={formatFileSize(data.size)} />
        {data.mimeType && <PropertyRow label="Type" value={data.mimeType} />}
        <PropertyRow icon={FileText} label="Chunks" value={data.chunkCount.toLocaleString()} />
      </div>

      <div className="space-y-1 border-t pt-3">
        <div className="mb-2 font-medium text-muted-foreground text-xs">Embedding Status</div>
        <div className="flex items-center gap-2">
          <EmbeddingStatusBadge status={data.embeddingStatus} />
          {data.embeddingProgress !== undefined && data.embeddingProgress < 100 && (
            <span className="text-muted-foreground text-xs">({data.embeddingProgress}%)</span>
          )}
        </div>
      </div>

      {data.importedAt && (
        <div className="space-y-1 border-t pt-3">
          <PropertyRow icon={Calendar} label="Imported" value={formatDate(data.importedAt)} />
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
        <PropertyRow icon={Hash} label="Chunk Index" value={`#${data.index}`} />
        <PropertyRow icon={Tag} label="Token Count" value={data.tokenCount.toLocaleString()} />
      </div>

      <div className="space-y-1 border-t pt-3">
        <div className="mb-2 font-medium text-muted-foreground text-xs">Embedding Status</div>
        <EmbeddingStatusBadge status={data.embeddingStatus} />
      </div>

      <div className="border-t pt-3">
        <div className="mb-1 font-medium text-muted-foreground text-xs">Content</div>
        <div className="relative w-full">
          <div className="h-24 overflow-y-auto overflow-x-hidden rounded border bg-muted/30 p-2">
            <div className="whitespace-pre-wrap break-all font-mono text-foreground/80 text-xs leading-relaxed">
              {data.content}
            </div>
          </div>
        </div>
      </div>

      {data.metadata && Object.keys(data.metadata).length > 0 && (
        <div className="border-t pt-3">
          <div className="mb-1 font-medium text-muted-foreground text-xs">Metadata</div>
          <div className="relative w-full">
            <div className="max-h-20 overflow-y-auto overflow-x-hidden rounded border bg-muted/30 p-2">
              <div className="whitespace-pre-wrap break-all font-mono text-foreground/80 text-xs leading-relaxed">
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
        <PropertyRow icon={Sparkles} label="Vector ID" value={data.vectorId} />
        <PropertyRow icon={Hash} label="Dimensions" value={`${data.dimensions}d`} />
      </div>

      {data.similarity !== undefined && (
        <div className="space-y-1 border-t pt-3">
          <div className="mb-2 font-medium text-muted-foreground text-xs">Search Result</div>
          <PropertyRow label="Similarity" value={`${(data.similarity * 100).toFixed(2)}%`} />
        </div>
      )}

      {data.metadata && Object.keys(data.metadata).length > 0 && (
        <div className="border-t pt-3">
          <div className="mb-1 font-medium text-muted-foreground text-xs">Metadata</div>
          <div className="relative w-full">
            <div className="max-h-20 overflow-y-auto overflow-x-hidden rounded border bg-muted/30 p-2">
              <div className="whitespace-pre-wrap break-all font-mono text-foreground/80 text-xs leading-relaxed">
                {JSON.stringify(data.metadata, null, 2)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Collapsed width constant */
const COLLAPSED_WIDTH = 40;

/**
 * Node type icon component - renders the appropriate icon for a node type
 */
function NodeTypeIcon({ type, className }: { type: string | null; className?: string }) {
  if (type === 'collection') {
    return <FolderOpen className={className} />;
  }
  if (type === 'file') {
    return <File className={className} />;
  }
  if (type === 'chunk') {
    return <FileText className={className} />;
  }
  if (type === 'embedding') {
    return <Sparkles className={className} />;
  }
  return <Info className={className} />;
}

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
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand inspector' : 'Collapse inspector'}
            className="h-8 w-8 p-0"
            onClick={onToggle}
            size="sm"
            variant="ghost"
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
  onToggle,
}: {
  className?: string | undefined;
  nodeType: string | null;
  onToggle: () => void;
}) {
  const typeConfig = nodeType
    ? NODE_TYPE_CONFIG[nodeType as keyof typeof NODE_TYPE_CONFIG]
    : NODE_TYPE_CONFIG.embedding;

  return (
    <div
      className={cn('flex h-full flex-col items-center border-l bg-muted/20', className)}
      style={{ width: COLLAPSED_WIDTH }}
    >
      <div className="flex h-12 w-full items-center justify-center border-b">
        <CollapseToggleButton isCollapsed onToggle={onToggle} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center">
        <NodeTypeIcon
          className={cn('h-5 w-5', typeConfig?.color ?? 'text-muted-foreground')}
          type={nodeType}
        />
      </div>
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
    <div className={cn('flex h-full flex-col border-l bg-muted/20', className)} style={{ width }}>
      <div className="flex h-12 items-center justify-between border-b px-3">
        <span className="font-medium text-muted-foreground text-sm">Inspector</span>
        <CollapseToggleButton isCollapsed={false} onToggle={onToggle} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center">
        <Info className="mb-2 h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">Select an item to view details</p>
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
  width,
  isCollapsed = false,
  onCollapseChange,
}: NodeInspectorProps) {
  const handleToggle = () => onCollapseChange?.(!isCollapsed);

  if (isCollapsed) {
    return <CollapsedView className={className} nodeType={nodeType} onToggle={handleToggle} />;
  }

  if (!(nodeType && nodeData)) {
    return <EmptyView className={className} onToggle={handleToggle} width={width ?? '100%'} />;
  }

  const typeConfig = NODE_TYPE_CONFIG[nodeType as keyof typeof NODE_TYPE_CONFIG];

  return (
    <div
      className={cn('flex h-full flex-col border-l bg-background', className)}
      style={{ width: width ?? '100%' }}
    >
      <div className="flex h-12 items-center gap-2 border-b px-3">
        <NodeTypeIcon
          className={cn('h-5 w-5', typeConfig?.color ?? 'text-muted-foreground')}
          type={nodeType}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium leading-none">
            {typeConfig?.label ?? 'Item'} Details
          </div>
          {nodeId && (
            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground leading-none">
              {nodeId}
            </div>
          )}
        </div>
        <CollapseToggleButton isCollapsed={false} onToggle={handleToggle} />
      </div>

      <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:!overflow-x-hidden flex-1">
        <div className="overflow-hidden p-3">
          <InspectorContent nodeData={nodeData} nodeType={nodeType} />
        </div>
      </ScrollArea>

      {actions && <div className="border-t p-3">{actions}</div>}
    </div>
  );
}

NodeInspector.displayName = 'NodeInspector';

export default NodeInspector;
