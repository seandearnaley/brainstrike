import type { ScopedLogger } from '@brainstrike/logging';

/**
 * Reset preparation is terminal for this renderer, so the reset UI reloads on
 * either outcome. A failure to record the intent or to reload is logged, and
 * never skips the reload.
 */
export async function reloadThroughLifecycle(
  reason: string,
  logger: Pick<ScopedLogger, 'error'>
): Promise<void> {
  try {
    await (
      window as Window & {
        desktopLifecycle?: { noteReloadIntent: (reason: string) => Promise<void> };
      }
    ).desktopLifecycle?.noteReloadIntent(reason);
  } catch (error) {
    logger.error('Failed to record the reload intent', { error, reason });
  }
  try {
    window.location.reload();
  } catch (error) {
    logger.error('Failed to reload the window', { error, reason });
  }
}
