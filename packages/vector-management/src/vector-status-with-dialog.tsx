import type { QueueAdapter } from '@brainstrike/queue';
import { VectorStatusWithDb } from './vector-status';

export interface VectorStatusWithDialogProps {
  /**
   * CRITICAL: The embedding queue adapter from the app layer.
   *
   * This prop MUST be passed through from:
   * - apps/desktop/src/renderer/components/root-layout-content.tsx (embeddingQueue)
   * - apps/web/src/app/root-layout-content.tsx (embeddingQueue)
   *
   * Flow: Desktop/Web App → RootLayoutContent → AgentSidebarPanel → DatabasePanel → DatabaseTab →
   *       VectorStatusWithDialog (HERE) → VectorStatusWithDb
   *
   * DO NOT remove this prop! The embedding queue is created at the app level
   * (web: createBrowserEmbeddingQueue, desktop: createElectronEmbeddingQueue)
   * and MUST be passed down so VectorStatus can use the same queue instance
   * for embedding operations.
   *
   * Without this prop, VectorStatusWithDb will create its own generic queue,
   * breaking the integration with the app's embedding system.
   */
  queueAdapter?: QueueAdapter | null;
}

/**
 * Wrapper component for VectorStatusWithDb.
 * This is separated to avoid circular dependency issues with @brainstrike/db imports.
 *
 * IMPORTANT: This component must forward the queueAdapter prop to VectorStatusWithDb.
 * See VectorStatusWithDialogProps.queueAdapter documentation for critical context.
 *
 * ARCHITECTURAL NOTE: Embedding set selection has been moved to Database Explorer's
 * SearchCollectionSelector. Vector Status now purely consumes the active collection
 * context via getActiveEmbeddingSetId() rather than controlling it. This establishes
 * a single source of truth for collection selection and eliminates redundant UI.
 */
export function VectorStatusWithDialog({ queueAdapter = null }: VectorStatusWithDialogProps = {}) {
  return <VectorStatusWithDb queueAdapter={queueAdapter} />;
}
