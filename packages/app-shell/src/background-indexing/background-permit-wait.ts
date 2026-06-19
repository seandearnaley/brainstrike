import { createLogger } from '@brainstrike/utils';

const logger = createLogger('WorkspaceCollectionSyncProvider');

// Longest a single background DB permit waits for foreground pressure to clear
// before proceeding anyway. Bounds the indefinite block that otherwise starves
// a newly-added root: the indexer's own writes refire foreground `live` queries,
// producing a lagging/self-inflicted foreground-latency signal that never clears
// while background work is pending. Paired with the QoS starvation bypass so a
// starved sync phase downgrades to gentle, constrained batches.
export const BACKGROUND_PERMIT_MAX_WAIT_MS = 5000;

// Wrap a database-pressure permit so it can never block longer than
// BACKGROUND_PERMIT_MAX_WAIT_MS. The underlying permit polls until foreground
// pressure clears with no upper bound; under a lagging/self-inflicted
// foreground-latency signal (the indexer's own writes refire foreground `live`
// queries) that can be indefinite, starving a newly-added root. On timeout we
// abort the underlying wait and proceed — the QoS layer keeps the resulting work
// gentle (constrained batches). Genuine foreground-query yielding is unaffected:
// the import phase only runs once the QoS gate allows new work, which still
// excludes foreground-query.
export function boundBackgroundPermitWait(
  basePermit: (options: { readonly label: string; readonly signal?: AbortSignal }) => Promise<void>
): (options: { readonly label: string }) => Promise<void> {
  return async (options: { readonly label: string }): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, BACKGROUND_PERMIT_MAX_WAIT_MS);
    try {
      await basePermit({ label: options.label, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        logger.warn('Background DB permit exceeded max wait; proceeding to avoid starvation', {
          label: options.label,
          maxWaitMs: BACKGROUND_PERMIT_MAX_WAIT_MS,
        });
        return;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
