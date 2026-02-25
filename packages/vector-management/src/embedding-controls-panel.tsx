import type { QueueAdapter } from '@brainstrike/queue';
import { useToast } from '@brainstrike/ui';
import { EmbeddingActionsDropdown } from './embedding-actions-dropdown';
import { EmbeddingQueueProvider } from './embedding-queue-provider';
import { EmbeddingStatusBar } from './embedding-status-bar';
import { useEmbeddingControls } from './use-embedding-controls';

export interface EmbeddingControlsPanelProps {
  /** Chunk repository with coverage methods */
  chunkRepository?: {
    getCoverageForSet: (
      setId: string
    ) => Promise<{ totalChunks: number; chunksWithEmbeddingsForSet: number }>;
    clearEmbeddingsForSet: (embeddingSetId: string) => Promise<number>;
  } | null;
  /** Additional className for the container */
  className?: string;
  /** The embedding queue adapter (passed from app) */
  embeddingQueue?: QueueAdapter | null;
  /** Whether to show the actions dropdown (default: true) */
  showActionsDropdown?: boolean;
  /** Whether to show the status bar (default: true) */
  showStatusBar?: boolean;
}

/**
 * Inner component that consumes the embedding queue context
 */
function EmbeddingControlsPanelContent({
  chunkRepository,
  showStatusBar = true,
  showActionsDropdown = true,
  className,
}: Omit<EmbeddingControlsPanelProps, 'embeddingQueue'>) {
  const { toast } = useToast();

  // Use the centralized hook for all embedding controls state
  const { dropdownProps, statusBarProps } = useEmbeddingControls({
    chunkRepository: chunkRepository ?? null,
    toast,
  });

  return (
    <div className={className}>
      {/* Actions Dropdown */}
      {showActionsDropdown && (
        <div className="flex items-center px-4 py-2">
          <EmbeddingActionsDropdown {...dropdownProps} />
        </div>
      )}

      {/* Embedding Status Bar */}
      {showStatusBar && <EmbeddingStatusBar {...statusBarProps} />}
    </div>
  );
}

/**
 * EmbeddingControlsPanel - Self-contained embedding controls with status bar.
 *
 * This component wraps the EmbeddingActionsDropdown and EmbeddingStatusBar
 * with all necessary hooks and state management. It provides a clean integration
 * point for adding embedding controls to any panel.
 *
 * Key features:
 * - Split button for Backfill/Retry/Clear/Wipe actions
 * - Compact status bar with queue metrics and sparklines
 * - Auto-starts worker on web platform when backfill is clicked
 * - Validates API key availability before embedding
 * - Shows PG and worker status badges
 *
 * For more control over placement, use the `useEmbeddingControls` hook directly
 * with `EmbeddingActionsDropdown` and `EmbeddingStatusBar` components.
 */
export function EmbeddingControlsPanel({
  embeddingQueue = null,
  chunkRepository = null,
  showStatusBar = true,
  showActionsDropdown = true,
  className,
}: EmbeddingControlsPanelProps) {
  return (
    <EmbeddingQueueProvider {...(embeddingQueue ? { adapter: embeddingQueue } : {})}>
      <EmbeddingControlsPanelContent
        chunkRepository={chunkRepository}
        showActionsDropdown={showActionsDropdown}
        showStatusBar={showStatusBar}
        {...(className ? { className } : {})}
      />
    </EmbeddingQueueProvider>
  );
}
