interface ShutdownRendererWindow {
  close(): void;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

function closeRenderer(window: ShutdownRendererWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const closed = () => resolve();
    window.once('closed', closed);
    try {
      // Normal close preserves beforeunload/unload and window state persistence.
      // The existing application deadline owns an unresponsive renderer.
      window.close();
    } catch (error) {
      window.removeListener('closed', closed);
      reject(error);
    }
  });
}

/** Stop renderer producers while their IPC dependencies are still available. */
export async function closeDesktopRenderers<Window extends ShutdownRendererWindow>(
  windows: readonly Window[],
  isOwnedHostWindow: (window: Window) => boolean
): Promise<void> {
  const results = await Promise.allSettled(
    windows
      .filter((window) => !(window.isDestroyed() || isOwnedHostWindow(window)))
      .map(closeRenderer)
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Desktop renderer shutdown failed');
  }
}
