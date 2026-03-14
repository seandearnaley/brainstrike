import { lazy, type ReactElement, Suspense } from 'react';

const LazyQueueStatusPopover = lazy(async () => {
  const module = await import('@brainstrike/vector-management');
  return { default: module.QueueStatusPopover };
});

/**
 * Embedding queue status with expandable diagnostics panel.
 *
 * Shows compact metrics in the status bar. Click to expand
 * a popover with full queue diagnostics including durable
 * and ephemeral queue metrics, worker health, and performance data.
 */
export function QueueStatusItem(): ReactElement {
  return (
    <Suspense fallback={null}>
      <LazyQueueStatusPopover />
    </Suspense>
  );
}
